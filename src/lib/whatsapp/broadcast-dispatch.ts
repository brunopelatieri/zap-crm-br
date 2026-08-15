// ============================================================
// Planejamento do disparo do PAINEL — SPEC 044 §6.1 e §6.6.
//
// O que mudou e por quê
//
//   Até aqui o disparo do wizard rodava no navegador: `use-broadcast-
//   sending.ts` percorria os lotes com `await fetch(...)` + `sleep(1000)`.
//   Fechar a aba matava a campanha no meio e deixava destinatários em
//   `pending` para sempre. Com audiências de milhares vindas de planilha
//   (fases 1–3 desta SPEC), isso deixou de ser risco teórico.
//
//   Este módulo é a metade "planejar" do mesmo par que a API pública já
//   usa: monta um `BroadcastPlan` e entrega para o `deliverBroadcast` de
//   `broadcast-core.ts` — o MESMO fan-out, com retry por variante de
//   telefone, reassinatura de header de mídia e contadores mantidos pelo
//   trigger do banco. Nada de motor de envio novo.
//
// Por que não reusar também o `createBroadcast`
//
//   `createBroadcast` resolve cada destinatário com `findOrCreateContact`,
//   uma ida ao banco POR TELEFONE — desenhado para uma requisição de API
//   com até 1000 números soltos. O painel chega aqui com contatos já
//   resolvidos em lote por `resolveAudienceContacts` (uma consulta
//   paginada), e converter contatos → telefones → contatos de novo seria
//   trocar uma consulta por N. O teto de 1000 daquela função é, pelo
//   mesmo motivo, um contrato da API pública e não um limite do motor.
//
// Ordem das etapas — e o que cada uma protege
//
//   1. config + template     → falha cedo, antes de criar qualquer linha
//   2. resolver audiência    → materializa contatos importados
//   3. opt-out (LGPD, §6.8)  → quem pediu para sair cai FORA da lista,
//                              antes de virar destinatário ou cota
//   4. validar telefones     → linhas inválidas viram `failed` visíveis
//   5. cota (autoritativa)   → §4.5, item 4: cliente adulterado não passa
//   6. persistir             → broadcast + destinatários
//   7. plano                 → pareia linha ↔ telefone/variáveis
//
// Por que o opt-out é REMOÇÃO e não uma linha `failed`
//
//   Telefone inválido vira destinatário `failed`: o usuário precisa ver
//   que aquele número da planilha dele não presta. Opt-out não — a
//   pessoa exerceu um direito, e materializá-la como "falha de entrega"
//   guardaria no banco o registro de uma tentativa de envio para quem
//   pediu para não receber. Ela sai da audiência antes de existir linha;
//   quantos saíram vai para a trilha (`broadcast_audit_log`).
//
// Sobre a forma deste arquivo (§6.6)
//
//   As etapas acima viraram funções nomeadas quando o teste A/B chegou.
//   Um teste A/B é a MESMA audiência resolvida uma vez e depois dividida
//   entre dois templates: reimplementar as etapas 1–5 numa segunda
//   função seria criar duas fontes de verdade para "quem pode receber" —
//   e a primeira divergência apareceria como o braço A excluindo um
//   opt-out que o braço B alcançou. `planDashboardBroadcast` e
//   `planAbTestBroadcast` são duas composições das mesmas peças.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  clampSplitPercent,
  splitInTwo,
  AB_DEFAULT_SPLIT_PERCENT,
} from '@/lib/broadcasts/ab-test';
import { resolveAudienceContacts } from '@/lib/audience/resolve';
import type { AudienceConfig } from '@/lib/audience/estimate';
import { excludesOptedOut, isOptedOut } from '@/lib/contacts/consent';
import { isWhatsappInvalid } from '@/lib/contacts/whatsapp-status';
import { decrypt } from '@/lib/whatsapp/encryption';
import { isMediaHeaderTemplate } from '@/lib/whatsapp/header-media';
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import { isValidE164, sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import {
  BroadcastError,
  assertAccountCanBroadcast,
  type BroadcastPlan,
} from '@/lib/whatsapp/broadcast-core';
import {
  fetchCustomValueIndex,
  resolveVariables,
  usesCustomFields,
  type CustomValueIndex,
  type VariableMapping,
} from '@/lib/whatsapp/broadcast-variables';
import type { Contact, MessageTemplate } from '@/types';

/**
 * Teto absoluto de destinatários por disparo do painel.
 *
 * Casa com o teto de linhas do parser de planilha (§3.4): uma audiência
 * maior do que isto não consegue nem ser importada, então este número é
 * uma rede de segurança contra um cliente adulterado, não uma regra de
 * produto. A regra de produto é a cota de 24 h da Meta, aplicada logo
 * abaixo.
 */
export const MAX_DASHBOARD_RECIPIENTS = 50_000;

/**
 * Ritmo do fan-out. 10 envios por segundo é o mesmo par que o laço do
 * navegador usava e mantém a campanha confortavelmente abaixo do limite
 * de taxa por número da Meta.
 */
export const SEND_BATCH_SIZE = 10;
export const SEND_BATCH_DELAY_MS = 1000;

/** Linhas por INSERT de destinatários. */
const INSERT_CHUNK = 200;

const INVALID_PHONE_MESSAGE = 'Invalid phone number format';

export interface DashboardBroadcastInput {
  name: string;
  templateName: string;
  templateLanguage: string;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  /**
   * URL de mídia para header IMAGE/VIDEO/DOCUMENT, escolhida no passo 3.
   * Sobrepõe a URL guardada no template.
   */
  headerMediaUrl?: string;
}

/**
 * A metade do teste A/B que difere entre os braços (§6.6): template,
 * variáveis e mídia de header. Nome, audiência e agendamento pertencem
 * ao teste inteiro, não a um braço — por isso não estão aqui.
 */
export interface AbVariantInput {
  templateName: string;
  templateLanguage: string;
  variables: Record<string, VariableMapping>;
  headerMediaUrl?: string;
}

/** O plano de UM braço: o que `deliverBroadcast` consome. */
export interface ArmPlan extends BroadcastPlan {
  /** Linhas criadas em `broadcast_recipients` — inclui as inválidas. */
  totalRecipients: number;
}

export interface DashboardBroadcastPlan extends ArmPlan {
  /**
   * Contatos retirados da audiência por estarem em `opted_out` (§6.8).
   * Não viraram destinatário nem consumiram cota. Vai para a trilha.
   */
  excludedOptedOut: number;
  /**
   * Contatos retirados da audiência por `whatsapp_status = 'invalid'`
   * (§6.4) — número morto. Mesmo tratamento do opt-out: não vira
   * destinatário, não consome cota, vai para a trilha.
   */
  excludedInvalidWhatsapp: number;
}

export interface PlanDashboardBroadcastParams {
  accountId: string;
  userId: string;
  input: DashboardBroadcastInput;
  /**
   * Máximo de contatos que o tier da conta permite em UM disparo,
   * vindo de `loadAccountQuota`. `Infinity` para TIER_UNLIMITED.
   */
  batchLimit: number;
  /**
   * Id de um `broadcasts` que já existe e deve ser ADOTADO em vez de um
   * INSERT novo — é assim que o cron da §6.3 retoma uma campanha
   * `scheduled` que ele acabou de travar em `sending`, sem criar uma
   * segunda linha ao lado do agendamento que o usuário vê na lista.
   *
   * Quando presente, o UPDATE casa apenas por id: quem garantiu o estado
   * da linha foi o `claim` do cron. Sem ele, o ramo `staged` continua
   * adotando o rascunho pelo `draftId`, exigindo `status = 'draft'`.
   */
  adoptBroadcastId?: string;
}

// ============================================================
// ETAPAS COMPARTILHADAS
// ============================================================

interface SendContext {
  phoneNumberId: string;
  accessToken: string;
  /** A linha local do template, ou `null` se ela não existe por aqui. */
  templateRow: MessageTemplate | null;
  /** A mesma linha com a mídia do passo 3 injetada, quando cabe. */
  templateForSend: MessageTemplate | null;
  /** URL já normalizada — é ela que vai para `broadcasts`. */
  headerMediaUrl: string;
}

/** WhatsApp configurado + token decifrado. Falha cedo, antes de tudo. */
async function loadWhatsappConfig(
  db: SupabaseClient,
  accountId: string
): Promise<{ phoneNumberId: string; accessToken: string }> {
  // SPEC 049 §5.3 — before the generic "not configured", tell a QR-only
  // account the real reason: broadcast just isn't available to them.
  await assertAccountCanBroadcast(db, accountId);

  const { data: config, error } = await db
    .from('whatsapp_config')
    .select('phone_number_id, access_token')
    .eq('account_id', accountId)
    .maybeSingle();

  if (error || !config) {
    throw new BroadcastError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }

  return {
    phoneNumberId: config.phone_number_id,
    accessToken: decrypt(config.access_token),
  };
}

/**
 * Lê a linha local do template e injeta a mídia escolhida no passo 3.
 *
 * A URL entra como se fosse a URL guardada do template. Assim o
 * `createHeaderMediaResolver` do fan-out continua podendo CACHEAR a
 * assinatura e reassinar a cada poucos minutos — passá-la como override
 * por destinatário faria uma assinatura nova para cada pessoa da
 * audiência.
 */
async function loadTemplateForSend(
  db: SupabaseClient,
  accountId: string,
  templateName: string,
  templateLanguage: string,
  rawHeaderMediaUrl: string | undefined
): Promise<Omit<SendContext, 'phoneNumberId' | 'accessToken'>> {
  const { data: rawTemplateRow } = await db
    .from('message_templates')
    .select('*')
    .eq('account_id', accountId)
    .eq('name', templateName)
    .eq('language', templateLanguage)
    .maybeSingle();

  if (rawTemplateRow && !isMessageTemplate(rawTemplateRow)) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
      500
    );
  }
  const templateRow = (rawTemplateRow as MessageTemplate | null) ?? null;

  const headerMediaUrl = rawHeaderMediaUrl?.trim() ?? '';
  const templateForSend =
    templateRow && headerMediaUrl && isMediaHeaderTemplate(templateRow)
      ? { ...templateRow, header_media_url: headerMediaUrl }
      : templateRow;

  return { templateRow, templateForSend, headerMediaUrl };
}

interface ResolvedAudience {
  contacts: Contact[];
  excludedOptedOut: number;
  excludedInvalidWhatsapp: number;
}

/**
 * Etapas 2–3b: resolve a audiência e aplica as duas exclusões que
 * acontecem ANTES de existir destinatário.
 *
 * Este é o ponto de imposição de verdade. Os contadores da triagem e a
 * estimativa do wizard são a mesma regra mostrada ao usuário; um cliente
 * adulterado passa por cima deles, e não por cima daqui.
 */
async function resolveSendableAudience(
  db: SupabaseClient,
  {
    accountId,
    userId,
    audience,
    templateCategory,
  }: {
    accountId: string;
    userId: string;
    audience: AudienceConfig;
    /** Categoria do template — decide se o opt-out se aplica (§6.8). */
    templateCategory: string | null;
  }
): Promise<ResolvedAudience> {
  const resolved = await resolveAudienceContacts(db, {
    accountId,
    userId,
    audience,
  });

  // ── Opt-out (LGPD, §6.8) ───────────────────────────────────────
  // A categoria do template decide: marketing exclui quem pediu para
  // sair; Utility/Authentication alcança (ver `excludesOptedOut`). Sem
  // linha de template local a categoria é desconhecida e a regra é a
  // conservadora — não mandar.
  const applyOptOut = excludesOptedOut(templateCategory);
  const afterOptOut = applyOptOut
    ? resolved.filter((c) => !isOptedOut(c))
    : resolved;
  const excludedOptedOut = resolved.length - afterOptOut.length;

  // ── Número morto (§6.4) ─────────────────────────────────────────
  // Ao contrário do opt-out, não depende da categoria do template: um
  // número que a Meta já rejeitou ou que falhou duas vezes seguidas não
  // vale a pena tentar de novo por nenhum motivo. Mesmo tratamento —
  // sai da audiência ANTES de virar destinatário ou consumir cota, em
  // vez de nascer `failed` e inflar `total_recipients` (a distorção que
  // a §6.4 existe para evitar).
  const contacts = afterOptOut.filter((c) => !isWhatsappInvalid(c));
  const excludedInvalidWhatsapp = afterOptOut.length - contacts.length;

  if (contacts.length === 0) {
    // Uma audiência que sumiu INTEIRA por opt-out ou número morto não é
    // "audiência vazia": o usuário selecionou pessoas e nenhuma pode
    // receber. O código próprio é o que deixa a UI dizer isso em vez de
    // mandar ele conferir um filtro que está certo.
    const code =
      excludedOptedOut > 0
        ? 'all_opted_out'
        : excludedInvalidWhatsapp > 0
          ? 'all_whatsapp_invalid'
          : 'empty_audience';
    const message =
      excludedOptedOut > 0
        ? `Every contact in this audience has opted out of marketing (${excludedOptedOut}).`
        : excludedInvalidWhatsapp > 0
          ? `Every contact in this audience has a dead WhatsApp number (${excludedInvalidWhatsapp}).`
          : 'No contacts found for this audience.';
    throw new BroadcastError(code, message, 400);
  }
  if (contacts.length > MAX_DASHBOARD_RECIPIENTS) {
    throw new BroadcastError(
      'too_many_recipients',
      `A broadcast is capped at ${MAX_DASHBOARD_RECIPIENTS} recipients; split this audience.`,
      400
    );
  }

  return { contacts, excludedOptedOut, excludedInvalidWhatsapp };
}

/** Um contato já avaliado: com telefone utilizável, ou sem. */
interface EvaluatedContact {
  contact: Contact;
  /** `null` = não passou no E.164; a linha nasce `failed` com o motivo. */
  phone: string | null;
}

/**
 * Etapa 4. Sanitiza antes da cota: um número inválido nunca vira
 * conversa na Meta, então não deve consumir cota nem bloquear um disparo
 * que caberia. As linhas continuam sendo criadas — aparecem na tela de
 * detalhe como `failed` com o motivo, em vez de sumirem sem explicação.
 */
function evaluatePhones(contacts: Contact[]): EvaluatedContact[] {
  return contacts.map((contact) => {
    const phone = sanitizePhoneForMeta(contact.phone ?? '');
    return { contact, phone: isValidE164(phone) ? phone : null };
  });
}

function countSendable(evaluated: EvaluatedContact[]): number {
  return evaluated.reduce((n, e) => (e.phone ? n + 1 : n), 0);
}

/**
 * Etapa 5 — o controle, não a dica.
 *
 * Os avisos do wizard são UX; um cliente adulterado passa por cima deles
 * sem esforço. Este teste é o que efetivamente protege o número da conta
 * (§4.5, item 4).
 */
function assertFitsQuota(sendable: number, batchLimit: number): void {
  if (Number.isFinite(batchLimit) && sendable > batchLimit) {
    throw new BroadcastError(
      'quota_exceeded',
      `This broadcast targets ${sendable} contacts but the account's messaging tier allows at most ${batchLimit} per broadcast.`,
      409
    );
  }
}

function audienceFilterOf(audience: AudienceConfig) {
  return {
    type: audience.type,
    tagIds: audience.tagIds,
    customField: audience.customField,
    excludeTagIds: audience.excludeTagIds,
    draftId: audience.draftId,
  };
}

interface MaterializeArmParams {
  accountId: string;
  userId: string;
  name: string;
  templateName: string;
  templateLanguage: string;
  variables: Record<string, VariableMapping>;
  context: SendContext;
  audience: AudienceConfig;
  /** Os contatos DESTE braço, já avaliados. */
  members: EvaluatedContact[];
  /** Ver `PlanDashboardBroadcastParams.adoptBroadcastId`. */
  adoptBroadcastId?: string;
  /** Rótulo do braço no teste A/B (§6.6). Ausente = campanha comum. */
  variantLabel?: 'A' | 'B';
  /** Só na variante B: aponta para a linha da variante A. */
  parentBroadcastId?: string;
  /** Só na variante A: a fatia da audiência que coube a ela. */
  abSplitPercent?: number;
}

/**
 * Etapas 6–8: persiste o braço (broadcast + destinatários) e devolve o
 * plano pareando cada linha com telefone e variáveis.
 *
 * Duas exceções ao INSERT, que caem no mesmo UPDATE:
 *
 *   • `staged` — o `broadcasts` já existe (criado pelo stage, §3.3) com
 *     `status = 'draft'`. Enviá-lo é um UPDATE desse mesmo rascunho, o
 *     que faz o draftId da triagem virar o id de verdade do disparo em
 *     vez de deixar um rascunho órfão ao lado de um broadcast novo.
 *   • `adoptBroadcastId` — o cron da §6.3 já travou a linha `scheduled`
 *     em `sending` e passa o id dela. Criar uma linha nova aqui daria
 *     ao usuário duas campanhas para o mesmo agendamento.
 */
async function materializeArm(
  db: SupabaseClient,
  {
    accountId,
    userId,
    name,
    templateName,
    templateLanguage,
    variables,
    context,
    audience,
    members,
    adoptBroadcastId,
    variantLabel,
    parentBroadcastId,
    abSplitPercent,
  }: MaterializeArmParams
): Promise<ArmPlan> {
  const contacts = members.map((m) => m.contact);
  const sendable = members.filter(
    (m): m is EvaluatedContact & { phone: string } => m.phone !== null
  );
  const invalidContactIds = members
    .filter((m) => m.phone === null)
    .map((m) => m.contact.id);

  // ── Variáveis ──────────────────────────────────────────────────
  // A leitura em lote de campos personalizados só acontece se o
  // mapeamento realmente usar algum — o caso comum (só estáticos e
  // campos nativos) não paga nada por ela.
  const customValueIndex: CustomValueIndex = usesCustomFields(variables)
    ? await fetchCustomValueIndex(
        db,
        sendable.map((s) => s.contact.id)
      )
    : new Map();

  // ── Persistir ──────────────────────────────────────────────────
  // Os contadores por status são do trigger agregador (migrações
  // 003/005), derivados das linhas de `broadcast_recipients`. Semear um
  // valor aqui seria sobrescrito na primeira mudança de destinatário.
  const row = {
    name,
    template_name: templateName,
    template_language: templateLanguage,
    template_variables: variables,
    audience_filter: audienceFilterOf(audience),
    // Persistido também no disparo imediato: é o que permite a um
    // futuro cron de drenagem (§12, item 8) retomar uma campanha
    // cortada no meio sem perder a mídia do header.
    header_media_url: context.headerMediaUrl || null,
    status: 'sending' as const,
    total_recipients: contacts.length,
  };

  // As colunas do §6.6 só entram quando há teste — uma campanha comum
  // não deve carregar `variant_label: null` explícito no UPDATE de
  // adoção (o CHECK da 051 aceita, mas o diff da linha mentiria sobre o
  // que o disparo decidiu).
  const abColumns = variantLabel
    ? {
        variant_label: variantLabel,
        parent_broadcast_id: parentBroadcastId ?? null,
        ab_split_percent: abSplitPercent ?? null,
      }
    : {};

  let broadcastId: string;

  const adoptId =
    adoptBroadcastId ??
    (audience.type === 'staged' ? audience.draftId : undefined);

  if (audience.type === 'staged' && !adoptId) {
    throw new BroadcastError(
      'bad_request',
      "Staged audience is missing 'draftId'.",
      400
    );
  }

  if (adoptId) {
    let update = db
      .from('broadcasts')
      .update({ ...row, ...abColumns })
      .eq('id', adoptId);

    // Sem `adoptBroadcastId`, a precondição de estado é parte da defesa:
    // um rascunho já enviado não pode ser reenviado por uma segunda aba.
    // COM ele, quem já garantiu a transição de estado (e a exclusividade)
    // foi o claim do cron — repetir `status = 'draft'` aqui faria o
    // UPDATE não casar linha nenhuma e o disparo agendado "desaparecer".
    if (!adoptBroadcastId) update = update.eq('status', 'draft');

    const { data: updated, error: updateError } = await update
      .select('id')
      .single();

    // RLS já escopa por conta; um id de outra conta ou um rascunho já
    // enviado simplesmente não casa nenhuma linha, e cai aqui — nunca
    // num "sucesso" silencioso sobre o registro errado.
    if (updateError || !updated) {
      throw new BroadcastError(
        'draft_not_found',
        'This draft no longer exists or was already sent.',
        404
      );
    }
    broadcastId = updated.id as string;

    // As linhas staged já cumpriram o papel: viraram `contacts` e o
    // `audience_filter` acima. Deixá-las para trás só confundiria quem
    // reabrisse a triagem de um disparo já enviado. Falha aqui é
    // cosmética — os destinatários de verdade já existem — então só loga.
    // Rodar isto também no caminho do cron é inofensivo: um agendamento
    // sem staging simplesmente não tem linha para apagar.
    const { error: purgeError } = await db
      .from('broadcast_audience_staging')
      .delete()
      .eq('broadcast_id', broadcastId);
    if (purgeError) {
      console.error(
        '[broadcast-dispatch] purge staging rows error:',
        purgeError
      );
    }
  } else {
    const { data: broadcast, error: broadcastError } = await db
      .from('broadcasts')
      .insert({
        user_id: userId,
        account_id: accountId,
        ...row,
        ...abColumns,
      })
      .select('id')
      .single();

    if (broadcastError || !broadcast) {
      console.error(
        '[broadcast-dispatch] create broadcast error:',
        broadcastError
      );
      throw new BroadcastError('internal', 'Failed to create broadcast', 500);
    }
    broadcastId = broadcast.id as string;
  }

  const rowIdByContact = new Map<string, string>();
  for (let i = 0; i < contacts.length; i += INSERT_CHUNK) {
    const chunk = contacts.slice(i, i + INSERT_CHUNK).map((c) => ({
      broadcast_id: broadcastId,
      contact_id: c.id,
      status: 'pending' as const,
    }));

    const { data: inserted, error: recipientError } = await db
      .from('broadcast_recipients')
      .insert(chunk)
      .select('id, contact_id');

    if (recipientError || !inserted) {
      // Rodar com um conjunto incompleto de destinatários é pior do que
      // não rodar: os webhooks de status não achariam as linhas
      // faltantes e os contadores agregados ficariam à deriva. Marca o
      // disparo como falho para o usuário ver o problema, e aborta.
      await db
        .from('broadcasts')
        .update({ status: 'failed' })
        .eq('id', broadcastId);
      console.error(
        '[broadcast-dispatch] create recipients error:',
        recipientError
      );
      throw new BroadcastError('internal', 'Failed to create broadcast', 500);
    }

    for (const r of inserted) {
      rowIdByContact.set(r.contact_id as string, r.id as string);
    }
  }

  // Telefone inválido não vai à Meta: a linha já nasce terminal, com o
  // motivo legível na tela de detalhe.
  if (invalidContactIds.length > 0) {
    const invalidRowIds = invalidContactIds
      .map((id) => rowIdByContact.get(id))
      .filter((id): id is string => Boolean(id));

    for (let i = 0; i < invalidRowIds.length; i += INSERT_CHUNK) {
      const { error } = await db
        .from('broadcast_recipients')
        .update({ status: 'failed', error_message: INVALID_PHONE_MESSAGE })
        .in('id', invalidRowIds.slice(i, i + INSERT_CHUNK));
      if (error) {
        console.error('[broadcast-dispatch] mark invalid error:', error);
      }
    }
  }

  const planned = sendable
    .map(({ contact, phone }) => {
      const recipientRowId = rowIdByContact.get(contact.id);
      if (!recipientRowId) return null;
      return {
        recipientRowId,
        contactId: contact.id,
        phone,
        params: resolveVariables(
          variables,
          contact,
          customValueIndex.get(contact.id)
        ),
      };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);

  return {
    broadcastId,
    accountId,
    templateName,
    templateLanguage,
    phoneNumberId: context.phoneNumberId,
    accessToken: context.accessToken,
    templateRow: context.templateForSend,
    planned,
    rejected: invalidContactIds.length,
    totalRecipients: contacts.length,
  };
}

// ============================================================
// DISPARO DE UM TEMPLATE SÓ (§6.1)
// ============================================================

/**
 * Valida, resolve a audiência e persiste o disparo. Nada é enviado
 * aqui — o retorno vai para `deliverBroadcast`, tipicamente dentro de
 * um `after()`.
 *
 * Lança {@link BroadcastError}, que a rota mapeia para status + código.
 */
export async function planDashboardBroadcast(
  db: SupabaseClient,
  {
    accountId,
    userId,
    input,
    batchLimit,
    adoptBroadcastId,
  }: PlanDashboardBroadcastParams
): Promise<DashboardBroadcastPlan> {
  const templateLanguage = input.templateLanguage || 'en_US';

  const { phoneNumberId, accessToken } = await loadWhatsappConfig(
    db,
    accountId
  );
  const template = await loadTemplateForSend(
    db,
    accountId,
    input.templateName,
    templateLanguage,
    input.headerMediaUrl
  );
  const context: SendContext = { phoneNumberId, accessToken, ...template };

  const { contacts, excludedOptedOut, excludedInvalidWhatsapp } =
    await resolveSendableAudience(db, {
      accountId,
      userId,
      audience: input.audience,
      templateCategory: context.templateRow?.category ?? null,
    });

  const evaluated = evaluatePhones(contacts);
  const sendable = countSendable(evaluated);

  if (sendable === 0) {
    throw new BroadcastError(
      'empty_audience',
      'No contacts in this audience have a valid phone number.',
      400
    );
  }

  assertFitsQuota(sendable, batchLimit);

  const arm = await materializeArm(db, {
    accountId,
    userId,
    name: input.name,
    templateName: input.templateName,
    templateLanguage,
    variables: input.variables,
    context,
    audience: input.audience,
    members: evaluated,
    adoptBroadcastId,
  });

  return { ...arm, excludedOptedOut, excludedInvalidWhatsapp };
}

// ============================================================
// TESTE A/B (SPEC 044 §6.6)
// ============================================================

export interface PlanAbTestParams {
  accountId: string;
  userId: string;
  /** A variante A: nome da campanha, audiência e o primeiro template. */
  input: DashboardBroadcastInput;
  /** O segundo template — e o mapeamento de variáveis DELE. */
  variant: AbVariantInput;
  /** Fatia da audiência sorteada para A (1–99). Padrão 50. */
  splitPercent?: number;
  /** Máximo de contatos por disparo — ver `PlanDashboardBroadcastParams`. */
  batchLimit: number;
  /** Linha a adotar para a variante A (rascunho staged ou agendamento). */
  adoptBroadcastId?: string;
  /** Linha a adotar para a variante B — só o cron usa (§6.3 + §6.6). */
  adoptVariantBroadcastId?: string;
  /** Injetável para o teste fixar o sorteio; produção usa `Math.random`. */
  rng?: () => number;
}

export interface AbTestPlan {
  variantA: ArmPlan;
  variantB: ArmPlan;
  /** Soma dos dois braços — é ela que vai para a trilha. */
  totalRecipients: number;
  excludedOptedOut: number;
  excludedInvalidWhatsapp: number;
  /** O percentual efetivamente usado, já normalizado. */
  splitPercent: number;
}

/**
 * Planeja um teste A/B: uma audiência, dois templates, dois braços
 * sorteados.
 *
 * Quatro decisões que o desenho impõe
 *
 *   1. **A audiência é resolvida UMA vez.** Resolver duas vezes (uma por
 *      braço) deixaria os dois conjuntos divergirem entre uma consulta e
 *      a outra — um contato criado no meio entra num braço só, e o
 *      "teste" passa a comparar audiências diferentes.
 *   2. **As duas categorias precisam bater.** Marketing exclui quem
 *      pediu opt-out; Utility não. Um teste entre categorias diferentes
 *      compararia dois públicos, não dois textos — e o resultado
 *      pareceria estatística.
 *   3. **A cota é conferida sobre o TOTAL.** Os dois braços saem na
 *      mesma janela de 24 h; conferir por braço deixaria passar um teste
 *      que estoura a cota da conta na soma.
 *   4. **O braço B é sempre uma linha NOVA**, exceto quando o cron passa
 *      `adoptVariantBroadcastId` — porque aí a linha já existe desde o
 *      agendamento e adotá-la é o que evita uma terceira campanha
 *      pendurada.
 */
export async function planAbTestBroadcast(
  db: SupabaseClient,
  {
    accountId,
    userId,
    input,
    variant,
    splitPercent = AB_DEFAULT_SPLIT_PERCENT,
    batchLimit,
    adoptBroadcastId,
    adoptVariantBroadcastId,
    rng,
  }: PlanAbTestParams
): Promise<AbTestPlan> {
  const languageA = input.templateLanguage || 'en_US';
  const languageB = variant.templateLanguage || 'en_US';

  if (input.templateName === variant.templateName && languageA === languageB) {
    throw new BroadcastError(
      'ab_same_template',
      'An A/B test needs two different templates.',
      400
    );
  }

  const { phoneNumberId, accessToken } = await loadWhatsappConfig(
    db,
    accountId
  );

  const templateA = await loadTemplateForSend(
    db,
    accountId,
    input.templateName,
    languageA,
    input.headerMediaUrl
  );
  const templateB = await loadTemplateForSend(
    db,
    accountId,
    variant.templateName,
    languageB,
    variant.headerMediaUrl
  );

  // Decisão 2. Só compara categorias quando as duas linhas existem
  // localmente: uma categoria desconhecida já cai na regra conservadora
  // do opt-out, e recusar por "não sei" bloquearia um teste legítimo de
  // uma conta que ainda não sincronizou os templates.
  const categoryA = templateA.templateRow?.category ?? null;
  const categoryB = templateB.templateRow?.category ?? null;
  if (categoryA && categoryB && categoryA !== categoryB) {
    throw new BroadcastError(
      'ab_category_mismatch',
      `Both variants must share a template category (got ${categoryA} and ${categoryB}).`,
      400
    );
  }

  const contextA: SendContext = { phoneNumberId, accessToken, ...templateA };
  const contextB: SendContext = { phoneNumberId, accessToken, ...templateB };

  const { contacts, excludedOptedOut, excludedInvalidWhatsapp } =
    await resolveSendableAudience(db, {
      accountId,
      userId,
      audience: input.audience,
      templateCategory: categoryA ?? categoryB,
    });

  const evaluated = evaluatePhones(contacts);
  const sendable = evaluated.filter((e) => e.phone !== null);
  const unsendable = evaluated.filter((e) => e.phone === null);

  if (sendable.length < 2) {
    // Um braço vazio não é um teste, e o usuário precisa saber disso
    // ANTES de gastar a audiência — não descobrir na tela de comparação.
    throw new BroadcastError(
      'ab_audience_too_small',
      'An A/B test needs at least two contacts with a valid phone number.',
      400
    );
  }

  assertFitsQuota(sendable.length, batchLimit);

  // O sorteio vale sobre quem PODE receber; os números inválidos são
  // repartidos na mesma proporção só para que cada braço leve as próprias
  // linhas `failed`. Sortear os dois grupos juntos deixaria os tamanhos
  // dos braços à mercê de quantos números ruins caíram de cada lado.
  const percent = clampSplitPercent(splitPercent);
  const sendableSplit = splitInTwo(sendable, percent, rng);
  const unsendableSplit = splitInTwo(unsendable, percent, rng);

  const armAMembers = [...sendableSplit.a, ...unsendableSplit.a];
  const armBMembers = [...sendableSplit.b, ...unsendableSplit.b];

  const variantA = await materializeArm(db, {
    accountId,
    userId,
    name: input.name,
    templateName: input.templateName,
    templateLanguage: languageA,
    variables: input.variables,
    context: contextA,
    audience: input.audience,
    members: armAMembers,
    adoptBroadcastId,
    variantLabel: 'A',
    abSplitPercent: percent,
  });

  const variantB = await materializeArm(db, {
    accountId,
    userId,
    name: input.name,
    templateName: variant.templateName,
    templateLanguage: languageB,
    variables: variant.variables,
    context: contextB,
    audience: audienceForVariantB(input.audience),
    members: armBMembers,
    adoptBroadcastId: adoptVariantBroadcastId,
    variantLabel: 'B',
    parentBroadcastId: variantA.broadcastId,
  });

  return {
    variantA,
    variantB,
    totalRecipients: variantA.totalRecipients + variantB.totalRecipients,
    excludedOptedOut,
    excludedInvalidWhatsapp,
    splitPercent: percent,
  };
}

/**
 * A audiência como a variante B a registra.
 *
 * `staged` significa "esta linha É o rascunho da triagem" — e o rascunho
 * é a variante A. Guardar `staged` + `draftId` em B faria
 * `materializeArm` tentar adotar o mesmo rascunho duas vezes; o segundo
 * UPDATE não casaria nada (a linha já saiu de `draft`) e o teste
 * morreria com `draft_not_found`. Sem o `draftId`, o filtro registra o
 * que aquela linha de fato é: um recorte já materializado.
 */
function audienceForVariantB(audience: AudienceConfig): AudienceConfig {
  if (audience.type !== 'staged') return audience;
  return { type: 'all', excludeTagIds: audience.excludeTagIds };
}

// ============================================================
// AGENDAMENTO (SPEC 044 §6.3)
// ============================================================

export interface ScheduleDashboardBroadcastParams {
  accountId: string;
  userId: string;
  input: DashboardBroadcastInput;
  /** Instante do disparo, já validado como futuro pela rota. */
  scheduledAt: Date;
  /** Fuso IANA em que o horário foi escolhido. */
  timeZone: string;
  /** O usuário aceitou disparar fora da janela permitida. */
  windowOverride: boolean;
  /**
   * Teste A/B agendado (§6.6): a segunda variante nasce junto, também em
   * `scheduled`, já apontando para a primeira. Quem divide a audiência é
   * o cron, na hora do envio — pelo mesmo motivo que ele resolve a
   * audiência lá e não aqui.
   */
  variant?: AbVariantInput;
  splitPercent?: number;
}

export interface ScheduledBroadcast {
  broadcastId: string;
  scheduledAt: string;
  /** Id da variante B, quando o agendamento é um teste A/B. */
  variantBroadcastId?: string;
}

/**
 * Persiste um disparo AGENDADO. Não resolve audiência, não cria
 * destinatário, não toca na cota.
 *
 * Por que quase nada acontece aqui
 *
 *   Um agendamento é uma INTENÇÃO, não um disparo adiado. Resolver a
 *   audiência agora congelaria a lista: quem entrar na etiqueta amanhã
 *   ficaria de fora, quem pedir opt-out hoje à noite receberia de manhã,
 *   e a cota conferida agora não diz nada sobre a janela de 24 h que vai
 *   valer na hora do envio. Tudo isso é decidido pelo cron, no momento
 *   em que a campanha realmente sai — pelo MESMO
 *   `planDashboardBroadcast` do disparo imediato.
 *
 *   O que é validado agora é só o que já estaria errado agora: WhatsApp
 *   configurado e template existente. Falhar hoje é infinitamente melhor
 *   do que falhar às 9h de sábado sem ninguém olhando.
 */
export async function scheduleDashboardBroadcast(
  db: SupabaseClient,
  {
    accountId,
    userId,
    input,
    scheduledAt,
    timeZone,
    windowOverride,
    variant,
    splitPercent,
  }: ScheduleDashboardBroadcastParams
): Promise<ScheduledBroadcast> {
  const templateLanguage = input.templateLanguage || 'en_US';

  // SPEC 049 §5.3 — same guard as the immediate-send path (loadWhatsappConfig
  // above); a scheduled broadcast on a QR-only account must fail with the
  // same real reason, not "not configured".
  await assertAccountCanBroadcast(db, accountId);

  const { data: config } = await db
    .from('whatsapp_config')
    .select('phone_number_id')
    .eq('account_id', accountId)
    .maybeSingle();

  if (!config) {
    throw new BroadcastError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }

  await assertTemplateExists(
    db,
    accountId,
    input.templateName,
    templateLanguage
  );

  const percent = variant
    ? clampSplitPercent(splitPercent ?? AB_DEFAULT_SPLIT_PERCENT)
    : null;
  const variantLanguage = variant?.templateLanguage || 'en_US';

  if (variant) {
    if (
      variant.templateName === input.templateName &&
      variantLanguage === templateLanguage
    ) {
      throw new BroadcastError(
        'ab_same_template',
        'An A/B test needs two different templates.',
        400
      );
    }
    await assertTemplateExists(
      db,
      accountId,
      variant.templateName,
      variantLanguage
    );
  }

  const row = {
    name: input.name,
    template_name: input.templateName,
    template_language: templateLanguage,
    template_variables: input.variables,
    audience_filter: {
      type: input.audience.type,
      tagIds: input.audience.tagIds,
      customField: input.audience.customField,
      csvContacts: input.audience.csvContacts,
      excludeTagIds: input.audience.excludeTagIds,
      draftId: input.audience.draftId,
    },
    // `header_media_url` é coluna nova (048). Sem ela, um agendamento com
    // header de imagem perderia a mídia escolhida no passo 3 entre o
    // agendamento e o envio — é a lacuna que a §12 item 8 registrava.
    header_media_url: input.headerMediaUrl?.trim() || null,
    scheduled_at: scheduledAt.toISOString(),
    scheduled_timezone: timeZone,
    window_override: windowOverride,
    status: 'scheduled' as const,
    ...(variant
      ? { variant_label: 'A' as const, ab_split_percent: percent }
      : {}),
  };

  let broadcastId: string;
  let storedScheduledAt: string;

  // `staged` adota o rascunho da triagem, exatamente como o envio
  // imediato: o agendamento É aquele rascunho, com hora marcada. As
  // linhas de `broadcast_audience_staging` ficam onde estão — é delas que
  // o cron vai ler a audiência, e apagá-las agora esvaziaria o disparo.
  if (input.audience.type === 'staged') {
    const draftId = input.audience.draftId;
    if (!draftId) {
      throw new BroadcastError(
        'bad_request',
        "Staged audience is missing 'draftId'.",
        400
      );
    }

    const { data: updated, error } = await db
      .from('broadcasts')
      .update(row)
      .eq('id', draftId)
      .eq('status', 'draft')
      .select('id, scheduled_at')
      .single();

    if (error || !updated) {
      throw new BroadcastError(
        'draft_not_found',
        'This draft no longer exists or was already sent.',
        404
      );
    }
    broadcastId = updated.id as string;
    storedScheduledAt = updated.scheduled_at as string;
  } else {
    const { data: inserted, error } = await db
      .from('broadcasts')
      .insert({ ...row, user_id: userId, account_id: accountId })
      .select('id, scheduled_at')
      .single();

    if (error || !inserted) {
      console.error('[broadcast-dispatch] schedule broadcast error:', error);
      throw new BroadcastError('internal', 'Failed to schedule broadcast', 500);
    }
    broadcastId = inserted.id as string;
    storedScheduledAt = inserted.scheduled_at as string;
  }

  if (!variant) return { broadcastId, scheduledAt: storedScheduledAt };

  // A variante B do agendamento carrega o próprio template/variáveis e
  // nada mais: audiência, horário e fuso são do teste, e o cron os lê da
  // variante A — a única linha que ele varre.
  const { data: variantRow, error: variantError } = await db
    .from('broadcasts')
    .insert({
      user_id: userId,
      account_id: accountId,
      name: input.name,
      template_name: variant.templateName,
      template_language: variantLanguage,
      template_variables: variant.variables,
      audience_filter: audienceForVariantB(input.audience),
      header_media_url: variant.headerMediaUrl?.trim() || null,
      scheduled_at: scheduledAt.toISOString(),
      scheduled_timezone: timeZone,
      window_override: windowOverride,
      status: 'scheduled' as const,
      variant_label: 'B' as const,
      parent_broadcast_id: broadcastId,
    })
    .select('id')
    .single();

  if (variantError || !variantRow) {
    // Um agendamento A/B com metade das linhas viraria um disparo
    // simples na hora do envio, sem ninguém avisado. Desfaz a variante A
    // e devolve o erro: melhor não agendar do que agendar outra coisa.
    await db.from('broadcasts').delete().eq('id', broadcastId);
    console.error(
      '[broadcast-dispatch] schedule A/B variant error:',
      variantError
    );
    throw new BroadcastError(
      'internal',
      'Failed to schedule the A/B variant',
      500
    );
  }

  return {
    broadcastId,
    scheduledAt: storedScheduledAt,
    variantBroadcastId: variantRow.id as string,
  };
}

/** Falhar hoje é melhor do que falhar às 9h de sábado sem ninguém olhando. */
async function assertTemplateExists(
  db: SupabaseClient,
  accountId: string,
  templateName: string,
  templateLanguage: string
): Promise<void> {
  const { data } = await db
    .from('message_templates')
    .select('id')
    .eq('account_id', accountId)
    .eq('name', templateName)
    .eq('language', templateLanguage)
    .maybeSingle();

  if (!data) {
    throw new BroadcastError(
      'template_not_found',
      'Template not found for this account.',
      400
    );
  }
}
