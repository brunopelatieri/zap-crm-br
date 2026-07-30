'use client';

// ============================================================
// TagBadge — o chip de etiqueta do card de Configurações.
//
// O ponto central deste componente é a separação das duas zonas de
// clique (§3.2 do SPEC). Antes, o chip era um `<span>` com um `<button>`
// de exclusão dentro; agora é um container INERTE com dois botões
// IRMÃOS: corpo (editar) e `×` (excluir).
//
// Botão dentro de botão é HTML inválido e produz propagação ambígua —
// com irmãos, cada clique tem um destino único e não há
// `stopPropagation` de que depender. Somam-se: separador visual de 1px,
// alvo do `×` de 28px (o mínimo da WCAG 2.2 §2.5.8 é 24px; o `×`
// anterior tinha ~16px), realce de fundo próprio no `×`, e o modal de
// confirmação que continua sendo a rede final.
//
// Os dois ícones ficam SEMPRE visíveis (pedido do mantenedor, §11.11 do
// SPEC): a revelação em hover que a §3.2 previa escondia a existência da
// edição e não funcionava em toque. A separação das zonas continua
// inteira sem ela — nenhuma das outras cinco medidas dependia do hover.
// ============================================================

import { useTranslations } from 'next-intl';
import { Pencil, X } from 'lucide-react';

import { CHIP_SURFACES, chipBackgroundHex, type ChipTheme } from '@/lib/colors';
import { cn } from '@/lib/utils';
import type { Tag } from '@/types';

/**
 * Estilo do chip: fundo e borda derivados da cor por alpha. Mantido
 * idêntico ao que já estava inline no `TagManager` para não alterar a
 * aparência das etiquetas existentes.
 */
function chipStyle(color: string) {
  return {
    backgroundColor: `${color}20`,
    color,
    border: `1px solid ${color}40`,
  };
}

interface TagBadgeProps {
  tag: Tag;
  /** Sem permissão → chip informativo, sem lápis e sem `×`. */
  canEdit: boolean;
  onEdit: (tag: Tag) => void;
  onDelete: (tag: Tag) => void;
}

export function TagBadge({ tag, canEdit, onEdit, onDelete }: TagBadgeProps) {
  const t = useTranslations('Settings.tagsAndFields');

  if (!canEdit) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium"
        style={chipStyle(tag.color)}
      >
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: tag.color }}
        />
        {tag.name}
      </span>
    );
  }

  return (
    <span
      className="group inline-flex items-center rounded-full py-0.5 pr-0.5 pl-1 text-sm font-medium transition-colors"
      style={chipStyle(tag.color)}
    >
      <button
        type="button"
        onClick={() => onEdit(tag)}
        aria-label={t('editAria', { name: tag.name })}
        className="flex cursor-pointer items-center gap-1.5 rounded-full px-2 py-1 transition-opacity hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-current"
      >
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: tag.color }}
        />
        {tag.name}
        {/* Sempre visível (não só em hover): a descoberta da ação vale
            mais que o chip enxuto, e o alvo de exclusão só é atingido
            depois do separador. */}
        <Pencil className="size-3 shrink-0 opacity-70 transition-opacity group-hover:opacity-100" />
      </button>

      <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-current/25" />

      <button
        type="button"
        onClick={() => onDelete(tag)}
        aria-label={t('deleteAria', { name: tag.name })}
        // Sempre visível, em qualquer viewport. A proteção contra o
        // clique acidental fica por conta do que não mudou: separador,
        // alvo de 28px, realce de fundo próprio e o modal de confirmação.
        className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full opacity-70 transition-all hover:bg-black/10 hover:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-current dark:hover:bg-white/10"
      >
        <X className="size-3.5" />
      </button>
    </span>
  );
}

interface TagBadgePreviewProps {
  name: string;
  color: string;
  /** Tema simulado — o fundo é composto na mão (ver `chipBackgroundHex`). */
  theme: ChipTheme;
}

/**
 * Chip só-leitura sobre uma superfície de tema forçado, para o preview
 * do modal de edição.
 *
 * O fundo do chip é composto em opaco em vez de usar alpha: dentro de
 * um modal claro, `${color}20` compõe sobre a superfície REAL, então a
 * amostra "escura" mentiria sobre como o chip vai aparecer no tema
 * escuro.
 */
export function TagBadgePreview({ name, color, theme }: TagBadgePreviewProps) {
  return (
    <div
      className={cn(
        'flex w-full min-w-0 items-center justify-center rounded-lg border p-3',
        theme === 'light' ? 'border-black/10' : 'border-white/10'
      )}
      style={{ backgroundColor: CHIP_SURFACES[theme] }}
    >
      <span
        className="inline-flex max-w-full items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium"
        style={{
          backgroundColor: chipBackgroundHex(color, theme),
          color,
          border: `1px solid ${color}40`,
        }}
      >
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
        <span className="truncate">{name}</span>
      </span>
    </div>
  );
}
