import type {
  InteractiveButton,
  InteractiveListSection,
  MediaKind,
} from '@/lib/whatsapp/meta-api';
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive';
import { resolveMediaUrlForServer } from '@/lib/storage/sign-media';
import { sendAndPersistOutbound } from '@/lib/channels/send';
import { supabaseAdmin } from './admin-client';

// ------------------------------------------------------------
// Flows-side sender.
//
// Mirrors src/lib/automations/meta-send.ts (engineSendText /
// engineSendTemplate) but also emits media + interactive button/list
// messages.
//
// Desde a F2 (PRD 047 / SPEC 048 §5) o esqueleto — resolver o contato
// pela conta, carregar as credenciais do canal, tentar as variantes de
// telefone, gravar a mensagem e atualizar o preview — vive em
// `lib/channels/send.ts`, e a chamada ao provedor passa pelo adaptador
// do canal. O que continua aqui é o que é DESTE motor: quais colunas
// cada tipo de envio grava (`ai_generated`, `interactive_payload`) e
// como o preview da conversa é montado.
//
// O nome do arquivo é mantido de propósito — vários módulos e testes
// importam `@/lib/flows/meta-send` por este caminho.
// ------------------------------------------------------------

interface SendTextEngineArgs {
  /** Account-level tenancy key. Drives contact + whatsapp_config
   *  lookups so a flow authored by user A still sends through the
   *  WhatsApp number user B saved on the same account. */
  accountId: string;
  /** Original author of the flow — used for INSERT audit columns
   *  and for resolving the agent's identity in logs. Not consulted
   *  for tenancy. */
  userId: string;
  conversationId: string;
  contactId: string;
  text: string;
  /** Marks the persisted message row `ai_generated = true` so the inbox
   *  badges it as an AI reply. Only the auto-reply bot sets this;
   *  deterministic Flow/automation sends leave it false. */
  aiGenerated?: boolean;
}

/**
 * Send a plain-text WhatsApp message from the Flows engine.
 *
 * Used by the runner's `send_message` and `collect_input` nodes —
 * both prompt the customer with text and either auto-advance (the
 * send_message case) or suspend awaiting a text reply (collect_input).
 *
 * Wraps the same phone-variant retry + DB persistence pattern as the
 * interactive senders; the duplication will be DRY'd into a shared
 * `engineSendBase` once the v2 features (templates with variables,
 * media sends) settle.
 */
export async function engineSendText(
  args: SendTextEngineArgs
): Promise<{ whatsapp_message_id: string }> {
  return sendAndPersistOutbound({
    db: supabaseAdmin(),
    accountId: args.accountId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    content: { kind: 'text', text: args.text },
    persist: {
      // `bot` distingue envio de motor de envio manual de agente; a
      // lista de conversas usa `last_message_text` como resumo.
      senderType: 'bot',
      contentType: 'text',
      contentText: args.text,
      previewText: args.text,
      extra: { ai_generated: args.aiGenerated ?? false },
    },
  });
}

interface SendMediaEngineArgs {
  accountId: string;
  userId: string;
  conversationId: string;
  contactId: string;
  kind: MediaKind;
  /** Public URL Meta fetches at send time. */
  link: string;
  caption?: string;
  /** Document-only; ignored by Meta for image/video. */
  filename?: string;
}

/**
 * Send an image / video / document from the Flows engine.
 *
 * Used by the runner's `send_media` node. Auto-advances after the
 * send lands (same suspend semantics as send_message). Same
 * phone-variant retry + DB persistence as the text/interactive
 * senders; persists the outgoing message with `content_type` matching
 * the media kind so the inbox renders the right preview.
 */
export async function engineSendMedia(
  args: SendMediaEngineArgs
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin();

  // O `link` vem do config do nó (`cfg.media_url`), que pode ser um
  // objeto nosso no bucket `flow-media` — privado desde a migração 040 —
  // ou uma URL externa que o usuário colou no builder. A primeira
  // precisa ser assinada para o provedor conseguir buscá-la; a segunda
  // passa intocada. Assinado UMA vez, fora do laço de variantes, para
  // não gerar uma assinatura nova por telefone tentado.
  const outboundLink = await resolveMediaUrlForServer(db, args.link);
  if (!outboundLink) {
    throw new Error(
      'Could not resolve the media for sending — the file may have been removed from storage.'
    );
  }

  return sendAndPersistOutbound({
    db,
    accountId: args.accountId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    content: {
      kind: 'media',
      mediaKind: args.kind,
      link: outboundLink,
      caption: args.caption,
      filename: args.filename,
    },
    persist: {
      senderType: 'bot',
      // content_type='image'|'video'|'document' — these are already in
      // the messages_content_type_check constraint (migration 001 + 010).
      contentType: args.kind,
      // content_text carries the caption (or empty) so the conversation
      // list preview shows something meaningful when the user glances at it.
      contentText: args.caption ?? null,
      previewText: args.caption?.trim() || `[${args.kind}]`,
    },
  });
}

interface SendInteractiveButtonsEngineArgs {
  accountId: string;
  userId: string;
  conversationId: string;
  contactId: string;
  bodyText: string;
  buttons: InteractiveButton[];
  headerText?: string;
  footerText?: string;
}

interface SendInteractiveListEngineArgs {
  accountId: string;
  userId: string;
  conversationId: string;
  contactId: string;
  bodyText: string;
  buttonLabel: string;
  sections: InteractiveListSection[];
  headerText?: string;
  footerText?: string;
}

/**
 * Send an interactive-button WhatsApp message from the Flows engine.
 *
 * Persists the outgoing message to `messages` with
 * `content_type='interactive'` and `sender_type='bot'` so the inbox
 * surfaces it with the "Button reply" affordance and the conversation
 * thread reflects the bot's prompt.
 *
 * Returns the Meta message id so the caller (engine) can stash it on
 * the `flow_runs.last_prompt_message_id` field for later reference.
 */
export async function engineSendInteractiveButtons(
  args: SendInteractiveButtonsEngineArgs
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaMeta({ ...args, kind: 'buttons' });
}

/**
 * Send an interactive-list WhatsApp message from the Flows engine.
 * Used when the flow needs more than 3 options (Meta's button cap).
 */
export async function engineSendInteractiveList(
  args: SendInteractiveListEngineArgs
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaMeta({ ...args, kind: 'list' });
}

type SendInput =
  | (SendInteractiveButtonsEngineArgs & { kind: 'buttons' })
  | (SendInteractiveListEngineArgs & { kind: 'list' });

async function sendInteractiveViaMeta(
  input: SendInput
): Promise<{ whatsapp_message_id: string }> {
  // O payload estruturado serve a DOIS propósitos: é o que o adaptador
  // do canal traduz para o provedor e é o que fica gravado na linha,
  // para que a thread do inbox re-renderize os botões/linhas que o bot
  // mandou (ida e volta), igual aos caminhos do composer e das
  // automações.
  const interactivePayload: InteractiveMessagePayload =
    input.kind === 'buttons'
      ? {
          kind: 'buttons',
          body: input.bodyText,
          header: input.headerText,
          footer: input.footerText,
          buttons: input.buttons,
        }
      : {
          kind: 'list',
          body: input.bodyText,
          header: input.headerText,
          footer: input.footerText,
          button_label: input.buttonLabel,
          sections: input.sections,
        };

  return sendAndPersistOutbound({
    db: supabaseAdmin(),
    accountId: input.accountId,
    conversationId: input.conversationId,
    contactId: input.contactId,
    content: { kind: 'interactive', payload: interactivePayload },
    persist: {
      // Persist the bot's prompt to the messages table so it appears in
      // the inbox. content_type='interactive' is supported as of
      // migration 010; sender_type='bot' distinguishes flow sends from
      // manual agent sends.
      //
      // We do NOT set interactive_reply_id here — that column is
      // reserved for the customer's tap on this message, populated by
      // the ingest when their reply arrives.
      senderType: 'bot',
      contentType: 'interactive',
      contentText: input.bodyText,
      previewText: input.bodyText,
      extra: { interactive_payload: interactivePayload },
    },
  });
}
