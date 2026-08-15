'use client';

/**
 * Resumo pós-parse: "1 240 lidas · 1 198 válidas · 31 duplicadas ·
 * 11 inválidas" (SPEC 044 §3.5, SPEC 052 F4).
 *
 * A lista de linhas rejeitadas é a razão de este componente existir.
 * Um import que diz "31 linhas ignoradas" sem dizer QUAIS é um import
 * que o usuário não tem como corrigir — ele volta para a planilha de
 * 1 200 linhas sem saber onde olhar. Cada linha aqui traz o número que
 * o Excel mostra e o motivo.
 *
 * Genérico de propósito (SPEC 052 §5.1): não conhece `NormalizedAudience`
 * nem nenhum outro tipo de domínio de contato/audiência — só os pedaços
 * que desenha. O motivo de rejeição sempre traduz por `Import.reason`
 * (vocabulário unificado da F2, compartilhado por disparo e contatos);
 * o resto do texto vem do `namespace` que cada consumidor passa.
 *
 * `ImportRejectReason` vem de `PhoneRejectReason` (SPEC 050,
 * `@/lib/phone/br`) e não de `@/lib/audience/types` de propósito: é o
 * módulo de telefone, compartilhado, que já é a fonte de verdade das
 * chaves de `Import.reason.*` — importar de `audience/types` aqui
 * acoplaria este componente genérico a um tipo de domínio só porque os
 * dois hoje têm o mesmo formato.
 */

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { PhoneRejectReason } from '@/lib/phone/br';

/** Quantas linhas rejeitadas mostrar antes do "ver todas". */
const PREVIEW_LIMIT = 10;

/** Chave de `Import.reason.*` (SPEC 052 F2) — nunca uma string solta. */
export type ImportRejectReason = PhoneRejectReason | 'duplicate_in_file';

export interface ImportRejectedRow {
  sourceRow: number;
  rawPhone: string;
  name?: string;
  reason: ImportRejectReason;
}

export interface ImportStats {
  read: number;
  valid: number;
  duplicates: number;
  invalid: number;
}

export interface ImportRejectSummaryProps {
  /** Namespace i18n com `title`, `sheet`, `read`, `valid`, `duplicates`,
   *  `invalid`, `rejectedRows`, `line`, `showAll` — cada consumidor tem o seu. */
  namespace: string;
  stats: ImportStats;
  invalid: ImportRejectedRow[];
  sheetName?: string;
}

function StatChip({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
}) {
  const toneClasses = {
    neutral: 'bg-muted text-muted-foreground',
    good: 'bg-primary/10 text-primary',
    warn: 'bg-amber-500/10 text-amber-300',
    bad: 'bg-red-500/10 text-red-300',
  }[tone];

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ${toneClasses}`}
    >
      <span className="tabular-nums">{value.toLocaleString()}</span>
      <span className="font-normal opacity-80">{label}</span>
    </span>
  );
}

export function ImportRejectSummary({
  namespace,
  stats,
  invalid,
  sheetName,
}: ImportRejectSummaryProps) {
  const t = useTranslations(namespace);
  const tReason = useTranslations('Import.reason');
  const [expanded, setExpanded] = useState(false);

  const shown = expanded ? invalid : invalid.slice(0, PREVIEW_LIMIT);
  const hasRejects = invalid.length > 0;

  return (
    <div className="border-border bg-card/50 space-y-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center gap-2">
        {stats.valid > 0 ? (
          <CheckCircle2 className="text-primary h-4 w-4" />
        ) : (
          <AlertTriangle className="h-4 w-4 text-red-400" />
        )}
        <p className="text-foreground text-sm font-medium">{t('title')}</p>
        {sheetName && (
          <span className="bg-muted text-muted-foreground inline-flex items-center rounded-md px-2 py-0.5 text-xs">
            {t('sheet', { name: sheetName })}
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <StatChip label={t('read')} value={stats.read} />
        <StatChip
          label={t('valid')}
          value={stats.valid}
          tone={stats.valid > 0 ? 'good' : 'bad'}
        />
        {stats.duplicates > 0 && (
          <StatChip
            label={t('duplicates')}
            value={stats.duplicates}
            tone="warn"
          />
        )}
        {stats.invalid > 0 && (
          <StatChip label={t('invalid')} value={stats.invalid} tone="bad" />
        )}
      </div>

      {hasRejects && (
        <div className="border-border rounded-lg border">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-muted-foreground hover:text-foreground flex w-full items-center justify-between px-3 py-2 text-xs font-medium"
          >
            <span>{t('rejectedRows', { count: invalid.length })}</span>
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform ${
                expanded ? 'rotate-180' : ''
              }`}
            />
          </button>

          <ul className="border-border max-h-48 overflow-y-auto border-t">
            {shown.map((row) => (
              <li
                key={`${row.sourceRow}-${row.rawPhone}`}
                className="border-border/50 flex items-center justify-between gap-3 border-b px-3 py-1.5 text-xs last:border-b-0"
              >
                <span className="text-muted-foreground shrink-0 tabular-nums">
                  {t('line', { n: row.sourceRow })}
                </span>
                <span className="text-foreground min-w-0 flex-1 truncate font-mono">
                  {row.rawPhone || '—'}
                  {row.name && (
                    <span className="text-muted-foreground ml-2 font-sans">
                      {row.name}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-amber-300">
                  {tReason(row.reason)}
                </span>
              </li>
            ))}
          </ul>

          {!expanded && invalid.length > PREVIEW_LIMIT && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="text-primary hover:bg-muted/50 w-full px-3 py-1.5 text-xs font-medium"
            >
              {t('showAll', { count: invalid.length })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
