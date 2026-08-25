'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Broadcast, BroadcastRecipient, RecipientStatus } from '@/types';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ArrowLeft,
  Loader2,
  Users,
  Send,
  CheckCheck,
  Eye,
  AlertCircle,
  MessageCircle,
  Filter,
  Download,
  ChevronDown,
  Trash2,
  Copy,
  ScrollText,
} from 'lucide-react';
import { toast } from 'sonner';
import { getBroadcastStatus, getRecipientStatus } from '@/lib/broadcast-status';
import { useTranslations } from 'next-intl';
import { StatCard } from '@/components/broadcasts/stat-card';
import {
  FunnelChart,
  type FunnelStep,
} from '@/components/broadcasts/funnel-chart';
import { VariantComparison } from '@/components/broadcasts/variant-comparison';
import { RecipientErrorCell } from '@/components/broadcasts/recipient-error-cell';
import { TooltipProvider } from '@/components/ui/tooltip';

/**
 * Cadência do polling enquanto o disparo roda no servidor. Igual à da
 * lista (`/broadcasts`) — os contadores vêm do trigger agregador da
 * migração 003, então só precisamos da foto mais recente.
 */
const DETAIL_POLL_INTERVAL_MS = 5_000;

const RECIPIENT_STATUSES: readonly RecipientStatus[] = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
  'failed',
];

/**
 * CSV export helper — RFC 4180 quoting. Quote every field so
 * commas/newlines/quotes round-trip cleanly.
 */
function toCsv(rows: string[][]): string {
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return rows.map((r) => r.map(escape).join(',')).join('\n');
}

function downloadBlob(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function BroadcastDetailPage() {
  const params = useParams();
  const router = useRouter();
  const t = useTranslations('Broadcasts.detail');
  const tStatus = useTranslations('Broadcasts.status');
  const tWebhook = useTranslations('Broadcasts.webhookFunnel');
  const broadcastId = params.id as string;

  const [broadcast, setBroadcast] = useState<Broadcast | null>(null);
  /** O outro braço do teste A/B (§6.6), quando esta campanha é um. */
  const [sibling, setSibling] = useState<Broadcast | null>(null);
  const [recipients, setRecipients] = useState<BroadcastRecipient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<RecipientStatus | 'all'>(
    'all'
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const supabase = createClient();

      const { data: bc, error: bcError } = await supabase
        .from('broadcasts')
        .select('*')
        .eq('id', broadcastId)
        .single();

      if (bcError) throw bcError;
      setBroadcast(bc);

      // Teste A/B (§6.6). A campanha aberta pode ser qualquer um dos dois
      // braços: a variante A é apontada pelo irmão, a B aponta para ele.
      // Entrar por qualquer uma das duas leva à mesma comparação — quem
      // recebeu o link de uma variante não deveria precisar descobrir
      // qual das duas é "a principal".
      if (bc?.variant_label === 'A') {
        const { data: variantB } = await supabase
          .from('broadcasts')
          .select('*')
          .eq('parent_broadcast_id', bc.id)
          .maybeSingle();
        setSibling(variantB ?? null);
      } else if (bc?.variant_label === 'B' && bc.parent_broadcast_id) {
        const { data: variantA } = await supabase
          .from('broadcasts')
          .select('*')
          .eq('id', bc.parent_broadcast_id)
          .maybeSingle();
        setSibling(variantA ?? null);
      } else {
        setSibling(null);
      }

      const { data: recs, error: recsError } = await supabase
        .from('broadcast_recipients')
        .select('*, contact:contacts(*)')
        .eq('broadcast_id', broadcastId)
        .order('created_at', { ascending: false });

      if (recsError) throw recsError;
      setRecipients(recs ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('notFound'));
    } finally {
      setLoading(false);
    }
    // `t` vem do next-intl e é estável dentro de um locale; incluí-lo na
    // lista recriaria o callback a cada render e reiniciaria o polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [broadcastId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Polling enquanto o disparo está `sending` — OU `streaming`.
  //
  // Passou a ser necessário quando o envio migrou para o servidor (SPEC
  // 044 §6.1): o wizard agora responde assim que as linhas existem e
  // redireciona para cá com tudo em `pending`. Sem isto o usuário veria
  // uma foto congelada de uma campanha que está andando. Espelha o
  // padrão da lista (`/broadcasts`), inclusive a pausa em aba oculta.
  //
  // `streaming` (SPEC 055, funil de webhook) INCLUI de propósito, ao
  // contrário da lista: lá, pollar toda linha `streaming` da tabela é
  // desperdício (um funil vive meses); aqui é UM funil específico que o
  // usuário abriu para acompanhar ao vivo — sem isto, novos
  // destinatários que chegam via POST em segundo plano nunca apareceriam
  // sem F5 manual.
  const isSending =
    broadcast?.status === 'sending' || broadcast?.status === 'streaming';
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    function startPolling() {
      if (pollTimer.current) return;
      pollTimer.current = setInterval(fetchData, DETAIL_POLL_INTERVAL_MS);
    }
    function stopPolling() {
      if (!pollTimer.current) return;
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
    function handleVisibilityChange() {
      if (!isSending) return;
      if (document.visibilityState === 'hidden') {
        stopPolling();
      } else {
        fetchData();
        startPolling();
      }
    }

    if (isSending && document.visibilityState === 'visible') startPolling();
    else stopPolling();

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isSending, fetchData]);

  const filteredRecipients = useMemo(
    () =>
      statusFilter === 'all'
        ? recipients
        : recipients.filter((r) => r.status === statusFilter),
    [recipients, statusFilter]
  );

  function handleExport() {
    if (!broadcast) return;
    const header = [
      t('table.contact'),
      t('table.phone'),
      t('table.status'),
      t('table.sent'),
      t('table.delivered'),
      t('table.read'),
      t('table.error'),
    ];
    const rows = recipients.map((r) => [
      r.contact?.name ?? '',
      r.contact?.phone ?? '',
      r.status,
      r.sent_at ?? '',
      r.delivered_at ?? '',
      r.read_at ?? '',
      r.error_message ?? '',
    ]);
    const csv = toCsv([header, ...rows]);
    const safeName = broadcast.name
      .replace(/[^a-z0-9-_]+/gi, '-')
      .toLowerCase();
    downloadBlob(`broadcast-${safeName}-${broadcastId.slice(0, 8)}.csv`, csv);
  }

  async function handleDelete() {
    setDeleting(true);
    const supabase = createClient();
    // broadcast_recipients cascades on broadcasts.id (migration 001), so a
    // single delete is sufficient — the aggregate trigger in migration 003
    // is defined on broadcast_recipients but fires only on its own row
    // changes, not on a cascaded drop of the parent row.
    const { error: delErr } = await supabase
      .from('broadcasts')
      .delete()
      .eq('id', broadcastId);
    setDeleting(false);
    if (delErr) {
      toast.error(t('toastFailedDelete', { error: delErr.message }));
      return;
    }
    toast.success(t('toastDeleted'));
    router.push('/broadcasts');
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (error || !broadcast) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-red-400">{error ?? t('notFound')}</p>
        <Button variant="outline" onClick={() => router.push('/broadcasts')}>
          {t('backToBroadcasts')}
        </Button>
      </div>
    );
  }

  const status = getBroadcastStatus(broadcast.status);

  const funnelSteps: FunnelStep[] = [
    {
      label: t('stats.sent'),
      value: broadcast.sent_count,
      color: 'bg-primary',
    },
    {
      label: t('stats.delivered'),
      value: broadcast.delivered_count,
      color: 'bg-teal-500',
    },
    {
      label: t('stats.read'),
      value: broadcast.read_count,
      color: 'bg-blue-500',
    },
    {
      label: t('stats.replied'),
      value: broadcast.replied_count,
      color: 'bg-indigo-500',
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-4">
          <Button
            variant="outline"
            size="icon"
            onClick={() => router.push('/broadcasts')}
            className="border-border"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-foreground text-2xl font-bold">
                {broadcast.name}
              </h1>
              <span
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${status.classes}`}
              >
                {tStatus(status.label)}
              </span>
              {broadcast.variant_label && (
                <span className="border-primary/30 bg-primary/10 text-primary inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium">
                  {t('abTest.variantLabel', {
                    variant: broadcast.variant_label,
                  })}
                </span>
              )}
            </div>
            {broadcast.source === 'webhook' ? (
              // SPEC 055 D-10 — cabeçalho do funil: o webhook_id (com
              // copiar) + link pro log já filtrado por ele. Uma linha
              // curta explica que "recipients" aqui conta ENVIOS, não
              // pessoas distintas (D-5 nota 1) — sem isso, o número
              // parece um bug para quem está acostumado com campanha
              // comum.
              <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-3 text-sm">
                <button
                  type="button"
                  onClick={() => {
                    if (broadcast.webhook_id) {
                      navigator.clipboard.writeText(broadcast.webhook_id);
                      toast.success(tWebhook('idCopied'));
                    }
                  }}
                  className="hover:text-foreground flex items-center gap-1 font-mono text-xs"
                  title={tWebhook('copyId')}
                >
                  {broadcast.webhook_id}
                  <Copy className="h-3 w-3" />
                </button>
                <span>-</span>
                <button
                  type="button"
                  onClick={() =>
                    router.push(
                      `/settings?tab=webhook-log&webhook_id=${broadcast.webhook_id}`
                    )
                  }
                  className="hover:text-foreground flex items-center gap-1"
                >
                  <ScrollText className="h-3.5 w-3.5" />
                  {tWebhook('viewLog')}
                </button>
              </div>
            ) : (
              <div className="text-muted-foreground mt-1 flex items-center gap-3 text-sm">
                <span>{t('template', { name: broadcast.template_name })}</span>
                <span>-</span>
                <span>
                  {t('createdAt', {
                    date: new Date(broadcast.created_at).toLocaleDateString(),
                  })}
                </span>
              </div>
            )}
            {broadcast.source === 'webhook' && (
              <p className="text-muted-foreground mt-1 text-xs">
                {tWebhook('recipientsNote')}
              </p>
            )}
          </div>
        </div>

        {/* Delete — inline-confirm pattern matches the pipeline-settings
            "Delete Pipeline" flow. Mid-send broadcasts can't be deleted
            because orphaning in-flight Meta messages would leave the
            funnel inconsistent. 'streaming' (webhook funnels, SPEC 055)
            is included in that same guard: a POST's after() send can be
            in flight against this exact broadcast_id at any time, and
            broadcast_recipients cascades on broadcasts.id (migration
            001) — deleting mid-send would silently orphan that update. */}
        {confirmDelete ? (
          <div className="flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-sm">
            <span className="text-red-300">
              {/* Apagar a variante A leva a B junto (FK em cascata da
                  051). Dizer isso ANTES é a diferença entre uma escolha
                  e uma surpresa. */}
              {broadcast.variant_label === 'A' && sibling
                ? t('abTest.deleteCascade')
                : t('deletePrompt')}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmDelete(false)}
              disabled={deleting}
              className="border-border text-muted-foreground hover:bg-muted h-7 bg-transparent"
            >
              {t('cancel')}
            </Button>
            <Button
              size="sm"
              onClick={handleDelete}
              disabled={deleting}
              className="h-7 bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
            >
              {deleting ? t('deleting') : t('confirm')}
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={
              broadcast.status === 'sending' || broadcast.status === 'streaming'
            }
            onClick={() => setConfirmDelete(true)}
            title={
              broadcast.status === 'streaming'
                ? t('cannotDeleteStreaming')
                : broadcast.status === 'sending'
                  ? t('cannotDeleteSending')
                  : t('deleteHover')
            }
            className="border-red-500/30 bg-transparent text-red-400 hover:bg-red-500/10 disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('delete')}
          </Button>
        )}
      </div>

      {/* Stats — 6 cards: Total / Sent / Delivered / Read / Replied / Failed */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label={t('stats.totalRecipients')}
          value={broadcast.total_recipients}
          total={broadcast.total_recipients}
          icon={<Users className="h-4 w-4" />}
          color="bg-muted text-muted-foreground"
        />
        <StatCard
          label={t('stats.sent')}
          value={broadcast.sent_count}
          total={broadcast.total_recipients}
          icon={<Send className="h-4 w-4" />}
          color="bg-primary/10 text-primary"
        />
        <StatCard
          label={t('stats.delivered')}
          value={broadcast.delivered_count}
          total={broadcast.total_recipients}
          icon={<CheckCheck className="h-4 w-4" />}
          color="bg-teal-500/10 text-teal-400"
        />
        <StatCard
          label={t('stats.read')}
          value={broadcast.read_count}
          total={broadcast.total_recipients}
          icon={<Eye className="h-4 w-4" />}
          color="bg-blue-500/10 text-blue-400"
        />
        <StatCard
          label={t('stats.replied')}
          value={broadcast.replied_count}
          total={broadcast.total_recipients}
          icon={<MessageCircle className="h-4 w-4" />}
          color="bg-indigo-500/10 text-indigo-400"
        />
        <StatCard
          label={t('stats.failed')}
          value={broadcast.failed_count}
          total={broadcast.total_recipients}
          icon={<AlertCircle className="h-4 w-4" />}
          color="bg-red-500/10 text-red-400"
        />
      </div>

      {/* Com os dois braços em mãos, a comparação SUBSTITUI o funil
          único: ela já contém o funil desta campanha, e mostrar os dois
          faria o mesmo número aparecer duas vezes na mesma tela. */}
      {broadcast.variant_label && sibling ? (
        <VariantComparison
          variantA={broadcast.variant_label === 'A' ? broadcast : sibling}
          variantB={broadcast.variant_label === 'A' ? sibling : broadcast}
          currentId={broadcast.id}
          onOpenVariant={(id) => router.push(`/broadcasts/${id}`)}
        />
      ) : (
        <FunnelChart steps={funnelSteps} title={t('funnel')} />
      )}

      {/* Recipients Table — TooltipProvider scoped to just this
            section: it's the only place a Tooltip (RecipientErrorCell)
            is rendered, so the rest of the page doesn't need to carry
            the provider. */}
      <TooltipProvider>
        <div className="border-border bg-card rounded-xl border">
          <div className="border-border flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
            <h2 className="text-foreground text-sm font-medium">
              {statusFilter !== 'all'
                ? t('recipientsHeader', {
                    filtered: filteredRecipients.length,
                    total: recipients.length,
                  })
                : t('recipientsHeaderAll', { total: recipients.length })}
            </h2>
            <div className="flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-border text-muted-foreground hover:bg-muted"
                    />
                  }
                >
                  <Filter className="h-3.5 w-3.5" />
                  {statusFilter === 'all'
                    ? t('allStatuses')
                    : tStatus(getRecipientStatus(statusFilter).label)}
                  <ChevronDown className="h-3 w-3" />
                </DropdownMenuTrigger>
                <DropdownMenuContent className="border-border bg-popover">
                  <DropdownMenuItem
                    onClick={() => setStatusFilter('all')}
                    className={
                      statusFilter === 'all'
                        ? 'text-primary'
                        : 'text-popover-foreground'
                    }
                  >
                    {t('allStatuses')}
                  </DropdownMenuItem>
                  {RECIPIENT_STATUSES.map((s) => (
                    <DropdownMenuItem
                      key={s}
                      onClick={() => setStatusFilter(s)}
                      className={
                        statusFilter === s
                          ? 'text-primary'
                          : 'text-popover-foreground'
                      }
                    >
                      {tStatus(getRecipientStatus(s).label)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <Button
                variant="outline"
                size="sm"
                onClick={handleExport}
                disabled={recipients.length === 0}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                <Download className="h-3.5 w-3.5" />
                {t('exportCsv')}
              </Button>
            </div>
          </div>

          {filteredRecipients.length === 0 ? (
            <div className="flex h-32 items-center justify-center">
              <p className="text-muted-foreground text-sm">
                {recipients.length === 0
                  ? t('noRecipients')
                  : t('noRecipientsFilter')}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-border hover:bg-transparent">
                    <TableHead className="text-muted-foreground">
                      {t('table.contact')}
                    </TableHead>
                    <TableHead className="text-muted-foreground">
                      {t('table.phone')}
                    </TableHead>
                    <TableHead className="text-muted-foreground">
                      {t('table.status')}
                    </TableHead>
                    <TableHead className="text-muted-foreground">
                      {t('table.sent')}
                    </TableHead>
                    <TableHead className="text-muted-foreground">
                      {t('table.delivered')}
                    </TableHead>
                    <TableHead className="text-muted-foreground">
                      {t('table.read')}
                    </TableHead>
                    <TableHead className="text-muted-foreground">
                      {t('table.error')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRecipients.map((recipient) => {
                    const rStatus = getRecipientStatus(recipient.status);
                    return (
                      <TableRow key={recipient.id} className="border-border">
                        <TableCell className="text-foreground font-medium">
                          {recipient.contact?.name ?? 'Unknown'}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {recipient.contact?.phone ?? '-'}
                        </TableCell>
                        <TableCell>
                          <span
                            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${rStatus.classes}`}
                          >
                            {tStatus(rStatus.label)}
                          </span>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {recipient.sent_at
                            ? new Date(recipient.sent_at).toLocaleString()
                            : '-'}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {recipient.delivered_at
                            ? new Date(recipient.delivered_at).toLocaleString()
                            : '-'}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {recipient.read_at
                            ? new Date(recipient.read_at).toLocaleString()
                            : '-'}
                        </TableCell>
                        <TableCell className="max-w-xs">
                          <RecipientErrorCell
                            errorMessage={recipient.error_message}
                            t={t}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </TooltipProvider>
    </div>
  );
}
