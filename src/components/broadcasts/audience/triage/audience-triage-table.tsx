'use client';

/**
 * Tabela de triagem enriquecida (SPEC 044 §5.1, §5.3).
 *
 * Pagina pela RPC `triage_audience_page` (migração 046) direto do
 * cliente — mesmo padrão já usado por `contacts/page.tsx`
 * (`filter_contacts_by_tags`) e `presence-heartbeat.tsx`: a RPC é
 * `SECURITY INVOKER` e a RLS de 045/017 escopa por conta, então não
 * existe motivo para uma rota própria só para repassar a chamada.
 *
 * "Selecionar todos" NUNCA carrega todas as páginas — isso é o botão de
 * seleção em massa no toolbar do pai, que chama `triage_set_selection`
 * (um UPDATE server-side). Esta tabela só faz scroll infinito de
 * LEITURA, 50 linhas por vez.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { AlertTriangle, Ban, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { createClient } from '@/lib/supabase/client';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import type { TriageFilter, TriageRow } from '@/lib/audience/triage';

const PAGE_SIZE = 50;

interface AudienceTriageTableProps {
  draftId: string;
  search: string;
  filter: TriageFilter;
  /** Incrementar força um reload do zero (ex.: depois de uma ação em massa). */
  reloadToken: number;
  /** Disparado após qualquer alteração de seleção — o pai reconfere a cota. */
  onSelectionChanged: () => void;
  /** Total do filtro atual, para o toolbar mostrar "selecionar todos (N)". */
  onTotalCountChanged: (total: number) => void;
}

function StatusBadge({ row }: { row: TriageRow }) {
  const tReason = useTranslations('Import.reason');
  const t = useTranslations('Broadcasts.audience.triage.badge');

  if (row.invalid_reason) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-red-500/10 px-1.5 py-0.5 text-[11px] font-medium text-red-300">
        <AlertTriangle className="h-3 w-3" />
        {tReason(row.invalid_reason)}
      </span>
    );
  }
  // Opt-out ganha do "Novo"/"Existente": é o fato que decide se a
  // mensagem sai, e mostrá-lo depois de um badge neutro faria o usuário
  // marcar a linha sem ver a restrição (§6.8).
  if (row.is_opted_out) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-300">
        <Ban className="h-3 w-3" />
        {t('optedOut')}
      </span>
    );
  }
  if (row.is_new) {
    return (
      <span className="bg-primary/10 text-primary inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium">
        {t('new')}
      </span>
    );
  }
  return (
    <span className="bg-muted text-muted-foreground inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium">
      {t('existing')}
    </span>
  );
}

function BoolMark({ value }: { value: boolean }) {
  return (
    <span className={value ? 'text-primary' : 'text-muted-foreground/50'}>
      {value ? '✓' : '—'}
    </span>
  );
}

export function AudienceTriageTable({
  draftId,
  search,
  filter,
  reloadToken,
  onSelectionChanged,
  onTotalCountChanged,
}: AudienceTriageTableProps) {
  const t = useTranslations('Broadcasts.audience.triage');
  const tTable = useTranslations('Broadcasts.audience.triage.table');

  const [rows, setRows] = useState<TriageRow[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);

  // Refs (não state) para o observer de scroll ler o valor mais recente
  // sem precisar recriar o IntersectionObserver a cada página carregada.
  const offsetRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const rowsLengthRef = useRef(0);
  const totalCountRef = useRef(0);
  const sentinelRef = useRef<HTMLTableRowElement | null>(null);

  const fetchPage = useCallback(
    async (offset: number, reset: boolean) => {
      const supabase = createClient();
      const { data, error: rpcError } = await supabase.rpc(
        'triage_audience_page',
        {
          p_draft_id: draftId,
          p_search: search.trim() || null,
          p_filter: filter,
          p_limit: PAGE_SIZE,
          p_offset: offset,
        }
      );
      if (rpcError) throw rpcError;

      const page = (data ?? []) as TriageRow[];
      const total = page[0]?.total_count ?? 0;

      setRows((prev) => (reset ? page : [...prev, ...page]));
      setTotalCount(total);
      onTotalCountChanged(total);
      offsetRef.current = offset + page.length;
      rowsLengthRef.current = reset
        ? page.length
        : rowsLengthRef.current + page.length;
      totalCountRef.current = total;
    },
    [draftId, search, filter, onTotalCountChanged]
  );

  // Reset completo sempre que o rascunho, busca, filtro ou reloadToken
  // mudar — inclui o caso de uma ação em massa do toolbar, que altera
  // linhas que esta tabela já tem em memória.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    offsetRef.current = 0;

    (async () => {
      try {
        await fetchPage(0, true);
      } catch (err) {
        console.error('[audience-triage-table] fetch page error:', err);
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fetchPage, reloadToken]);

  // Scroll infinito: uma linha-sentinela no fim do corpo da tabela.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting) return;
        if (loadingMoreRef.current) return;
        if (rowsLengthRef.current >= totalCountRef.current) return;

        loadingMoreRef.current = true;
        setLoadingMore(true);
        fetchPage(offsetRef.current, false)
          .catch((err) => {
            console.error('[audience-triage-table] load more error:', err);
          })
          .finally(() => {
            loadingMoreRef.current = false;
            setLoadingMore(false);
          });
      },
      { rootMargin: '300px' }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [fetchPage]);

  async function toggleRow(row: TriageRow) {
    const next = !row.selected;
    setRows((prev) =>
      prev.map((r) => (r.id === row.id ? { ...r, selected: next } : r))
    );

    const supabase = createClient();
    const { error: updateError } = await supabase
      .from('broadcast_audience_staging')
      .update({ selected: next })
      .eq('id', row.id);

    if (updateError) {
      setRows((prev) =>
        prev.map((r) => (r.id === row.id ? { ...r, selected: !next } : r))
      );
      toast.error(t('toggleFailed'));
      return;
    }
    onSelectionChanged();
  }

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="text-primary h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-40 items-center justify-center">
        <p className="text-sm text-red-400">{t('loadError')}</p>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center">
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      </div>
    );
  }

  return (
    <div className="max-h-[520px] overflow-x-auto overflow-y-auto">
      <Table>
        <TableHeader className="bg-card sticky top-0 z-10">
          <TableRow className="border-border hover:bg-transparent">
            <TableHead className="w-10" />
            <TableHead className="text-muted-foreground">
              {tTable('contact')}
            </TableHead>
            <TableHead className="text-muted-foreground">
              {tTable('status')}
            </TableHead>
            <TableHead className="text-muted-foreground hidden text-right sm:table-cell">
              {tTable('campaigns')}
            </TableHead>
            <TableHead className="text-muted-foreground hidden md:table-cell">
              {tTable('lastDelivered')}
            </TableHead>
            <TableHead className="text-muted-foreground hidden text-center lg:table-cell">
              {tTable('read')}
            </TableHead>
            <TableHead className="text-muted-foreground hidden text-center lg:table-cell">
              {tTable('replied')}
            </TableHead>
            <TableHead className="text-muted-foreground hidden text-right xl:table-cell">
              {tTable('failures')}
            </TableHead>
            <TableHead className="text-muted-foreground hidden xl:table-cell">
              {tTable('tags')}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id} className="border-border">
              <TableCell>
                <Checkbox
                  checked={row.selected}
                  onCheckedChange={() => toggleRow(row)}
                  aria-label={`${t('selectRow')} ${row.name ?? row.phone}`}
                />
              </TableCell>
              <TableCell>
                <p className="text-foreground font-medium">{row.name || '—'}</p>
                <p className="text-muted-foreground font-mono text-xs">
                  {row.phone}
                </p>
              </TableCell>
              <TableCell>
                <StatusBadge row={row} />
              </TableCell>
              <TableCell className="text-muted-foreground hidden text-right tabular-nums sm:table-cell">
                {row.campaigns_received}
              </TableCell>
              <TableCell className="text-muted-foreground hidden text-xs md:table-cell">
                {row.last_delivered_at
                  ? formatDistanceToNow(new Date(row.last_delivered_at), {
                      addSuffix: true,
                    })
                  : t('never')}
              </TableCell>
              <TableCell className="hidden text-center lg:table-cell">
                <BoolMark value={row.has_read} />
              </TableCell>
              <TableCell className="hidden text-center lg:table-cell">
                <BoolMark value={row.has_replied} />
              </TableCell>
              <TableCell
                className={`hidden text-right tabular-nums xl:table-cell ${
                  row.failure_count >= 2
                    ? 'font-medium text-red-400'
                    : 'text-muted-foreground'
                }`}
              >
                {row.failure_count}
              </TableCell>
              <TableCell className="hidden xl:table-cell">
                {row.tag_names.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {row.tag_names.slice(0, 3).map((name) => (
                      <span
                        key={name}
                        className="bg-muted text-muted-foreground inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px]"
                      >
                        {name}
                      </span>
                    ))}
                    {row.tag_names.length > 3 && (
                      <span className="text-muted-foreground text-[10px]">
                        +{row.tag_names.length - 3}
                      </span>
                    )}
                  </div>
                ) : (
                  <span className="text-muted-foreground/50 text-xs">—</span>
                )}
              </TableCell>
            </TableRow>
          ))}

          {/* Sentinela do scroll infinito — sem altura própria quando
              tudo já carregou, então não fica um espaço vazio no fim. */}
          <TableRow
            ref={sentinelRef}
            className="border-none hover:bg-transparent"
          >
            <TableCell colSpan={9} className="p-0">
              {loadingMore && (
                <div className="flex items-center justify-center py-3">
                  <Loader2 className="text-primary h-4 w-4 animate-spin" />
                </div>
              )}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>

      <p className="text-muted-foreground border-border border-t px-4 py-2 text-xs">
        {t('rowCount', { shown: rows.length, total: totalCount })}
      </p>
    </div>
  );
}
