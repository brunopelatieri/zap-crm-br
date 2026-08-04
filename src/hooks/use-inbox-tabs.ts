'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  DEFAULT_TAB,
  isConversationTab,
  isTabId,
  type ConversationTabId,
  type TabId,
} from '@/lib/inbox/tabs';
import { isUuid } from '@/lib/api/uuid';
import type { ConversationStatus } from '@/types';

export type InboxStatusFilter = ConversationStatus | 'all' | 'unread';

export interface TabFilters {
  search: string;
  /** Só é lido/renderizado na aba "Open" — ver `conversation-list.tsx`. */
  statusFilter: InboxStatusFilter;
  selectedTagIds: string[];
  selectedCompany: string | null;
}

function emptyFilters(statusFilter: InboxStatusFilter = 'all'): TabFilters {
  return { search: '', statusFilter, selectedTagIds: [], selectedCompany: null };
}

export interface UseInboxTabsResult {
  /**
   * Aba ativa, derivada de `?tab=` na URL. A navegação em si (o
   * `router.replace`) fica com `inbox/page.tsx` — este hook só lê,
   * nunca escreve a URL, para não haver duas fontes de verdade
   * disputando o mesmo `router.replace` (a página já é dona do `?c=`).
   */
  activeTab: TabId;
  /**
   * Alvo do seletor "ver como" (SPEC 042, D7) — o `user_id` do agente
   * cuja carteira a aba "Chat" está mostrando, ou `null` quando é a
   * própria sessão (o caso comum). Derivado de `?viewAs=` na URL pelo
   * mesmo motivo que `?tab=` está lá: refresh estável e link
   * compartilhável — um admin manda ao colega "olha a fila do Fulano".
   *
   * Só admin/owner podem de fato produzir este valor pela UI (o
   * seletor só renderiza sob `useCan('view-all-conversations')`), mas
   * o hook não impõe isso — quem decide o que a URL pode pedir é a
   * RLS: um agente comum forçando `?viewAs=<outro>` na barra de
   * endereço simplesmente não recebe nenhuma linha (nem `assigned_agent_id
   * = <outro>` nem `IS NULL` casam com o que a política deixa passar
   * para ele). `inbox/page.tsx` também degrada defensivamente por UX,
   * não por segurança — ver o comentário lá.
   */
  viewAsUserId: string | null;
  /**
   * Filtros por aba conversacional (Chat/Open). Ficam em memória, não
   * na URL — trocar de aba preserva; recarregar a página reseta. Isso
   * é deliberado: a aba em si vale a pena persistir num link
   * compartilhável, os filtros de busca não.
   */
  filters: Record<ConversationTabId, TabFilters>;
  setSearch: (tab: ConversationTabId, value: string) => void;
  setStatusFilter: (tab: ConversationTabId, value: InboxStatusFilter) => void;
  toggleTag: (tab: ConversationTabId, tagId: string) => void;
  setSelectedCompany: (tab: ConversationTabId, company: string | null) => void;
  clearContactFilters: (tab: ConversationTabId) => void;
  /**
   * Abas conversacionais já visitadas ao menos uma vez nesta sessão —
   * controla o fetch preguiçoso de `useConversationFeed` (a aba que o
   * agente nunca abriu não gasta uma consulta).
   */
  visitedTabs: ReadonlySet<ConversationTabId>;
}

export function useInboxTabs(): UseInboxTabsResult {
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const activeTab: TabId = isTabId(tabParam) ? tabParam : DEFAULT_TAB;

  const viewAsParam = searchParams.get('viewAs');
  // Forma de UUID inválida (adulterado à mão, link truncado) degrada
  // para "eu", nunca quebra — mesmo padrão de `isTabId` acima.
  const viewAsUserId = isUuid(viewAsParam) ? viewAsParam : null;

  const [filters, setFilters] = useState<Record<ConversationTabId, TabFilters>>(
    () => ({
      // As duas abas abrem recortadas em "Abertas" — o agente troca o
      // recorte pela própria linha de filtros depois. (Já foi 'all' a
      // pedido do usuário; voltou a ser 'open' por pedido posterior.)
      chat: emptyFilters('open'),
      open: emptyFilters('open'),
    })
  );

  const [visitedTabs, setVisitedTabs] = useState<Set<ConversationTabId>>(
    () => new Set(isConversationTab(activeTab) ? [activeTab] : [])
  );

  // Marca a aba ativa como visitada. Roda em efeito (não durante o
  // render) para respeitar a regra de refs/setState do React 19; a
  // primeira visita a cada aba dispara exatamente um re-render extra,
  // que é o que liga o fetch preguiçoso do feed correspondente.
  useEffect(() => {
    if (!isConversationTab(activeTab)) return;
    // Acumula histórico entre renders (quais abas já foram visitadas) —
    // não é uma derivação pura de `activeTab`, é memória ao longo do
    // tempo, então precisa mesmo de um efeito + setState.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVisitedTabs((prev) =>
      prev.has(activeTab) ? prev : new Set(prev).add(activeTab)
    );
  }, [activeTab]);

  const setSearch = useCallback((tab: ConversationTabId, value: string) => {
    setFilters((prev) => ({ ...prev, [tab]: { ...prev[tab], search: value } }));
  }, []);

  const setStatusFilter = useCallback(
    (tab: ConversationTabId, value: InboxStatusFilter) => {
      setFilters((prev) => ({
        ...prev,
        [tab]: { ...prev[tab], statusFilter: value },
      }));
    },
    []
  );

  const toggleTag = useCallback((tab: ConversationTabId, tagId: string) => {
    setFilters((prev) => {
      const current = prev[tab];
      const already = current.selectedTagIds.includes(tagId);
      return {
        ...prev,
        [tab]: {
          ...current,
          selectedTagIds: already
            ? current.selectedTagIds.filter((id) => id !== tagId)
            : [...current.selectedTagIds, tagId],
        },
      };
    });
  }, []);

  const setSelectedCompany = useCallback(
    (tab: ConversationTabId, company: string | null) => {
      setFilters((prev) => ({
        ...prev,
        [tab]: { ...prev[tab], selectedCompany: company },
      }));
    },
    []
  );

  const clearContactFilters = useCallback((tab: ConversationTabId) => {
    setFilters((prev) => ({
      ...prev,
      [tab]: { ...prev[tab], selectedTagIds: [], selectedCompany: null },
    }));
  }, []);

  return {
    activeTab,
    viewAsUserId,
    filters,
    setSearch,
    setStatusFilter,
    toggleTag,
    setSelectedCompany,
    clearContactFilters,
    visitedTabs,
  };
}
