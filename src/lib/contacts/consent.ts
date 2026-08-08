/**
 * Consentimento de contato — leitura e escrita (SPEC 044 §6.8).
 *
 * Três coisas moram aqui:
 *
 *   1. `setContactOptIn` — o ÚNICO caminho de escrita. Envolve a RPC
 *      `set_contact_opt_in` (migração 048), que grava o estado em
 *      `contacts` e o evento em `contact_consent_events` na mesma
 *      transação. Escrever `opt_in_status` direto pela tabela funciona
 *      no SQL e é errado: deixaria a trilha com um buraco exatamente no
 *      registro que alguém vai precisar mostrar depois.
 *   2. `excludesOptedOut` — a regra de PRODUTO da §6.8, em um lugar só.
 *   3. `isOptedOut` — o predicado, para o filtro em memória do envio.
 *
 * Por que a exclusão é por categoria de template
 *
 *   A §6.8 diz "`opted_out` **nunca** entra em audiência de marketing".
 *   Não diz "nunca recebe mensagem": um template Utility ("seu pedido
 *   saiu para entrega") é legítimo para quem cancelou marketing, e
 *   bloqueá-lo transformaria um pedido de "pare de me vender coisas" em
 *   "pare de me avisar do que eu comprei".
 *
 *   Categoria ausente ou desconhecida conta como marketing — o lado
 *   conservador é o único aceitável quando a dúvida é "posso mandar
 *   propaganda para quem pediu para sair?".
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type OptInStatus = 'opted_in' | 'opted_out' | 'unknown';

export type ConsentSource =
  'inbound_keyword' | 'manual' | 'import' | 'api' | 'automation';

/** Categorias que NÃO são marketing e portanto alcançam quem optou por sair. */
const NON_MARKETING_CATEGORIES = new Set(['utility', 'authentication']);

/**
 * `true` quando esta categoria de template precisa excluir contatos em
 * opt-out da audiência.
 */
export function excludesOptedOut(category: string | null | undefined): boolean {
  if (!category) return true;
  return !NON_MARKETING_CATEGORIES.has(category.trim().toLowerCase());
}

/** Predicado sobre uma linha de contato já carregada. */
export function isOptedOut(contact: {
  opt_in_status?: string | null;
}): boolean {
  return contact.opt_in_status === 'opted_out';
}

export interface SetContactOptInParams {
  contactId: string;
  status: OptInStatus;
  source: ConsentSource;
  /** Só para `inbound_keyword`: a frase normalizada que casou. */
  keyword?: string | null;
  /** Só para `inbound_keyword`: o id da mensagem na Meta. */
  whatsappMessageId?: string | null;
}

export interface SetContactOptInResult {
  contactId: string;
  status: OptInStatus;
  updatedAt: string;
  /** `false` quando o contato já estava neste estado. */
  changed: boolean;
}

/**
 * Grava o consentimento e o evento de trilha.
 *
 * Escopo: a RPC é `SECURITY INVOKER`, então quem decide se este contato
 * pode ser alterado é a RLS de `contacts` — o cliente SSR do usuário
 * fica limitado à conta dele, e o cliente de service-role (webhook)
 * alcança qualquer conta, que é o necessário para atender um inbound.
 */
export async function setContactOptIn(
  db: SupabaseClient,
  params: SetContactOptInParams
): Promise<SetContactOptInResult> {
  const { data, error } = await db.rpc('set_contact_opt_in', {
    p_contact_id: params.contactId,
    p_status: params.status,
    p_source: params.source,
    p_keyword: params.keyword ?? null,
    p_whatsapp_message_id: params.whatsappMessageId ?? null,
  });

  if (error) throw error;

  // `RETURNS TABLE` chega como array de uma linha.
  const row = (
    data as
      | {
          contact_id: string;
          opt_in_status: OptInStatus;
          opt_in_updated_at: string;
          changed: boolean;
        }[]
      | null
  )?.[0];

  if (!row) {
    throw new Error('set_contact_opt_in returned no row');
  }

  return {
    contactId: row.contact_id,
    status: row.opt_in_status,
    updatedAt: row.opt_in_updated_at,
    changed: row.changed,
  };
}
