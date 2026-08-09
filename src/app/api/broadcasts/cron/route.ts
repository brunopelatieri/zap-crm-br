/**
 * GET /api/broadcasts/cron — dispara as campanhas agendadas que venceram
 * (SPEC 044 §6.3).
 *
 * O que ela resolve
 *
 *   `broadcasts.scheduled_at` existe desde a migração 001 e nunca foi
 *   lido por ninguém: agendar era impossível. Com o envio já no servidor
 *   (§6.1), o que faltava era alguém acordando de tempo em tempo para
 *   perguntar "venceu algo?". É esta rota.
 *
 * Três decisões que valem ser lidas antes de mexer
 *
 *   1. **A audiência é resolvida AGORA, não no agendamento.** O que ficou
 *      gravado é o FILTRO. Quem entrou na etiqueta depois de ontem
 *      recebe; quem pediu opt-out na madrugada não recebe (§6.8); a cota
 *      conferida é a da janela de 24 h que vale neste instante. Congelar
 *      a lista no agendamento produziria um disparo tecnicamente correto
 *      e factualmente velho.
 *   2. **Fora da janela, ADIA — não dispara nem falha.** Um agendamento
 *      que vence às 23h (porque o cron ficou fora do ar, ou porque o
 *      usuário marcou assim e depois tirou o override) é empurrado para a
 *      próxima abertura da janela. Disparar queimaria reputação; marcar
 *      como falho destruiria a intenção do usuário. Adiar preserva as
 *      duas coisas, e o motivo fica na trilha (§6.8).
 *   3. **O claim é o lock.** `UPDATE … WHERE status = 'scheduled'` só
 *      casa uma vez; duas invocações sobrepostas do cron não disparam a
 *      mesma campanha duas vezes. Mesmo padrão de
 *      `/api/automations/cron`, sem `SELECT … FOR UPDATE`.
 *   4. **A varredura ignora variantes B** (§6.6). Um teste A/B agendado
 *      são duas linhas `scheduled`, e só a variante A é campanha por si
 *      só: a B existe para receber metade da audiência que a A vai
 *      sortear. Varrê-la também faria o cron disparar a audiência
 *      INTEIRA duas vezes, uma por template.
 *
 * Auth: reusa `AUTOMATION_CRON_SECRET` para o operador ter um segredo só
 * — igual a `/api/flows/cron`.
 *
 * Hospedagem: um ping a cada 5 min é suficiente (a granularidade do
 * agendamento na UI é de minuto, e um atraso de poucos minutos num
 * disparo em massa não muda nada). Ver docs/automations-and-cron.md.
 */

import { timingSafeEqual } from 'node:crypto';
import { NextResponse, after } from 'next/server';

import { logBroadcastAudit } from '@/lib/broadcasts/audit';
import {
  parseAudienceConfig,
  parseVariableMap,
} from '@/lib/broadcasts/parse-input';
import {
  DEFAULT_TIME_ZONE,
  describeSendWindow,
  isWithinSendWindow,
  nextWindowOpening,
  resolveTimeZone,
} from '@/lib/broadcasts/send-window';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  BroadcastError,
  deliverBroadcast,
} from '@/lib/whatsapp/broadcast-core';
import {
  SEND_BATCH_DELAY_MS,
  SEND_BATCH_SIZE,
  planAbTestBroadcast,
  planDashboardBroadcast,
} from '@/lib/whatsapp/broadcast-dispatch';
import { loadAccountQuota } from '@/lib/whatsapp/messaging-limit-server';

/** Mesmo teto da rota de envio: o fan-out roda em `after()`. */
export const maxDuration = 300;

/**
 * Quantas campanhas uma invocação assume.
 *
 * Baixo de propósito: cada uma pode ter milhares de destinatários e o
 * fan-out roda em `after()`, dentro do `maxDuration` desta requisição.
 * Um ping a cada 5 min drena 5 campanhas por ciclo, e o excedente espera
 * o próximo — que é melhor do que assumir 50 e ser cortado no meio da
 * décima.
 */
const MAX_PER_RUN = 5;

/**
 * Quanto tempo esperar antes de tentar de novo quando a cota da janela de
 * 24 h não cabe. A janela é DESLIZANTE: em uma hora ela já liberou parte
 * do consumo, então reagendar é a resposta certa — marcar como falho
 * jogaria a campanha fora por uma condição temporária.
 */
const QUOTA_RETRY_MS = 60 * 60 * 1000;

interface DueBroadcast {
  id: string;
  account_id: string;
  user_id: string;
  name: string;
  template_name: string;
  template_language: string;
  template_variables: unknown;
  audience_filter: unknown;
  header_media_url: string | null;
  scheduled_at: string;
  scheduled_timezone: string | null;
  window_override: boolean;
  /** Teste A/B (§6.6): fatia da audiência da variante A. */
  ab_split_percent: number | null;
}

/** A variante B de um agendamento A/B, quando existe. */
interface VariantRow {
  id: string;
  template_name: string;
  template_language: string;
  template_variables: unknown;
  header_media_url: string | null;
}

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }
  // Comparação de tempo constante, igual a /api/flows/cron: sem ela, um
  // atacante que alcança o endpoint recupera o segredo byte a byte pelos
  // deltas de tempo de resposta.
  const supplied = request.headers.get('x-cron-secret') ?? '';
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(expected);
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = supabaseAdmin();
  const now = new Date();

  const { data: due, error } = await admin
    .from('broadcasts')
    .select(
      'id, account_id, user_id, name, template_name, template_language, template_variables, audience_filter, header_media_url, scheduled_at, scheduled_timezone, window_override, ab_split_percent'
    )
    .eq('status', 'scheduled')
    // Decisão 4 do cabeçalho: variante B não é campanha por si só.
    .is('parent_broadcast_id', null)
    .lte('scheduled_at', now.toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(MAX_PER_RUN);

  if (error) {
    console.error('[broadcasts-cron] due scan failed:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!due || due.length === 0) {
    return NextResponse.json({ dispatched: 0, postponed: 0, failed: 0 });
  }

  let dispatched = 0;
  let postponed = 0;
  let failed = 0;

  for (const row of due as DueBroadcast[]) {
    const timeZone = resolveTimeZone(
      row.scheduled_timezone ?? DEFAULT_TIME_ZONE
    );

    // ── Janela de horário (decisão 2 do cabeçalho) ────────────────
    if (!row.window_override && !isWithinSendWindow(now, timeZone)) {
      const next = nextWindowOpening(now, timeZone);
      const { data: moved } = await admin
        .from('broadcasts')
        .update({ scheduled_at: next.toISOString() })
        .eq('id', row.id)
        // Precondição: se outra invocação já assumiu esta campanha, não
        // adiamos um disparo que está saindo.
        .eq('status', 'scheduled')
        .select('id')
        .maybeSingle();

      if (moved) {
        // A variante B (§6.6) acompanha o adiamento. Ela nunca é varrida,
        // então o horário dela é só o que a lista mostra — mas mostrar
        // duas metades do mesmo teste com horas diferentes seria pior do
        // que não mostrar hora nenhuma.
        await admin
          .from('broadcasts')
          .update({ scheduled_at: next.toISOString() })
          .eq('parent_broadcast_id', row.id)
          .eq('status', 'scheduled');

        postponed++;
        await logBroadcastAudit(admin, {
          accountId: row.account_id,
          event: 'postponed_window',
          broadcastId: row.id,
          broadcastName: row.name,
          templateName: row.template_name,
          scheduledAt: next.toISOString(),
          details: {
            was_due_at: row.scheduled_at,
            time_zone: timeZone,
            window: describeSendWindow(),
          },
        });
      }
      continue;
    }

    // ── Claim: o lock (decisão 3) ────────────────────────────────
    const { data: claim } = await admin
      .from('broadcasts')
      .update({ status: 'sending' })
      .eq('id', row.id)
      .eq('status', 'scheduled')
      .select('id')
      .maybeSingle();
    if (!claim) continue;

    // ── A variante B do teste A/B (§6.6) ─────────────────────────
    // Ela é travada pelo MESMO claim, e pelo mesmo motivo: o par sai
    // junto ou não sai. Se a linha sumiu (o usuário apagou só a B) ou
    // outra invocação a assumiu, o disparo degrada para uma campanha
    // comum — metade de um teste A/B, disparada sozinha, seria pior.
    let abVariant: VariantRow | null = null;
    const { data: variantRow } = await admin
      .from('broadcasts')
      .select(
        'id, template_name, template_language, template_variables, header_media_url'
      )
      .eq('parent_broadcast_id', row.id)
      .eq('status', 'scheduled')
      .maybeSingle();

    if (variantRow) {
      const { data: variantClaim } = await admin
        .from('broadcasts')
        .update({ status: 'sending' })
        .eq('id', variantRow.id)
        .eq('status', 'scheduled')
        .select('id')
        .maybeSingle();
      if (variantClaim) abVariant = variantRow as VariantRow;
    }

    /** Devolve o par inteiro a um estado, não só a linha da variante A. */
    async function updatePair(patch: Record<string, unknown>) {
      await admin.from('broadcasts').update(patch).eq('id', row.id);
      if (abVariant) {
        await admin.from('broadcasts').update(patch).eq('id', abVariant.id);
      }
    }

    const audience = parseAudienceConfig(row.audience_filter);
    const variables = parseVariableMap(row.template_variables);
    const variantVariables = abVariant
      ? parseVariableMap(abVariant.template_variables)
      : {};

    if (!audience || !variables || !variantVariables) {
      // Um `audience_filter` que não valida é um agendamento que nunca
      // vai poder sair. Marcar como falho é o que faz o usuário VER isso
      // na lista, em vez de a campanha ficar em `sending` para sempre.
      failed++;
      await updatePair({ status: 'failed' });
      await logBroadcastAudit(admin, {
        accountId: row.account_id,
        event: 'failed',
        broadcastId: row.id,
        broadcastName: row.name,
        templateName: row.template_name,
        details: { reason: 'malformed_audience_filter' },
      });
      continue;
    }

    try {
      const quota = await loadAccountQuota(admin, row.account_id);
      const batchLimit = quota.configured
        ? quota.snapshot.batchLimit
        : Number.POSITIVE_INFINITY;

      // ── Teste A/B agendado (§6.6) ──────────────────────────────
      // A divisão da audiência acontece AQUI, não no agendamento —
      // mesma razão da decisão 1 do cabeçalho: sortear ontem uma lista
      // que só existe hoje dividiria gente que já saiu e deixaria de
      // fora quem entrou.
      if (abVariant) {
        const ab = await planAbTestBroadcast(admin, {
          accountId: row.account_id,
          userId: row.user_id,
          batchLimit,
          adoptBroadcastId: row.id,
          adoptVariantBroadcastId: abVariant.id,
          splitPercent: row.ab_split_percent ?? undefined,
          input: {
            name: row.name,
            templateName: row.template_name,
            templateLanguage: row.template_language,
            audience,
            variables,
            headerMediaUrl: row.header_media_url ?? undefined,
          },
          variant: {
            templateName: abVariant.template_name,
            templateLanguage: abVariant.template_language,
            variables: variantVariables,
            headerMediaUrl: abVariant.header_media_url ?? undefined,
          },
        });

        dispatched++;
        await logBroadcastAudit(admin, {
          accountId: row.account_id,
          event: 'dispatched',
          broadcastId: ab.variantA.broadcastId,
          broadcastName: row.name,
          actorUserId: null,
          templateName: row.template_name,
          totalRecipients: ab.totalRecipients,
          excludedOptedOut: ab.excludedOptedOut,
          scheduledAt: row.scheduled_at,
          details: {
            audience_type: audience.type,
            scheduled_by: row.user_id,
            time_zone: timeZone,
            window_override: row.window_override,
            excluded_invalid_whatsapp: ab.excludedInvalidWhatsapp,
            ab_test: true,
            ab_split_percent: ab.splitPercent,
            ab_variant_broadcast_id: ab.variantB.broadcastId,
            ab_variant_template: abVariant.template_name,
            ab_accepted_a: ab.variantA.planned.length,
            ab_accepted_b: ab.variantB.planned.length,
            rejected: ab.variantA.rejected + ab.variantB.rejected,
          },
        });

        // Em sequência, pelo mesmo motivo da rota de envio: os dois
        // braços saem pelo mesmo número da Meta.
        after(async () => {
          await deliverBroadcast(admin, ab.variantA, {
            batchSize: SEND_BATCH_SIZE,
            delayMs: SEND_BATCH_DELAY_MS,
          });
          await deliverBroadcast(admin, ab.variantB, {
            batchSize: SEND_BATCH_SIZE,
            delayMs: SEND_BATCH_DELAY_MS,
          });
        });

        continue;
      }

      const plan = await planDashboardBroadcast(admin, {
        accountId: row.account_id,
        // Dono das linhas de contato que uma importação criar: quem
        // agendou, não quem (ninguém) apertou o botão agora.
        userId: row.user_id,
        batchLimit,
        // Adota a linha que acabamos de travar — sem isto o planner
        // criaria um broadcast NOVO e o agendamento ficaria pendurado em
        // `sending` para sempre, ao lado de uma cópia enviada.
        adoptBroadcastId: row.id,
        input: {
          name: row.name,
          templateName: row.template_name,
          templateLanguage: row.template_language,
          audience,
          variables,
          headerMediaUrl: row.header_media_url ?? undefined,
        },
      });

      dispatched++;
      await logBroadcastAudit(admin, {
        accountId: row.account_id,
        event: 'dispatched',
        broadcastId: plan.broadcastId,
        broadcastName: row.name,
        // NULL = sistema. O agendamento tem dono (`row.user_id`), mas o
        // disparo em si não foi ação de ninguém — e a trilha não deve
        // atribuir a um humano um clique que ele não deu.
        actorUserId: null,
        templateName: row.template_name,
        totalRecipients: plan.totalRecipients,
        excludedOptedOut: plan.excludedOptedOut,
        scheduledAt: row.scheduled_at,
        details: {
          audience_type: audience.type,
          accepted: plan.planned.length,
          rejected: plan.rejected,
          scheduled_by: row.user_id,
          time_zone: timeZone,
          window_override: row.window_override,
          excluded_invalid_whatsapp: plan.excludedInvalidWhatsapp,
        },
      });

      // Fan-out fora do caminho da resposta, como na rota de envio.
      after(() =>
        deliverBroadcast(admin, plan, {
          batchSize: SEND_BATCH_SIZE,
          delayMs: SEND_BATCH_DELAY_MS,
        })
      );
    } catch (err) {
      const code = err instanceof BroadcastError ? err.code : 'internal';

      // Cota é condição TEMPORÁRIA: a janela de 24 h desliza. Volta para
      // `scheduled` mais tarde em vez de jogar a campanha fora.
      if (code === 'quota_exceeded') {
        const retryAt = new Date(now.getTime() + QUOTA_RETRY_MS);
        // O par inteiro volta: a cota foi conferida sobre a soma dos dois
        // braços, então nenhum dos dois cabia.
        await updatePair({
          status: 'scheduled',
          scheduled_at: retryAt.toISOString(),
        });
        postponed++;
        await logBroadcastAudit(admin, {
          accountId: row.account_id,
          event: 'blocked_quota',
          broadcastId: row.id,
          broadcastName: row.name,
          templateName: row.template_name,
          scheduledAt: retryAt.toISOString(),
          details: {
            was_due_at: row.scheduled_at,
            message: err instanceof Error ? err.message : String(err),
          },
        });
        continue;
      }

      failed++;
      console.error('[broadcasts-cron] dispatch failed:', row.id, err);
      await updatePair({ status: 'failed' });
      await logBroadcastAudit(admin, {
        accountId: row.account_id,
        event: 'failed',
        broadcastId: row.id,
        broadcastName: row.name,
        templateName: row.template_name,
        details: {
          code,
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  return NextResponse.json({ dispatched, postponed, failed });
}
