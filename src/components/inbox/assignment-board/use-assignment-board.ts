'use client';

// ============================================================
// use-assignment-board — camada de dados do Quadro de Atribuição
// (SPEC 043, §4 e §5).
//
// Dono de TUDO que fala com a rede: papéis/colunas, as N+1 queries da
// onda 1 (uma por coluna, teto por coluna + contagem exata), a
// hidratação em lote da onda 2 (notas + deal primário), o canal
// realtime próprio, e a mutação otimista do drop (claim/assign com
// rollback por snapshot).
//
// Sem React Query — o repo não usa (ver `use-conversation-feed.ts`).
// Mesma convenção: `useState` + `useEffect` + flag `cancelled` no
// carregamento inicial + um `resyncToken` bumpável como mecanismo de
// invalidação (reconexão do WS, `visibilitychange`, e — aqui — também
// o caso `INVALID_ASSIGNEE`, §5.3, que precisa reler o roster).
//
// Não reusa `useAccountMembers()`: aquele hook não expõe uma forma de
// forçar um refetch, e o caso `INVALID_ASSIGNEE` exige exatamente isso
// (a coluna renderizada ficou velha — membro removido/rebaixado entre
// o load e o drop). Unificar "membros + colunas + cards" atrás de um
// único `resyncToken` também é o que faz reconexão/visibilidade
// recarregarem o quadro inteiro de forma consistente, com uma unica
// fonte de invalidação.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useRealtime } from '@/hooks/use-realtime';
import {
  BOARD_CONVERSATION_SELECT,
  BOARD_PAGE_SIZE,
  BOARD_STATUSES,
  UNASSIGNED_COLUMN_ID,
  appendCards,
  applyColumnCounts,
  boardColumnIdToAgentId,
  buildBoardColumns,
  clearCardPending,
  hydrateCards,
  insertCard,
  isBoardEligibleStatus,
  moveCard,
  pickPrimaryDeal,
  removeCard,
  restoreCard,
  setColumnLoadingMore,
  settleCard,
  toBoardCard,
  type BoardCard,
  type BoardColumn,
  type BoardColumnState,
  type BoardColumnStateMap,
  type BoardDealRow,
  type DropSnapshot,
} from '@/lib/inbox/assignment-board';
import {
  normalizeConversation,
  normalizeConversations,
} from '@/lib/inbox/conversations';
import type { Conversation, Profile } from '@/types';

// Reexportados por conveniência dos componentes desta pasta, que
// consomem os dois tipos vindos deste hook.
export type { BoardCard, BoardColumnState } from '@/lib/inbox/assignment-board';

export interface UseAssignmentBoardResult {
  /** Colunas na ordem de exibição — a fila sempre primeiro. */
  columns: BoardColumnState[];
  /** Carga inicial (ou resync completo) em voo. */
  loading: boolean;
  /** Nenhum membro com papel atribuível na conta (só a fila existe). */
  hasNoAssignableMembers: boolean;
  loadMore: (columnId: string) => void;
  /**
   * Move `conversationId` de `sourceColumnId` para `targetColumnId` —
   * ponto de entrada único do drop (SPEC 043, §5). Todas as guardas de
   * no-op (mesma coluna, coluna inexistente, card já em voo) vivem
   * aqui, não no orquestrador de DnD.
   */
  moveConversation: (
    conversationId: string,
    sourceColumnId: string,
    targetColumnId: string
  ) => void;
}

/**
 * Janela de coalescência do refresh de contagens. Longa o bastante para
 * uma rajada de eventos (um disparo de automação, um lote de webhooks)
 * virar UMA consulta, curta o bastante para o cabeçalho não ficar
 * visivelmente errado enquanto o supervisor olha para ele.
 */
const COUNTS_REFRESH_DEBOUNCE_MS = 3_000;

export function useAssignmentBoard(): UseAssignmentBoardResult {
  const t = useTranslations('Inbox.assignmentBoard');
  // Reusa a chave existente para "membro sem nome resolvido" — mesma
  // label que o seletor "ver como" (SPEC 042) já usa, em vez de
  // duplicar a string aqui.
  const tTabs = useTranslations('Inbox.tabs');
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [columnsState, setColumnsState] = useState<BoardColumnStateMap>({});
  const [loading, setLoading] = useState(true);
  const [resyncToken, setResyncToken] = useState(0);

  // Refs espelhando o estado mais recente — lidas dentro de callbacks
  // assíncronos (drop, realtime, load-more) que não podem depender do
  // valor capturado no fechamento sem recriar a cada render.
  const columnsStateRef = useRef<BoardColumnStateMap>(columnsState);
  useEffect(() => {
    columnsStateRef.current = columnsState;
  }, [columnsState]);

  const columnIdsRef = useRef<Set<string>>(new Set());
  /**
   * `conversationId → columnId` — espelho necessário porque
   * `conversations` roda com `REPLICA IDENTITY DEFAULT` (SPEC 043,
   * §2.6): o `old` de um evento realtime só traz a PK, então não há
   * como saber de qual coluna um card saiu olhando o payload.
   */
  const cardColumnRef = useRef<Map<string, string>>(new Map());

  const bumpResync = useCallback(() => setResyncToken((n) => n + 1), []);

  // ----------------------------------------------------------
  // Onda 1 — uma query por coluna, em paralelo (SPEC 043, §4.3).
  // ----------------------------------------------------------
  const fetchColumnPage = useCallback(
    async (
      column: BoardColumn,
      offset: number
    ): Promise<{ cards: BoardCard[]; total: number }> => {
      const supabase = createClient();
      const base = supabase
        .from('conversations')
        .select(BOARD_CONVERSATION_SELECT, { count: 'exact' })
        .in('status', BOARD_STATUSES)
        .order('last_message_at', { ascending: false })
        .range(offset, offset + BOARD_PAGE_SIZE - 1);
      const query =
        column.agent === null
          ? base.is('assigned_agent_id', null)
          : base.eq('assigned_agent_id', column.agent.user_id);

      const { data, error, count } = await query;
      if (error) throw error;

      // `BOARD_CONVERSATION_SELECT` é montado por concatenação (não um
      // literal de string), então o parser de tipos do postgrest-js
      // (que precisaria do literal para resolver os embeds) não
      // consegue tipar `data` — cai em `GenericStringError`. O shape
      // real na resposta é o de sempre; a fronteira de tipos segura é
      // `normalizeConversation[s]`, não este cast.
      const conversations = normalizeConversations(
        (data ?? []) as unknown as Parameters<typeof normalizeConversations>[0]
      );
      return {
        cards: conversations.map(toBoardCard),
        total: count ?? conversations.length,
      };
    },
    []
  );

  // ----------------------------------------------------------
  // Onda 2 — hidratação em lote de notas + deal primário (§4.4).
  // ----------------------------------------------------------
  const hydrateContacts = useCallback(async (contactIds: readonly string[]) => {
    const notes = new Map<string, string>();
    const deals = new Map<string, BoardDealRow[]>();
    if (contactIds.length === 0) return { notes, deals };

    const supabase = createClient();
    const [notesRes, dealsRes] = await Promise.all([
      supabase
        .from('contact_notes')
        .select('contact_id, note_text, created_at')
        .in('contact_id', contactIds)
        .order('created_at', { ascending: false }),
      supabase
        .from('deals')
        .select(
          'contact_id, status, created_at, stage:pipeline_stages(id,name,color), pipeline:pipelines(id,name)'
        )
        .in('contact_id', contactIds)
        .order('created_at', { ascending: false }),
    ]);

    // Já vem ordenado created_at desc — a primeira ocorrência por
    // contato é a mais recente.
    for (const row of (notesRes.data ?? []) as {
      contact_id: string;
      note_text: string;
    }[]) {
      if (!notes.has(row.contact_id)) notes.set(row.contact_id, row.note_text);
    }

    // O parser de tipos do postgrest-js infere embeds many-to-one como
    // array quando não há um schema `Database` para resolver a
    // cardinalidade real da FK — em runtime o PostgREST devolve objeto
    // (cada deal tem exatamente um stage_id/pipeline_id `NOT NULL`,
    // ver `BoardDealRow`), daí o cast em vez de ajustar o tipo.
    for (const row of (dealsRes.data ?? []) as unknown as BoardDealRow[]) {
      if (!row.contact_id) continue;
      const list = deals.get(row.contact_id);
      if (list) list.push(row);
      else deals.set(row.contact_id, [row]);
    }

    return { notes, deals };
  }, []);

  // ----------------------------------------------------------
  // Carga inicial + resync completo (reconexão / visibilidade /
  // INVALID_ASSIGNEE). Sempre uma SUBSTITUIÇÃO do mirror local, nunca
  // um merge — a mesma lição de "revogação é silêncio" documentada em
  // `use-total-unread.ts`.
  // ----------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      try {
        const supabase = createClient();
        const { data: profiles, error: profilesError } = await supabase
          .from('profiles')
          .select('*')
          .order('full_name');
        if (profilesError) throw profilesError;
        if (cancelled) return;

        const cols = buildBoardColumns((profiles as Profile[]) ?? []);
        columnIdsRef.current = new Set(cols.map((c) => c.id));

        const pages = await Promise.all(
          cols.map((col) => fetchColumnPage(col, 0))
        );
        if (cancelled) return;

        const nextState: BoardColumnStateMap = {};
        cardColumnRef.current.clear();
        const contactIds = new Set<string>();
        cols.forEach((col, i) => {
          const { cards, total } = pages[i];
          nextState[col.id] = { column: col, cards, total, loadingMore: false };
          for (const card of cards) {
            cardColumnRef.current.set(card.conversation.id, col.id);
            if (card.conversation.contact_id) {
              contactIds.add(card.conversation.contact_id);
            }
          }
        });

        setColumnsState(nextState);
        setLoading(false);

        const ids = [...contactIds];
        const { notes, deals } = await hydrateContacts(ids);
        if (cancelled) return;
        setColumnsState((prev) => hydrateCards(prev, ids, notes, deals));
      } catch (err) {
        if (cancelled) return;
        console.error('[assignment-board] failed to load board:', err);
        toast.error(t('toastFailed'));
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [resyncToken, fetchColumnPage, hydrateContacts, t]);

  // ----------------------------------------------------------
  // Carregar mais (§6.2) — avança o range de UMA coluna sem recarregar
  // as demais.
  // ----------------------------------------------------------
  const loadMore = useCallback(
    (columnId: string) => {
      const state = columnsStateRef.current[columnId];
      if (!state || state.loadingMore) return;

      setColumnsState((prev) =>
        setColumnLoadingMore(prev, { columnId, loadingMore: true })
      );

      (async () => {
        try {
          const { cards: newCards } = await fetchColumnPage(
            state.column,
            state.cards.length
          );

          const contactIds = newCards
            .map((c) => c.conversation.contact_id)
            .filter((id): id is string => !!id);
          const { notes, deals } = await hydrateContacts(contactIds);
          const hydratedCards = newCards.map((card) => {
            const contactId = card.conversation.contact_id;
            if (!contactId) return card;
            return {
              ...card,
              latestNote: notes.get(contactId) ?? null,
              primaryDeal: pickPrimaryDeal(deals.get(contactId) ?? []),
              hydrated: true,
            };
          });

          for (const card of hydratedCards) {
            cardColumnRef.current.set(card.conversation.id, columnId);
          }

          setColumnsState((prev) =>
            setColumnLoadingMore(
              appendCards(prev, { columnId, cards: hydratedCards }),
              { columnId, loadingMore: false }
            )
          );
        } catch (err) {
          console.error('[assignment-board] failed to load more:', err);
          toast.error(t('toastFailed'));
          setColumnsState((prev) =>
            setColumnLoadingMore(prev, { columnId, loadingMore: false })
          );
        }
      })();
    },
    [fetchColumnPage, hydrateContacts, t]
  );

  // ----------------------------------------------------------
  // Remoção/inserção/reconciliação usadas tanto pelo realtime quanto
  // pelo tratamento de erro do drop (§5.3).
  // ----------------------------------------------------------
  const removeCardById = useCallback((conversationId: string) => {
    const columnId = cardColumnRef.current.get(conversationId);
    if (!columnId) return;
    cardColumnRef.current.delete(conversationId);
    setColumnsState((prev) => removeCard(prev, { conversationId, columnId }));
  }, []);

  /** Busca a linha atual e a reinsere na coluna correta — usado pelo
   *  realtime (id desconhecido) e pelo 409 do drop (§5.3). */
  const refetchCardInto = useCallback(
    async (conversationId: string) => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from('conversations')
        .select(BOARD_CONVERSATION_SELECT)
        .eq('id', conversationId)
        .maybeSingle();

      removeCardById(conversationId);
      if (error || !data) return; // apagada/fora de escopo — fica removida

      const conversation = normalizeConversation(
        data as unknown as Parameters<typeof normalizeConversation>[0]
      );
      if (!isBoardEligibleStatus(conversation.status)) return;

      const targetColumnId =
        conversation.assigned_agent_id ?? UNASSIGNED_COLUMN_ID;
      if (!columnIdsRef.current.has(targetColumnId)) return;

      const card = toBoardCard(conversation);
      cardColumnRef.current.set(conversationId, targetColumnId);
      setColumnsState((prev) =>
        insertCard(prev, { card, columnId: targetColumnId })
      );

      if (conversation.contact_id) {
        const ids = [conversation.contact_id];
        const { notes, deals } = await hydrateContacts(ids);
        setColumnsState((prev) => hydrateCards(prev, ids, notes, deals));
      }
    },
    [hydrateContacts, removeCardById]
  );

  // ----------------------------------------------------------
  // Correção de deriva do `total` (SPEC 043, §4.6 / §6.2).
  //
  // O quadro mostra no máximo `BOARD_PAGE_SIZE` cards por coluna, mas o
  // cabeçalho mostra o total REAL. Um evento sobre uma conversa que não
  // está na página carregada não tem como ajustar as duas pontas: com
  // `REPLICA IDENTITY DEFAULT` o `old` só traz a PK (§2.6), então
  // sabemos para onde ela foi mas não de onde veio. Incrementar o
  // destino sem decrementar a origem faz o cabeçalho mentir — de forma
  // permanente, já que nada no fluxo normal reconcilia.
  //
  // A correção é reler SÓ as contagens. É barato: `head: true` não
  // devolve linha nenhuma, e as duas queries batem exatamente nos
  // índices que a 039 criou. Nunca toca em `cards` — só em `total` —
  // para não competir com um drop em voo nem descartar hidratação.
  // ----------------------------------------------------------
  const refreshColumnCounts = useCallback(async () => {
    const columns = Object.values(columnsStateRef.current).map((s) => s.column);
    if (columns.length === 0) return;

    const supabase = createClient();
    const results = await Promise.all(
      columns.map(async (column) => {
        const base = supabase
          .from('conversations')
          .select('id', { count: 'exact', head: true })
          .in('status', BOARD_STATUSES);
        const query =
          column.agent === null
            ? base.is('assigned_agent_id', null)
            : base.eq('assigned_agent_id', column.agent.user_id);
        const { count, error } = await query;
        // Falha numa coluna não invalida as outras — deixar o total
        // antigo é melhor que zerar o cabeçalho.
        return { id: column.id, count: error ? null : (count ?? 0) };
      })
    );

    setColumnsState((prev) => applyColumnCounts(prev, results));
  }, []);

  const countsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Auto-referência via ref: o agendador precisa poder reagendar a si
  // mesmo quando encontra uma mutação em voo, sem virar dependência
  // circular de `useCallback`.
  const scheduleCountsRefreshRef = useRef<() => void>(() => {});

  const scheduleCountsRefresh = useCallback(() => {
    if (countsTimerRef.current) clearTimeout(countsTimerRef.current);
    countsTimerRef.current = setTimeout(() => {
      countsTimerRef.current = null;
      // Com um drop em voo, o servidor ainda responde a contagem
      // ANTERIOR à escrita: aplicá-la sobrescreveria o ajuste otimista
      // com um número velho, e nada o corrigiria depois. Reagenda.
      const hasPending = Object.values(columnsStateRef.current).some((s) =>
        s.cards.some((c) => c.pending)
      );
      if (hasPending) {
        scheduleCountsRefreshRef.current();
        return;
      }
      void refreshColumnCounts();
    }, COUNTS_REFRESH_DEBOUNCE_MS);
  }, [refreshColumnCounts]);

  useEffect(() => {
    scheduleCountsRefreshRef.current = scheduleCountsRefresh;
  }, [scheduleCountsRefresh]);

  useEffect(
    () => () => {
      if (countsTimerRef.current) clearTimeout(countsTimerRef.current);
    },
    []
  );

  // ----------------------------------------------------------
  // Realtime — canal próprio (SPEC 043, §4.6). Segue a tabela de
  // eventos da SPEC: nunca lê `old.assigned_agent_id` (§2.6).
  // ----------------------------------------------------------
  const handleBoardEvent = useCallback(
    (event: {
      eventType: 'INSERT' | 'UPDATE' | 'DELETE';
      new: Conversation;
      old: Partial<Conversation>;
    }) => {
      if (event.eventType === 'DELETE') {
        const deletedId = event.old?.id;
        if (!deletedId) return;
        // Fora da página carregada: nada a remover localmente, mas a
        // contagem de alguma coluna caiu — ver a nota abaixo.
        if (cardColumnRef.current.has(deletedId)) removeCardById(deletedId);
        else scheduleCountsRefresh();
        return;
      }

      const conv = event.new;
      if (!conv?.id) return;

      // Conversa que NÃO está na página carregada de nenhuma coluna.
      // Qualquer coisa que aconteça com ela mexe em contagens que não
      // temos como ajustar linha a linha (não sabemos de que coluna
      // saiu — §2.6), então a única saída honesta é reler os totais.
      // Debounced: numa conta movimentada isto dispara em rajada e
      // colapsa numa consulta só.
      const isOffPage = !cardColumnRef.current.has(conv.id);
      if (isOffPage) scheduleCountsRefresh();

      if (!isBoardEligibleStatus(conv.status)) {
        if (cardColumnRef.current.has(conv.id)) removeCardById(conv.id);
        return;
      }

      const knownColumnId = cardColumnRef.current.get(conv.id);
      const targetColumnId = conv.assigned_agent_id ?? UNASSIGNED_COLUMN_ID;

      if (!columnIdsRef.current.has(targetColumnId)) {
        // Atribuída a alguém que não é coluna do quadro (papel não
        // atribuível, ou saiu da conta) — não pertence a nenhuma coluna
        // visível.
        if (knownColumnId) removeCardById(conv.id);
        return;
      }

      if (knownColumnId === targetColumnId) return; // já está no lugar certo

      if (!knownColumnId) {
        // Id desconhecido + elegível: busca a linha completa (o
        // payload de realtime não traz o embed de contato/tags).
        void refetchCardInto(conv.id);
        return;
      }

      // Move de uma coluna conhecida para a derivada do novo dono.
      cardColumnRef.current.set(conv.id, targetColumnId);
      setColumnsState((prev) =>
        moveCard(prev, {
          conversationId: conv.id,
          fromColumnId: knownColumnId,
          toColumnId: targetColumnId,
          assignedAgentId: conv.assigned_agent_id ?? null,
        })
      );
    },
    [removeCardById, refetchCardInto, scheduleCountsRefresh]
  );

  const { isConnected } = useRealtime({
    // Canal PRÓPRIO, distinto do 'inbox-realtime' da página — o custo
    // fica limitado ao tempo em que a aba "Time" está montada (o
    // componente só existe enquanto `activeTab === 'board'`, então não
    // há necessidade de um flag `enabled` adicional aqui). Em troca, a
    // página desliga o canal DELA enquanto o quadro está aberto, para
    // não haver duas assinaturas simultâneas às mesmas tabelas.
    channelName: 'inbox-assignment-board',
    // Só `conversations`: tudo o que o card mostra e que muda sozinho —
    // `assigned_agent_id`, `status`, `last_message_at`, `unread_count` —
    // vive nessa linha; o webhook já a atualiza ao gravar a mensagem.
    // Assinar `messages` traria o firehose inteiro da conta para ser
    // descartado.
    tables: ['conversations'],
    onConversationEvent: handleBoardEvent,
    enabled: true,
  });

  // Resync em reconexão do WS (após a conexão inicial) — mesmo padrão
  // de `inbox/page.tsx`.
  const wasConnectedRef = useRef(false);
  const initialConnectDoneRef = useRef(false);
  useEffect(() => {
    if (isConnected && !wasConnectedRef.current) {
      if (initialConnectDoneRef.current) {
        bumpResync();
      } else {
        initialConnectDoneRef.current = true;
      }
    }
    wasConnectedRef.current = isConnected;
  }, [isConnected, bumpResync]);

  // Resync ao a aba voltar a ficar visível.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') bumpResync();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [bumpResync]);

  // ----------------------------------------------------------
  // Drop — mutação otimista (SPEC 043, §5.2) + matriz de erros (§5.3).
  // ----------------------------------------------------------
  /**
   * Encerra a mutação de um card: limpa `pending` e — só se ele ainda
   * estiver onde o drop o colocou — grava o `assigned_agent_id` que o
   * servidor devolveu.
   *
   * ⚠️ Localiza o card por `cardColumnRef`, NUNCA pela coluna capturada
   * no snapshot do drop. Um evento de realtime intercalado (outro admin
   * movendo a mesma conversa enquanto o nosso POST está em voo) já pode
   * tê-lo levado para uma terceira coluna; procurar em `expectedColumnId`
   * não o acharia e o `pending` ficaria preso para sempre — card
   * esmaecido e inarrastável (o `useDraggable` fica `disabled`), sem
   * saída até um resync.
   *
   * Quando o card MUDOU de coluna nesse meio-tempo, o evento de realtime
   * é mais recente que a nossa resposta: limpamos o `pending` mas não
   * sobrescrevemos `assigned_agent_id`, senão a UI voltaria ao dono que
   * pedimos em vez do dono que de fato venceu a corrida.
   */
  const settleDrop = useCallback(
    (
      conversationId: string,
      expectedColumnId: string,
      assignedAgentId: string | null
    ) => {
      const currentColumnId = cardColumnRef.current.get(conversationId);
      if (!currentColumnId) return; // card já saiu do quadro
      setColumnsState((prev) =>
        settleCard(prev, {
          conversationId,
          columnId: currentColumnId,
          assignedAgentId,
          patchAssignment: currentColumnId === expectedColumnId,
        })
      );
    },
    []
  );

  /** Limpa só o `pending` de um card, onde quer que ele esteja agora. */
  const clearPending = useCallback((conversationId: string) => {
    const columnId = cardColumnRef.current.get(conversationId);
    if (!columnId) return;
    setColumnsState((prev) =>
      clearCardPending(prev, { conversationId, columnId })
    );
  }, []);

  /**
   * Desfaz o movimento otimista, devolvendo o card à coluna e ao índice
   * de origem.
   *
   * ⚠️ Só restaura se o card AINDA estiver na coluna de destino do
   * snapshot. Se um evento de realtime já o moveu para outro lugar, o
   * estado do servidor é mais recente que o nosso snapshot: restaurar
   * ali inseriria uma SEGUNDA cópia do card (o `filter` no destino não
   * acharia nada para remover, mas o `splice` na origem aconteceria
   * mesmo assim) — chave React duplicada e `total` inflado. Nesse caso
   * só limpamos o `pending` e deixamos a posição que o realtime ditou.
   */
  const rollbackDrop = useCallback(
    (snapshot: DropSnapshot) => {
      const { sourceColumnId, targetColumnId, card } = snapshot;
      const conversationId = card.conversation.id;

      if (cardColumnRef.current.get(conversationId) !== targetColumnId) {
        clearPending(conversationId);
        return;
      }

      cardColumnRef.current.set(conversationId, sourceColumnId);
      setColumnsState((prev) => restoreCard(prev, snapshot));
    },
    [clearPending]
  );

  const handleDropError = useCallback(
    (status: number, code: string | undefined, snapshot: DropSnapshot) => {
      const conversationId = snapshot.card.conversation.id;

      // 429 não carrega `code` (ver rate-limit.ts) — precisa checar o
      // status antes do switch por código.
      if (status === 429) {
        rollbackDrop(snapshot);
        toast.error(t('toastRateLimited'));
        return;
      }

      switch (code) {
        case 'CONVERSATION_ALREADY_CLAIMED':
          // NÃO faz rollback — outro agente ficou com ela; devolvê-la à
          // fila mostraria uma mentira. Refetch pontual recoloca o card
          // na coluna real.
          toast.info(t('toastAlreadyClaimed'));
          void refetchCardInto(conversationId);
          return;
        case 'CONVERSATION_NOT_FOUND':
          // Sob a RLS, "não é sua" e "não existe" são indistinguíveis
          // por desenho — remove sem tentar diferenciar.
          removeCardById(conversationId);
          toast.error(t('toastNotFound'));
          return;
        case 'INVALID_ASSIGNEE':
          rollbackDrop(snapshot);
          toast.error(t('toastInvalidAssignee'));
          bumpResync(); // roster desatualizado — recarrega colunas + cards
          return;
        case 'ONLY_ADMIN_CAN_REASSIGN_TO_OTHERS':
        case 'NOT_CONVERSATION_OWNER':
        case 'INSUFFICIENT_ROLE':
        case 'Unauthorized':
          rollbackDrop(snapshot);
          toast.error(t('toastForbidden'));
          return;
        default:
          rollbackDrop(snapshot);
          toast.error(t('toastFailed'));
      }
    },
    [rollbackDrop, refetchCardInto, removeCardById, bumpResync, t]
  );

  const moveConversation = useCallback(
    (
      conversationId: string,
      sourceColumnId: string,
      targetColumnId: string
    ) => {
      if (sourceColumnId === targetColumnId) return;

      // `cardColumnRef` é a autoridade sobre onde o card está: todos os
      // caminhos que mexem em colunas (drop, realtime, remoção) o
      // atualizam SINCRONAMENTE, enquanto `columnsStateRef` só reflete o
      // último commit do React. Se um evento de realtime reposicionou
      // este card entre o `dragStart` e o `drop`, é aqui que se descobre
      // — e a origem correta é a do ref, não a que a UI mostrava.
      const actualSourceId =
        cardColumnRef.current.get(conversationId) ?? sourceColumnId;
      if (actualSourceId === targetColumnId) return;

      const sourceState = columnsStateRef.current[actualSourceId];
      const targetState = columnsStateRef.current[targetColumnId];
      if (!sourceState || !targetState) return;

      const cardIndex = sourceState.cards.findIndex(
        (c) => c.conversation.id === conversationId
      );
      if (cardIndex === -1) return;
      const card = sourceState.cards[cardIndex];
      if (card.pending) return; // já há mutação em voo para este card

      const snapshot: DropSnapshot = {
        sourceColumnId: actualSourceId,
        targetColumnId,
        cardIndex,
        card,
      };

      // Otimista — move, ajusta os dois `total`, marca `pending`.
      //
      // ⚠️ `cardColumnRef` é atualizado ANTES do fetch, e isso é
      // load-bearing: o `postgres_changes` do Supabase não exclui o
      // cliente que originou a escrita, então o nosso próprio UPDATE
      // volta como evento. Com o ref já apontando para o destino,
      // `handleBoardEvent` reconhece o eco como no-op
      // (`knownColumnId === targetColumnId`). Mover este `set` para
      // depois do `await` faria o eco reprocessar o movimento.
      cardColumnRef.current.set(conversationId, targetColumnId);
      setColumnsState((prev) =>
        moveCard(prev, {
          conversationId,
          fromColumnId: actualSourceId,
          toColumnId: targetColumnId,
          markPending: true,
        })
      );

      (async () => {
        try {
          const targetAgentId = boardColumnIdToAgentId(targetColumnId);
          // Puxar da fila para a PRÓPRIA coluna passa pelo RPC atômico
          // de claim (o `WHERE assigned_agent_id IS NULL` é o lock —
          // SPEC 043, §5.1); qualquer outro movimento vai por /assign.
          const isClaimFromQueue =
            actualSourceId === UNASSIGNED_COLUMN_ID && targetAgentId === userId;
          const endpoint = isClaimFromQueue
            ? `/api/inbox/conversations/${conversationId}/claim`
            : `/api/inbox/conversations/${conversationId}/assign`;

          const res = await fetch(endpoint, {
            method: 'POST',
            ...(isClaimFromQueue
              ? {}
              : {
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ assigned_agent_id: targetAgentId }),
                }),
          });
          const json = await res.json().catch(() => ({}));

          if (!res.ok) {
            handleDropError(res.status, json?.code, snapshot);
            return;
          }

          // RPCs fazem `RETURNS conversations` — a linha volta crua,
          // sem embed de contato/tags. Patch APENAS `assigned_agent_id`
          // (§5.2) — substituir o card inteiro apagaria nome, tags,
          // nota e badge já hidratados.
          const updatedAgentId =
            (json?.conversation?.assigned_agent_id as
              string | null | undefined) ?? targetAgentId;
          settleDrop(conversationId, targetColumnId, updatedAgentId);

          if (targetColumnId === UNASSIGNED_COLUMN_ID) {
            toast.success(t('toastUnassigned'));
          } else {
            toast.success(
              t('toastAssigned', {
                name:
                  targetState.column.agent?.full_name ??
                  tTabs('viewAsUnknownMember'),
              })
            );
          }
        } catch (err) {
          console.error('[assignment-board] drop failed:', err);
          rollbackDrop(snapshot);
          toast.error(t('toastFailed'));
        }
      })();
    },
    [userId, handleDropError, settleDrop, rollbackDrop, t, tTabs]
  );

  const columns = useMemo(() => Object.values(columnsState), [columnsState]);
  const hasNoAssignableMembers = !loading && columns.length <= 1;

  return {
    columns,
    loading,
    hasNoAssignableMembers,
    loadMore,
    moveConversation,
  };
}
