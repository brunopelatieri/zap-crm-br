/**
 * Caminho único de entrada (PRD 047 / SPEC 048 §5, fase F2).
 *
 * O que é isto
 *
 *   O `processMessage()` que vivia dentro da rota do webhook da Meta
 *   (`app/api/whatsapp/webhook/route.ts`), movido para cá SEM mudança de
 *   comportamento. A rota da Meta virou o que sempre deveria ter sido:
 *   um tradutor do formato dela para um evento normalizado. Quando o
 *   canal QRCode chegar (F4), o webhook da Evolution será outro tradutor
 *   fino — e tudo o que acontece depois de uma mensagem entrar (contato,
 *   conversa, opt-out, flows, automações, IA, webhooks de saída) já
 *   estará escrito uma vez só.
 *
 * A ordem das etapas É o comportamento
 *
 *   Cada passo abaixo está na posição em que estava, e os comentários
 *   vieram junto porque documentam decisões que custaram caro:
 *   `conversation.created` antes do curto-circuito de reação, a âncora
 *   monotônica da janela de 24h em UPDATE separado, a supressão de
 *   gatilhos quando um flow consome a mensagem, o opt-out ANTES das
 *   automações. Reordenar qualquer um deles muda o produto em silêncio.
 *
 * O que passou a ser condicional ao canal
 *
 *   Só a janela de sessão de 24h (`shouldTrackSessionWindow`) e a
 *   idempotência de reentrega. Todo o resto vale para qualquer canal.
 *
 * ⚠️ Este é o caminho quente de RECEBIMENTO. Um erro aqui não aparece
 *    como erro: aparece como mensagem que nunca chegou ao inbox.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { setContactOptIn } from '@/lib/contacts/consent';
import { detectOptOut } from '@/lib/contacts/opt-out';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dispatchInboundToFlows } from '@/lib/flows/engine';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import { shouldTrackSessionWindow } from './session-window';
import type {
  ChannelType,
  NormalizedMessage,
  NormalizedReaction,
} from './types';

export interface IngestContext {
  /**
   * Cliente de service-role. A ingestão roda sem sessão de usuário e
   * precisa escrever em contatos, conversas e mensagens de qualquer
   * membro da conta — o escopo vem do `accountId` abaixo, não da RLS.
   */
  db: SupabaseClient;
  /**
   * Tenancy. Resolvido pelo tradutor do provedor (na Meta, pela linha de
   * `whatsapp_config` que casa com o `phone_number_id`); toda linha
   * criada aqui é carimbada com ele para que qualquer membro da conta
   * enxergue a conversa.
   */
  accountId: string;
  /**
   * Autor de registro para os INSERTs que exigem `user_id` NOT NULL
   * (contatos, conversas). Nenhuma mensagem recebida tem um "usuário que
   * a criou" — atribui-se ao admin dono da configuração do canal. A
   * escolha é arbitrária desde a 017, mas estável.
   */
  ownerUserId: string;
  channelType: ChannelType;
  /**
   * `channels.id` da conversa (migração 059 — `conversations.channel_id`
   * é NOT NULL). Quem chama já resolveu isto: a rota da Meta lê
   * `whatsapp_config.channel_id`, a Evolution lê `evolution_instances`.
   */
  channelId: string;
}

/** Evento de entrada que a ingestão sabe consumir. */
export type InboundEvent = NormalizedMessage | NormalizedReaction;

/**
 * Provedores que reentregam o MESMO evento (SPEC 048 §5 e §6.3).
 *
 *   A Evolution reentrega por desenho — sem uma checagem antes do
 *   INSERT, a mesma mensagem vira duas bolhas no inbox, dois disparos de
 *   automação e duas execuções de flow. Ali a idempotência deixa de ser
 *   defesa em profundidade e vira caminho quente.
 *
 *   `whatsapp_cloud` fica de FORA de propósito. A Meta também reentrega
 *   quando o nosso ack demora, e ligar a checagem para ela seria uma
 *   melhoria real — mas seria também uma mudança de comportamento do
 *   canal oficial dentro da fase cuja regra número um é não mudar nada.
 *   É uma decisão separada, com o seu próprio teste de regressão.
 *
 * A checagem é best-effort: não existe índice único em
 * `(conversation_id, message_id)`, então duas entregas concorrentes
 * ainda podem passar as duas. Cobre a reentrega sequencial, que é o caso
 * real.
 */
const PROVIDERS_THAT_REDELIVER: ReadonlySet<ChannelType> = new Set<ChannelType>(
  ['whatsapp_qr']
);

/**
 * Ingere um evento de entrada já normalizado.
 *
 * Nunca lança por falha de dependência opcional (automações, IA,
 * webhooks): quem chama é um webhook que precisa devolver 200 ao
 * provedor, e uma exceção aqui viraria reentrega — ou seja, duplicata.
 */
export async function ingestInbound(
  ctx: IngestContext,
  event: InboundEvent
): Promise<void> {
  const { db, accountId } = ctx;

  // Find or create contact
  const contactOutcome = await findOrCreateContact(
    ctx,
    event.fromPhone,
    event.pushName ?? ''
  );
  if (!contactOutcome) return;
  const contactRecord = contactOutcome.contact;

  // Find or create conversation
  const convResult = await findOrCreateConversation(ctx, contactRecord.id);
  if (!convResult) return;
  const conversation = convResult.conversation;

  // Emit conversation.created as soon as the thread is opened — BEFORE
  // the reaction short-circuit below — so a conversation first opened by
  // a reaction still fires the event, and a subscriber always sees the
  // thread open before its first message.received.
  if (convResult.created) {
    // SPEC 049 §5.5 — purely additive: existing subscribers ignore a
    // field they don't know about. `ctx` already resolved both (the
    // caller picked the channel before ingest started), so no extra
    // query.
    await dispatchWebhookEvent(db, accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
      channel_id: ctx.channelId,
      channel_type: ctx.channelType,
    });
  }

  // Reactions short-circuit here — they aren't messages. We never insert
  // into `messages`, never bump unread_count, never update last_message_text.
  // Done before the content is persisted so the media-URL fetch is skipped.
  if (event.kind === 'reaction') {
    await handleReaction(ctx, event, conversation.id, contactRecord.id);
    return;
  }

  // ============================================================
  // Eco do próprio operador (`fromMe`) — SPEC 048 §6.3.
  //
  // O canal QRCode entrega de volta o que o operador digitou NO PRÓPRIO
  // APARELHO (`SEND_MESSAGE`), algo que a Cloud API não faz. Sem esta
  // porta, esse eco seguiria o caminho de baixo e seria gravado como
  // `sender_type: 'customer'`: contaria como não-lida, dispararia
  // `new_message_received`/`keyword_match` e poderia fazer a IA
  // responder ao próprio operador.
  //
  // Decisão de produto (F4): grava como `sender_type: 'agent'`,
  // `sender_id: null` — mesma convenção de um envio pela API pública
  // (nenhum usuário do CRM autorou isto; ver `send-message.ts`).
  // Suprime apenas o EFETIVO eco de algo que o PRÓPRIO CRM já mandou
  // via `send.ts` (mesmo `message_id` já gravado) — sem isso, toda
  // resposta do inbox reapareceria duplicada quando a Evolution
  // confirma via `SEND_MESSAGE`. Nunca dispara automações, flows, IA
  // ou opt-out: é saída, não entrada. O canal oficial nunca entra neste
  // ramo (a rota da Meta fixa `fromMe: false`), então nada muda nele.
  // ============================================================
  if (event.fromMe) {
    const { data: alreadyStored } = await db
      .from('messages')
      .select('id')
      .eq('conversation_id', conversation.id)
      .eq('message_id', event.providerMessageId)
      .limit(1)
      .maybeSingle();
    if (alreadyStored) {
      return;
    }

    const { error: echoError } = await db.from('messages').insert({
      conversation_id: conversation.id,
      sender_type: 'agent',
      sender_id: null,
      content_type: event.contentType,
      content_text: event.text ?? null,
      media_url: event.mediaUrl ?? null,
      media_id: event.mediaId ?? null,
      // O canal QRCode preenche SÓ este campo (o webhook baixa a mídia e
      // sobe ao bucket). Sem ele a foto que o operador mandou pelo
      // celular vira bolha vazia — e o objeto já subido fica órfão.
      media_path: event.mediaPath ?? null,
      message_id: event.providerMessageId,
      status: 'sent',
      created_at: event.occurredAt.toISOString(),
    });
    if (echoError) {
      console.error('[ingest] failed to persist operator echo:', echoError);
      return;
    }

    await db
      .from('conversations')
      .update({
        last_message_text:
          event.text || `[${event.providerContentLabel ?? event.contentType}]`,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversation.id);

    return;
  }

  // Resolve swipe-reply context if present. A missing parent is fine —
  // we just store NULL and the UI renders the message without a quote.
  let replyToInternalId: string | null = null;
  if (event.replyToProviderMessageId) {
    replyToInternalId = await lookupInternalIdByProviderId(
      db,
      event.replyToProviderMessageId,
      conversation.id
    );
    if (!replyToInternalId) {
      console.warn(
        '[ingest] reply context parent not found:',
        event.replyToProviderMessageId
      );
    }
  }

  // ============================================================
  // Idempotência por (conversation_id, provider message id).
  // Ver `PROVIDERS_THAT_REDELIVER` — desligada no canal oficial.
  // ============================================================
  if (PROVIDERS_THAT_REDELIVER.has(ctx.channelType)) {
    const { data: alreadyStored } = await db
      .from('messages')
      .select('id')
      .eq('conversation_id', conversation.id)
      .eq('message_id', event.providerMessageId)
      .limit(1)
      .maybeSingle();
    if (alreadyStored) {
      console.warn(
        '[ingest] duplicate delivery ignored:',
        event.providerMessageId
      );
      return;
    }
  }

  // Determine whether this is the contact's very first inbound message
  // BEFORE we insert, so the count is accurate. Covers the case where
  // the contact row already exists (manual add / CSV import) but they've
  // never messaged us before — which new_contact_created wouldn't catch.
  const { count: priorCustomerMsgCount } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer');
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0;

  // Instante DO PROVEDOR, não do nosso servidor — usado tanto para o
  // `created_at` da mensagem quanto para a âncora da janela de sessão
  // logo abaixo (SPEC 045 §5.2.1). É um valor só para que os dois nunca
  // divirjam: `new Date()` no segundo produziria uma âncora no futuro
  // sempre que o webhook chegar atrasado (fila da Meta, reentrega após
  // 5xx nosso), fazendo o CRM achar que a janela ainda está aberta
  // quando a Meta já a fechou.
  const occurredAt = event.occurredAt;

  // Insert message — field names MUST match the messages table schema
  // (see supabase/migrations/001_initial_schema.sql):
  //   conversation_id, sender_type, content_type, content_text,
  //   media_url, template_name, message_id, status, created_at
  const { error: msgError } = await db.from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: event.contentType,
    content_text: event.text ?? null,
    media_url: event.mediaUrl ?? null,
    // Migração 040: é por esta coluna que a rota-proxy autoriza o
    // download (F-40-A). Sem ela, a mídia recebida fica inacessível
    // até para quem é dono da conversa.
    media_id: event.mediaId ?? null,
    // Canal QRCode (SPEC 048 §6.5): mídia já baixada e reenviada ao
    // bucket privado — `resolveMediaRef` prioriza este campo sobre
    // `media_url`/`media_id`, que são específicos do proxy da Meta.
    media_path: event.mediaPath ?? null,
    message_id: event.providerMessageId,
    status: 'delivered',
    created_at: occurredAt.toISOString(),
    reply_to_message_id: replyToInternalId,
    // Only populated for content_type='interactive'. Migration 010 added
    // the column; null for every other content_type so existing inserts
    // behave identically.
    interactive_reply_id: event.interactiveReplyId ?? null,
  });

  if (msgError) {
    console.error('Error inserting message:', msgError);
    return;
  }

  // Update conversation
  const { error: convError } = await db
    .from('conversations')
    .update({
      last_message_text:
        event.text || `[${event.providerContentLabel ?? event.contentType}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id);

  if (convError) {
    console.error('Error updating conversation:', convError);
  }

  // ============================================================
  // Âncora da janela de sessão de 24h (SPEC 045 §5.2.1) — UPDATE
  // separado do que já existe acima, de propósito: `last_message_at`
  // é um rótulo de UI e pode usar o instante do nosso servidor, mas a
  // âncora da janela tem de usar o instante DO PROVEDOR (`occurredAt`,
  // o mesmo valor do INSERT logo acima) e tem de ser monotônica.
  //
  // A Meta reentrega webhooks sem garantir ordem; um UPDATE cego
  // aceitaria um timestamp mais antigo que o já gravado e puxaria a
  // âncora PARA TRÁS — reabrindo elegibilidade de uma janela já
  // reengajada e encurtando artificialmente a janela vigente. O filtro
  // abaixo só deixa a escrita passar quando avança a âncora (ou quando
  // ainda não há nenhuma).
  //
  // Condicional ao canal (PRD 047 §7.1.1): num canal sem janela de 24h
  // a âncora tem de continuar NULA. Escrevê-la colocaria conversas do
  // QRCode no alcance da varredura de reengajamento, que tentaria
  // reengajá-las com um template que não existe ali. No canal oficial a
  // capacidade é `true` e nada muda.
  // ============================================================
  if (shouldTrackSessionWindow(ctx.channelType)) {
    const { data: anchorMoved, error: anchorError } = await db
      .from('conversations')
      .update({ last_customer_message_at: occurredAt.toISOString() })
      .eq('id', conversation.id)
      .or(
        `last_customer_message_at.is.null,last_customer_message_at.lt.${occurredAt.toISOString()}`
      )
      // O `.select()` existe para sabermos se a âncora AVANÇOU: numa
      // reentrega fora de ordem o filtro acima não casa e o resultado vem
      // vazio. É esse sinal que decide o bloco de `reopened_at` abaixo —
      // marcar reabertura com um timestamp velho contaria uma resposta
      // que não aconteceu agora.
      .select('id');

    if (anchorError) {
      console.error('Error updating session window anchor:', anchorError);
    }

    // ============================================================
    // Reengajamento que FUNCIONOU (SPEC 045 §5.5.5 / §7).
    //
    // O cliente acabou de escrever. Se existe um claim desta conversa que
    // já enviou um reengajamento nas últimas 24h e ainda não foi marcado,
    // então foi este reengajamento que trouxe a pessoa de volta — e é
    // exatamente essa a definição da métrica de reabertura da §7.
    //
    // Marcar aqui é o que transforma "cruzar automation_logs com messages
    // por contact_id e faixa de tempo" (a consulta que ninguém escreve
    // depois do deploy) em um count sobre uma coluna. O índice parcial da
    // migração 053 cobre exatamente este filtro.
    //
    // Best-effort e fora do caminho crítico: perder a marcação custa a
    // métrica, nunca a entrega da mensagem.
    // ============================================================
    if (!anchorError && anchorMoved && anchorMoved.length > 0) {
      const reopenCutoff = new Date(
        occurredAt.getTime() - 24 * 60 * 60 * 1000
      ).toISOString();
      const { error: reopenError } = await db
        .from('automation_window_claims')
        .update({ reopened_at: occurredAt.toISOString() })
        .eq('conversation_id', conversation.id)
        .not('sent_at', 'is', null)
        .is('reopened_at', null)
        .gte('sent_at', reopenCutoff);
      if (reopenError) {
        console.error('Error marking window reopen:', reopenError);
      }
    }
  }

  // If this contact was a recent broadcast recipient, flag the reply
  // so the broadcast's `replied_count` advances (via the aggregate
  // trigger installed in migration 003).
  await flagBroadcastReplyIfAny(db, accountId, contactRecord.id);

  // ============================================================
  // Opt-out por palavra-chave (SPEC 044 §6.8).
  //
  // "SAIR", "PARAR", "DESCADASTRAR" — se a mensagem INTEIRA é um pedido
  // de descadastro, o contato vira `opted_out` e o pedido entra na
  // trilha (`contact_consent_events`). A partir daí ele não entra em
  // audiência de marketing nenhuma.
  //
  // Roda ANTES dos gatilhos de automação, e de propósito não os
  // suprime: a §6.8 descreve a detecção como "plugável nas automações
  // que já existem", e é por um `keyword_match` que o operador manda a
  // confirmação de descadastro que quiser. O que muda é o estado — e o
  // estado já estará gravado quando a automação rodar.
  //
  // Best-effort: uma falha aqui não pode impedir o 200 para o provedor.
  // ============================================================
  const inboundText = event.text ?? '';
  const optOutKeyword = detectOptOut(inboundText);
  if (optOutKeyword) {
    try {
      await setContactOptIn(db, {
        contactId: contactRecord.id,
        status: 'opted_out',
        source: 'inbound_keyword',
        keyword: optOutKeyword,
        whatsappMessageId: event.providerMessageId,
      });
    } catch (err) {
      console.error('[ingest] opt-out registration failed:', err);
    }
  }

  // ============================================================
  // Flow runner dispatch.
  //
  // If the runner consumes the message (it either advanced an active
  // run or started a new one), we suppress the `new_message_received`
  // + `keyword_match` automation triggers for this inbound. Customer
  // is navigating the bot menu, not sending a fresh trigger word
  // that should fork into automations.
  //
  // The relationship-level triggers (`new_contact_created`,
  // `first_inbound_message`) still fire even when consumed — those
  // are about WHO is messaging, not what they said.
  //
  // Awaited (not fire-and-forget) because we need the `consumed`
  // result before deciding whether to dispatch automations. The
  // runner has its own try/catch and never throws. Accounts with
  // no active flows take the runner's early-exit "no_match" path
  // basically for free (one indexed SELECT for the active run).
  // ============================================================
  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: ctx.ownerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message: event.interactiveReplyId
      ? {
          kind: 'interactive_reply',
          reply_id: event.interactiveReplyId,
          reply_title: event.text ?? '',
          meta_message_id: event.providerMessageId,
        }
      : {
          kind: 'text',
          text: inboundText,
          meta_message_id: event.providerMessageId,
        },
    isFirstInboundMessage,
  });
  const flowConsumed = flowResult.consumed;

  // Fire any automations that react to this webhook event. All dispatches
  // run here (not earlier) so the contact, conversation, and inbound
  // message all exist before any step — including send_message — runs.
  // Fire-and-forget: a slow or failing automation must not block the
  // webhook's 200 OK response to the provider.
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = [];
  // Content-level triggers are suppressed when a flow consumed the
  // message — see the comment block above.
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match');
    // Interactive tap → fire the interactive_reply trigger too (only
    // meaningful when a button/list reply actually arrived). Enables
    // automation-only chained menus; when a Flow owns the menu it will
    // have consumed the reply and this is skipped.
    if (event.interactiveReplyId) {
      automationTriggers.push('interactive_reply');
    }
  }
  // new_contact_created fires only when the webhook just auto-created the
  // contact row. first_inbound_message fires whenever this is the contact's
  // first-ever customer-sent message — a superset that also catches
  // manually-imported contacts sending for the first time. We dispatch both
  // so users can pick whichever semantic they want; an automation that
  // listens to only one trigger runs only when that trigger matches.
  if (contactOutcome.wasCreated)
    automationTriggers.unshift('new_contact_created');
  if (isFirstInboundMessage)
    automationTriggers.unshift('first_inbound_message');
  for (const triggerType of automationTriggers) {
    runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        // Only set on interactive taps; drives the interactive_reply
        // trigger's exact-id match.
        interactive_reply_id: event.interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err));
  }

  // AI auto-reply. Runs only for plain-text inbound the deterministic
  // flow runner did NOT consume (flows win over the LLM), and only when
  // the account has enabled it. Awaited inside the caller's `after()`
  // (same reason as the webhook dispatch below);
  // `dispatchInboundToAiReply` owns its eligibility gates + try/catch and
  // never throws.
  // `optOutKeyword` entra na condição: responder "SAIR" com um texto
  // gerado por LLM é o oposto do que a pessoa pediu, e a resposta
  // consumiria uma mensagem em nome de quem acabou de sair da lista. Uma
  // confirmação, se o operador quiser mandar, é trabalho de automação
  // determinística — ver o bloco de opt-out acima.
  if (
    !flowConsumed &&
    !event.interactiveReplyId &&
    !optOutKeyword &&
    inboundText.trim()
  ) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId: ctx.ownerUserId,
    });
  }

  // message.received webhook (public API). Awaited — not fire-and-forget
  // — because the caller runs inside the route's `after()` block, which
  // only keeps the function alive for promises it can see; a detached
  // promise could be frozen before it delivers. `dispatchWebhookEvent`
  // early-exits when the account has no matching endpoint and never
  // throws. (conversation.created is emitted earlier, right after the
  // thread is opened.)
  await dispatchWebhookEvent(db, accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: event.providerMessageId,
    content_type: event.contentType,
    text: event.text ?? null,
    // SPEC 049 §5.5 — same reasoning as conversation.created above.
    channel_id: ctx.channelId,
    channel_type: ctx.channelType,
  });
}

// ------------------------------------------------------------
// Contato e conversa
// ------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any;

interface ContactOutcome {
  contact: ContactRow;
  /** True when this call created the row; drives new_contact_created
   *  automation dispatch in ingestInbound. */
  wasCreated: boolean;
}

async function findOrCreateContact(
  ctx: IngestContext,
  phone: string,
  name: string
): Promise<ContactOutcome | null> {
  const { db, accountId } = ctx;

  // Find an existing contact for this account by phone. The shared
  // helper pre-filters in SQL by the last-8-digit suffix (so we don't
  // pull every contact on every inbound message) then applies the
  // strict `phonesMatch` in JS on the small candidate set. The same
  // helper backs the manual contact form and CSV import, so all three
  // paths agree on what "same number" means (issue #212).
  const existingContact = await findExistingContact(db, accountId, phone);

  if (existingContact) {
    // Update name if it changed
    if (name && name !== existingContact.name) {
      await db
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id);
    }
    return { contact: existingContact, wasCreated: false };
  }

  // Create new contact. account_id is the tenancy column;
  // user_id is the NOT NULL FK audit column (no inbound message
  // has a single "user who created" it — we attribute to the
  // channel config owner as a stable default).
  const { data: newContact, error: createError } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: ctx.ownerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single();

  if (createError) {
    // Lost a race: a concurrent inbound delivery (or another path)
    // created this contact between our lookup and insert, and the
    // unique index (migration 022) rejected the duplicate. Re-resolve
    // the existing row instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(db, accountId, phone);
      if (raced) return { contact: raced, wasCreated: false };
    }
    console.error('Error creating contact:', createError);
    return null;
  }

  return { contact: newContact, wasCreated: true };
}

async function findOrCreateConversation(ctx: IngestContext, contactId: string) {
  const { db, accountId, channelId } = ctx;

  // Look for an existing conversation in this account AND CHANNEL,
  // oldest-first (D-2, migração 059: uma conversa por canal — o mesmo
  // contato falando pelo Cloud e pelo QRCode gera DUAS threads).
  //
  // We deliberately do NOT use `.single()` here. `.single()` errors on
  // *both* 0 rows and ≥2 rows, and the old code treated any error as
  // "none found" and inserted a new row. So once two conversations
  // existed for a contact (from a race — the provider retries a
  // delivery, or a batch fans out to concurrent runs), every subsequent
  // inbound message errored on the lookup and created yet another
  // conversation, snowballing into a wall of duplicate chats (issue
  // #363).
  //
  // Ordering oldest-first and taking one row makes the lookup resolve to
  // the same canonical survivor the dedup migration (036/059) keeps, so
  // any pre-existing duplicates converge instead of compounding.
  const { data: existingRows, error: findError } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('channel_id', channelId)
    .order('created_at', { ascending: true })
    .limit(1);

  if (findError) {
    console.error('Error finding conversation:', findError);
    return null;
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false };
  }

  // Create new conversation. Same tenancy + audit split as
  // findOrCreateContact above.
  const { data: newConv, error: createError } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: ctx.ownerUserId,
      contact_id: contactId,
      channel_id: channelId,
    })
    .select()
    .single();

  if (createError) {
    // Lost a race: a concurrent inbound delivery created the
    // conversation between our lookup and insert, and the unique index
    // (migração 059: account_id, contact_id, channel_id) rejected the
    // duplicate. Re-resolve the winning row instead of dropping the
    // message — mirrors findOrCreateContact.
    if (isUniqueViolation(createError)) {
      const { data: raced } = await db
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .eq('channel_id', channelId)
        .order('created_at', { ascending: true })
        .limit(1);
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false };
      }
    }
    console.error('Error creating conversation:', createError);
    return null;
  }

  return { conversation: newConv, created: true };
}

// ------------------------------------------------------------
// Reações e citações
// ------------------------------------------------------------

/**
 * Resolve o id de mensagem DO PROVEDOR no UUID interno correspondente,
 * dentro de uma conversa. Devolve null quando nunca recebemos a mensagem
 * original (ex.: resposta com citação a uma mensagem mais antiga que
 * esta instalação do CRM).
 */
async function lookupInternalIdByProviderId(
  db: SupabaseClient,
  providerMessageId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await db
    .from('messages')
    .select('id')
    .eq('message_id', providerMessageId)
    .eq('conversation_id', conversationId)
    .maybeSingle();
  if (error) {
    console.error(
      '[ingest] lookupInternalIdByProviderId failed:',
      error.message
    );
    return null;
  }
  return data?.id ?? null;
}

/**
 * Persist an inbound reaction. Reactions are not new messages — they're
 * per-(target, actor) state. We upsert / delete on `message_reactions`,
 * never write a row into `messages`.
 *
 * Best-effort: a missing parent (we never received it) is logged and
 * skipped so the webhook still acks 200 to the provider.
 */
async function handleReaction(
  ctx: IngestContext,
  event: NormalizedReaction,
  conversationId: string,
  contactId: string
) {
  const { db } = ctx;
  if (!event.targetProviderMessageId) return;

  const targetInternalId = await lookupInternalIdByProviderId(
    db,
    event.targetProviderMessageId,
    conversationId
  );
  if (!targetInternalId) {
    console.warn(
      '[ingest] reaction target message not found; skipping',
      event.targetProviderMessageId
    );
    return;
  }

  // Empty emoji = removal (per Meta's Cloud API spec; the Evolution
  // channel signals removal the same way).
  if (!event.emoji) {
    const { error: delError } = await db
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId);
    if (delError) {
      console.error('[ingest] reaction delete failed:', delError.message);
    }
    return;
  }

  const { error: upsertError } = await db.from('message_reactions').upsert(
    {
      message_id: targetInternalId,
      conversation_id: conversationId,
      actor_type: 'customer',
      actor_id: contactId,
      emoji: event.emoji,
    },
    { onConflict: 'message_id,actor_type,actor_id' }
  );
  if (upsertError) {
    console.error('[ingest] reaction upsert failed:', upsertError.message);
  }
}

// ------------------------------------------------------------
// Disparo em massa
// ------------------------------------------------------------

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast.
 *
 * Runs on a best-effort basis — failures here must not break the
 * main inbound-message flow, so errors are swallowed with a log.
 */
async function flagBroadcastReplyIfAny(
  db: SupabaseClient,
  accountId: string,
  contactId: string
) {
  try {
    // Most recent outbound broadcast in this account that hasn't
    // been replied to yet. Account-scoped so a shared inbox reply
    // marks the broadcast as replied regardless of which teammate
    // sent it.
    const { data: recs, error } = await db
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1);

    if (error || !recs || recs.length === 0) return;

    const row = recs[0];
    const { error: updErr } = await db
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id);

    if (updErr) {
      console.error('Error marking broadcast recipient replied:', updErr);
    }
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err);
  }
}
