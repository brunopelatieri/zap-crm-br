'use client';

/**
 * Dashboard histórico de engajamento (SPEC 044 §5.2, fase 5).
 *
 * Dois blocos, duas fontes:
 *
 *   (a) Cards + série de 30 dias — "como vai a CONTA". Vem de
 *       `broadcast_account_stats` / `broadcast_engagement_series`
 *       (migração 047), escopadas por `accountId` porque são
 *       `SECURITY DEFINER` (agregam a conta inteira, não uma linha de
 *       cada vez sob RLS). Independem de `draftId`, `search` e `filter`
 *       — por isso vivem no próprio efeito, disparado só quando
 *       `accountId` resolve.
 *
 *   (b) Frase de recorte — "como vai ESTA LISTA". Vem de
 *       `audience_engagement_summary` (046), que aceita o MESMO
 *       filtro+busca da tabela ao lado para descrever o que está na
 *       tela, não o rascunho inteiro.
 *
 * A cota de 24 h NÃO é recalculada aqui — já vive no
 * `MessagingLimitProvider` (fase 2) e duplicá-la criaria uma segunda
 * fonte de verdade para o mesmo número, o defeito que a §1.2 aponta no
 * passo 4 antigo.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Activity,
  Ban,
  Clock,
  Send,
  CheckCheck,
  Eye,
  MessageCircle,
  Users,
} from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts';

import { useAuth } from '@/hooks/use-auth';
import { createClient } from '@/lib/supabase/client';
import { useMessagingLimit } from '@/components/broadcasts/messaging-limit-provider';
import { StatCard } from '@/components/broadcasts/stat-card';
import {
  loadAccountEngagementStats,
  loadAudienceEngagementSummary,
  loadEngagementSeries,
  type AccountEngagementStats,
  type AudienceEngagementSummary,
  type EngagementSeriesPoint,
} from '@/lib/audience/engagement';
import type { TriageFilter } from '@/lib/audience/triage';

/** Janela do gráfico e dos cards — as duas descrevem o MESMO período. */
const SERIES_DAYS = 30;

type SeriesMetric =
  | 'messages_sent'
  | 'messages_delivered'
  | 'messages_read'
  | 'messages_replied'
  | 'messages_failed';

/** Cores fixas (hex), como o gráfico de conversas do dashboard — a
 *  paleta segue o mesmo Funnel de `[id]/page.tsx` (primary/teal/blue/
 *  indigo), com vermelho tracejado para falhas destacando o sinal de
 *  qualidade de número que a §5.1 monitora. */
const SERIES_LINES: { key: SeriesMetric; color: string; dashed?: boolean }[] =
  [
    { key: 'messages_sent', color: '#8b5cf6' },
    { key: 'messages_delivered', color: '#14b8a6' },
    { key: 'messages_read', color: '#3b82f6' },
    { key: 'messages_replied', color: '#6366f1' },
    { key: 'messages_failed', color: '#ef4444', dashed: true },
  ];

interface ChartRow extends EngagementSeriesPoint {
  label: string;
}

function shortDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

interface EngagementDashboardProps {
  draftId: string;
  search: string;
  filter: TriageFilter;
}

export function EngagementDashboard({
  draftId,
  search,
  filter,
}: EngagementDashboardProps) {
  const t = useTranslations('Broadcasts.audience.triage.dashboard');
  const { accountId } = useAuth();
  const { usedLast24h } = useMessagingLimit();

  const [stats, setStats] = useState<AccountEngagementStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [series, setSeries] = useState<EngagementSeriesPoint[] | null>(null);
  const [seriesLoading, setSeriesLoading] = useState(true);
  const [summary, setSummary] = useState<AudienceEngagementSummary | null>(
    null
  );
  const [summaryLoading, setSummaryLoading] = useState(true);

  // Bloco (a) — conta inteira. Só depende de `accountId`, que na prática
  // resolve uma vez por sessão (é NOT NULL desde a 017) — mas o efeito
  // segue o mesmo formato de IIFE assíncrona + try/finally de
  // `audience-triage-table.tsx` para o carregamento ficar consistente
  // com o resto do módulo.
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const db = createClient();
    const sinceIso = new Date(
      Date.now() - SERIES_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    (async () => {
      try {
        const s = await loadAccountEngagementStats(db, accountId, sinceIso);
        if (!cancelled) setStats(s);
      } catch (err) {
        console.error('[engagement-dashboard] stats error:', err);
      } finally {
        if (!cancelled) setStatsLoading(false);
      }
    })();

    (async () => {
      try {
        const s = await loadEngagementSeries(
          db,
          accountId,
          SERIES_DAYS,
          timeZone
        );
        if (!cancelled) setSeries(s);
      } catch (err) {
        console.error('[engagement-dashboard] series error:', err);
      } finally {
        if (!cancelled) setSeriesLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [accountId]);

  // Bloco (b) — recorte da lista aberta. Acompanha o filtro+busca da
  // tabela ao lado (a busca já chega debounced do componente pai).
  useEffect(() => {
    let cancelled = false;
    const db = createClient();

    (async () => {
      try {
        const s = await loadAudienceEngagementSummary(
          db,
          draftId,
          search,
          filter
        );
        if (!cancelled) setSummary(s);
      } catch (err) {
        console.error('[engagement-dashboard] summary error:', err);
      } finally {
        if (!cancelled) setSummaryLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [draftId, search, filter]);

  const readRate =
    stats && stats.messages_delivered > 0
      ? Math.round((stats.messages_read / stats.messages_delivered) * 100)
      : 0;
  const replyRate =
    stats && stats.messages_delivered > 0
      ? Math.round((stats.messages_replied / stats.messages_delivered) * 100)
      : 0;

  const chartData: ChartRow[] = useMemo(
    () => (series ?? []).map((p) => ({ ...p, label: shortDay(p.day) })),
    [series]
  );
  const chartHasActivity = chartData.some(
    (p) => p.messages_sent > 0 || p.messages_failed > 0
  );

  // Base da frase (b): quantos JÁ FORAM CONTATADOS — "61% leram" só faz
  // sentido como fração de quem recebeu algo, não da lista inteira (que
  // inclui gente nunca contatada, para quem "leu" não é nem sim nem não).
  const contactedBase = summary?.ever_contacted ?? 0;
  const summaryReadPct =
    contactedBase > 0
      ? Math.round(((summary?.ever_read ?? 0) / contactedBase) * 100)
      : 0;
  const summaryReplyPct =
    contactedBase > 0
      ? Math.round(((summary?.ever_replied ?? 0) / contactedBase) * 100)
      : 0;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-foreground text-sm font-semibold">
          {t('title')}
        </h2>
        <p className="text-muted-foreground mt-0.5 text-xs">
          {t('subtitle')}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label={t('cards.campaignsSent')}
          value={statsLoading ? 0 : (stats?.campaigns_sent ?? 0)}
          icon={<Send className="h-4 w-4" />}
          color="bg-primary/10 text-primary"
        />
        <StatCard
          label={t('cards.messagesDelivered')}
          value={statsLoading ? 0 : (stats?.messages_delivered ?? 0)}
          total={stats?.messages_sent}
          icon={<CheckCheck className="h-4 w-4" />}
          color="bg-teal-500/10 text-teal-400"
        />
        <StatCard
          label={t('cards.readRate')}
          value={readRate}
          format="percent"
          icon={<Eye className="h-4 w-4" />}
          color="bg-blue-500/10 text-blue-400"
        />
        <StatCard
          label={t('cards.replyRate')}
          value={replyRate}
          format="percent"
          icon={<MessageCircle className="h-4 w-4" />}
          color="bg-indigo-500/10 text-indigo-400"
        />
        <StatCard
          label={t('cards.contactsReached')}
          value={statsLoading ? 0 : (stats?.contacts_reached ?? 0)}
          icon={<Users className="h-4 w-4" />}
          color="bg-muted text-muted-foreground"
        />
        {/*
          Sem denominador e sem linguagem de "aviso" de propósito. O
          tier é o teto de UM disparo, não um saldo diário — exibir
          "340 / 2 000" com ícone de medidor e cor âmbar sugeriria que
          os alcançados hoje consomem o limite da próxima campanha, que
          é exatamente a leitura errada que este ajuste corrige. Este
          card é volume puro, no mesmo registro visual neutro de
          "Contatos alcançados"; o teto por disparo é o que o
          `QuotaMeter` do wizard mostra, com o vermelho/âmbar que faz
          sentido lá.
        */}
        <StatCard
          label={t('cards.reached24h')}
          value={usedLast24h}
          icon={<Activity className="h-4 w-4" />}
          color="bg-cyan-500/10 text-cyan-400"
        />
      </div>

      <div className="border-border bg-card rounded-xl border p-4">
        <h3 className="text-foreground mb-3 text-sm font-medium">
          {t('chart.title')}
        </h3>

        {seriesLoading ? (
          <div className="bg-muted h-[220px] w-full animate-pulse rounded-md" />
        ) : !chartHasActivity ? (
          <div className="text-muted-foreground flex h-[220px] items-center justify-center text-sm">
            {t('chart.empty')}
          </div>
        ) : (
          <div className="h-[220px] w-full">
            <ResponsiveContainer>
              <LineChart
                data={chartData}
                margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  className="stroke-border"
                  vertical={false}
                />
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  minTickGap={24}
                  className="fill-muted-foreground text-[10px]"
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={32}
                  allowDecimals={false}
                  className="fill-muted-foreground text-[10px]"
                />
                <Tooltip content={SeriesTooltip} />
                {SERIES_LINES.map((line) => (
                  <Line
                    key={line.key}
                    type="monotone"
                    dataKey={line.key}
                    stroke={line.color}
                    strokeWidth={2}
                    strokeDasharray={line.dashed ? '4 3' : undefined}
                    dot={false}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        <div className="text-muted-foreground mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {SERIES_LINES.map((line) => (
            <span key={line.key} className="flex items-center gap-1.5">
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: line.color }}
              />
              {t(`chart.legend.${line.key}`)}
            </span>
          ))}
        </div>
      </div>

      <div className="border-border bg-card/50 rounded-xl border p-4">
        {summaryLoading || !summary ? (
          <div className="bg-muted h-4 w-3/4 animate-pulse rounded" />
        ) : summary.valid_rows === 0 ? (
          <p className="text-muted-foreground text-sm">{t('summary.empty')}</p>
        ) : (
          <div className="space-y-1.5">
            <p className="text-foreground text-sm">
              {t('summary.sentence', {
                total: summary.valid_rows,
                everContacted: summary.ever_contacted,
                readPct: summaryReadPct,
                repliedPct: summaryReplyPct,
                neverDelivered: summary.never_delivered,
              })}
            </p>
            {/* Consentimento (§6.8). Aparece só quando há alguém em
                opt-out — uma linha fixa dizendo "0 em opt-out" viraria
                ruído na maioria das triagens. */}
            {summary.opted_out_rows > 0 && (
              <p className="flex items-center gap-1.5 text-xs text-amber-300">
                <Ban className="h-3.5 w-3.5 shrink-0" />
                {t('summary.optedOut', { count: summary.opted_out_rows })}
              </p>
            )}
            {/* Anti-fadiga (§6.2). O staging já desmarcou estas linhas
                por padrão — a frase existe para o agente entender POR
                QUE a contagem selecionada é menor do que o total. */}
            {summary.in_cooldown > 0 && (
              <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                <Clock className="h-3.5 w-3.5 shrink-0" />
                {t('summary.inCooldown', { count: summary.in_cooldown })}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SeriesTooltip({ active, payload, label }: TooltipContentProps) {
  const t = useTranslations('Broadcasts.audience.triage.dashboard.chart.legend');

  if (!active || !payload || payload.length === 0) return null;

  return (
    <div className="border-border bg-popover rounded-md border px-3 py-2 text-xs shadow-lg">
      <p className="text-popover-foreground mb-1 font-medium">{label}</p>
      <div className="space-y-0.5">
        {payload.map((entry) => {
          // `dataKey` é tipado como `string | number | função` pelo
          // recharts (aceita um accessor), mas os `Line` deste gráfico
          // só usam literais de `SeriesMetric` — o cast é seguro aqui.
          const metric = String(entry.dataKey ?? entry.name) as SeriesMetric;
          return (
            <div
              key={metric}
              className="flex items-center justify-between gap-4"
            >
              <span className="text-muted-foreground flex items-center gap-1.5">
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ background: entry.color }}
                />
                {t(metric)}
              </span>
              <span className="text-popover-foreground font-medium tabular-nums">
                {entry.value}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
