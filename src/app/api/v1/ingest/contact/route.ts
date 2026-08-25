// ============================================================
// POST /api/v1/ingest/contact — webhook de ENTRADA (SPEC 055)
// (scope: ingest:write)
//
// Terceiro (n8n, formulário, e-commerce) faz POST para o CRM — o
// inverso de /api/v1/webhooks (que notifica terceiros). Recebe um
// contato, valida telefone pela SPEC 050 (estrita — D-3), grava tudo
// o que o cadastro manual grava (nome/email/empresa/tags/notas/campos
// personalizados) e, se `template_id` vier aprovado, dispara um
// template. Todo POST aceito também alimenta o funil acumulado por
// `webhook_id` (D-4/D-5/D-15) e toda rejeição vira uma linha em
// `webhook_ingest_logs` (D-11), visível em Settings → Log de webhook.
//
// Assimetria de HTTP (D-14): falha ANTES de criar o contato é 400 —
// nada foi gravado. Falha DEPOIS (template não aprovado, canal
// incapaz, envio recusado pela Meta) é 202 — o contato existe, e um
// 4xx faria quem chama reprocessar e duplicar. O envio em si roda em
// `after()`, no mesmo padrão de `POST /api/v1/broadcasts` — a
// resposta não espera a chamada à Meta.
// ============================================================

import { after } from 'next/server';

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  findOrCreateContact,
  resolveAuditUserId,
  ContactError,
} from '@/lib/api/v1/contacts';
import {
  resolveImportTagIds,
  assignImportedContactTags,
} from '@/lib/contacts/resolve-import-tags';
import { parseIngestPayload, type IngestWarning } from '@/lib/ingest/validate';
import { insertContactNotes } from '@/lib/ingest/notes';
import { applyCustomValues } from '@/lib/ingest/custom-values';
import { upsertFunnel, addFunnelRecipient } from '@/lib/ingest/funnel';
import { sendIngestTemplate } from '@/lib/ingest/send';
import { logIngestEvent, PAYLOAD_MAX_BYTES } from '@/lib/ingest/log';

// O envio real (chamada à Meta) roda em after() — a mesma folga de
// duração que POST /api/v1/broadcasts documenta, embora aqui seja
// sempre UM destinatário por requisição, então o risco de corte é bem
// menor.
export const maxDuration = 60;

function rawFieldAsString(body: unknown, key: string): string | null {
  if (!body || typeof body !== 'object') return null;
  const v = (body as Record<string, unknown>)[key];
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function payloadByteSize(body: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(body ?? {}), 'utf8');
  } catch {
    return 0;
  }
}

/** `.code` de IngestSendError / BroadcastError — ambos têm a mesma forma. */
function errorCode(err: unknown, fallback: string): string {
  if (
    err &&
    typeof err === 'object' &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string'
  ) {
    return (err as { code: string }).code;
  }
  return fallback;
}

/**
 * Vincula tags de forma ADITIVA (D-6 — nunca `setContactTags`, que
 * substitui) e devolve o resumo `{linked, created}` para a resposta.
 * `linked` conta as que já existiam na conta; `created`, as novas.
 *
 * Uma única chamada a `resolveImportTagIds` — que já sabe quais nomes
 * criou (`createdNames`) — em vez de uma SELECT própria em `tags`
 * seguida da SELECT interna do helper: duas leituras não-transacionais
 * da mesma tabela podiam divergir sob concorrência (uma tag criada por
 * outra requisição entre as duas leituras fazia `linked`/`created`
 * discordar do que realmente aconteceu), além de pagar uma query a
 * mais em todo POST com tags.
 */
async function linkContactTagsAdditive(
  supabase: Parameters<typeof resolveImportTagIds>[0],
  accountId: string,
  userId: string,
  contactId: string,
  tagNames: string[]
): Promise<{ linked: number; created: number }> {
  const uniqueRequested = new Set(
    tagNames.map((t) => t.trim().toLowerCase()).filter(Boolean)
  );

  const { tagIdByKey, createdNames } = await resolveImportTagIds(supabase, {
    accountId,
    userId,
    tagNames,
    canCreateTags: true,
  });
  await assignImportedContactTags(
    supabase,
    [{ contactId, tagNames }],
    tagIdByKey
  );

  const created = createdNames.length;
  return { linked: uniqueRequested.size - created, created };
}

export async function POST(request: Request) {
  let ctx: Awaited<ReturnType<typeof requireApiKey>>;
  try {
    ctx = await requireApiKey(request, 'ingest:write');
  } catch (err) {
    // D-2: sem chave válida não há account_id a que uma linha de log
    // pertença — nenhuma linha é gravada para 401/403/429.
    return toApiErrorResponse(err);
  }

  const rawBody: unknown = await request.json().catch(() => null);
  const parseResult = parseIngestPayload(rawBody);

  if (!parseResult.ok) {
    await logIngestEvent(ctx.supabase, {
      accountId: ctx.accountId,
      apiKeyId: ctx.keyId,
      webhookId: rawFieldAsString(rawBody, 'webhook_id'),
      webhookName: rawFieldAsString(rawBody, 'webhook_name'),
      level: 'error',
      code: parseResult.code,
      message: parseResult.message,
      phone: rawFieldAsString(rawBody, 'phone'),
      payload: rawBody,
    });
    return fail(parseResult.code, parseResult.message, 400);
  }

  const payload = parseResult.value;
  const warnings: IngestWarning[] = [...parseResult.warnings];
  if (payloadByteSize(rawBody) > PAYLOAD_MAX_BYTES) {
    warnings.push({
      code: 'payload_truncated',
      message: 'The request payload exceeds 8 KB and was truncated in the log',
    });
  }

  // Logger amarrado aos campos fixos desta requisição (D-11) — cada
  // chamada abaixo só precisa dizer o que MUDA (nível/código/mensagem/
  // contactId/broadcastId), nunca repetir account/key/webhook/telefone/
  // payload nos 6+ pontos de log espalhados pela função.
  const log = (
    level: 'error' | 'warning',
    code: string,
    message: string,
    extra: { contactId?: string | null; broadcastId?: string | null } = {}
  ) =>
    logIngestEvent(ctx.supabase, {
      accountId: ctx.accountId,
      apiKeyId: ctx.keyId,
      webhookId: payload.webhookId,
      webhookName: payload.webhookName,
      level,
      code,
      message,
      phone: payload.phone,
      contactId: extra.contactId ?? null,
      broadcastId: extra.broadcastId ?? null,
      payload: rawBody,
    });

  let auditUserId: string;
  let contactId: string;
  let contactCreated: boolean;
  try {
    auditUserId = await resolveAuditUserId(ctx.supabase, ctx.accountId);
    ({ id: contactId, created: contactCreated } = await findOrCreateContact(
      ctx.supabase,
      ctx.accountId,
      auditUserId,
      {
        phone: payload.phone,
        name: payload.name,
        email: payload.email,
        company: payload.company,
      }
    ));
  } catch (err) {
    // Pré-criação: nada foi gravado ainda — 4xx/5xx é seguro aqui, é
    // exatamente o que D-14 reserva para "antes de criar o contato".
    if (err instanceof ContactError) {
      return fail(
        err.status === 400 ? 'bad_request' : 'internal',
        err.message,
        err.status
      );
    }
    console.error(
      '[api/v1/ingest/contact] unexpected error before contact creation:',
      err
    );
    return fail('internal', 'Internal server error', 500);
  }

  // A PARTIR DAQUI O CONTATO JÁ EXISTE. D-14: nenhuma falha depois
  // deste ponto pode virar 4xx/5xx — cada etapa é best-effort, uma
  // falha é logada e a etapa seguinte roda do mesmo jeito, e a resposta
  // final é sempre 202 (achado do code-review: o código anterior deixava
  // qualquer erro aqui cair no catch genérico como 500 sem log nenhum,
  // contradizendo exatamente essa promessa).
  let tagsSummary = { linked: 0, created: 0 };
  if (payload.tags.length > 0) {
    try {
      tagsSummary = await linkContactTagsAdditive(
        ctx.supabase,
        ctx.accountId,
        auditUserId,
        contactId,
        payload.tags
      );
    } catch (err) {
      await log(
        'error',
        'internal',
        err instanceof Error ? err.message : 'Failed to link tags',
        { contactId }
      );
    }
  }

  let notesInserted = 0;
  try {
    const notesResult = await insertContactNotes(ctx.supabase, {
      accountId: ctx.accountId,
      userId: auditUserId,
      contactId,
      notes: payload.notes,
    });
    notesInserted = notesResult.inserted;
  } catch (err) {
    await log(
      'error',
      'internal',
      err instanceof Error ? err.message : 'Failed to insert contact notes',
      { contactId }
    );
  }

  let matchedFields = 0;
  let skippedFields: string[] = [];
  try {
    const customValuesResult = await applyCustomValues(ctx.supabase, {
      accountId: ctx.accountId,
      contactId,
      entries: payload.customFields,
    });
    warnings.push(...customValuesResult.warnings);
    matchedFields = customValuesResult.outcomes.filter(
      (o) => o.status === 'matched'
    ).length;
    skippedFields = customValuesResult.outcomes
      .filter((o) => o.status !== 'matched')
      .map((o) => o.field);
  } catch (err) {
    await log(
      'error',
      'internal',
      err instanceof Error
        ? err.message
        : 'Failed to write custom field values',
      { contactId }
    );
  }

  // Funil (D-15): tentado para TODO POST aceito, com ou sem disparo.
  let funnelBroadcastId: string | null = null;
  try {
    const funnel = await upsertFunnel(ctx.supabase, {
      accountId: ctx.accountId,
      userId: auditUserId,
      webhookId: payload.webhookId,
      webhookName: payload.webhookName,
    });
    funnelBroadcastId = funnel.broadcastId;
  } catch (err) {
    await log(
      'error',
      'internal',
      err instanceof Error ? err.message : 'Failed to upsert webhook funnel',
      { contactId }
    );
  }

  let sendSummary: { attempted: boolean; template_id?: string } = {
    attempted: false,
  };
  if (payload.templateId && funnelBroadcastId) {
    const templateId = payload.templateId;
    const broadcastId = funnelBroadcastId;
    sendSummary = { attempted: true, template_id: templateId };

    try {
      const { recipientRowId } = await addFunnelRecipient(ctx.supabase, {
        broadcastId,
        contactId,
      });

      const { supabase, accountId, keyId } = ctx;
      const { phone, templateParams, webhookId, webhookName } = payload;

      after(async () => {
        try {
          await sendIngestTemplate(supabase, {
            accountId,
            phone,
            templateId,
            templateParams,
            recipientRowId,
          });
        } catch (err) {
          await logIngestEvent(supabase, {
            accountId,
            apiKeyId: keyId,
            webhookId,
            webhookName,
            level: 'error',
            code: errorCode(err, 'send_failed'),
            message: err instanceof Error ? err.message : 'Unknown error',
            phone,
            contactId,
            broadcastId,
            payload: rawBody,
          });
        }
      });
    } catch (err) {
      // addFunnelRecipient falhou antes de qualquer tentativa de
      // envio — o contato já existe, então isto é 202 + log, nunca
      // um 4xx (D-14).
      await log(
        'error',
        'send_failed',
        err instanceof Error ? err.message : 'Unknown error',
        { contactId, broadcastId }
      );
    }
  } else if (payload.templateId && !funnelBroadcastId) {
    // O upsert do funil falhou acima — sem broadcastId não há onde
    // pendurar a linha de destinatário. O contato foi criado do mesmo
    // jeito; só o disparo não pôde ser rastreado.
    warnings.push({
      code: 'send_failed',
      message:
        'Send skipped: could not resolve the webhook funnel for this request',
    });
  }

  // Cada warning vira sua própria linha no log (D-11 — filtrável por
  // código), best-effort e em paralelo: uma falha ao gravar um não
  // deve atrasar as demais nem a resposta.
  await Promise.all(
    warnings.map((w) =>
      log('warning', w.code, w.message, {
        contactId,
        broadcastId: funnelBroadcastId,
      })
    )
  );

  return ok(
    {
      contact_id: contactId,
      contact_created: contactCreated,
      funnel: funnelBroadcastId
        ? { broadcast_id: funnelBroadcastId, webhook_id: payload.webhookId }
        : null,
      tags: tagsSummary,
      notes: { inserted: notesInserted },
      custom_fields: { matched: matchedFields, skipped: skippedFields },
      send: sendSummary,
      warnings,
    },
    202
  );
}
