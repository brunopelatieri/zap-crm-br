'use client';

/**
 * `/broadcasts/new/[draftId]/triage` — SPEC 044 §3.3, §5.1.
 *
 * A área de triagem roteada que a §1.5 apontou como faltando: o
 * rascunho criado por `POST /api/broadcasts/audience/stage` agora tem
 * um id na URL, então um F5 aqui não perde nada — a audiência inteira
 * já está em `broadcast_audience_staging` (045), não em `useState`.
 *
 * O wizard em si continua sem gerenciador de estado global (§1.6,
 * compromisso 1): esta página não guarda `template`/`variables`. Ao
 * clicar "Continuar", ela só navega para `/broadcasts/new?draftId=…` —
 * é `new/page.tsx` que reidrata o template a partir do rascunho
 * (`template_name`/`template_language`, já persistidos no stage) e
 * retoma o wizard direto no passo 3.
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowRight, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

import { QuotaMeter, exceedsQuota } from '@/components/broadcasts/quota-meter';
import { useMessagingLimit } from '@/components/broadcasts/messaging-limit-provider';
import { AudienceTriageTable } from '@/components/broadcasts/audience/triage/audience-triage-table';
import { TriageToolbar } from '@/components/broadcasts/audience/triage/triage-toolbar';
import { EngagementDashboard } from '@/components/broadcasts/audience/triage/engagement-dashboard';
import { estimateAudience } from '@/lib/audience/estimate';
import { excludesOptedOut } from '@/lib/contacts/consent';
import type { TriageFilter } from '@/lib/audience/triage';

/** Debounce da busca — evita uma RPC por tecla digitada. */
const SEARCH_DEBOUNCE_MS = 300;

interface DraftInfo {
  id: string;
  status: string;
  template_name: string;
  template_language: string;
}

export default function AudienceTriagePage() {
  const params = useParams();
  const router = useRouter();
  const draftId = params.draftId as string;

  const t = useTranslations('Broadcasts.audience.triage');
  const { remaining, refresh: refreshQuota } = useMessagingLimit();

  const [draft, setDraft] = useState<DraftInfo | null>(null);
  const [draftLoading, setDraftLoading] = useState(true);
  const [draftError, setDraftError] = useState(false);

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<TriageFilter>('all');
  const [matchingCount, setMatchingCount] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);

  // `true` até a categoria do template ser lida: começar por "exclui" faz
  // a primeira renderização mostrar o número conservador, e não um
  // alcance maior que depois encolhe sozinho.
  const [optOutApplies, setOptOutApplies] = useState(true);
  const [selectedCount, setSelectedCount] = useState<number | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [discarding, setDiscarding] = useState(false);

  // Busca com debounce — o filtro muda a lista imediatamente, mas
  // digitar não deve disparar uma RPC por tecla.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from('broadcasts')
        .select('id, status, template_name, template_language')
        .eq('id', draftId)
        .maybeSingle();
      if (cancelled) return;
      if (!data) {
        setDraftError(true);
        setDraftLoading(false);
        return;
      }

      const draftRow = data as DraftInfo;
      setDraft(draftRow);

      // A categoria do template decide se o opt-out (§6.8) subtrai da
      // contagem: marketing exclui, Utility/Authentication alcança. Sem
      // esta leitura o número desta tela discordaria do que o servidor
      // envia — e ela mora aqui porque a triagem, ao contrário do
      // wizard, não recebe o template como prop.
      const { data: templateRow } = await supabase
        .from('message_templates')
        .select('category')
        .eq('name', draftRow.template_name)
        .eq('language', draftRow.template_language)
        .maybeSingle();
      if (cancelled) return;

      // Template ausente localmente → categoria desconhecida → regra
      // conservadora (`excludesOptedOut(null) === true`).
      setOptOutApplies(
        excludesOptedOut((templateRow?.category as string | null) ?? null)
      );
      setDraftLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [draftId]);

  const refreshSelectedCount = useCallback(async () => {
    const supabase = createClient();
    const count = await estimateAudience(
      supabase,
      { type: 'staged', draftId },
      { excludeOptedOut: optOutApplies }
    );
    setSelectedCount(count ?? 0);
  }, [draftId, optOutApplies]);

  useEffect(() => {
    // setSelectedCount só roda depois do `await` dentro de
    // refreshSelectedCount — não é o cascade síncrono que a regra evita.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshSelectedCount();
  }, [refreshSelectedCount]);

  function handleBulkSelectionApplied() {
    refreshSelectedCount();
    // As linhas já carregadas na tabela podem ter mudado de `selected`
    // fora da página atual — recarrega do zero em vez de tentar
    // remendar o estado local linha a linha.
    setReloadToken((v) => v + 1);
  }

  async function handleContinue() {
    await refreshQuota();
    router.push(`/broadcasts/new?draftId=${draftId}`);
  }

  async function handleDiscard() {
    setDiscarding(true);
    const supabase = createClient();
    // CASCADE (045) leva as linhas staged junto.
    const { error } = await supabase
      .from('broadcasts')
      .delete()
      .eq('id', draftId);
    setDiscarding(false);
    if (error) {
      toast.error(t('discardFailed'));
      return;
    }
    setDiscardOpen(false);
    router.push('/broadcasts/new');
  }

  if (draftLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (draftError || !draft) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3">
        <p className="text-sm text-red-400">{t('draftNotFound')}</p>
        <Button variant="outline" onClick={() => router.push('/broadcasts/new')}>
          {t('backToNew')}
        </Button>
      </div>
    );
  }

  if (draft.status !== 'draft') {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3">
        <p className="text-muted-foreground text-sm">
          {t('draftAlreadySent')}
        </p>
        <Button onClick={() => router.push(`/broadcasts/${draft.id}`)}>
          {t('viewBroadcast')}
        </Button>
      </div>
    );
  }

  const selected = selectedCount ?? 0;
  const overQuota = exceedsQuota(selected, remaining);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-foreground text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {t('subtitle', { template: draft.template_name })}
          </p>
        </div>

        <Dialog open={discardOpen} onOpenChange={setDiscardOpen}>
          <DialogTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                className="border-red-500/30 bg-transparent text-red-400 hover:bg-red-500/10"
              />
            }
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('backToAudience')}
          </DialogTrigger>
          <DialogContent className="border-border bg-popover sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">
                {t('cancelConfirmTitle')}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {t('cancelConfirmBody')}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setDiscardOpen(false)}
                disabled={discarding}
                className="border-border text-muted-foreground"
              >
                {t('cancel')}
              </Button>
              <Button
                onClick={handleDiscard}
                disabled={discarding}
                className="bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
              >
                {discarding ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {t('cancelConfirmAction')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <EngagementDashboard draftId={draftId} search={search} filter={filter} />

      <QuotaMeter selected={selected} />

      <div className="border-border bg-card rounded-xl border">
        <div className="border-border space-y-3 border-b p-4">
          <TriageToolbar
            draftId={draftId}
            search={searchInput}
            onSearchChange={setSearchInput}
            filter={filter}
            onFilterChange={setFilter}
            matchingCount={matchingCount}
            onBulkSelectionApplied={handleBulkSelectionApplied}
          />
        </div>

        <AudienceTriageTable
          draftId={draftId}
          search={search}
          filter={filter}
          reloadToken={reloadToken}
          onSelectionChanged={refreshSelectedCount}
          onTotalCountChanged={setMatchingCount}
        />
      </div>

      <div className="border-border flex items-center justify-between border-t pt-4">
        <p className="text-muted-foreground text-sm">
          {t('selectedSummary', { selected })}
        </p>
        <Button
          onClick={handleContinue}
          disabled={selected === 0 || overQuota}
          title={overQuota ? t('quotaBlockedHint') : undefined}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('continue')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
