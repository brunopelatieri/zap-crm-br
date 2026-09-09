'use client';

// ============================================================
// <EmojiPickerPopover> — o componente REUTILIZÁVEL do seletor de
// emojis. Não sabe o que é uma conversa: qualquer campo de texto do
// produto (inbox, personalizar de disparo, respostas rápidas) pluga
// aqui passando só `onSelect` e `finalFocus`.
//
// O gatilho é o `PopoverTrigger` de `@/components/ui/popover` (Base
// UI) estilizado DIRETO — mesmo padrão já usado em
// `message-actions.tsx` (reações rápidas) e `tag-color-picker.tsx`:
// className/disabled/aria-label vão no próprio PopoverTrigger, o
// conteúdo visual (ícone) é o `children`. Não introduz um segundo
// padrão de composição via `render`.
//
// SPEC: docs/spec-066-emoji-picker-inbox.md § Uso — Popover
// ============================================================

import dynamic from 'next/dynamic';
import { useCallback, useRef, useState, type ComponentProps } from 'react';
import type { Emoji } from 'frimousse';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useEmojiRecents } from '@/hooks/use-emoji-preferences';

// Carregado só na primeira abertura. `ssr: false`: o painel lê
// localStorage e busca dado da Emojibase — nada disso produz algo
// aproveitável no servidor, e ainda arriscaria divergência de
// hidratação.
const EmojiPickerPanel = dynamic(() => import('./emoji-picker-panel'), {
  ssr: false,
});

export interface EmojiPickerPopoverProps extends Pick<
  ComponentProps<typeof PopoverTrigger>,
  'disabled' | 'className' | 'title' | 'aria-label'
> {
  /** Conteúdo do botão-gatilho — normalmente um ícone. */
  children: React.ReactNode;
  /** Chamado a cada emoji escolhido. O popover NÃO fecha sozinho. */
  onSelect: (emoji: Emoji) => void;
  /** Campo que recebe o foco quando o popover fecha. */
  finalFocus?: React.RefObject<HTMLElement | null>;
  side?: 'top' | 'bottom';
  align?: 'start' | 'center' | 'end';
}

export function EmojiPickerPopover({
  children,
  onSelect,
  finalFocus,
  side = 'top',
  align = 'start',
  ...triggerProps
}: EmojiPickerPopoverProps) {
  const [open, setOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const { recents, remember, clear, userId } = useEmojiRecents();

  const handleSelect = useCallback(
    (emoji: Emoji) => {
      remember(emoji);
      onSelect(emoji);
      // O popover NÃO fecha: inserção múltipla é o comportamento
      // esperado (WhatsApp Web) — escolher 😀 e depois 👍 sem reabrir.
      // Esc, clique fora e o próprio gatilho continuam fechando.
    },
    [remember, onSelect]
  );

  // Baixa o chunk do painel antes do clique — hover/foco costumam
  // preceder o clique o suficiente para o painel abrir já montado.
  const prefetch = useCallback(() => {
    void import('./emoji-picker-panel');
  }, []);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        {...triggerProps}
        onPointerEnter={prefetch}
        onFocus={prefetch}
      >
        {children}
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        sideOffset={8}
        className="w-auto gap-0 overflow-hidden p-0"
        initialFocus={searchRef}
        finalFocus={finalFocus}
      >
        {open && (
          <EmojiPickerPanel
            onSelect={handleSelect}
            recents={recents}
            onClearRecents={clear}
            userId={userId}
            searchRef={searchRef}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
