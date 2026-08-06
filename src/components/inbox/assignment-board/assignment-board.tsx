'use client';

// ============================================================
// AssignmentBoard — orquestrador de DnD do Quadro de Atribuição
// (SPEC 043, §3.3, §6, §7). `DndContext` + sensores + `DragOverlay` +
// `announcements`, montado como a aba "Time" do Inbox
// (`inbox/page.tsx`, `activeTab === 'board'`).
//
// Vocabulário do módulo (SPEC 043, §3.1, invariante 4): coluna = um
// agente (ou a fila); card = uma conversa. Nenhuma referência a
// `deals`/`pipeline_stages` além do badge read-only já resolvido pelo
// hook de dados (`primaryDeal`).
// ============================================================

import { useCallback, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { usePresence } from '@/hooks/use-presence';
import type { BoardAssignTarget } from '@/lib/inbox/assignment-board';
import {
  useAssignmentBoard,
  type BoardCard,
  type BoardColumnState,
} from './use-assignment-board';
import { AgentColumn } from './agent-column';
import { ConversationCard } from './conversation-card';

function columnDisplayName(
  state: BoardColumnState,
  t: ReturnType<typeof useTranslations>,
  tTabs: ReturnType<typeof useTranslations>
): string {
  return state.column.agent === null
    ? t('unassignedColumn')
    : state.column.agent.full_name || tTabs('viewAsUnknownMember');
}

function findCard(
  columns: BoardColumnState[],
  cardId: string
): { card: BoardCard; state: BoardColumnState } | null {
  for (const state of columns) {
    const card = state.cards.find((c) => c.conversation.id === cardId);
    if (card) return { card, state };
  }
  return null;
}

export function AssignmentBoard() {
  const t = useTranslations('Inbox.assignmentBoard');
  const tTabs = useTranslations('Inbox.tabs');
  const tList = useTranslations('Inbox.conversationList');
  const router = useRouter();

  const {
    columns,
    loading,
    hasNoAssignableMembers,
    loadMore,
    moveConversation,
  } = useAssignmentBoard();
  const { getPresence, now: presenceNow } = usePresence();

  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  // Coluna de origem observada no início do arrasto — usada APENAS para
  // os anúncios de acessibilidade ("levantado da coluna X"), porque no
  // `onDragEnd` a mutação otimista já pode ter movido o card e não daria
  // mais para reconstruir de onde ele saiu.
  //
  // ⚠️ NÃO é o que decide a origem do movimento: um evento de realtime
  // pode reposicionar o card durante o arrasto, tornando este valor
  // obsoleto. Quem resolve a origem real é `moveConversation`, contra o
  // `cardColumnRef` do hook (atualizado sincronamente por todos os
  // caminhos). Antes, passar este valor obsoleto adiante fazia o drop
  // ser descartado em silêncio, sem nenhum feedback ao usuário.
  const dragOriginRef = useRef<{ cardId: string; columnId: string } | null>(
    null
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor)
  );

  // Destinos do menu "atribuir a…" dos cards (§6.4). Calculado uma vez
  // aqui, com os rótulos já resolvidos, para o card não precisar de
  // `useTranslations` nem conhecer o roster.
  const assignTargets = useMemo<BoardAssignTarget[]>(
    () =>
      columns.map((state) => ({
        id: state.column.id,
        label: columnDisplayName(state, t, tTabs),
        isQueue: state.column.agent === null,
      })),
    [columns, t, tTabs]
  );

  // Mesmo ponto de entrada do drop — todas as guardas (mesma coluna,
  // card em voo, origem real via `cardColumnRef`) já vivem lá.
  const handleAssignCard = useCallback(
    (conversationId: string, targetColumnId: string) => {
      const found = findCard(columns, conversationId);
      if (!found) return;
      moveConversation(conversationId, found.state.column.id, targetColumnId);
    },
    [columns, moveConversation]
  );

  const handleOpenCard = useCallback(
    (card: BoardCard) => {
      const conv = card.conversation;
      const url = conv.assigned_agent_id
        ? `/inbox?tab=chat&c=${conv.id}&viewAs=${conv.assigned_agent_id}`
        : `/inbox?tab=open&c=${conv.id}`;
      router.push(url);
    },
    [router]
  );

  function handleDragStart(event: DragStartEvent) {
    const cardId = String(event.active.id);
    setActiveCardId(cardId);
    const found = findCard(columns, cardId);
    dragOriginRef.current = found
      ? { cardId, columnId: found.state.column.id }
      : null;
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveCardId(null);
    const { active, over } = event;
    // `dragOriginRef` NÃO é limpo aqui: o anúncio de acessibilidade do
    // `onDragEnd` roda depois deste handler (a Accessibility do dnd-kit
    // reage ao estado num efeito) e precisa da origem para dizer "voltou
    // para a coluna X" quando o card é solto fora de qualquer coluna.
    // O `onDragStart` sempre sobrescreve o valor, então não há resíduo.
    if (!over) return;

    const cardId = String(active.id);
    const targetColumnId = String(over.id);
    // Origem recalculada AGORA, no estado corrente — não a do
    // `dragOriginRef`, que pode ter envelhecido durante o arrasto (ver a
    // nota na declaração do ref). `moveConversation` ainda revalida
    // contra o `cardColumnRef`, que é a autoridade final.
    const found = findCard(columns, cardId);
    if (!found) return;
    moveConversation(cardId, found.state.column.id, targetColumnId);
  }

  function handleDragCancel() {
    setActiveCardId(null);
  }

  const activeCard = activeCardId
    ? (findCard(columns, activeCardId)?.card ?? null)
    : null;

  const announcements: Announcements = useMemo(
    () => ({
      onDragStart({ active }) {
        const found = findCard(columns, String(active.id));
        if (!found) return '';
        const contact = found.card.conversation.contact;
        return t('a11yDragStart', {
          contact: contact?.name || contact?.phone || tList('unknown'),
          from: columnDisplayName(found.state, t, tTabs),
        });
      },
      onDragOver({ over }) {
        if (!over) return '';
        const state = columns.find((c) => c.column.id === over.id);
        if (!state) return '';
        return t('a11yDragOver', { over: columnDisplayName(state, t, tTabs) });
      },
      onDragEnd({ active, over }) {
        const origin = dragOriginRef.current;
        const found = findCard(columns, String(active.id));
        const contactName =
          found?.card.conversation.contact?.name ||
          found?.card.conversation.contact?.phone ||
          tList('unknown');
        if (!over) {
          const originState = origin
            ? columns.find((c) => c.column.id === origin.columnId)
            : undefined;
          return t('a11yDragCancel', {
            contact: contactName,
            from: originState ? columnDisplayName(originState, t, tTabs) : '',
          });
        }
        const toState = columns.find((c) => c.column.id === over.id);
        return t('a11yDragEnd', {
          contact: contactName,
          to: toState ? columnDisplayName(toState, t, tTabs) : String(over.id),
        });
      },
      onDragCancel({ active }) {
        const found = findCard(columns, String(active.id));
        const contact = found?.card.conversation.contact;
        return t('a11yDragCancel', {
          contact: contact?.name || contact?.phone || tList('unknown'),
          from: found ? columnDisplayName(found.state, t, tTabs) : '',
        });
      },
    }),
    [columns, t, tTabs, tList]
  );

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden p-3">
      {hasNoAssignableMembers && (
        <p className="text-muted-foreground mb-3 text-xs">{t('noMembers')}</p>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        accessibility={{ announcements }}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div className="assignment-board-scroll flex flex-1 snap-x snap-mandatory gap-3 overflow-x-auto pb-2 lg:snap-none">
          {columns.map((state) => (
            <AgentColumn
              key={state.column.id}
              state={state}
              presence={
                state.column.agent
                  ? getPresence(state.column.agent.user_id)
                  : null
              }
              presenceNow={presenceNow}
              assignTargets={assignTargets}
              onOpenCard={handleOpenCard}
              onAssignCard={handleAssignCard}
              onLoadMore={loadMore}
            />
          ))}
        </div>

        <DragOverlay
          dropAnimation={{
            duration: 200,
            easing: 'cubic-bezier(0.2, 0, 0, 1)',
          }}
        >
          {activeCard ? (
            <div className="w-[260px] opacity-90">
              {/* Fantasma do arrasto: sem menu e sem interação — daí
                  `assignTargets` vazio e os handlers no-op. */}
              <ConversationCard
                card={activeCard}
                columnId=""
                assignTargets={[]}
                onOpen={() => {}}
                onAssign={() => {}}
                isOverlay
              />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <style jsx>{`
        .assignment-board-scroll {
          scroll-behavior: smooth;
        }
        @media (hover: none), (pointer: coarse) {
          .assignment-board-scroll::-webkit-scrollbar {
            height: 0;
            display: none;
          }
          .assignment-board-scroll {
            scrollbar-width: none;
          }
        }
        @media (hover: hover) and (pointer: fine) {
          .assignment-board-scroll {
            scrollbar-width: thin;
            scrollbar-color: var(--border) transparent;
          }
          .assignment-board-scroll::-webkit-scrollbar {
            height: 8px;
          }
          .assignment-board-scroll::-webkit-scrollbar-track {
            background: transparent;
          }
          .assignment-board-scroll::-webkit-scrollbar-thumb {
            background-color: var(--border);
            border-radius: 9999px;
          }
          .assignment-board-scroll::-webkit-scrollbar-thumb:hover {
            background-color: var(--muted-foreground);
          }
        }
      `}</style>
    </div>
  );
}
