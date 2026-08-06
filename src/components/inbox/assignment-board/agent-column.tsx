'use client';

// ============================================================
// AgentColumn — coluna do Quadro de Atribuição (SPEC 043, §6.2).
// `useDroppable`; cabeçalho (avatar/ícone, nome, presença, contagem
// TOTAL real do servidor), lista de cards, "carregar mais", estado
// vazio.
// ============================================================

import { useDroppable } from '@dnd-kit/core';
import { useTranslations } from 'next-intl';
import { Inbox as InboxIcon, Loader2 } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { PresenceDot } from '@/components/presence/presence-dot';
import { presenceLabel, type PresenceStatus } from '@/lib/presence';
import { cn } from '@/lib/utils';
import type { BoardAssignTarget } from '@/lib/inbox/assignment-board';
import type { BoardCard, BoardColumnState } from './use-assignment-board';
import { DraggableConversationCard } from './draggable-conversation-card';

interface AgentColumnProps {
  state: BoardColumnState;
  /** `null` para a coluna da fila — ela não representa uma pessoa. */
  presence: PresenceStatus | null;
  presenceNow: number;
  /** Destinos do menu "atribuir a…" dos cards desta coluna (§6.4). */
  assignTargets: readonly BoardAssignTarget[];
  onOpenCard: (card: BoardCard) => void;
  onAssignCard: (conversationId: string, targetColumnId: string) => void;
  onLoadMore: (columnId: string) => void;
}

export function AgentColumn({
  state,
  presence,
  presenceNow,
  assignTargets,
  onOpenCard,
  onAssignCard,
  onLoadMore,
}: AgentColumnProps) {
  const t = useTranslations('Inbox.assignmentBoard');
  const tTabs = useTranslations('Inbox.tabs');
  const { setNodeRef, isOver } = useDroppable({ id: state.column.id });

  const { column, cards, total, loadingMore } = state;
  const isQueue = column.agent === null;
  const columnName = isQueue
    ? t('unassignedColumn')
    : column.agent!.full_name || tTabs('viewAsUnknownMember');
  const hasMore = cards.length < total;

  return (
    <div className="border-border bg-card/60 flex w-[85vw] max-w-[320px] min-w-[260px] shrink-0 snap-start flex-col rounded-xl border p-3 lg:w-auto lg:max-w-none lg:flex-1 lg:shrink lg:basis-[260px] lg:snap-none">
      <div className="flex items-center gap-2 px-1">
        {isQueue ? (
          <span className="bg-muted text-muted-foreground flex h-6 w-6 shrink-0 items-center justify-center rounded-full">
            <InboxIcon className="h-3.5 w-3.5" />
          </span>
        ) : (
          <span className="relative shrink-0">
            <Avatar size="sm">
              <AvatarFallback>
                {columnName.charAt(0).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            {presence && (
              <PresenceDot
                status={presence}
                label={presenceLabel(presence, null, presenceNow)}
                className="ring-card absolute -right-0.5 -bottom-0.5 ring-2"
              />
            )}
          </span>
        )}
        <span className="text-foreground min-w-0 flex-1 truncate text-sm font-semibold">
          {columnName}
        </span>
        <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium">
          {total}
        </span>
      </div>

      <div
        ref={setNodeRef}
        aria-label={t('columnAriaLabel', { name: columnName })}
        className={cn(
          'mt-3 flex flex-1 flex-col gap-2 rounded-lg transition-all',
          isOver &&
            'bg-primary/5 outline-primary outline outline-2 outline-offset-2 outline-dashed'
        )}
      >
        {cards.length === 0 ? (
          <div className="border-border text-muted-foreground flex flex-1 items-center justify-center rounded-lg border-2 border-dashed py-10 text-center text-xs">
            {t('dropHere')}
          </div>
        ) : (
          cards.map((card) => (
            <DraggableConversationCard
              key={card.conversation.id}
              card={card}
              columnId={column.id}
              assignTargets={assignTargets}
              onOpen={onOpenCard}
              onAssign={onAssignCard}
            />
          ))
        )}
      </div>

      {hasMore && (
        <div className="mt-3 flex flex-col items-center gap-1.5">
          <span className="text-muted-foreground text-[11px]">
            {t('showingOf', { shown: cards.length, total })}
          </span>
          <button
            type="button"
            onClick={() => onLoadMore(column.id)}
            disabled={loadingMore}
            className="border-border text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed bg-transparent px-3 py-1.5 text-xs disabled:opacity-60"
          >
            {loadingMore && <Loader2 className="h-3 w-3 animate-spin" />}
            {t('loadMore')}
          </button>
        </div>
      )}
    </div>
  );
}
