// ============================================================
// Predicados e definições das 3 abas do Inbox (Chat / Open / Contacts).
//
// Módulo puro — sem React, sem Supabase — para poder ser testado
// isoladamente (src/lib/inbox/tabs.test.ts) e importado tanto pelos
// hooks quanto pelos componentes de apresentação.
//
// ⚠️ Isto NÃO é controle de acesso. A regra real vive na RLS da
// migração 039 (`can_access_conversation`, `conversations_select`). O
// que está aqui só decide QUAL FATIA das linhas que o servidor já
// deixaria o chamador ver deve ser pedida/mostrada em cada aba —
// filtrar no cliente nunca substitui a policy do banco.
// ============================================================

export type ConversationTabId = 'chat' | 'open';
export type TabId = ConversationTabId | 'contacts';

export const TAB_IDS: readonly TabId[] = ['chat', 'open', 'contacts'] as const;

/** Type-narrow um valor desconhecido (ex.: `?tab=` da URL) para TabId. */
export function isTabId(value: unknown): value is TabId {
  return typeof value === 'string' && (TAB_IDS as readonly string[]).includes(value);
}

/** `tab` é uma das duas abas que listam conversas (não "contacts"). */
export function isConversationTab(tab: TabId): tab is ConversationTabId {
  return tab === 'chat' || tab === 'open';
}

/**
 * Aba inicial ao abrir o Inbox sem `?tab=` na URL. É a fila de
 * não-atribuídas — mantém o comportamento "padrão do sistema" que a
 * spec pede (`filter === 'open'` era o default antes das abas).
 */
export const DEFAULT_TAB: TabId = 'open';

export interface TabDefinition {
  id: TabId;
  /** Chave sob `Inbox.tabs.*` — o rótulo/aria-label vive no i18n. */
  labelKey: string;
}

export const TAB_DEFINITIONS: readonly TabDefinition[] = [
  { id: 'chat', labelKey: 'chat' },
  { id: 'open', labelKey: 'open' },
  { id: 'contacts', labelKey: 'contacts' },
];

/**
 * Descreve o filtro extra a aplicar numa query de `conversations` para
 * a aba pedida. A tenência (`account_id`) e a visibilidade por
 * atribuição continuam sendo aplicadas pela RLS — isto só decide entre
 * `assigned_agent_id = <alvo>` (Chat) e `assigned_agent_id IS NULL`
 * (Open).
 *
 * "Alvo" (`viewAsUserId`), não "eu": desde a SPEC 042 (D7), a aba Chat
 * de um admin/owner pode mostrar a carteira de OUTRO agente via o
 * seletor "ver como" — o predicado é o mesmo `eq`, só muda quem entra
 * no lado direito. Para o caso comum (ninguém sendo observado), o
 * chamador passa o próprio `user.id` como alvo.
 */
// União discriminada por `op` (não `{ value: string | null }` solto) para
// que o chamador narrowe sem cast: `predicate.op === 'eq'` já garante
// `predicate.value: string` no branch do `.eq()`.
export type ConversationTabPredicate =
  | { column: 'assigned_agent_id'; op: 'eq'; value: string }
  | { column: 'assigned_agent_id'; op: 'is'; value: null };

export function conversationTabPredicate(
  tab: ConversationTabId,
  viewAsUserId: string
): ConversationTabPredicate {
  return tab === 'chat'
    ? { column: 'assigned_agent_id', op: 'eq', value: viewAsUserId }
    : { column: 'assigned_agent_id', op: 'is', value: null };
}

/**
 * Espelho client-side do predicado acima — decide se uma conversa
 * (já em mãos, vinda de um fetch ou de um evento realtime) pertence à
 * aba `tab` para o alvo `viewAsUserId`. Usado para rotear eventos
 * realtime para o cache certo sem precisar de um refetch.
 *
 * Precisa ficar em sincronia com `conversationTabPredicate` — os dois
 * descrevem a MESMA regra, um em forma de filtro de query, o outro em
 * forma de predicado booleano.
 */
export function matchesConversationTab(
  tab: ConversationTabId,
  assignedAgentId: string | null | undefined,
  viewAsUserId: string
): boolean {
  const assigned = assignedAgentId ?? null;
  return tab === 'chat' ? assigned === viewAsUserId : assigned === null;
}
