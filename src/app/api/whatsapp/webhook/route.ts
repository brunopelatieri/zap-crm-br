import { NextResponse, after } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption';
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { detectDeadNumberOnFailure } from '@/lib/contacts/whatsapp-status';
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature';
import { proxyMediaUrl } from '@/lib/storage/media-url';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import { ingestInbound, type IngestContext } from '@/lib/channels/ingest';
import { resolveDefaultChannelId } from '@/lib/channels/send';
import type { NormalizedMessage } from '@/lib/channels/types';
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from '@/lib/whatsapp/template-webhook';

// The `after()` callback in POST runs within this route's max duration.
// Inbound processing can fan out to per-media Meta verification calls, so
// give it headroom beyond the platform default (Vercel clamps this to the
// plan's ceiling). Tune as needed.
export const maxDuration = 60;

// Lazy-initialized to avoid build-time crash when env vars are missing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null;
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _adminClient;
}

interface WhatsAppMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type: string; caption?: string };
  video?: { id: string; mime_type: string; caption?: string };
  document?: {
    id: string;
    mime_type: string;
    filename?: string;
    caption?: string;
  };
  audio?: { id: string; mime_type: string };
  sticker?: { id: string; mime_type: string };
  location?: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };
  reaction?: { message_id: string; emoji: string };
  /**
   * Set when the customer taps a button or list row on an interactive
   * message we sent. `button_reply.id` / `list_reply.id` is whatever id
   * we put on the button/row when sending — the Flows engine uses this
   * to advance the per-contact run.
   */
  interactive?: {
    type: 'button_reply' | 'list_reply';
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  /**
   * Set when the customer taps a Quick Reply button on a message
   * TEMPLATE we sent. Distinct from `interactive` (which covers taps on
   * Interactive messages we composed ourselves) — Meta uses this
   * separate `button` type for template quick replies. `payload` is the
   * developer-defined value configured on the template button; `text` is
   * its display label.
   */
  button?: { text: string; payload: string };
  /** Present when the customer shares one or more contact cards. */
  contacts?: Array<{
    name?: { formatted_name?: string };
    phones?: Array<{ phone?: string }>;
  }>;
  /** Present when the customer swipe-replies to one of our messages. */
  context?: { id: string };
}

interface WhatsAppWebhookEntry {
  id: string;
  changes: Array<{
    value: {
      messaging_product: string;
      metadata: {
        display_phone_number: string;
        phone_number_id: string;
      };
      contacts?: Array<{
        profile: { name: string };
        wa_id: string;
      }>;
      messages?: WhatsAppMessage[];
      statuses?: Array<{
        id: string;
        status: string;
        timestamp: string;
        recipient_id: string;
        /**
         * Present on `status: 'failed'` events. `code` 131026 means the
         * recipient isn't a WhatsApp user (SPEC 044 §6.4) — see
         * `isInvalidWhatsappNumberError`.
         */
        errors?: Array<{
          code: number;
          title?: string;
          message?: string;
        }>;
      }>;
    };
    field: string;
  }>;
}

// GET - Webhook verification
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const mode = searchParams.get('hub.mode');
    const challenge = searchParams.get('hub.challenge');
    const verifyToken = searchParams.get('hub.verify_token');

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 400 }
      );
    }

    // Fetch all whatsapp configs to check verify tokens
    const { data: configs, error: configError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('id, verify_token');

    if (configError || !configs) {
      console.error('Error fetching configs for verification:', configError);
      return NextResponse.json(
        { error: 'Verification failed' },
        { status: 403 }
      );
    }

    // Check if any config's verify_token matches. Also collect the
    // matching row so we can opportunistically upgrade its token to
    // GCM if it was still in the legacy CBC format.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let matchedConfig: any = null;
    for (const config of configs) {
      if (!config.verify_token) continue;
      try {
        if (decrypt(config.verify_token) === verifyToken) {
          matchedConfig = config;
          break;
        }
      } catch {
        // Malformed / wrong-key token row — skip it and keep checking.
      }
    }

    if (matchedConfig) {
      // Fire-and-forget GCM upgrade. Safe to run on every subscribe
      // since it's a no-op once the column is already GCM.
      if (isLegacyFormat(matchedConfig.verify_token)) {
        void supabaseAdmin()
          .from('whatsapp_config')
          .update({ verify_token: encrypt(verifyToken) })
          .eq('id', matchedConfig.id)
          .then(({ error }: { error: unknown }) => {
            if (error) {
              console.warn(
                '[webhook] verify_token GCM upgrade failed:',
                (error as { message?: string })?.message ?? error
              );
            }
          });
      }
      // Return challenge as plain text
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    return NextResponse.json(
      { error: 'Verification token mismatch' },
      { status: 403 }
    );
  } catch (error) {
    console.error('Error in webhook GET verification:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// POST - Receive messages
export async function POST(request: Request) {
  // Read raw body first so we can HMAC-verify the exact bytes Meta
  // signed. request.json() would re-encode and break the signature.
  const rawBody = await request.text();
  const signature = request.headers.get('x-hub-signature-256');

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    // 401 (not 200) — we want Meta's delivery dashboard to show failures
    // loudly if a misconfiguration causes signatures to stop matching,
    // rather than silently eating events.
    console.warn('[webhook] rejected request with invalid signature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let body: { entry?: WhatsAppWebhookEntry[] };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Process AFTER the response so we ack Meta within their ~20s timeout
  // (a slow ack triggers Meta retries + duplicate inserts), while still
  // guaranteeing the work runs to completion.
  //
  // This MUST use `after()` rather than a detached `processWebhook(body)`
  // promise: on serverless platforms (we run on Vercel) the function can
  // be frozen or terminated the moment the response is sent, so a floating
  // promise's DB writes are not guaranteed to finish. That dropped a
  // non-deterministic *subset* of inbound messages — contacts/conversations
  // were created but the message insert never landed, leaving conversations
  // that show in the inbox with an empty thread, and no logs to explain it
  // (see issue #301). `after()` hands the callback to the runtime, which
  // keeps the function alive until it resolves (within the route's
  // maxDuration).
  after(async () => {
    try {
      await processWebhook(body);
    } catch (error) {
      console.error('Error processing webhook:', error);
    }
  });

  return NextResponse.json({ status: 'received' }, { status: 200 });
}

async function processWebhook(body: { entry?: WhatsAppWebhookEntry[] }) {
  if (!body.entry) return;

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      // Template-lifecycle events (status / quality / components
      // updates from Meta) come in on a different change.field and
      // have a different value shape — route them through the
      // dedicated handler. Skip the messaging branches below so we
      // don't try to read message-shaped fields off a template event.
      if (isTemplateWebhookField(change.field)) {
        await handleTemplateWebhookChange(
          { field: change.field, value: change.value as unknown },
          supabaseAdmin()
        );
        continue;
      }

      const value = change.value;

      // Handle status updates
      if (value.statuses) {
        for (const status of value.statuses) {
          await handleStatusUpdate(status);
        }
      }

      // Handle incoming messages
      if (!value.messages || !value.contacts) continue;

      const phoneNumberId = value.metadata.phone_number_id;

      // Find user's config by phone_number_id. `.single()` returns
      // PGRST116 for both 0 rows AND ≥2 rows — distinguish them so
      // operators see the real cause in logs. ≥2 rows shouldn't happen
      // post-migration 013 (UNIQUE constraint), but a row created
      // before the constraint, or a race, would still surface here.
      const { data: configRows, error: configError } = await supabaseAdmin()
        .from('whatsapp_config')
        .select('*')
        .eq('phone_number_id', phoneNumberId);

      if (configError) {
        console.error(
          'Error fetching whatsapp_config for phone_number_id:',
          phoneNumberId,
          configError
        );
        continue;
      }

      if (!configRows || configRows.length === 0) {
        console.error('No config found for phone_number_id:', phoneNumberId);
        continue;
      }

      if (configRows.length > 1) {
        console.error(
          `Multiple configs (${configRows.length}) found for phone_number_id:`,
          phoneNumberId,
          '— inbound message dropped. Resolve duplicates so each number maps to a single account.',
          'Account owners:',
          configRows.map(
            (r: { account_id: string; user_id: string }) =>
              `${r.account_id} (admin ${r.user_id})`
          )
        );
        continue;
      }

      const config = configRows[0];

      const decryptedAccessToken = decrypt(config.access_token);

      for (let i = 0; i < value.messages.length; i++) {
        const message = value.messages[i];
        const contact = value.contacts[i] || value.contacts[0];

        await processMessage(
          message,
          contact,
          // Tenancy — drives every contact / conversation lookup
          // and the engines' active-row dispatch.
          config.account_id,
          // Audit / sender-of-record — used as the user_id on row
          // inserts that need it for NOT NULL FK compliance. Always
          // the admin who saved the WhatsApp config.
          config.user_id,
          decryptedAccessToken,
          // `channel_id` já vive em `whatsapp_config` desde a 055; o
          // fallback só cobre uma conta que nunca passou pelo backfill.
          config.channel_id ??
            (await resolveDefaultChannelId(supabaseAdmin(), config.account_id))
        );
      }
    }
  }
}

// The happy-path status ladder — pending → sent → delivered → read →
// replied. Webhook replays must never regress a recipient back down
// this ladder.
//
// `failed` is NOT on this ladder. It's a terminal side branch that is
// only valid from the early states (pending / sent) — once Meta has
// delivered or the user has read or replied, a later "failed" status
// event is a bug in Meta's pipeline or a spoof attempt and must be
// ignored.
const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const;

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s);
  return idx < 0 ? -1 : idx;
}

/**
 * Can a recipient transition from `current` to `incoming`?
 *   - Along the ladder, only forward moves are allowed.
 *   - `failed` is accepted only from `pending` or `sent`; it's refused
 *     once the recipient has reached any of the success states.
 */
function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent';
  }
  if (current === 'failed') {
    return false; // failed is terminal
  }
  const ci = ladderLevel(current);
  const ii = ladderLevel(incoming);
  if (ii < 0) return false; // unknown incoming status
  if (ci < 0) return true; // unknown current — accept anything on the ladder
  return ii > ci;
}

async function handleStatusUpdate(status: {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
  errors?: Array<{ code: number; title?: string; message?: string }>;
}) {
  // Meta's async "message undeliverable" callback — the only place this
  // error ever surfaces, since the send call itself already returned
  // 200. Computed once, up front, so both mirrors below (messages and
  // broadcast_recipients) persist the same reason.
  let errorMessage: string | null = null;
  if (status.status === 'failed' && status.errors && status.errors[0]) {
    const e = status.errors[0];
    errorMessage = e.message
      ? `(#${e.code}) ${e.title ?? ''}: ${e.message}`.trim()
      : `(#${e.code}) ${e.title ?? 'Message undeliverable'}`;
  }

  // 1) Mirror onto messages (legacy behavior) — Meta's status values
  //    already match the CHECK constraint on messages.status. No
  //    `.select()`: message_id is NOT unique (migration 009 — Meta ids
  //    repeat across numbers), so this updates 0..N rows and must not
  //    assume a single row.
  const { error: msgErr } = await supabaseAdmin()
    .from('messages')
    .update({
      status: status.status,
      ...(errorMessage ? { error_message: errorMessage } : {}),
    })
    .eq('message_id', status.id);

  if (msgErr) {
    console.error('Error updating message status:', msgErr);
  }

  // Webhook fan-out for this status change happens at the END of this
  // handler (after the broadcast mirror below), so a slow subscriber
  // endpoint can't delay the broadcast_recipients update.

  // 2) Mirror onto broadcast_recipients via whatsapp_message_id
  //    (added in migration 003). The aggregate trigger on
  //    broadcast_recipients re-derives the parent broadcast's
  //    sent/delivered/read/failed counts automatically.
  const tsIso = new Date(parseInt(status.timestamp) * 1000).toISOString();

  const { data: recipient, error: recFetchErr } = await supabaseAdmin()
    .from('broadcast_recipients')
    .select('id, status, contact_id')
    .eq('whatsapp_message_id', status.id)
    .maybeSingle();

  if (recFetchErr) {
    console.error('Error fetching broadcast recipient:', recFetchErr);
  } else if (
    recipient &&
    // Guard transitions — forward-only on the success ladder, and
    // `failed` only from pre-delivered states.
    isValidStatusTransition(recipient.status, status.status)
  ) {
    const update: Record<string, unknown> = { status: status.status };
    if (status.status === 'sent' && !('sent_at' in update))
      update.sent_at = tsIso;
    if (status.status === 'delivered') update.delivered_at = tsIso;
    if (status.status === 'read') update.read_at = tsIso;
    if (errorMessage) update.error_message = errorMessage;

    const { error: recUpdateErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update(update)
      .eq('id', recipient.id);

    if (recUpdateErr) {
      console.error('Error updating broadcast recipient status:', recUpdateErr);
    } else if (status.status === 'failed' && recipient.contact_id) {
      // Auto-limpeza de números mortos (§6.4) — best-effort.
      await detectDeadNumberOnFailure(supabaseAdmin(), {
        contactId: recipient.contact_id,
        errorMessage,
      });
    }
  }

  // 3) Webhook fan-out for messages we store (inbox / API sends).
  //    Runs last so a slow subscriber can't delay the mirrors above.
  //    Bounded to one row (message_id isn't unique) purely to resolve
  //    the owning account for delivery.
  const { data: msgRow } = await supabaseAdmin()
    .from('messages')
    .select(
      'conversation_id, conversations(account_id, channel_id, channels(type))'
    )
    .eq('message_id', status.id)
    .limit(1)
    .maybeSingle();

  if (msgRow) {
    const conv = msgRow.conversations as {
      account_id: string;
      channel_id: string | null;
      channels: { type: string } | { type: string }[] | null;
    } | null;
    const accountId = conv?.account_id;
    if (accountId) {
      // SPEC 049 §5.5 — purely additive, same fields as message.received
      // / conversation.created: existing subscribers ignore what they
      // don't know about.
      const channelRel = conv?.channels;
      const channelType = Array.isArray(channelRel)
        ? channelRel[0]?.type
        : channelRel?.type;
      await dispatchWebhookEvent(
        supabaseAdmin(),
        accountId,
        'message.status_updated',
        {
          whatsapp_message_id: status.id,
          conversation_id: msgRow.conversation_id,
          status: status.status,
          channel_id: conv?.channel_id ?? null,
          channel_type: channelType ?? null,
        }
      );
    }
  }
}

/**
 * Mapeia o `type` que a Meta entrega para o `content_type` do nosso
 * schema.
 *
 * A CHECK constraint de `messages.content_type` (ampliada na migração
 * 010 para aceitar 'interactive') permite: text, image, document, audio,
 * video, location, template, interactive. Tipos de entrada que não estão
 * nessa lista são mapeados para o valor permitido mais próximo, senão o
 * INSERT falha por violação de constraint.
 *
 * É tradução ESPECÍFICA DA META e por isso ficou na rota: o canal QRCode
 * entrega outro vocabulário e terá o seu próprio mapeamento.
 */
function toStoredContentType(
  metaType: string
): NormalizedMessage['contentType'] {
  const ALLOWED_CONTENT_TYPES = new Set([
    'text',
    'image',
    'document',
    'audio',
    'video',
    'location',
    'template',
    'interactive',
  ]);
  const stored = ALLOWED_CONTENT_TYPES.has(metaType)
    ? metaType
    : metaType === 'sticker'
      ? 'image' // stickers are images
      : metaType === 'button'
        ? 'interactive' // template quick-reply tap — same UI as an interactive tap
        : 'text'; // reaction, contacts, unknown → text fallback
  // `template` está na constraint mas não no vocabulário de entrada — a
  // Meta nunca entrega uma mensagem RECEBIDA com esse tipo. O cast cobre
  // essa diferença sem afrouxar o mapeamento acima.
  return stored as NormalizedMessage['contentType'];
}

async function processMessage(
  message: WhatsAppMessage,
  contact: { profile: { name: string }; wa_id: string },
  // Tenancy. Resolved from the matched whatsapp_config row; every
  // contact / conversation / message row created downstream is
  // stamped with this so any member of the account can see it.
  accountId: string,
  // Sender-of-record for inserts that need a NOT NULL user_id FK
  // (contacts, conversations). Always the admin who saved the
  // WhatsApp config; the choice is arbitrary post-017 but stable.
  configOwnerUserId: string,
  accessToken: string,
  channelId: string
) {
  // Tudo o que acontece DEPOIS de uma mensagem entrar (contato,
  // conversa, janela de 24h, opt-out, flows, automações, IA, webhooks de
  // saída) mora em `lib/channels/ingest.ts` desde a F2 — ver o cabeçalho
  // de lá. O que sobrou aqui é a tradução do formato da Meta.
  const ctx: IngestContext = {
    db: supabaseAdmin(),
    accountId,
    ownerUserId: configOwnerUserId,
    channelType: 'whatsapp_cloud',
    channelId,
  };

  const senderPhone = normalizePhone(message.from);
  const contactName = contact.profile.name;

  // Instante DA META, não do nosso servidor (SPEC 045 §5.2.1) — o
  // ingest o usa tanto no `created_at` da mensagem quanto na âncora da
  // janela de sessão, e um `new Date()` aqui produziria uma âncora no
  // futuro sempre que o webhook chegasse atrasado.
  const metaMessageAt = new Date(parseInt(message.timestamp) * 1000);

  // Reactions aren't messages: the ingest never inserts into `messages`,
  // never bumps unread_count and never touches last_message_text for
  // them. Short-circuiting via the event kind (instead of parsing the
  // content first) is what keeps the media-URL fetch out of this path.
  if (message.type === 'reaction') {
    await ingestInbound(ctx, {
      kind: 'reaction',
      fromPhone: senderPhone,
      pushName: contactName,
      // Vazio quando a Meta manda um evento de reação sem alvo. O
      // ingest ignora a reação nesse caso — mas só DEPOIS de contato e
      // conversa existirem, que é como esta rota sempre se comportou.
      targetProviderMessageId: message.reaction?.message_id ?? '',
      // Emoji vazio = remoção da reação (spec da Cloud API).
      emoji: message.reaction?.emoji ?? '',
      occurredAt: metaMessageAt,
    });
    return;
  }

  // Parse message content based on type.
  //
  // ⚠️ Mudança de ORDEM em relação ao código anterior à F2: a
  //    verificação da mídia contra a Graph API acontecia DEPOIS de
  //    contato e conversa existirem; agora acontece antes, porque virou
  //    parte da tradução. Nada observável muda — `verifyMedia` nunca
  //    lança (falha vira `mediaUrl: null`) e o resultado só é usado no
  //    INSERT da mensagem. O custo é uma chamada à Meta desperdiçada no
  //    caso raro em que a criação do contato falha logo depois.
  const { contentText, mediaUrl, mediaId, mediaType, interactiveReplyId } =
    await parseMessageContent(message, accessToken);

  // `mediaType` is intentionally unused — the schema has no media_type
  // column; the MIME type is only used to construct the proxy URL during
  // parseMessageContent. Silence the unused-var warning:
  void mediaType;

  await ingestInbound(ctx, {
    kind: 'message',
    fromPhone: senderPhone,
    pushName: contactName,
    providerMessageId: message.id,
    // A Meta nunca entrega no webhook uma mensagem que NÓS enviamos —
    // ao contrário do canal QRCode, que entrega (`SEND_MESSAGE`).
    fromMe: false,
    contentType: toStoredContentType(message.type),
    // `contentText` já é o valor final. Para `type: 'text'` ele é
    // `text.body || null`, então o antigo fallback duplo
    // (`contentText ?? message.text?.body ?? ''`) nunca podia produzir
    // valor diferente de `contentText ?? ''` — que é exatamente o que o
    // ingest faz com este campo.
    text: contentText,
    mediaUrl,
    mediaId,
    interactiveReplyId,
    occurredAt: metaMessageAt,
    // Resposta com citação. O ingest resolve o pai dentro da conversa;
    // pai ausente vira NULL e a bolha renderiza sem a citação.
    replyToProviderMessageId: message.context?.id ?? null,
    // O preview da lista de conversas sempre mostrou o tipo CRU
    // (`[sticker]`, `[contacts]`), não o normalizado (`[image]`).
    providerContentLabel: message.type,
  });
}

async function parseMessageContent(
  message: WhatsAppMessage,
  accessToken: string
): Promise<{
  contentText: string | null;
  mediaUrl: string | null;
  /**
   * Id da mídia na Meta. Persistido em `messages.media_id` (migração
   * 040) porque é por ele que a rota-proxy autoriza o download: sem
   * uma coluna própria, o id só existiria embutido na string de
   * `mediaUrl` e a autorização ficaria amarrada ao formato da rota.
   * Só é preenchido quando a verificação com a Meta passou — um id
   * cuja mídia não existe não deve virar uma linha "autorizável".
   */
  mediaId: string | null;
  mediaType: string | null;
  /**
   * For interactive button / list replies: the stable id of the tapped
   * option (whatever we put on the button when sending). Used by the
   * Flows engine to advance the per-contact run; persisted to
   * `messages.interactive_reply_id` so the inbox bubble can render the
   * tap with the right affordance. Null for everything else.
   */
  interactiveReplyId: string | null;
}> {
  // getMediaUrl signature is (mediaId, accessToken) — earlier code had
  // the args swapped, so every verification hit an invalid Meta URL and
  // fell through to the catch block, leaving mediaUrl as null. That's
  // why images showed up as empty bubbles in the inbox.
  //
  // Devolve os dois campos juntos, e não só a URL, para que seja
  // impossível gravar `media_id` sem `media_url` (ou o contrário): a
  // rota-proxy autoriza por `media_id` e exibe o que a `media_url`
  // aponta — se um existir sem o outro, ou a mídia fica inacessível ou
  // fica autorizável sem existir.
  const verifyMedia = async (
    mediaId: string
  ): Promise<{ mediaUrl: string | null; mediaId: string | null }> => {
    try {
      await getMediaUrl({ mediaId, accessToken });
      return { mediaUrl: proxyMediaUrl(mediaId), mediaId };
    } catch (error) {
      console.error(
        `Failed to verify media ${mediaId} with Meta:`,
        error instanceof Error ? error.message : error
      );
      return { mediaUrl: null, mediaId: null };
    }
  };

  // Default shape — each case overrides only the fields it cares about.
  // Keeps the new `interactiveReplyId` field DRY across every return site.
  const empty = {
    contentText: null,
    mediaUrl: null,
    mediaId: null,
    mediaType: null,
    interactiveReplyId: null,
  };

  switch (message.type) {
    case 'text':
      return { ...empty, contentText: message.text?.body || null };

    case 'image':
      if (message.image?.id) {
        return {
          ...empty,
          contentText: message.image.caption || null,
          ...(await verifyMedia(message.image.id)),
          mediaType: message.image.mime_type,
        };
      }
      return empty;

    case 'video':
      if (message.video?.id) {
        return {
          ...empty,
          contentText: message.video.caption || null,
          ...(await verifyMedia(message.video.id)),
          mediaType: message.video.mime_type,
        };
      }
      return empty;

    case 'document':
      if (message.document?.id) {
        return {
          ...empty,
          contentText:
            message.document.caption || message.document.filename || null,
          ...(await verifyMedia(message.document.id)),
          mediaType: message.document.mime_type,
        };
      }
      return empty;

    case 'audio':
      if (message.audio?.id) {
        return {
          ...empty,
          ...(await verifyMedia(message.audio.id)),
          mediaType: message.audio.mime_type,
        };
      }
      return empty;

    case 'sticker':
      // Stickers are images under the hood. Treat them as such so the
      // MessageBubble renders the <img>. The caller maps the DB
      // content_type to 'image' for the CHECK constraint.
      if (message.sticker?.id) {
        return {
          ...empty,
          ...(await verifyMedia(message.sticker.id)),
          mediaType: message.sticker.mime_type,
        };
      }
      return empty;

    case 'location':
      if (message.location) {
        const loc = message.location;
        const locationText = [
          loc.name,
          loc.address,
          `${loc.latitude},${loc.longitude}`,
        ]
          .filter(Boolean)
          .join(' - ');
        return { ...empty, contentText: locationText };
      }
      return empty;

    case 'reaction':
      return { ...empty, contentText: message.reaction?.emoji || null };

    case 'interactive': {
      // The customer tapped a reply button or a list row on a message
      // we previously sent. Meta delivers `interactive.button_reply` for
      // 3-button messages and `interactive.list_reply` for list messages.
      // Use the human-readable title as contentText so the inbox bubble
      // renders the tap legibly ("Existing customer"), and stash the
      // stable id separately so the Flows engine can route on it.
      const reply =
        message.interactive?.button_reply ?? message.interactive?.list_reply;
      if (reply?.id) {
        return {
          ...empty,
          contentText: reply.title || reply.id,
          interactiveReplyId: reply.id,
        };
      }
      return { ...empty, contentText: '[Interactive reply]' };
    }

    case 'button':
      // Quick-reply tap on a message TEMPLATE (not an Interactive message —
      // see the `button` field comment on WhatsAppMessage). Same shape/intent
      // as interactive.button_reply, so route it through interactiveReplyId
      // too: Flows/automations that key off a tapped option's stable id work
      // the same way regardless of whether the tap came from a template or
      // an interactive send.
      if (message.button) {
        return {
          ...empty,
          contentText: message.button.text || message.button.payload || null,
          interactiveReplyId: message.button.payload || null,
        };
      }
      return { ...empty, contentText: '[Button reply]' };

    case 'contacts': {
      const names = (message.contacts ?? [])
        .map((c) => c.name?.formatted_name)
        .filter((n): n is string => !!n);
      return {
        ...empty,
        contentText: names.length
          ? `\u{1F464} ${names.join(', ')}`
          : '[Contact shared]',
      };
    }

    default:
      return {
        ...empty,
        contentText: `[Unsupported message type: ${message.type}]`,
      };
  }
}
