import { sendTextMessage, sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { withSignedHeaderMedia } from '@/lib/whatsapp/header-media';
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive';
import type { MessageTemplate, TemplatePreviewPayload } from '@/types';
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import { renderTemplateText } from '@/lib/whatsapp/template-send-builder';
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
} from '@/lib/flows/meta-send';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import { supabaseAdmin } from './admin-client';

// ------------------------------------------------------------
// Automation-side Meta sender.
//
// Mirrors the logic in src/app/api/whatsapp/send/route.ts but uses
// the service-role client (engine has no cookies) and accepts the
// user / conversation / contact identifiers the engine already has
// on hand. Kept here (rather than refactoring the user-facing send
// route) to avoid risk to the working manual-send path — they can
// converge in a later refactor.
// ------------------------------------------------------------

interface SendTextArgs {
  /** Account-level tenancy key. Drives contact + whatsapp_config
   *  lookups so an automation authored by user A still sends through
   *  the WhatsApp number user B saved on the same account. */
  accountId: string;
  /** Original author of the automation/flow — used for INSERT audit
   *  columns (messages.sender_id-ish) and for resolving the agent's
   *  identity in logs. Not consulted for tenancy. */
  userId: string;
  conversationId: string;
  contactId: string;
  text: string;
}

interface SendTemplateArgs {
  accountId: string;
  userId: string;
  conversationId: string;
  contactId: string;
  templateName: string;
  language?: string;
  params?: string[];
}

export async function engineSendText(
  args: SendTextArgs
): Promise<{ whatsapp_message_id: string }> {
  return sendViaMeta({ ...args, kind: 'text' });
}

export async function engineSendTemplate(
  args: SendTemplateArgs
): Promise<{ whatsapp_message_id: string }> {
  return sendViaMeta({ ...args, kind: 'template' });
}

interface SendInteractiveArgs {
  accountId: string;
  userId: string;
  conversationId: string;
  contactId: string;
  payload: InteractiveMessagePayload;
}

/**
 * Send an interactive (reply-buttons or list) message from the
 * automation engine.
 *
 * Delegates to the Flows interactive senders
 * (`engineSendInteractiveButtons` / `engineSendInteractiveList`), which
 * already own the account-scoped lookup, phone-variant retry, and the
 * `messages` insert with `interactive_payload` + `sender_type='bot'`.
 * Both engines want identical behaviour here, so there's one
 * implementation rather than a second hand-rolled copy that could drift.
 */
export async function engineSendInteractive(
  args: SendInteractiveArgs
): Promise<{ whatsapp_message_id: string }> {
  const { payload, accountId, userId, conversationId, contactId } = args;
  const common = { accountId, userId, conversationId, contactId };
  if (payload.kind === 'buttons') {
    return engineSendInteractiveButtons({
      ...common,
      bodyText: payload.body,
      headerText: payload.header,
      footerText: payload.footer,
      buttons: payload.buttons,
    });
  }
  return engineSendInteractiveList({
    ...common,
    bodyText: payload.body,
    buttonLabel: payload.button_label,
    headerText: payload.header,
    footerText: payload.footer,
    sections: payload.sections,
  });
}

type SendInput =
  (SendTextArgs & { kind: 'text' }) | (SendTemplateArgs & { kind: 'template' });

async function sendViaMeta(
  input: SendInput
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin();

  // Scope the contact + config lookups by account_id, not user_id.
  // The engine uses the service-role client (bypassing RLS); without
  // this filter, an authenticated user could fire their own
  // automations against another tenant's contact UUID and send via
  // their own WhatsApp config to that contact's phone. The 017
  // migration moved both tables to account-scoped tenancy, so the
  // check is the same defense-in-depth as before, just keyed on the
  // new tenancy column.
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', input.contactId)
    .eq('account_id', input.accountId)
    .maybeSingle();
  if (contactErr || !contact?.phone) {
    throw new Error('contact not found for this account');
  }

  const sanitized = sanitizePhoneForMeta(contact.phone);
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`);
  }

  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', input.accountId)
    .single();
  if (configErr || !config) {
    throw new Error('WhatsApp not configured for this account');
  }

  const accessToken = decrypt(config.access_token);

  // Load the local template row so the send builds the full components
  // array (required for media-header templates — Meta rejects those
  // without the header component on every send) and so the persisted
  // message carries `template_preview` for the inbox bubble. A template
  // that only exists on Meta (never synced locally) still sends via the
  // legacy body-only path and just renders as plain text in the chat.
  let templateRow: MessageTemplate | null = null;
  if (input.kind === 'template') {
    const { data } = await db
      .from('message_templates')
      .select('*')
      .eq('account_id', input.accountId)
      .eq('name', input.templateName)
      .eq('language', input.language || 'en_US')
      .maybeSingle();
    if (data && isMessageTemplate(data)) templateRow = data;
  }

  // Header de mídia: o bucket virou privado na migração 040, então a
  // URL guardada no template não é mais buscável pela Meta. Assina uma
  // vez, fora do `attempt`, para não gerar uma assinatura nova a cada
  // variante de telefone tentada.
  const templateSendParams = await withSignedHeaderMedia(
    db,
    templateRow ?? undefined
  );

  const attempt = async (phone: string): Promise<string> => {
    if (input.kind === 'template') {
      const r = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        templateName: input.templateName,
        language: input.language,
        template: templateRow ?? undefined,
        messageParams: templateSendParams,
        params: input.params,
      });
      return r.messageId;
    }
    const r = await sendTextMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      text: input.text,
    });
    return r.messageId;
  };

  // Same phone-variant retry as /api/whatsapp/send — Meta sandbox and
  // numbers registered with/without a trunk 0 both require this to
  // reliably land a message.
  const variants = phoneVariants(sanitized);
  let workingPhone = sanitized;
  let waMessageId = '';
  let lastError: unknown = null;
  for (const v of variants) {
    try {
      waMessageId = await attempt(v);
      workingPhone = v;
      lastError = null;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isRecipientNotAllowedError(msg)) throw err;
      lastError = err;
    }
  }
  if (lastError) throw lastError;

  if (workingPhone !== sanitized) {
    await db
      .from('contacts')
      .update({ phone: workingPhone })
      .eq('id', contact.id);
  }

  // Persist the sent message so it appears in the inbox with a real
  // Meta message id. sender_type='bot' distinguishes automation sends
  // from manual agent sends.
  // Templates: when the local row was found, resolve header/body/footer/
  // buttons into `template_preview` (mirrors sendMessageToConversation,
  // migration 037) so the bubble renders the template in full instead of
  // an empty "Template" badge. Automations only carry positional body
  // params — a text-header {{1}} has no value source here, so it keeps
  // its placeholder (visible, not wrong).
  let templatePreview: TemplatePreviewPayload | null = null;
  let renderedBody: string | null = null;
  if (input.kind === 'template' && templateRow) {
    renderedBody = renderTemplateText(templateRow.body_text, input.params ?? []);
    const headerMediaType =
      templateRow.header_type === 'image' ||
      templateRow.header_type === 'video' ||
      templateRow.header_type === 'document'
        ? templateRow.header_type
        : null;
    templatePreview = {
      header:
        templateRow.header_type === 'text' && templateRow.header_content
          ? templateRow.header_content
          : undefined,
      headerMedia:
        headerMediaType && templateRow.header_media_url
          ? { type: headerMediaType, url: templateRow.header_media_url }
          : undefined,
      body: renderedBody,
      footer: templateRow.footer_text,
      buttons: templateRow.buttons,
    };
  }

  const content_type = input.kind === 'template' ? 'template' : 'text';
  const content_text = input.kind === 'text' ? input.text : renderedBody;
  const template_name = input.kind === 'template' ? input.templateName : null;

  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: input.conversationId,
    sender_type: 'bot',
    content_type,
    content_text,
    template_name,
    template_preview: templatePreview,
    message_id: waMessageId,
    status: 'sent',
  });
  if (msgErr) {
    // Meta already has the message; record the DB error but don't pretend
    // the send failed. The engine wraps this in a log line.
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`);
  }

  await db
    .from('conversations')
    .update({
      last_message_text:
        input.kind === 'template'
          ? (renderedBody ?? `[template:${input.templateName}]`)
          : input.text,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.conversationId);

  return { whatsapp_message_id: waMessageId };
}
