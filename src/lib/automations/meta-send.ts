import { withSignedHeaderMedia } from '@/lib/whatsapp/header-media';
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive';
import type { MessageTemplate, TemplatePreviewPayload } from '@/types';
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import { renderTemplateText } from '@/lib/whatsapp/template-send-builder';
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
} from '@/lib/flows/meta-send';
import { sendAndPersistOutbound } from '@/lib/channels/send';
import { supabaseAdmin } from './admin-client';

// ------------------------------------------------------------
// Automation-side sender.
//
// Usa o cliente de service-role (o motor não tem cookies) e aceita os
// identificadores de usuário / conversa / contato que o motor já tem em
// mãos.
//
// Desde a F2 (PRD 047 / SPEC 048 §5) o esqueleto de envio vive em
// `lib/channels/send.ts` e a chamada ao provedor passa pelo adaptador do
// canal. O que continua aqui é o que é DESTE motor: carregar a linha
// local do template, assinar o header de mídia e montar o
// `template_preview` da bolha.
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

  // O escopo por `account_id` (e não por `user_id`) do contato e das
  // credenciais é aplicado dentro de `lib/channels/send.ts` — ver lá o
  // porquê: o motor usa service-role, com a RLS desligada.
  //
  // ⚠️ Diferença de ORDEM em relação ao código anterior à F2: a linha do
  //    template e a assinatura do header passaram a ser resolvidas ANTES
  //    da validação do contato e do canal (antes vinham depois). Nada
  //    observável muda — as duas primeiras são leituras —, exceto o
  //    texto do erro quando contato E header de mídia estão quebrados ao
  //    mesmo tempo.

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
  // vez, fora do laço de variantes, para não gerar uma assinatura nova a
  // cada telefone tentado.
  const templateSendParams = await withSignedHeaderMedia(
    db,
    templateRow ?? undefined
  );

  // Persist the sent message so it appears in the inbox with a real
  // provider message id. sender_type='bot' distinguishes automation
  // sends from manual agent sends.
  // Templates: when the local row was found, resolve header/body/footer/
  // buttons into `template_preview` (mirrors sendMessageToConversation,
  // migration 037) so the bubble renders the template in full instead of
  // an empty "Template" badge. Automations only carry positional body
  // params — a text-header {{1}} has no value source here, so it keeps
  // its placeholder (visible, not wrong).
  let templatePreview: TemplatePreviewPayload | null = null;
  let renderedBody: string | null = null;
  if (input.kind === 'template' && templateRow) {
    renderedBody = renderTemplateText(
      templateRow.body_text,
      input.params ?? []
    );
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

  return sendAndPersistOutbound({
    db,
    accountId: input.accountId,
    conversationId: input.conversationId,
    contactId: input.contactId,
    content:
      input.kind === 'template'
        ? {
            kind: 'template',
            templateName: input.templateName,
            language: input.language,
            // A linha local é o que faz header de mídia e botão de URL
            // com variável chegarem ao destinatário; sem ela o envio cai
            // no caminho legado de corpo simples (`positionalParams`).
            definition: templateRow ?? undefined,
            components: templateSendParams,
            positionalParams: input.params,
          }
        : { kind: 'text', text: input.text },
    persist: {
      senderType: 'bot',
      contentType: content_type,
      contentText: content_text,
      previewText:
        input.kind === 'template'
          ? (renderedBody ?? `[template:${input.templateName}]`)
          : input.text,
      extra: { template_name, template_preview: templatePreview },
    },
  });
}
