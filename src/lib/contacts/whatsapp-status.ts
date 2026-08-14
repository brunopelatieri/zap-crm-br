/**
 * Auto-limpeza de números mortos (SPEC 044 §6.4).
 *
 * Dois gatilhos independentes marcam `contacts.whatsapp_status =
 * 'invalid'`:
 *
 *   1. Um erro da Meta que já significa "este número não é WhatsApp"
 *      (código 131026, `isInvalidWhatsappNumberError`) — um único
 *      strike basta, a Meta já confirmou.
 *   2. Sem esse sinal, as DUAS tentativas de entrega mais recentes ao
 *      mesmo contato terem sido `failed` — uma heurística mais barata
 *      que pega números que a Meta não rotula claramente. "Recentes",
 *      não "no total": um contato que falhou duas vezes há seis meses
 *      e recebeu normalmente desde então não é um número morto.
 *
 * Chamado dos dois pontos que escrevem `broadcast_recipients.status =
 * 'failed'` — o envio síncrono (`broadcast-core.ts`) e o webhook
 * assíncrono de status da Meta (`app/api/whatsapp/webhook/route.ts`).
 * Best-effort: uma falha aqui nunca deve derrubar o envio ou o
 * processamento do webhook que a chamou, então erros só logam.
 *
 * Reversível a qualquer momento pela tela do contato
 * (`markWhatsappValid`) — ver `contact-detail-view.tsx`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { isInvalidWhatsappNumberError } from '@/lib/whatsapp/phone-utils';

export type WhatsappStatusReason =
  'consecutive_failures' | 'meta_error' | 'manual';

/** Predicado sobre uma linha de contato já carregada. */
export function isWhatsappInvalid(contact: {
  whatsapp_status?: string | null;
}): boolean {
  return contact.whatsapp_status === 'invalid';
}

/**
 * Marca o contato como número morto. Não sobrescreve um motivo já
 * registrado — `.eq('whatsapp_status', 'valid')` faz o UPDATE não
 * casar nenhuma linha se o contato já estiver `invalid`, preservando o
 * motivo ORIGINAL (o primeiro é o que importa para quem decide
 * reativar).
 *
 * Best-effort: chamadores são caminhos de sistema (webhook, despacho)
 * que não podem falhar por causa disto.
 */
export async function markWhatsappInvalid(
  db: SupabaseClient,
  contactId: string,
  reason: WhatsappStatusReason
): Promise<void> {
  const { error } = await db
    .from('contacts')
    .update({
      whatsapp_status: 'invalid',
      whatsapp_status_reason: reason,
      whatsapp_status_updated_at: new Date().toISOString(),
    })
    .eq('id', contactId)
    .eq('whatsapp_status', 'valid');

  if (error) {
    console.error('[whatsapp-status] mark invalid failed:', error);
  }
}

/**
 * Reverte manualmente — a ação da tela do contato. Ao contrário de
 * {@link markWhatsappInvalid}, lança em erro: é uma ação do usuário e
 * o chamador mostra o toast.
 */
export async function markWhatsappValid(
  db: SupabaseClient,
  contactId: string
): Promise<void> {
  const { error } = await db
    .from('contacts')
    .update({
      whatsapp_status: 'valid',
      whatsapp_status_reason: 'manual',
      whatsapp_status_updated_at: new Date().toISOString(),
    })
    .eq('id', contactId);

  if (error) throw error;
}

export interface DetectDeadNumberParams {
  contactId: string;
  /** Mensagem de erro da tentativa que acabou de falhar. */
  errorMessage?: string | null;
}

/**
 * Roda logo depois que uma linha de `broadcast_recipients` é marcada
 * `failed`. Ver o cabeçalho do arquivo para os dois gatilhos.
 */
export async function detectDeadNumberOnFailure(
  db: SupabaseClient,
  { contactId, errorMessage }: DetectDeadNumberParams
): Promise<void> {
  if (isInvalidWhatsappNumberError(errorMessage ?? '')) {
    await markWhatsappInvalid(db, contactId, 'meta_error');
    return;
  }

  // As duas tentativas mais recentes — não o histórico inteiro (essa é
  // a contagem vitalícia que a triagem já mostra como "problematic",
  // §5.1/§6.5). "Consecutivas" é o que distingue as duas.
  const { data, error } = await db
    .from('broadcast_recipients')
    .select('status')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
    .limit(2);

  if (error) {
    console.error(
      '[whatsapp-status] consecutive-failure lookup failed:',
      error
    );
    return;
  }

  const rows = (data ?? []) as { status: string }[];
  if (rows.length === 2 && rows.every((r) => r.status === 'failed')) {
    await markWhatsappInvalid(db, contactId, 'consecutive_failures');
  }
}
