'use client';

/**
 * Fontes de audiência do passo 2 (SPEC 044 §3.1).
 *
 * A UI de fato (os cards) mora em `ImportSourcePicker`
 * (`@/components/import/import-source-picker`), compartilhada com o
 * futuro importador de contatos (SPEC 052 F4/F5) — este arquivo é só o
 * que é específico do disparo: os ids, a regra "isto é fonte de
 * planilha ou não" e a lista de opções já traduzida.
 */

import { Filter, Sheet, Tags, Upload, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { ImportSourceOption } from '@/components/import/import-source-picker';

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

/** As 5 opções do passo 2, com rótulos já traduzidos. */
export function useAudienceSourceOptions(): ImportSourceOption<AudienceSourceId>[] {
  const t = useTranslations('Broadcasts.audience.source');

  return [
    {
      id: 'google_sheets',
      icon: Sheet,
      label: t('googleSheets.label'),
      description: t('googleSheets.description'),
      recommended: true,
    },
    {
      id: 'spreadsheet',
      icon: Upload,
      label: t('spreadsheet.label'),
      description: t('spreadsheet.description'),
    },
    {
      id: 'all',
      icon: Users,
      label: t('all.label'),
      description: t('all.description'),
    },
    {
      id: 'tags',
      icon: Tags,
      label: t('tags.label'),
      description: t('tags.description'),
    },
    {
      id: 'custom_field',
      icon: Filter,
      label: t('customField.label'),
      description: t('customField.description'),
    },
  ];
}
