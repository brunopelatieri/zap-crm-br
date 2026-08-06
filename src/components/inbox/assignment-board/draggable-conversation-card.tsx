'use client';

// ============================================================
// DraggableConversationCard — wrapper fino com `useDraggable`,
// espelhando `DraggableDealCard` do board de pipelines (SPEC 043,
// §3.2). O card em si (`ConversationCard`) não sabe nada de DnD.
// ============================================================

import { useDraggable } from '@dnd-kit/core';
import type { BoardAssignTarget } from '@/lib/inbox/assignment-board';
import type { BoardCard as BoardCardData } from './use-assignment-board';
import { ConversationCard } from './conversation-card';

interface DraggableConversationCardProps {
  card: BoardCardData;
  columnId: string;
  assignTargets: readonly BoardAssignTarget[];
  onOpen: (card: BoardCardData) => void;
  onAssign: (conversationId: string, targetColumnId: string) => void;
}

export function DraggableConversationCard({
  card,
  columnId,
  assignTargets,
  onOpen,
  onAssign,
}: DraggableConversationCardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: card.conversation.id,
    // Uma mutação já em voo não pode ser arrastada de novo (SPEC 043,
    // §5.2) — dnd-kit desliga os listeners de arrasto via `disabled`,
    // sem precisar de um hack de `pointer-events`.
    disabled: card.pending,
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={{ opacity: isDragging ? 0.3 : 1, touchAction: 'none' }}
    >
      <ConversationCard
        card={card}
        columnId={columnId}
        assignTargets={assignTargets}
        onOpen={onOpen}
        onAssign={onAssign}
      />
    </div>
  );
}
