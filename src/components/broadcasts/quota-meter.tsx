'use client';

/**
 * Medidor do limite de contatos por disparo (SPEC 044 §4.5).
 *
 * Mostra "selecionados / limite do tier" e é o que torna o teto da Meta
 * visível antes do disparo, em vez de descoberto no meio dele.
 *
 * O número exibido é `batchLimit` — o valor de
 * `whatsapp_business_manager_messaging_limit`, que é quantos contatos
 * cabem em UM disparo em lote. Não se subtrai daqui o que já foi
 * enviado hoje: isso encolhia o teto artificialmente. Os contatos
 * alcançados nas últimas 24 h aparecem ao lado como informação de
 * volume, sem participar da validação.
 *
 * O botão "Checar limite" força uma consulta à Graph API (ignorando o
 * cache de 15 min) e propaga o resultado pelo provider — então o passo
 * 4 e a triagem enxergam o valor novo sem recarregar a página.
 */

import { useState } from 'react';
import {
  AlertTriangle,
  Gauge,
  Infinity as InfinityIcon,
  RefreshCw,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';

import { useMessagingLimit } from './messaging-limit-provider';

interface QuotaMeterProps {
  /** Quantos contatos a audiência atual tem. */
  selected: number;
  /** Compacto para o passo 4; completo para o passo 2. */
  compact?: boolean;
}

/** True quando a seleção não cabe no disparo — mesma regra do servidor. */
export function exceedsQuota(selected: number, batchLimit: number): boolean {
  return Number.isFinite(batchLimit) && selected > batchLimit;
}

export function QuotaMeter({ selected, compact = false }: QuotaMeterProps) {
  const t = useTranslations('Broadcasts.audience.quota');
  const { configured, tier, batchLimit, usedLast24h, stale, loading, refresh } =
    useMessagingLimit();

  // `loading` do provider também sobe na busca automática de montagem;
  // um estado local é o que faz o spinner pertencer a ESTE clique.
  const [checking, setChecking] = useState(false);

  // Sem WhatsApp conectado não há tier a exibir; o passo 1 já bloqueia
  // esse caminho (sem template aprovado não se chega aqui).
  if (!configured && !loading) return null;

  const unlimited = !Number.isFinite(batchLimit);
  const over = exceedsQuota(selected, batchLimit);
  const pct = unlimited
    ? 0
    : Math.min(100, Math.round((selected / Math.max(1, batchLimit)) * 100));

  const barColor = over
    ? 'bg-red-500'
    : pct > 80
      ? 'bg-amber-500'
      : 'bg-primary';

  async function handleCheck() {
    setChecking(true);
    try {
      await refresh({ force: true });
    } finally {
      setChecking(false);
    }
  }

  const busy = checking || loading;

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

        {stale && !busy && (
          <span
            className="inline-flex items-center rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-300"
            title={t('staleHint')}
          >
            {t('stale')}
          </span>
        )}

        <Button
          variant="outline"
          size={compact ? 'icon-xs' : 'xs'}
          className="ml-auto"
          disabled={busy}
          onClick={handleCheck}
          title={t('checkHint')}
          aria-label={t('check')}
        >
          <RefreshCw className={busy ? 'animate-spin' : undefined} />
          {!compact && <span>{busy ? t('checking') : t('check')}</span>}
        </Button>
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
              {t('selectedOfLimit', {
                selected: selected.toLocaleString(),
                limit: batchLimit.toLocaleString(),
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
              excess: (selected - batchLimit).toLocaleString(),
            })}
          </span>
        </div>
      )}
    </div>
  );
}
