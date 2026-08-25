// ============================================================
// Outbound message send — the core that both the dashboard's
// `/api/whatsapp/send` route and the public `/api/v1/messages`
// endpoint call.
//
// Given a conversation and message params, this:
//   1. validates the params for the message type,
//   2. loads the conversation + contact + WhatsApp config,
//   3. sends to Meta (with phone-variant retry + contact auto-fix),
//   4. persists the message + updates the conversation,
//   5. pauses any active Flow run for the contact (agent stepped in).
//
// It is transport-agnostic: it takes a `SupabaseClient` and an
// `accountId` and throws `SendMessageError` on failure. The callers
// own auth, rate-limiting, body parsing, and mapping the error to
// their respective response shapes (internal `{ error }` vs the v1
// envelope). Behaviour is identical to the original inline route —
// this is a straight extraction so the public endpoint can reuse it
// without duplicating ~250 lines of Meta plumbing.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import type { MediaKind } from '@/lib/whatsapp/meta-api';
import {
  validateInteractivePayload,
  interactivePayloadPreviewText,
  type InteractiveMessagePayload,
} from '@/lib/whatsapp/interactive';
import {
  resolveChannelForConversation,
  sendWithPhoneVariants,
  ChannelCapabilityError,
  ChannelNotConfiguredError,
  type OutboundContent,
} from '@/lib/channels/send';
import { can } from '@/lib/channels/capabilities';
import {
  checkColdSend,
  recordColdSend,
  type ColdSendCheck,
} from '@/lib/channels/cold-send-wiring';
import { describeDenial } from '@/lib/channels/cold-send-limit';
import { encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';
import type { MessageTemplate, TemplatePreviewPayload } from '@/types';
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import {
  renderTemplateText,
  type SendTimeParams,
} from '@/lib/whatsapp/template-send-builder';
import { resolveMediaUrlForServer } from '@/lib/storage/sign-media';
import { withSignedHeaderMedia } from '@/lib/whatsapp/header-media';

export const MEDIA_KINDS = ['image', 'video', 'document', 'audio'] as const;
export const VALID_MESSAGE_TYPES = [
  'text',
  'template',
  'interactive',
  ...MEDIA_KINDS,
] as const;

/**
 * Typed failure with a machine `code` and a suggested HTTP `status`.
 * Callers map it to their own response shape (`toErrorResponse` for
 * the dashboard route, the v1 envelope for the public endpoint).
 */
export class SendMessageError extends Error {
  readonly code: string;
  readonly status: number;
  /** Extra headers the caller should echo — hoje só o `Retry-After` do
   *  teto de envio frio (SPEC 049 §6.2). Ausente na maioria dos erros. */
  readonly headers?: Record<string, string>;
  constructor(
    code: string,
    message: string,
    status: number,
    headers?: Record<string, string>
  ) {
    super(message);
    this.name = 'SendMessageError';
    this.code = code;
    this.status = status;
    this.headers = headers;
  }
}

export interface SendMessageParams {
  conversationId: string;
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  /**
   * Caminho do objeto no bucket `chat-media`, quando o anexo foi subido
   * por nós (migração 040). É a fonte de verdade para assinar a URL na
   * hora do envio e para exibir a mídia depois — a `mediaUrl` pública
   * deixou de ser buscável quando o bucket virou privado.
   *
   * Nulo em dois casos legítimos: envio pela API pública com um link
   * externo, e chamadas anteriores à 040.
   */
  mediaPath?: string | null;
  filename?: string | null;
  templateName?: string | null;
  templateLanguage?: string | null;
  /** Legacy positional body params (only used if messageParams.body unset). */
  templateParams?: string[];
  /** Structured template params (header/body/buttons). */
  templateMessageParams?: unknown;
  /** Structured payload for `messageType === 'interactive'`. */
  interactivePayload?: InteractiveMessagePayload | null;
  replyToMessageId?: string | null;
  /**
   * Autor humano da mensagem, gravado em `messages.sender_id`.
   *
   * A coluna existe desde a migração 001 e NUNCA foi preenchida por
   * este caminho — as 172 mensagens de agente da base tinham
   * `sender_id` nulo. Isso deixava a autoria irrecuperável: o
   * message-thread cai no fallback ao nomear quem respondeu, e o
   * backfill da 039 (que atribuiria cada thread ao último agente a
   * responder) não teve nenhum sinal com que trabalhar.
   *
   * Nulo quando não há humano: a API pública `/api/v1/messages` roda
   * com service role e chave de API, sem `auth.uid()`.
   */
  senderId?: string | null;
  /**
   * Quem está mandando, para o teto de envio frio (SPEC 049 §6.2, D-1).
   * `human` (inbox) NUNCA bloqueia — só registra, para a cota descrever
   * o número por inteiro, não só o motor. `api` (pública v1) bloqueia
   * com 429. Omitido = nenhuma verificação nem registro — um chamador
   * que ainda não migrou não regride, só fica sem o dado.
   */
  coldSendOrigin?: 'human' | 'api';
}

export interface SendMessageResult {
  /** Our `messages.id` (the persisted row). */
  messageId: string;
  /** Meta's `wamid` for the delivered message. */
  whatsappMessageId: string;
}

/**
 * Send a message in an existing conversation and persist it.
 *
 * `db` may be an RLS-scoped user client (dashboard) or the service-
 * role client (public API) — every query is filtered by `accountId`
 * either way, so tenancy holds regardless of which client is passed.
 */
/**
 * Validate the message-shape params (type, required content, caption
 * cap) independently of any DB state, throwing `SendMessageError` on a
 * bad payload. Exported so a caller can reject a malformed request
 * *before* it finds-or-creates a contact/conversation — otherwise an
 * invalid payload leaves an orphan empty conversation behind. The send
 * core calls this too, so validation can't be skipped.
 */
export function validateSendMessageParams(params: {
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  templateName?: string | null;
  interactivePayload?: InteractiveMessagePayload | null;
}): void {
  const {
    messageType,
    contentText,
    mediaUrl,
    templateName,
    interactivePayload,
  } = params;

  if (!messageType) {
    throw new SendMessageError('bad_request', 'message_type is required', 400);
  }

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  if (!(VALID_MESSAGE_TYPES as readonly string[]).includes(messageType)) {
    throw new SendMessageError(
      'bad_request',
      `Unsupported message_type "${messageType}"`,
      400
    );
  }

  if (messageType === 'text' && !contentText) {
    throw new SendMessageError(
      'bad_request',
      'content_text is required for text messages',
      400
    );
  }

  if (messageType === 'template' && !templateName) {
    throw new SendMessageError(
      'bad_request',
      'template_name is required for template messages',
      400
    );
  }

  // Interactive: validate the full structured payload against Meta's
  // limits up front so a bad payload 400s before we touch Meta.
  if (messageType === 'interactive') {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) {
      throw new SendMessageError('bad_request', result.error, 400);
    }
  }

  if (isMediaKind && !mediaUrl) {
    throw new SendMessageError(
      'bad_request',
      `media_url is required for ${messageType} messages`,
      400
    );
  }

  // Meta caps media captions at 1024 chars (audio carries none).
  if (
    isMediaKind &&
    messageType !== 'audio' &&
    typeof contentText === 'string' &&
    contentText.length > 1024
  ) {
    throw new SendMessageError(
      'bad_request',
      'Caption exceeds the 1024-character limit',
      400
    );
  }
}

export async function sendMessageToConversation(
  db: SupabaseClient,
  accountId: string,
  params: SendMessageParams
): Promise<SendMessageResult> {
  const {
    conversationId,
    messageType,
    contentText,
    mediaUrl,
    mediaPath,
    filename,
    templateName,
    templateLanguage,
    templateParams,
    templateMessageParams,
    interactivePayload,
    replyToMessageId,
    senderId,
    coldSendOrigin,
  } = params;

  if (!conversationId) {
    throw new SendMessageError(
      'bad_request',
      'conversation_id is required',
      400
    );
  }

  validateSendMessageParams({
    messageType,
    contentText,
    mediaUrl,
    templateName,
    interactivePayload,
  });

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  // Conversation + contact, account-scoped.
  const { data: conversation, error: convError } = await db
    .from('conversations')
    .select('*, contact:contacts(*)')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .single();

  if (convError || !conversation) {
    throw new SendMessageError('not_found', 'Conversation not found', 404);
  }

  const contact = conversation.contact;
  if (!contact?.phone) {
    throw new SendMessageError(
      'bad_request',
      'Contact phone number not found',
      400
    );
  }

  const sanitizedPhone = sanitizePhoneForMeta(contact.phone);
  if (!isValidE164(sanitizedPhone)) {
    throw new SendMessageError(
      'bad_request',
      'Invalid phone number format',
      400
    );
  }

  // Credenciais do canal DA CONVERSA (F4.1), não do padrão da conta.
  // Antes disto a resolução era fixa em `whatsapp_cloud`, então
  // responder uma thread do WhatsApp QRCode saía pelo número oficial da
  // Meta — ver o cabeçalho de `resolveChannelForConversation`. O cliente
  // `db` é o mesmo de antes — o do usuário no painel, service-role na
  // API pública —, então o alcance da consulta e a RLS não mudam.
  let channelCtx;
  let config;
  try {
    ({ ctx: channelCtx, configRow: config } =
      await resolveChannelForConversation(db, accountId, conversationId));
  } catch (err) {
    if (err instanceof ChannelNotConfiguredError) {
      throw new SendMessageError(
        'whatsapp_not_configured',
        'WhatsApp not configured. Please set up your WhatsApp integration first.',
        400
      );
    }
    throw err;
  }

  const isCloudChannel = channelCtx.channel.type === 'whatsapp_cloud';
  const accessToken = channelCtx.credentials.accessToken;

  // Teto de envio frio (SPEC 049 §6.2, D-1) — só em canal sem janela da
  // Meta. `human` (este caminho, vindo do inbox) NUNCA bloqueia: travar
  // um agente no meio do atendimento é pior que o risco marginal de um
  // envio manual. `api` (a pública v1) bloqueia com 429 — caminho
  // automatizado por definição, e um integrador que recebesse 200
  // continuaria mandando.
  let coldSendCheck: ColdSendCheck | null = null;
  if (coldSendOrigin && !can(channelCtx.channel.type, 'sessionWindow24h')) {
    coldSendCheck = await checkColdSend(db, {
      channelId: channelCtx.channel.id,
      channelType: channelCtx.channel.type,
      lastInboundAt: conversation.last_customer_message_at
        ? new Date(conversation.last_customer_message_at)
        : null,
    });
    if (
      coldSendOrigin === 'api' &&
      coldSendCheck.decision &&
      !coldSendCheck.decision.allowed
    ) {
      throw new SendMessageError(
        'cold_send_limit',
        describeDenial(coldSendCheck.decision),
        429,
        {
          'Retry-After': String(coldSendCheck.decision.retryAfterSeconds ?? 60),
        }
      );
    }
  }

  // Self-heal legacy CBC ciphertexts. Fire-and-forget; idempotent.
  // Só no canal oficial: fora dele `config` é a instância Evolution
  // (sem `access_token`) e não há `whatsapp_config` a reparar.
  if (isCloudChannel && isLegacyFormat(config.access_token)) {
    void db
      .from('whatsapp_config')
      .update({ access_token: encrypt(accessToken) })
      .eq('id', config.id)
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) {
          console.warn(
            '[send-message] access_token GCM upgrade failed:',
            error.message
          );
        }
      });
  }

  // Resolve the reply target to its Meta message_id. The parent must
  // belong to this same conversation — otherwise a caller could quote
  // messages they can't see by guessing UUIDs.
  let contextMessageId: string | undefined;
  if (replyToMessageId) {
    const { data: parent, error: parentError } = await db
      .from('messages')
      .select('message_id, conversation_id')
      .eq('id', replyToMessageId)
      .eq('conversation_id', conversationId)
      .maybeSingle();

    if (parentError || !parent) {
      throw new SendMessageError(
        'bad_request',
        'reply_to_message_id not found in this conversation',
        400
      );
    }
    if (!parent.message_id) {
      console.warn(
        '[send-message] reply target has no Meta message_id; sending without context'
      );
    } else {
      contextMessageId = parent.message_id;
    }
  }

  // Template row (for header + button components). isMessageTemplate
  // guards against a malformed local row crashing the send-builder.
  let templateRow: MessageTemplate | null = null;
  if (messageType === 'template' && templateName) {
    const { data } = await db
      .from('message_templates')
      .select('*')
      .eq('account_id', accountId)
      .eq('name', templateName)
      .eq('language', templateLanguage || 'en_US')
      .maybeSingle();
    if (data && !isMessageTemplate(data)) {
      throw new SendMessageError(
        'template_malformed',
        'Template row is malformed locally — run "Sync from Meta" in Settings to repair it.',
        500
      );
    }
    templateRow = data ?? null;
  }

  // ---- URL que a Meta vai buscar (SPEC 040) -------------------------
  //
  // Desde a migração 040 o bucket `chat-media` é PRIVADO, então a URL
  // gravada na linha não é mais buscável por um terceiro. A Meta precisa
  // de um link que ela consiga abrir sem credencial — logo, assinamos
  // aqui, imediatamente antes do envio.
  //
  // Isso é seguro porque a Meta baixa o arquivo UMA vez e o re-hospeda
  // para servir ao destinatário; a validade curta da assinatura basta.
  // E a URL assinada NÃO é persistida: `messages.media_url` continua
  // guardando o valor estável (ver o insert adiante), senão o registro
  // ficaria com um link morto em dez minutos.
  //
  // `resolveMediaUrlForServer` devolve a URL intocada quando ela é
  // externa (link de terceiro colado pelo usuário), então este caminho
  // cobre os dois casos sem ramificação no chamador.
  let outboundMediaLink = mediaUrl ?? null;
  if (isMediaKind && mediaUrl) {
    outboundMediaLink = await resolveMediaUrlForServer(db, mediaUrl, mediaPath);
    if (!outboundMediaLink) {
      throw new SendMessageError(
        'media_unavailable',
        'Could not resolve the attachment for sending. It may have been removed from storage.',
        400
      );
    }
  }

  // Idem para o header de mídia de TEMPLATE — ver `header-media.ts`,
  // compartilhado com os motores de automações e flows.
  let templateParamsForSend = templateMessageParams as
    SendTimeParams | undefined;
  if (messageType === 'template' && templateRow) {
    try {
      templateParamsForSend = await withSignedHeaderMedia(
        db,
        templateRow,
        templateParamsForSend
      );
    } catch (err) {
      throw new SendMessageError(
        'media_unavailable',
        err instanceof Error
          ? err.message
          : 'Could not resolve the template header media for sending.',
        400
      );
    }
  }

  // O que vai ser enviado, na linguagem da camada de canais. As quatro
  // formas abaixo são exatamente os quatro ramos que este caminho sempre
  // teve — inclusive o `contextMessageId` da citação, que vale para
  // TODOS eles e não só para texto.
  const outboundContent: OutboundContent =
    messageType === 'template'
      ? {
          kind: 'template',
          templateName: templateName!,
          language: templateLanguage || 'en_US',
          definition: templateRow ?? undefined,
          components: templateParamsForSend ?? undefined,
          positionalParams: templateParams || [],
        }
      : isMediaKind
        ? {
            kind: 'media',
            mediaKind: messageType as MediaKind,
            link: outboundMediaLink!,
            caption: contentText || undefined,
            filename: filename || undefined,
          }
        : messageType === 'interactive'
          ? { kind: 'interactive', payload: interactivePayload! }
          : { kind: 'text', text: contentText! };

  // Send via the channel — retry across phone-number variants if the
  // provider rejects with "recipient not in allowed list"; persist a
  // working variant back to the contact so the next send goes straight
  // through.
  let waMessageId = '';
  let workingPhone = sanitizedPhone;
  try {
    const result = await sendWithPhoneVariants({
      ctx: channelCtx,
      sanitizedPhone,
      content: outboundContent,
      quotedProviderMessageId: contextMessageId,
      onVariantRejected: (variant) =>
        console.warn(
          `[send-message] variant "${variant}" rejected by Meta, trying next…`
        ),
    });
    waMessageId = result.providerMessageId;
    workingPhone = result.workingPhone;
  } catch (err) {
    // O canal não sabe fazer o que foi pedido (template ou botão numa
    // conversa QRCode, por exemplo). É erro do PEDIDO, não do provedor —
    // 400 com o motivo, em vez de um 502 "Meta API error" que culpa a
    // Meta por algo que nunca chegou a ela.
    if (err instanceof ChannelCapabilityError) {
      throw new SendMessageError('unsupported_by_channel', err.message, 400);
    }
    const message =
      err instanceof Error ? err.message : 'Unknown Meta API error';
    console.error('[send-message] Meta send failed for all variants:', message);
    throw new SendMessageError('meta_error', `Meta API error: ${message}`, 502);
  }

  if (workingPhone !== sanitizedPhone) {
    console.log(
      `[send-message] Auto-corrected contact phone: ${sanitizedPhone} → ${workingPhone}`
    );
    await db
      .from('contacts')
      .update({ phone: workingPhone })
      .eq('id', contact.id);
  }

  // Persist the sent message. Field names MUST match the messages
  // schema (see 001_initial_schema.sql).
  // Interactive messages persist the body as content_text (so the
  // conversation-list preview reads sensibly) plus the full structured
  // payload so the thread can re-render the buttons / rows.
  const interactiveBody =
    messageType === 'interactive' ? interactivePayload!.body : null;

  // Template messages: resolve header/body/footer/buttons (variables
  // substituted) so the bubble can render the sent template exactly as
  // it appears on the recipient's phone, not just its plain body text.
  // Only possible when the template row was found locally — a template
  // that exists on Meta but never got synced locally still sends fine
  // (legacy `params`-only path), it just falls back to the plain badge.
  let templatePreview: TemplatePreviewPayload | null = null;
  if (messageType === 'template' && templateRow) {
    const sendParams = (templateMessageParams ?? {}) as Partial<SendTimeParams>;
    const header =
      templateRow.header_type === 'text' && templateRow.header_content
        ? renderTemplateText(
            templateRow.header_content,
            sendParams.headerText ? [sendParams.headerText] : []
          )
        : undefined;
    // Media headers: prefer a send-time URL override, else the template's
    // stored public URL. No fallback for `headerMediaId`-only sends (a bare
    // Meta media id, not a fetchable URL) — those still send fine to Meta,
    // the bubble just won't have anything to render inline for them.
    const headerMediaUrl =
      sendParams.headerMediaUrl ?? templateRow.header_media_url;
    const headerMedia =
      (templateRow.header_type === 'image' ||
        templateRow.header_type === 'video' ||
        templateRow.header_type === 'document') &&
      headerMediaUrl
        ? { type: templateRow.header_type, url: headerMediaUrl }
        : undefined;
    templatePreview = {
      header,
      headerMedia,
      body:
        contentText ||
        renderTemplateText(
          templateRow.body_text,
          sendParams.body ?? templateParams ?? []
        ),
      footer: templateRow.footer_text,
      buttons: templateRow.buttons,
    };
  }

  const { data: messageRecord, error: msgError } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'agent',
      // Nulo para envios da API pública (service role, sem usuário).
      sender_id: senderId ?? null,
      content_type: messageType,
      content_text: interactiveBody ?? contentText ?? null,
      // Valor ESTÁVEL, nunca a URL assinada que acabou de ir para a
      // Meta: aquela expira em minutos e deixaria a bolha com um link
      // morto. Quem exibe usa `media_path` (assinando de novo na hora)
      // e cai em `media_url` para o histórico anterior à 040.
      media_url: mediaUrl || null,
      media_path: mediaPath || null,
      template_name: templateName || null,
      template_preview: templatePreview,
      interactive_payload:
        messageType === 'interactive' ? interactivePayload : null,
      message_id: waMessageId,
      status: 'sent',
      reply_to_message_id: replyToMessageId || null,
    })
    .select()
    .single();

  if (msgError) {
    console.error('[send-message] error inserting sent message:', msgError);
    throw new SendMessageError(
      'db_error',
      `Message sent to Meta but failed to save to DB: ${msgError.message}`,
      500
    );
  }

  const lastMessageText =
    messageType === 'interactive'
      ? interactivePayloadPreviewText(interactivePayload!)
      : contentText || `[${messageType}]`;

  // `.select()` não é decorativo aqui. Sem ele, uma recusa da RLS volta
  // como SUCESSO com 0 linhas afetadas — o PostgREST não distingue "não
  // atualizei nada" de "não posso atualizar". O preview da lista ficaria
  // eternamente desatualizado sem um único erro no console.
  //
  // Não é fatal: a mensagem já foi entregue e gravada. Registrar e
  // seguir — o evento de realtime e o resync convergem o preview.
  const { data: touched, error: touchErr } = await db
    .from('conversations')
    .update({
      last_message_text: lastMessageText,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId)
    .select('id');

  if (touchErr || !touched || touched.length === 0) {
    console.warn(
      '[send-message] conversation preview not updated (RLS or missing row):',
      { conversationId, error: touchErr?.message ?? 'no rows affected' }
    );
  }

  // Pause any active Flow run for this contact — the agent stepping in
  // is the strongest "yield, human is here" signal. Best-effort.
  try {
    const { error: pauseErr } = await supabaseAdmin()
      .from('flow_runs')
      .update({
        status: 'paused_by_agent',
        ended_at: new Date().toISOString(),
        end_reason: 'agent_replied',
      })
      .eq('account_id', accountId)
      .eq('contact_id', contact.id)
      .eq('status', 'active');
    if (pauseErr) {
      console.error('[flows] pause-on-agent-send failed:', pauseErr.message);
    }
  } catch (err) {
    console.error(
      '[flows] pause-on-agent-send threw:',
      err instanceof Error ? err.message : err
    );
  }

  // Gravado DEPOIS da entrega confirmada (§6.1 ponto 4 da SPEC 049) —
  // contar antes faria uma falha de rede consumir cota que nunca saiu.
  // `recordColdSend` já escala pra supabaseAdmin() internamente (062: só
  // service_role escreve em channel_cold_sends) e nunca lança —
  // best-effort de verdade, diferente do pause-on-agent-send acima, que
  // precisa do try/catch explícito porque ele mesmo chama supabaseAdmin().
  if (coldSendCheck?.cold) {
    await recordColdSend({
      channelId: channelCtx.channel.id,
      accountId,
      contactId: contact.id,
      origin: coldSendOrigin!,
    });
  }

  return { messageId: messageRecord.id, whatsappMessageId: waMessageId };
}
