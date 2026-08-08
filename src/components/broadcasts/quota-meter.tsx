'use client';

/**
 * Medidor de cota de 24 h (SPEC 044 §4.5).
 *
 * Mostra "selecionados / disponíveis" e é o que torna o teto da Meta
 * visível antes do disparo, em vez de descoberto no meio dele.
 *
 * O número exibido é `remaining` (teto − já enviados na janela), não o
 * teto do tier: um TIER_1K com 800 contatos já alcançados hoje tem 150
 * de folga, não 1 000. Exibir o teto bruto seria tecnicamente verdade e
 * praticamente uma armadilha.
 */

import { AlertTriangle, Gauge, Infinity as InfinityIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useMessagingLimit } from './messaging-limit-provider';

interface QuotaMeterProps {
  /** Quantos contatos a audiência atual tem. */
  selected: number;
  /** Compacto para o passo 4; completo para o passo 2. */
  compact?: boolean;
}

/** True quando a seleção não cabe na cota — mesma regra do servidor. */
export function exceedsQuota(selected: number, remaining: number): boolean {
  return Number.isFinite(remaining) && selected > remaining;
}

export function QuotaMeter({ selected, compact = false }: QuotaMeterProps) {
  const t = useTranslations('Broadcasts.audience.quota');
  const { configured, tier, remaining, usedLast24h, stale, loading } =
    useMessagingLimit();

  // Sem WhatsApp conectado não há tier a exibir; o passo 1 já bloqueia
  // esse caminho (sem template aprovado não se chega aqui).
  if (!configured && !loading) return null;

  const unlimited = !Number.isFinite(remaining);
  const over = exceedsQuota(selected, remaining);
  const pct = unlimited
    ? 0
    : Math.min(100, Math.round((selected / Math.max(1, remaining)) * 100));

  const barColor = over
    ? 'bg-red-500'
    : pct > 80
      ? 'bg-amber-500'
      : 'bg-primary';

  return (
    <div
      className={`border-border bg-card/50 rounded-xl border ${
        compact ? 'p-3' : 'p-4'
      } ${over ? 'border-red-500/40' : ''}`}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Gauge
          className={`h-4 w-4 ${over ? 'text-red-400' : 'text-primary'}`}
        />
        <p className="text-foreground text-sm font-medium">{t('title')}</p>

        <span className="bg-muted text-muted-foreground inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium">
          {tier.replace('TIER_', '')}
        </span>

        {stale && !loading && (
          <span
            className="inline-flex items-center rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-300"
            title={t('staleHint')}
          >
            {t('stale')}
          </span>
        )}
      </div>

      {unlimited ? (
        <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <InfinityIcon className="h-3.5 w-3.5" />
          <span>{t('unlimited')}</span>
        </div>
      ) : (
        <>
          <div className="bg-muted mb-2 h-1.5 w-full overflow-hidden rounded-full">
            <div
              className={`h-1.5 rounded-full transition-[width] duration-300 ${barColor}`}
              style={{ width: `${pct}%` }}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
            <span className={over ? 'text-red-300' : 'text-foreground'}>
              {t('selectedOfRemaining', {
                selected: selected.toLocaleString(),
                remaining: remaining.toLocaleString(),
              })}
            </span>
            <span className="text-muted-foreground">
              {t('usedInWindow', { used: usedLast24h.toLocaleString() })}
            </span>
          </div>
        </>
      )}

      {over && (
        <div className="mt-2 flex items-start gap-1.5 text-xs text-red-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {t('exceeded', {
              excess: (selected - remaining).toLocaleString(),
            })}
          </span>
        </div>
      )}
    </div>
  );
}
