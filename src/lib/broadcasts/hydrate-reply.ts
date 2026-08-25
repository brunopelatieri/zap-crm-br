/**
 * Hidratação preguiçosa da conversa — SPEC 057 D-4/D-8.
 *
 * O disparo do painel nunca cria `conversations`/`messages` (SPEC 057
 * A-8): `dispatchBroadcast`/`deliverBroadcast` só gravam
 * `broadcast_recipients`. Quando o cliente responde,
 * `flagBroadcastReplyIfAny` (`src/lib/channels/ingest.ts`) já encontra a
 * linha do recipient — esta função insere retroativamente a mensagem de
 * template que originou a resposta, com `created_at = recipient.sent_at`,
 * para a bolha aparecer ACIMA da resposta na ordenação por `created_at`
 * mesmo tendo sido inserida depois.
 *
 * Por que preguiçosa (lazy), não no disparo (eager)
 *
 *   As três opções do draft original (stage / antes do envio / depois do
 *   envio) criariam uma `conversations` POR DESTINATÁRIO — um disparo de
 *   5.000 contatos abriria 5.000 conversas no inbox, das quais
 *   tipicamente 3–8% respondem. A decisão (D-4) é hidratar só quando a
 *   resposta chega: 0 linhas escritas por quem não responde, o trade-off
 *   é não ter histórico de quem não respondeu dentro do inbox (fica em
 *   `broadcast_recipients` e na tela da campanha).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  fetchCustomValueIndex,
  resolveVariables,
  usesCustomFields,
} from '@/lib/whatsapp/broadcast-variables';
import { renderTemplateText } from '@/lib/whatsapp/template-send-builder';
import type { Contact, MessageTemplate, TemplatePreviewPayload } from '@/types';

import { parseVariableMap } from './parse-input';

export interface HydrateBroadcastReplyParams {
  conversationId: string;
  accountId: string;
  contactId: string;
  broadcastId: string;
  /** `broadcast_recipients.id` da linha que acabou de ser marcada `replied`. */
  recipientId: string;
}

/**
 * Best-effort: nunca lança. Quem chama (`flagBroadcastReplyIfAny`) já
 * está dentro do caminho quente de recebimento — uma falha aqui custa o
 * banner de origem da campanha, nunca a entrega do inbound.
 */
export async function hydrateBroadcastReply(
  db: SupabaseClient,
  params: HydrateBroadcastReplyParams
): Promise<void> {
  try {
    const { conversationId, accountId, contactId, broadcastId, recipientId } =
      params;

    const { data: recipient } = await db
      .from('broadcast_recipients')
      .select('sent_at, whatsapp_message_id')
      .eq('id', recipientId)
      .maybeSingle();

    // R-11 — corrida: o cliente respondeu antes do fan-out carimbar
    // `sent_at`/`whatsapp_message_id` nesta linha. Sem os dois não há o
    // que hidratar ainda; a resposta em si já foi gravada por quem
    // chamou esta função — só o banner de origem fica para trás.
    if (!recipient?.sent_at || !recipient.whatsapp_message_id) return;

    // R-8 (replay do webhook) + os dados de broadcast/contato são três
    // leituras independentes — nenhuma depende do resultado das outras
    // — então rodam em paralelo em vez de sequenciais. Isto está no
    // caminho quente de RECEBIMENTO (ver o cabeçalho do arquivo); cada
    // round trip evitado aqui é latência a menos antes do ack ao provedor.
    const [{ data: already }, { data: broadcast }, { data: contact }] =
      await Promise.all([
        // `messages.message_id` já é indexado (migração 001), mas o
        // índice não é único — reentrega concorrente ainda pode passar
        // pelas duas checagens antes de qualquer INSERT confirmar.
        db
          .from('messages')
          .select('id')
          .eq('conversation_id', conversationId)
          .eq('message_id', recipient.whatsapp_message_id)
          .limit(1)
          .maybeSingle(),
        db
          .from('broadcasts')
          .select('template_name, template_language, template_variables')
          .eq('id', broadcastId)
          .maybeSingle(),
        db.from('contacts').select('*').eq('id', contactId).maybeSingle(),
      ]);

    if (already) return;
    if (!broadcast?.template_name) return;
    if (!contact) return;

    const { data: templateRowData } = await db
      .from('message_templates')
      .select('*')
      .eq('account_id', accountId)
      .eq('name', broadcast.template_name)
      .eq('language', broadcast.template_language ?? 'en_US')
      .maybeSingle();
    const templateRow = (templateRowData ?? null) as MessageTemplate | null;

    // Trade-off consciente: personaliza com o contato de AGORA, não com
    // o valor que a Meta de fato entregou no instante do envio (aquele
    // não é persistido em lugar nenhum hoje — `broadcast_recipients` só
    // guarda o mapeamento de variáveis, não o resultado resolvido por
    // destinatário). Se o nome/e-mail/campo personalizado do contato
    // mudar entre o envio e a resposta, a bolha retroativa reflete o
    // dado atual, não o histórico. Corrigir isso de verdade exigiria uma
    // coluna nova em `broadcast_recipients` para guardar os parâmetros
    // resolvidos no momento do disparo — fora do escopo deste ajuste.
    const customValues = templateRow
      ? await maybeCustomValues(
          db,
          broadcast.template_variables,
          contact.id as string
        )
      : undefined;
    const templateParams = resolveTemplateParams(
      templateRow,
      broadcast.template_variables,
      contact as Contact,
      customValues
    );
    const { templatePreview, contentText, contentType } = buildPreview(
      templateRow,
      broadcast.template_name,
      templateParams
    );

    const { error } = await db.from('messages').insert({
      conversation_id: conversationId,
      sender_type: 'agent',
      sender_id: null,
      content_type: contentType,
      content_text: contentText,
      template_name: broadcast.template_name,
      template_preview: templatePreview,
      message_id: recipient.whatsapp_message_id,
      status: 'sent',
      created_at: recipient.sent_at,
      broadcast_id: broadcastId,
    });
    if (error) {
      console.error('[hydrateBroadcastReply] insert error:', error);
    }
  } catch (err) {
    console.error('[hydrateBroadcastReply] failed:', err);
  }
}

async function maybeCustomValues(
  db: SupabaseClient,
  rawVariables: unknown,
  contactId: string
): Promise<Map<string, string> | undefined> {
  const variables = parseVariableMap(rawVariables) ?? {};
  if (!usesCustomFields(variables)) return undefined;
  const index = await fetchCustomValueIndex(db, [contactId]);
  return index.get(contactId);
}

function resolveTemplateParams(
  templateRow: MessageTemplate | null,
  rawVariables: unknown,
  contact: Contact,
  customValues: Map<string, string> | undefined
): string[] {
  if (!templateRow) return [];
  const variables = parseVariableMap(rawVariables) ?? {};
  return resolveVariables(variables, contact, customValues);
}

/**
 * D-8 — sem a linha local do template (removido da Meta, nunca
 * sincronizado, ou `template_name` não bate mais) não há header/body/
 * footer/buttons para resolver. Cai para uma bolha de texto simples com
 * o nome do template — nunca uma bolha vazia (R-6).
 *
 * Header de mídia é deliberadamente omitido: reassiná-lo exigiria o
 * mesmo resolvedor que `deliverBroadcast` usa por destinatário
 * (`createHeaderMediaResolver`), e o ganho não paga a complexidade aqui
 * — a bolha ainda mostra header de texto, corpo, rodapé e botões.
 *
 * Header de TEXTO com variável ({{1}}) nunca é resolvido aqui (sempre
 * `renderTemplateText(header_content, [])`) — mas isto não é uma lacuna
 * nova: `deliverBroadcast` (broadcast-core.ts) também nunca preenche
 * `headerText` para um disparo, e `buildTemplateSendComponents`
 * (template-send-builder.ts) LANÇA nesse caso ("Header text variable
 * {{1}} requires a value"). Ou seja, um template com variável no header
 * de texto já falha no ENVIO do broadcast — nunca existe uma resposta de
 * verdade para hidratar com esse template. `headerText` só é usado hoje
 * pelo composer de envio avulso (`send-message.ts`), um caminho que este
 * módulo não hidrata.
 */
function buildPreview(
  templateRow: MessageTemplate | null,
  templateName: string,
  params: string[]
): {
  templatePreview: TemplatePreviewPayload | null;
  contentText: string;
  contentType: 'template' | 'text';
} {
  if (!templateRow) {
    return {
      templatePreview: null,
      contentText: templateName,
      contentType: 'text',
    };
  }

  const header =
    templateRow.header_type === 'text' && templateRow.header_content
      ? renderTemplateText(templateRow.header_content, [])
      : undefined;
  const body = renderTemplateText(templateRow.body_text, params);

  const templatePreview: TemplatePreviewPayload = {
    header,
    body,
    footer: templateRow.footer_text,
    buttons: templateRow.buttons,
  };

  return { templatePreview, contentText: body, contentType: 'template' };
}
