'use client';

/**
 * Visão comparativa de um teste A/B (SPEC 044 §6.6).
 *
 * Duas coisas que esta tela se recusa a fazer
 *
 *   1. **Declarar vencedor em amostra pequena.** Abaixo de
 *      `AB_MIN_ARM_FOR_SIGNIFICANCE` destinatários por braço, o selo de
 *      "amostra pequena" aparece e nenhum braço é apontado — as taxas
 *      continuam visíveis, porque escondê-las seria esconder o resultado
 *      do disparo, mas sem veredito. É a exigência literal da §6.6, e é
 *      o que impede alguém de trocar um template que estava bom com base
 *      em 40 pessoas.
 *   2. **Fingir precisão que não tem.** As taxas usam `sent_count` como
 *      denominador — quem nunca recebeu mensagem não entra na conta.
 *
 * O funil é o MESMO componente da tela de campanha, um por braço: o
 * usuário compara duas coisas que ele já sabe ler.
 */

import { useLocale, useTranslations } from 'next-intl';
import { Trophy, Info } from 'lucide-react';

import {
  AB_MIN_ARM_FOR_SIGNIFICANCE,
  AB_PRIMARY_METRIC,
  summarizeAbTest,
  type MetricComparison,
  type VariantStats,
} from '@/lib/broadcasts/ab-test';
import {
  FunnelChart,
  type FunnelStep,
} from '@/components/broadcasts/funnel-chart';
import type { Broadcast } from '@/types';

interface VariantComparisonProps {
  variantA: Broadcast;
  variantB: Broadcast;
  /** Navega para a campanha do outro braço. */
  onOpenVariant: (broadcastId: string) => void;
  /** Qual dos dois é a campanha aberta — recebe o destaque. */
  currentId: string;
}

function statsOf(b: Broadcast): VariantStats {
  return {
    sent: b.sent_count,
    delivered: b.delivered_count,
    read: b.read_count,
    replied: b.replied_count,
  };
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/** p pequeno demais para caber em três casas vira "< 0,001". */
function formatPValue(p: number | null, locale: string): string {
  const threeDecimals = (v: number) =>
    v.toLocaleString(locale, {
      minimumFractionDigits: 3,
      maximumFractionDigits: 3,
    });
  if (p === null) return '—';
  if (p < 0.001) return `< ${threeDecimals(0.001)}`;
  return threeDecimals(p);
}

export function VariantComparison({
  variantA,
  variantB,
  onOpenVariant,
  currentId,
}: VariantComparisonProps) {
  const t = useTranslations('Broadcasts.detail.abTest');
  const tStats = useTranslations('Broadcasts.detail.stats');
  const locale = useLocale();

  const summary = summarizeAbTest(statsOf(variantA), statsOf(variantB));

  const stepsOf = (b: Broadcast): FunnelStep[] => [
    { label: tStats('sent'), value: b.sent_count, color: 'bg-primary' },
    {
      label: tStats('delivered'),
      value: b.delivered_count,
      color: 'bg-teal-500',
    },
    { label: tStats('read'), value: b.read_count, color: 'bg-blue-500' },
    {
      label: tStats('replied'),
      value: b.replied_count,
      color: 'bg-indigo-500',
    },
  ];

  const metricLabel = (m: MetricComparison['metric']) =>
    m === 'delivered'
      ? tStats('delivered')
      : m === 'read'
        ? tStats('read')
        : tStats('replied');

  return (
    <div className="border-border bg-card space-y-4 rounded-xl border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-foreground text-sm font-medium">{t('title')}</h2>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {t('subtitle', {
              percentA: variantA.ab_split_percent ?? 50,
              percentB: 100 - (variantA.ab_split_percent ?? 50),
            })}
          </p>
        </div>

        {summary.winner ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-300">
            <Trophy className="h-3.5 w-3.5" />
            {t('winner', {
              variant: summary.winner,
              metric: metricLabel(AB_PRIMARY_METRIC),
            })}
          </span>
        ) : (
          <span
            className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-300"
            title={
              summary.smallSample
                ? t('smallSampleHint', {
                    minimum: AB_MIN_ARM_FOR_SIGNIFICANCE,
                    smallest: summary.smallestArm,
                  })
                : t('noWinnerHint')
            }
          >
            <Info className="h-3.5 w-3.5" />
            {summary.smallSample ? t('smallSample') : t('noWinner')}
          </span>
        )}
      </div>

      {/* Amostra pequena: a frase inteira, não só o selo. O selo some da
          vista assim que o usuário rola a página; o resultado errado que
          ele pode tirar daqui, não. */}
      {summary.smallSample && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          {t('smallSampleHint', {
            minimum: AB_MIN_ARM_FOR_SIGNIFICANCE,
            smallest: summary.smallestArm,
          })}
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {[
          { broadcast: variantA, label: 'A' as const },
          { broadcast: variantB, label: 'B' as const },
        ].map(({ broadcast, label }) => (
          <div key={label} className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
                  summary.winner === label
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                    : 'border-border bg-muted text-muted-foreground'
                }`}
              >
                {t('variantLabel', { variant: label })}
              </span>
              {broadcast.id === currentId ? (
                <span className="text-muted-foreground text-xs">
                  {t('currentCampaign')}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onOpenVariant(broadcast.id)}
                  className="text-primary text-xs hover:underline"
                >
                  {t('openVariant')}
                </button>
              )}
            </div>
            <FunnelChart
              steps={stepsOf(broadcast)}
              title={broadcast.template_name}
              subtitle={t('armSize', {
                total: broadcast.total_recipients,
                sent: broadcast.sent_count,
              })}
            />
          </div>
        ))}
      </div>

      {/* Tabela de taxas. Diferença em PONTOS percentuais, não em "%": a
          confusão entre 5 pontos e 5 % é a forma mais comum de ler um
          teste A/B errado. */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-border text-muted-foreground border-b text-xs">
              <th className="py-2 pr-3 text-left font-medium">
                {t('table.metric')}
              </th>
              <th className="py-2 pr-3 text-right font-medium">A</th>
              <th className="py-2 pr-3 text-right font-medium">B</th>
              <th className="py-2 pr-3 text-right font-medium">
                {t('table.difference')}
              </th>
              <th className="py-2 pr-3 text-right font-medium">
                {t('table.pValue')}
              </th>
            </tr>
          </thead>
          <tbody>
            {summary.metrics.map((m) => (
              <tr
                key={m.metric}
                className="border-border border-b last:border-0"
              >
                <td className="text-foreground py-2 pr-3">
                  {metricLabel(m.metric)}
                  {m.metric === AB_PRIMARY_METRIC && (
                    <span className="text-muted-foreground ml-1.5 text-[10px] uppercase">
                      {t('primary')}
                    </span>
                  )}
                </td>
                <td className="text-muted-foreground py-2 pr-3 text-right tabular-nums">
                  {formatPercent(m.rateA)}
                </td>
                <td className="text-muted-foreground py-2 pr-3 text-right tabular-nums">
                  {formatPercent(m.rateB)}
                </td>
                <td
                  className={`py-2 pr-3 text-right tabular-nums ${
                    m.diffPoints > 0
                      ? 'text-emerald-400'
                      : m.diffPoints < 0
                        ? 'text-red-400'
                        : 'text-muted-foreground'
                  }`}
                >
                  {m.diffPoints > 0 ? '+' : ''}
                  {m.diffPoints.toFixed(1)} {t('points')}
                </td>
                <td className="text-muted-foreground py-2 pr-3 text-right tabular-nums">
                  {formatPValue(m.pValue, locale)}
                  {m.significant && (
                    <span className="ml-1.5 text-emerald-400">✓</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-muted-foreground text-xs">{t('methodology')}</p>
    </div>
  );
}
