'use client';

// ============================================================
// ConversationCard — card puro do Quadro de Atribuição (SPEC 043,
// §6.3). Sem hooks de DnD e sem rede — só apresentação. O wrapper
// arrastável fica em `draggable-conversation-card.tsx`, mesma divisão
// de `DealCard` / `DraggableDealCard` no board de pipelines: o
// `DragOverlay` precisa renderizar o card SEM os listeners de arrasto.
// ============================================================

import { format } from 'date-fns';
import { useTranslations } from 'next-intl';
import { Check, Inbox as InboxIcon, Layers, MoreVertical } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { BoardAssignTarget } from '@/lib/inbox/assignment-board';
import type { BoardCard as BoardCardData } from './use-assignment-board';

interface ConversationCardProps {
  card: BoardCardData;
  /** Coluna em que este card está — origem do movimento pelo menu. */
  columnId: string;
  /** Destinos do menu "atribuir a…", com rótulo já resolvido. */
  assignTargets: readonly BoardAssignTarget[];
  onOpen: (card: BoardCardData) => void;
  onAssign: (conversationId: string, targetColumnId: string) => void;
  isOverlay?: boolean;
}

const MAX_VISIBLE_TAGS = 3;

export function ConversationCard({
  card,
  columnId,
  assignTargets,
  onOpen,
  onAssign,
  isOverlay,
}: ConversationCardProps) {
  const t = useTranslations('Inbox.assignmentBoard');
  // Reusa a chave existente do Inbox para "contato sem nome" — mesma
  // label que `conversation-list.tsx` já usa, em vez de duplicar.
  const tList = useTranslations('Inbox.conversationList');
  const { conversation, latestNote, primaryDeal, hydrated, pending } = card;
  const contact = conversation.contact;

  const displayName = contact?.name || contact?.phone || tList('unknown');
  const initial = displayName.charAt(0).toUpperCase();
  const time = conversation.last_message_at
    ? format(new Date(conversation.last_message_at), 'HH:mm')
    : '';
  const tags = contact?.tags ?? [];
  const visibleTags = tags.slice(0, MAX_VISIBLE_TAGS);
  const hiddenTagCount = tags.length - visibleTags.length;

  return (
    // Raiz é um `<div>` puro, NÃO um `<button>`: o wrapper de arrasto
    // (`useDraggable`) já injeta `role="button"` + `tabIndex={0}` para o
    // arrasto por teclado, e aninhar um botão real ali dentro criava
    // conteúdo interativo aninhado e um segundo tab-stop por card.
    // O clique aqui é conveniência de mouse; o caminho de TECLADO para
    // as mesmas ações é o menu abaixo, que é um botão de verdade e
    // inclui o item "abrir conversa".
    <div
      onClick={(e) => {
        // Sobrevive ao tap não-arrasto por causa do
        // `activationConstraint: { distance: 5 }` do PointerSensor —
        // mesmo padrão de DealCard.
        if (isOverlay) return;
        e.stopPropagation();
        onOpen(card);
      }}
      aria-busy={pending}
      className={cn(
        'group border-border/50 bg-muted/70 relative w-full cursor-pointer rounded-xl border p-3 text-left shadow-sm transition-all',
        isOverlay
          ? 'shadow-xl'
          : 'hover:border-border hover:bg-muted hover:-translate-y-0.5 hover:shadow-lg',
        pending && 'pointer-events-none opacity-50'
      )}
    >
      {/* Linha 1: avatar + nome + hora + não lidas + menu */}
      <div className="flex items-center gap-2">
        <span className="bg-muted text-foreground flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full text-xs font-semibold">
          {contact?.avatar_url ? (
            <img
              src={contact.avatar_url}
              alt=""
              className="h-7 w-7 rounded-full object-cover"
            />
          ) : (
            initial
          )}
        </span>
        <span className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">
          {displayName}
        </span>
        {time && (
          <span className="text-muted-foreground shrink-0 text-[10px]">
            {time}
          </span>
        )}
        {conversation.unread_count > 0 && (
          <span className="bg-primary text-primary-foreground flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-bold">
            {conversation.unread_count}
          </span>
        )}

        {/* Menu "atribuir a…" — o caminho SEM arrasto (SPEC 043, §6.4).
            Torna a feature operável no toque e por teclado, onde o DnD
            é frágil ou impossível. Não renderiza no overlay de arrasto,
            que é só um fantasma visual.

            Sem `PresenceDot` aqui, ao contrário do dropdown do
            message-thread: a presença de cada agente já está no
            cabeçalho da coluna, uma linha acima, e trazê-la para o card
            exigiria injetar a API inteira de `usePresence` num
            componente-folha (chamar o hook aqui abriria um canal
            realtime POR CARD). */}
        {!isOverlay && assignTargets.length > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger
              // ⚠️ `pointerdown`, não só `click`: o `PointerSensor` do
              // dnd-kit ativa em QUALQUER pointerdown primário sobre o
              // elemento arrastável — ele não exclui filhos interativos
              // (ver `PointerSensor.activators` no core). Sem barrar
              // aqui, tocar o menu no celular e mover o dedo 5px começa
              // um arrasto em vez de abrir o menu — justamente no
              // dispositivo em que o menu existe para substituir o
              // arrasto. Os listeners do dnd-kit são handlers React no
              // wrapper, então `stopPropagation` no evento sintético do
              // filho basta.
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              aria-label={t('assignMenuLabel', { name: displayName })}
              title={t('assignMenuTitle')}
              className="text-muted-foreground hover:bg-background hover:text-foreground focus-visible:ring-primary flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-[opacity,background-color,color] focus-visible:opacity-100 focus-visible:ring-2 focus-visible:outline-none lg:opacity-0 lg:group-focus-within:opacity-100 lg:group-hover:opacity-100"
            >
              <MoreVertical className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="border-border bg-popover"
              // O conteúdo é portalado no DOM, mas eventos sintéticos do
              // React continuam propagando pela ÁRVORE DE COMPONENTES —
              // ou seja, ainda chegariam ao card e ao wrapper de
              // arrasto. Sem isto, clicar num item abriria a conversa
              // junto com a atribuição.
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <DropdownMenuItem
                onClick={() => onOpen(card)}
                className="text-popover-foreground text-sm"
              >
                {t('assignMenuOpen')}
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-border" />
              <DropdownMenuLabel className="text-muted-foreground text-xs">
                {t('assignMenuTitle')}
              </DropdownMenuLabel>
              {assignTargets.map((target) => {
                const isCurrent = target.id === columnId;
                return (
                  <DropdownMenuItem
                    key={target.id}
                    disabled={isCurrent}
                    onClick={() => onAssign(conversation.id, target.id)}
                    className={cn(
                      'text-sm',
                      isCurrent ? 'text-primary' : 'text-popover-foreground'
                    )}
                  >
                    {target.isQueue && (
                      <InboxIcon className="mr-2 h-3 w-3 shrink-0" />
                    )}
                    <span className="flex-1 truncate">{target.label}</span>
                    {isCurrent && <Check className="ml-2 h-3 w-3 shrink-0" />}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Linha 2: trecho da última nota — altura reservada mesmo antes
          da onda 2 chegar, para não haver layout shift (§4.4). */}
      <p className="text-muted-foreground mt-1.5 min-h-[1rem] truncate text-xs">
        {!hydrated ? (
          <span className="bg-muted-foreground/20 inline-block h-3 w-2/3 animate-pulse rounded" />
        ) : (
          (latestNote ?? '')
        )}
      </p>

      {/* Linha 3: etiquetas — fórmula universal do repo, não ui/badge.tsx. */}
      {visibleTags.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {visibleTags.map((tag) => (
            <span
              key={tag.id}
              className="rounded-full px-2 py-0.5 text-[10px] font-medium"
              style={{ backgroundColor: `${tag.color}20`, color: tag.color }}
            >
              {tag.name}
            </span>
          ))}
          {hiddenTagCount > 0 && (
            <span className="text-muted-foreground text-[10px] font-medium">
              {t('moreTags', { count: hiddenTagCount })}
            </span>
          )}
        </div>
      )}

      {/* Linha 4: badge de CRM — SOMENTE LEITURA (SPEC 043, §3.1
          invariante 3 e §6.3). Visualmente distinto das etiquetas
          (ícone + formato "{funil} › {etapa}") para não ser confundido
          com uma tag. */}
      {primaryDeal && (
        <div
          className={cn(
            'text-muted-foreground mt-1.5 inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium',
            primaryDeal.stale && 'opacity-60'
          )}
          style={{ borderColor: `${primaryDeal.stageColor}40` }}
          title={
            primaryDeal.stale
              ? t('crmBadgeClosedTitle', {
                  pipeline: primaryDeal.pipelineName,
                  stage: primaryDeal.stageName,
                })
              : t('crmBadge', {
                  pipeline: primaryDeal.pipelineName,
                  stage: primaryDeal.stageName,
                })
          }
        >
          <Layers
            className="h-2.5 w-2.5 shrink-0"
            style={{ color: primaryDeal.stageColor }}
          />
          <span className="truncate">
            {t('crmBadge', {
              pipeline: primaryDeal.pipelineName,
              stage: primaryDeal.stageName,
            })}
          </span>
        </div>
      )}
    </div>
  );
}
