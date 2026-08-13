'use client';

/**
 * Busca + filtro + ações em massa da triagem (SPEC 044 §5.3, §5.4).
 *
 * "Selecionar/limpar tudo" nunca mexe em linha por linha no cliente —
 * chama `triage_set_selection` (migração 046), um UPDATE server-side
 * sobre o MESMO filtro+busca que a tabela está mostrando. Selecionar
 * 50 000 linhas continua sendo um comando, não 50 000 mutações de
 * estado.
 */

import { useState } from 'react';
import { Ban, ChevronDown, Clock, Filter, Search, Undo2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { createClient } from '@/lib/supabase/client';
import { useCan } from '@/hooks/use-can';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  TRIAGE_CONSENT_FILTERS,
  TRIAGE_ENGAGEMENT_FILTERS,
  TRIAGE_STATE_FILTERS,
  type TriageFilter,
} from '@/lib/audience/triage';

interface TriageToolbarProps {
  draftId: string;
  search: string;
  onSearchChange: (value: string) => void;
  filter: TriageFilter;
  onFilterChange: (value: TriageFilter) => void;
  /** Total de linhas que casam com o filtro+busca atuais. */
  matchingCount: number;
  /** Chamado depois de uma seleção em massa bem-sucedida. */
  onBulkSelectionApplied: () => void;
  disabled?: boolean;
}

export function TriageToolbar({
  draftId,
  search,
  onSearchChange,
  filter,
  onFilterChange,
  matchingCount,
  onBulkSelectionApplied,
  disabled = false,
}: TriageToolbarProps) {
  const t = useTranslations('Broadcasts.audience.triage');
  const tFilter = useTranslations('Broadcasts.audience.triage.filter');
  const canOverrideCooldown = useCan('override-cooldown');
  const [applying, setApplying] = useState<
    'select' | 'clear' | 'optout' | 'cooldown' | 'cooldownOverride' | null
  >(null);

  async function applyBulkSelection(
    selected: boolean,
    options: {
      /** Ignora filtro+busca da tela e usa este filtro. */
      filterOverride?: TriageFilter;
      label: 'select' | 'clear' | 'optout' | 'cooldown' | 'cooldownOverride';
    }
  ) {
    setApplying(options.label);
    try {
      const supabase = createClient();
      const { data, error } = await supabase.rpc('triage_set_selection', {
        p_draft_id: draftId,
        p_selected: selected,
        // Com `filterOverride` a busca também sai da conta: "remover quem
        // pediu para sair" tem que valer para o rascunho INTEIRO, não só
        // para as linhas que a busca atual está mostrando.
        p_search: options.filterOverride ? null : search.trim() || null,
        p_filter: options.filterOverride ?? filter,
      });
      if (error) throw error;
      toast.success(t('selectionUpdated', { count: (data as number) ?? 0 }));
      onBulkSelectionApplied();
    } catch (err) {
      console.error('[triage-toolbar] bulk selection error:', err);
      toast.error(t('bulkActionFailed'));
    } finally {
      setApplying(null);
    }
  }

  const activeFilterLabel =
    filter === 'all' ? tFilter('all') : tFilter(filter);

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-1 flex-col gap-2 sm:flex-row">
        <div className="relative w-full max-w-sm">
          <Search className="text-muted-foreground absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="border-border bg-card text-foreground placeholder:text-muted-foreground pl-8"
          />
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="outline"
                className="border-border text-muted-foreground hover:bg-muted shrink-0"
              />
            }
          >
            <Filter className="h-3.5 w-3.5" />
            {activeFilterLabel}
            <ChevronDown className="h-3 w-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="border-border bg-popover max-h-80 overflow-y-auto">
            {TRIAGE_STATE_FILTERS.map((value) => (
              <DropdownMenuItem
                key={value}
                onClick={() => onFilterChange(value)}
                className={
                  filter === value ? 'text-primary' : 'text-popover-foreground'
                }
              >
                {tFilter(value)}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            {/* DropdownMenuGroup (base-ui Menu.Group) é OBRIGATÓRIO: o
                DropdownMenuLabel abaixo é o Menu.GroupLabel do base-ui,
                que lança "Base UI error #31" sem um Menu.Group ancestral
                (ver dropdown-menu-group-label.test.tsx). */}
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-muted-foreground text-[11px] font-normal">
                {t('engagementPresets')}
              </DropdownMenuLabel>
              {TRIAGE_ENGAGEMENT_FILTERS.map((value) => (
                <DropdownMenuItem
                  key={value}
                  onClick={() => onFilterChange(value)}
                  className={
                    filter === value ? 'text-primary' : 'text-popover-foreground'
                  }
                >
                  {tFilter(value)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-muted-foreground text-[11px] font-normal">
                {t('consentFilters')}
              </DropdownMenuLabel>
              {TRIAGE_CONSENT_FILTERS.map((value) => (
                <DropdownMenuItem
                  key={value}
                  onClick={() => onFilterChange(value)}
                  className={
                    filter === value ? 'text-primary' : 'text-popover-foreground'
                  }
                >
                  {tFilter(value)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || applying !== null}
          onClick={() => applyBulkSelection(true, { label: 'select' })}
          className="border-border text-muted-foreground hover:bg-muted"
        >
          {t('selectAllFiltered', { count: matchingCount })}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || applying !== null}
          onClick={() => applyBulkSelection(false, { label: 'clear' })}
          className="text-muted-foreground hover:text-foreground"
        >
          {t('clearAllFiltered')}
        </Button>
        {/* Ação de um clique da §5.4/§6.8. O envio já remove quem está em
            opt-out; isto existe para o número na tela concordar com o que
            vai sair ANTES de disparar. */}
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || applying !== null}
          onClick={() =>
            applyBulkSelection(false, {
              filterOverride: 'opted_out',
              label: 'optout',
            })
          }
          className="text-muted-foreground hover:text-foreground"
        >
          <Ban className="h-3.5 w-3.5" />
          {t('removeOptedOut')}
        </Button>
        {/* Anti-fadiga (§6.2/§5.4). O staging já desmarca cooldown por
            padrão (§6.2) — este botão existe para reaplicar depois de
            uma edição manual, sem sair pra outro filtro. */}
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || applying !== null}
          onClick={() =>
            applyBulkSelection(false, {
              filterOverride: 'cooldown',
              label: 'cooldown',
            })
          }
          className="text-muted-foreground hover:text-foreground"
        >
          <Clock className="h-3.5 w-3.5" />
          {t('removeCooldown')}
        </Button>
        {/* Override explícito de admin (§6.2) — trazer de volta quem o
            cooldown desmarcou automaticamente. Restrito na UI, não no
            banco: o checkbox por linha já permite o mesmo a qualquer
            agente, então a guarda aqui é sobre a ação EM MASSA. */}
        {canOverrideCooldown && (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled || applying !== null}
            onClick={() =>
              applyBulkSelection(true, {
                filterOverride: 'cooldown',
                label: 'cooldownOverride',
              })
            }
            className="text-muted-foreground hover:text-foreground"
          >
            <Undo2 className="h-3.5 w-3.5" />
            {t('overrideCooldown')}
          </Button>
        )}
      </div>
    </div>
  );
}
