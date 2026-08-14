// ============================================================
// Simulação a seco (dry run) — SPEC 044 §6.7.
//
// "Enviar teste" dispara para até MAX_TEST_SEND_RECIPIENTS contatos
// escolhidos a dedo, usando a MESMA resolução de variáveis que o
// disparo real usaria (`resolveVariables` + `fetchCustomValueIndex`,
// de broadcast-variables.ts) — não o texto estático que a pré-
// visualização do passo 3 mostra. É essa diferença que pega um
// {{1}} vazio ANTES de queimar cota com a audiência inteira.
//
// Não cria `broadcasts` nem `broadcast_recipients`: cada envio é uma
// chamada avulsa a `sendTemplateMessage`, igual ao que o composer do
// inbox já faz. Sem linha, não há campanha para o cron encontrar nem
// contador para o trigger agregar — e é por isso que o teto de
// destinatários (5) não precisa ir contra a cota de 24 h da §4: cinco
// conversas de teste são ruído perto do tier mais restritivo.
//
// Ainda assim, dois invariantes de produto valem aqui como valem no
// envio de verdade:
//
//   • Opt-out (§6.8) — a mesma regra de categoria decide se o teste
//     alcança quem já saiu da lista de marketing. Um "teste" que
//     ignorasse isso seria uma mensagem de marketing de verdade para
//     quem pediu para não receber.
//   • Escopo de conta — contatos são lidos por `account_id` explícito,
//     não só por RLS (mesma correção da §6.4/§6.8 em resolve.ts):
//     um `contactId` de outra conta simplesmente não casa nenhuma
//     linha, em vez de um 500 tentando resolver `undefined`.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { BroadcastError } from '@/lib/whatsapp/broadcast-core';
import { excludesOptedOut, isOptedOut } from '@/lib/contacts/consent';
import { isWhatsappInvalid } from '@/lib/contacts/whatsapp-status';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  withSignedHeaderMedia,
  isMediaHeaderTemplate,
} from '@/lib/whatsapp/header-media';
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { isValidE164, sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import {
  fetchCustomValueIndex,
  resolveVariables,
  usesCustomFields,
  type CustomValueIndex,
  type VariableMapping,
} from '@/lib/whatsapp/broadcast-variables';
import type { Contact, MessageTemplate } from '@/types';

/** Teto de destinatários por chamada — "até 5 números" da §6.7. */
export const MAX_TEST_SEND_RECIPIENTS = 5;

export type TestSendStatus =
  | 'sent'
  | 'failed'
  | 'invalid_phone'
  | 'opted_out'
  | 'whatsapp_invalid'
  | 'not_found';

export interface TestSendResult {
  contactId: string;
  name: string | null;
  phone: string;
  status: TestSendStatus;
  error?: string;
  messageId?: string;
}

export interface SendBroadcastTestInput {
  templateName: string;
  templateLanguage: string;
  variables: Record<string, VariableMapping>;
  /** URL escolhida no passo 3 — sobrepõe a do template, igual ao envio real. */
  headerMediaUrl?: string;
  /** 1 a `MAX_TEST_SEND_RECIPIENTS` ids de `contacts`. */
  contactIds: string[];
}

export interface SendBroadcastTestParams {
  accountId: string;
  input: SendBroadcastTestInput;
}

/**
 * Envia um template a um punhado de contatos reais, fora do fluxo de
 * campanha. Lança {@link BroadcastError} para falhas de configuração
 * (sem WhatsApp, sem template); falhas POR DESTINATÁRIO (telefone
 * inválido, opt-out, erro da Meta) viram entradas no array de retorno
 * — a rota sempre responde 200 com o detalhe por linha, para a UI
 * mostrar "3 de 5 enviados" em vez de tudo-ou-nada.
 */
export async function sendBroadcastTest(
  db: SupabaseClient,
  { accountId, input }: SendBroadcastTestParams
): Promise<TestSendResult[]> {
  const templateLanguage = input.templateLanguage || 'en_US';

  if (input.contactIds.length === 0) {
    throw new BroadcastError(
      'bad_request',
      'Pick at least one contact to send a test to.',
      400
    );
  }
  if (input.contactIds.length > MAX_TEST_SEND_RECIPIENTS) {
    throw new BroadcastError(
      'too_many_recipients',
      `A test send is capped at ${MAX_TEST_SEND_RECIPIENTS} recipients.`,
      400
    );
  }

  const { data: config } = await db
    .from('whatsapp_config')
    .select('phone_number_id, access_token')
    .eq('account_id', accountId)
    .maybeSingle();

  if (!config) {
    throw new BroadcastError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }
  const accessToken = decrypt(config.access_token);

  const { data: rawTemplateRow } = await db
    .from('message_templates')
    .select('*')
    .eq('account_id', accountId)
    .eq('name', input.templateName)
    .eq('language', templateLanguage)
    .maybeSingle();

  if (!rawTemplateRow) {
    throw new BroadcastError(
      'template_not_found',
      'Template not found for this account.',
      400
    );
  }
  if (!isMessageTemplate(rawTemplateRow)) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before sending a test.',
      500
    );
  }
  const templateRow = rawTemplateRow as MessageTemplate;

  // Mesma sobreposição do disparo real (broadcast-dispatch.ts §6.1): a
  // URL do passo 3 vale como se fosse a URL guardada do template.
  const headerMediaUrl = input.headerMediaUrl?.trim();
  const templateForSend =
    headerMediaUrl && isMediaHeaderTemplate(templateRow)
      ? { ...templateRow, header_media_url: headerMediaUrl }
      : templateRow;

  // Assinatura ÚNICA (não o resolvedor com refresh de
  // `createHeaderMediaResolver`) — um punhado de envios avulsos, não um
  // fan-out que levaria minutos e furaria o TTL de 10 min da assinatura.
  const signedParams = await withSignedHeaderMedia(db, templateForSend);

  const { data: contactRows } = await db
    .from('contacts')
    .select('*')
    .eq('account_id', accountId)
    .in('id', input.contactIds);

  const byId = new Map<string, Contact>();
  for (const c of (contactRows ?? []) as Contact[]) byId.set(c.id, c);

  const applyOptOut = excludesOptedOut(templateRow.category);

  const customValueIndex: CustomValueIndex = usesCustomFields(input.variables)
    ? await fetchCustomValueIndex(db, input.contactIds)
    : new Map();

  const results: TestSendResult[] = [];

  for (const contactId of input.contactIds) {
    const contact = byId.get(contactId);
    if (!contact) {
      results.push({ contactId, name: null, phone: '', status: 'not_found' });
      continue;
    }

    if (applyOptOut && isOptedOut(contact)) {
      results.push({
        contactId,
        name: contact.name ?? null,
        phone: contact.phone,
        status: 'opted_out',
      });
      continue;
    }

    // Número morto (§6.4) — a Meta já rejeitou este contato antes, ou
    // ele acumulou falhas seguidas. Testar de novo não prova nada que a
    // detecção não soubesse; reativar pela tela do contato é o caminho
    // para quem quiser tentar mesmo assim.
    if (isWhatsappInvalid(contact)) {
      results.push({
        contactId,
        name: contact.name ?? null,
        phone: contact.phone,
        status: 'whatsapp_invalid',
      });
      continue;
    }

    const phone = sanitizePhoneForMeta(contact.phone ?? '');
    if (!isValidE164(phone)) {
      results.push({
        contactId,
        name: contact.name ?? null,
        phone: contact.phone,
        status: 'invalid_phone',
      });
      continue;
    }

    const params = resolveVariables(
      input.variables,
      contact,
      customValueIndex.get(contact.id)
    );

    try {
      const sent = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        templateName: input.templateName,
        language: templateLanguage,
        template: templateForSend,
        messageParams: { ...signedParams, body: params },
      });
      results.push({
        contactId,
        name: contact.name ?? null,
        phone: contact.phone,
        status: 'sent',
        messageId: sent.messageId,
      });
    } catch (err) {
      results.push({
        contactId,
        name: contact.name ?? null,
        phone: contact.phone,
        status: 'failed',
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  return results;
}
