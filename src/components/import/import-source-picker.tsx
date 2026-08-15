'use client';

/**
 * Seletor de fonte de importação (SPEC 044 §3.1, SPEC 052 F4).
 *
 * Puramente apresentacional — não conhece Supabase, parsing nem i18n:
 * cada consumidor resolve seus próprios rótulos e monta a lista de
 * opções; o componente só desenha os cards e reporta a escolha.
 *
 * Genérico em `T` (o id da fonte) porque disparo e contatos têm listas
 * diferentes — disparo mostra 5 cards (Google Sheets, arquivo, todos,
 * etiquetas, campo personalizado); contatos mostra 2 (Google Sheets,
 * arquivo) — SPEC 052 §5.1.
 */

import type { LucideIcon } from 'lucide-react';

export interface ImportSourceOption<T extends string> {
  id: T;
  icon: LucideIcon;
  label: string;
  description: string;
  recommended?: boolean;
}

export interface ImportSourcePickerProps<T extends string> {
  value: T;
  onChange: (id: T) => void;
  options: ImportSourceOption<T>[];
  /** Selo "recomendado" — só aparece nas opções com `recommended: true`. */
  recommendedLabel?: string;
}

export function ImportSourcePicker<T extends string>({
  value,
  onChange,
  options,
  recommendedLabel,
}: ImportSourcePickerProps<T>) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {options.map((option) => {
        const isSelected = value === option.id;
        const Icon = option.icon;

        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(option.id)}
            aria-pressed={isSelected}
            className={`flex items-start gap-3 rounded-xl border p-4 text-left transition-all ${
              isSelected
                ? 'border-primary bg-primary/5 ring-primary/30 ring-1'
                : 'border-border bg-card/50 hover:border-border'
            }`}
          >
            <div
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                isSelected
                  ? 'bg-primary/10 text-primary'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              <Icon className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <p className="text-foreground text-sm font-medium">
                  {option.label}
                </p>
                {option.recommended && recommendedLabel && (
                  <span className="bg-primary/10 text-primary inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium">
                    {recommendedLabel}
                  </span>
                )}
              </div>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {option.description}
              </p>
            </div>
          </button>
        );
      })}
    </div>
  );
}
