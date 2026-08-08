'use client';

/**
 * Seletor da fonte de audiência (SPEC 044 §3.1).
 *
 * Substitui o grid de 4 cards do passo 2. Google Sheets vem primeiro e
 * marcado como recomendado porque é a única fonte que não exige o
 * usuário exportar nada — ele cola o link da planilha que já mantém.
 *
 * CSV e Excel dividem um card só. São dois formatos, mas um gesto: o
 * mesmo dropzone aceita os dois, e separá-los em cards idênticos
 * obrigaria o usuário a saber a extensão do próprio arquivo antes de
 * poder escolher onde clicar.
 *
 * Puramente apresentacional — não conhece Supabase nem parsing.
 */

import { Filter, Sheet, Tags, Upload, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * Fonte escolhida na UI. Difere de `AudienceConfig['type']` de
 * propósito: `google_sheets` e `spreadsheet` produzem os mesmos dados
 * (uma lista importada) e viajam para o hook de envio como `'csv'`. A
 * distinção só existe para saber qual painel renderizar.
 */
export type AudienceSourceId =
  'google_sheets' | 'spreadsheet' | 'all' | 'tags' | 'custom_field';

/** Fontes que produzem uma lista importada em vez de uma query. */
export const IMPORT_SOURCES: readonly AudienceSourceId[] = [
  'google_sheets',
  'spreadsheet',
] as const;

export function isImportSource(id: AudienceSourceId): boolean {
  return IMPORT_SOURCES.includes(id);
}

interface SourceOption {
  id: AudienceSourceId;
  icon: LucideIcon;
  /** Sufixo da chave i18n em `Broadcasts.audience.source`. */
  key: string;
  recommended?: boolean;
}

const OPTIONS: SourceOption[] = [
  { id: 'google_sheets', icon: Sheet, key: 'googleSheets', recommended: true },
  { id: 'spreadsheet', icon: Upload, key: 'spreadsheet' },
  { id: 'all', icon: Users, key: 'all' },
  { id: 'tags', icon: Tags, key: 'tags' },
  { id: 'custom_field', icon: Filter, key: 'customField' },
];

interface AudienceSourcePickerProps {
  value: AudienceSourceId;
  onChange: (id: AudienceSourceId) => void;
}

export function AudienceSourcePicker({
  value,
  onChange,
}: AudienceSourcePickerProps) {
  const t = useTranslations('Broadcasts.audience.source');

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {OPTIONS.map((option) => {
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
                  {t(`${option.key}.label`)}
                </p>
                {option.recommended && (
                  <span className="bg-primary/10 text-primary inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium">
                    {t('recommended')}
                  </span>
                )}
              </div>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {t(`${option.key}.description`)}
              </p>
            </div>
          </button>
        );
      })}
    </div>
  );
}
