// ============================================================
// Predicados e definições das 4 abas do Inbox (Chat / Open / Board /
// Contacts).
//
// Módulo puro — sem React, sem Supabase — para poder ser testado
// isoladamente (src/lib/inbox/tabs.test.ts) e importado tanto pelos
// hooks quanto pelos componentes de apresentação.
//
// ⚠️ Isto NÃO é controle de acesso. A regra real vive na RLS da
// migração 039 (`can_access_conversation`, `conversations_select`). O
// que está aqui só decide QUAL FATIA das linhas que o servidor já
// deixaria o chamador ver deve ser pedida/mostrada em cada aba —
// filtrar no cliente nunca substitui a policy do banco. `minRole` em
// `TabDefinition` (a aba "Board", SPEC 043) segue a mesma regra: existe
// só para não oferecer uma aba que a RLS deixaria vazia, nunca como
// fronteira de segurança.
// ============================================================

import { hasMinRole, type AccountRole } from '@/lib/auth/roles';

export type ConversationTabId = 'chat' | 'open';
export type TabId = ConversationTabId | 'board' | 'contacts';

export const TAB_IDS: readonly TabId[] = [
  'chat',
  'open',
  'board',
  'contacts',
] as const;

/** Type-narrow um valor desconhecido (ex.: `?tab=` da URL) para TabId. */
export function isTabId(value: unknown): value is TabId {
  return (
    typeof value === 'string' && (TAB_IDS as readonly string[]).includes(value)
  );
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
  /**
   * Papel mínimo para a aba SEQUER APARECER. Ausente = todos os
   * membros. Não é controle de acesso (ver cabeçalho do arquivo) — é só
   * o que decide o que renderizar/oferecer.
   */
  minRole?: AccountRole;
}

export const TAB_DEFINITIONS: readonly TabDefinition[] = [
  { id: 'chat', labelKey: 'chat' },
  { id: 'open', labelKey: 'open' },
  // Quadro de atribuição (SPEC 043) — logo após "Fila". `admin+` porque
  // a RLS de `conversations_select` (039) não deixa um `agent` ler a
  // carteira dos colegas: a aba ficaria com colunas vazias sem erro.
  { id: 'board', labelKey: 'board', minRole: 'admin' },
  { id: 'contacts', labelKey: 'contacts' },
];

/** Definições visíveis a um papel — filtra por `minRole` (SPEC 043). */
export function visibleTabDefinitions(
  role: AccountRole | null
): readonly TabDefinition[] {
  return TAB_DEFINITIONS.filter(
    (def) => !def.minRole || (role !== null && hasMinRole(role, def.minRole))
  );
}

/**
 * Resolve o valor de `?tab=` da URL para a aba a exibir, degradando
 * uma aba que o papel atual não pode ver para `DEFAULT_TAB` (SPEC 043,
 * §3.7). Devolve `null` enquanto o papel ainda está carregando — nesse
 * meio-tempo o chamador deve segurar o render (esqueleto), não assumir
 * `DEFAULT_TAB`: um admin com deep link para `?tab=board` não pode ver
 * a "Fila" piscar antes do quadro, e a URL não pode ser reescrita no
 * meio do caminho.
 */
export function resolveTab(
  raw: string | null,
  role: AccountRole | null,
  profileLoading: boolean
): TabId | null {
  if (!isTabId(raw)) return DEFAULT_TAB;
  if (profileLoading) return null;
  const def = TAB_DEFINITIONS.find((d) => d.id === raw);
  if (def?.minRole && (role === null || !hasMinRole(role, def.minRole))) {
    return DEFAULT_TAB;
  }
  return raw;
}

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
