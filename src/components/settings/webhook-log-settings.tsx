'use client';

// ============================================================
// WebhookLogSettings — Settings → Log de webhook (SPEC 055 D-12).
//
// Mostra SÓ falhas/avisos de validação do webhook de entrada
// (`POST /api/v1/ingest/contact`) — o sucesso vive no funil, em
// Disparos (`/broadcasts`, filtro "Funis de webhook"). Uma
// requisição com chave de API inválida/ausente também não aparece
// aqui: sem chave não há `account_id` a que a linha pertença (D-2).
//
// Estrutura no molde de `api-keys-settings.tsx`: SettingsPanelHead +
// Card + lista, carregada via fetch na rota interna
// (`/api/account/webhook-logs`), `RequireRole min="admin"` só na ação
// de limpar.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Loader2, ScrollText, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RequireRole } from '@/components/auth/require-role';
import { maskPhoneForLog } from '@/lib/phone/mask-for-log';
import { SettingsPanelHead } from './settings-panel-head';

type LogLevel = 'error' | 'warning';

interface WebhookLog {
  id: string;
  webhook_id: string | null;
  webhook_name: string | null;
  level: LogLevel;
  code: string;
  message: string;
  phone: string | null;
  contact_id: string | null;
  broadcast_id: string | null;
  payload: unknown;
  created_at: string;
}

interface WebhookOption {
  webhook_id: string;
  webhook_name: string | null;
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const LEVEL_BADGE: Record<LogLevel, string> = {
  error: 'border-red-500/40 bg-red-500/10 text-red-300',
  warning: 'border-yellow-500/40 bg-yellow-500/10 text-yellow-300',
};

export function WebhookLogSettings({
  /**
   * Pré-seleciona o filtro de `webhook_id` — usado pelo link "Ver
   * log" no cabeçalho do funil (`/broadcasts/[id]`, SPEC 055 D-10),
   * que chega aqui via `?tab=webhook-log&webhook_id=…`.
   */
  initialWebhookId,
}: {
  initialWebhookId?: string | null;
} = {}) {
  const t = useTranslations('Settings.webhookLog');

  const [logs, setLogs] = useState<WebhookLog[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookOption[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [payloadLog, setPayloadLog] = useState<WebhookLog | null>(null);

  const [webhookFilter, setWebhookFilter] = useState<string>(
    initialWebhookId || 'all'
  );
  const [levelFilter, setLevelFilter] = useState<'all' | LogLevel>('all');

  // O dropdown de webhooks só é pedido UMA VEZ (carga inicial) — nem
  // "carregar mais" nem trocar de filtro tem qualquer efeito sobre
  // quais webhook_ids existem, então repetir o scan de até 500 linhas
  // a cada clique seria puro desperdício (code-review).
  const webhooksRequested = useRef(false);

  const load = useCallback(
    async (opts: { cursor?: string | null; append?: boolean } = {}) => {
      const params = new URLSearchParams();
      if (webhookFilter !== 'all') params.set('webhook_id', webhookFilter);
      if (levelFilter !== 'all') params.set('level', levelFilter);
      if (opts.cursor) params.set('cursor', opts.cursor);
      if (!webhooksRequested.current) {
        params.set('include_webhooks', '1');
      }

      if (opts.append) setLoadingMore(true);
      else setLoading(true);

      try {
        const res = await fetch(`/api/account/webhook-logs?${params}`, {
          cache: 'no-store',
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          toast.error(body.error || t('loadFailed'));
          return;
        }
        const data = (await res.json()) as {
          logs: WebhookLog[];
          next_cursor: string | null;
          webhooks: WebhookOption[] | null;
        };
        setLogs((prev) => (opts.append ? [...prev, ...data.logs] : data.logs));
        setNextCursor(data.next_cursor);
        if (data.webhooks !== null) {
          setWebhooks(data.webhooks);
          webhooksRequested.current = true;
        }
      } catch (err) {
        console.error('[WebhookLogSettings] load error:', err);
        toast.error(t('networkError'));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [webhookFilter, levelFilter, t]
  );

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webhookFilter, levelFilter]);

  async function handleClear() {
    setClearing(true);
    try {
      const res = await fetch('/api/account/webhook-logs', {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error || t('clearFailed'));
        return;
      }
      toast.success(t('clearSuccess'));
      setConfirmClearOpen(false);
      await load();
    } catch (err) {
      console.error('[WebhookLogSettings] clear error:', err);
      toast.error(t('networkError'));
    } finally {
      setClearing(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          <RequireRole min="admin">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmClearOpen(true)}
              disabled={logs.length === 0}
              className="border-red-500/40 bg-red-500/10 text-red-300 hover:border-red-500/60 hover:bg-red-500/20 hover:text-red-200"
            >
              <Trash2 className="size-4" />
              {t('clear')}
            </Button>
          </RequireRole>
        }
      />

      <div className="flex flex-wrap gap-2">
        <Select
          value={levelFilter}
          onValueChange={(v) => setLevelFilter(v as 'all' | LogLevel)}
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('levelAll')}</SelectItem>
            <SelectItem value="error">{t('levelError')}</SelectItem>
            <SelectItem value="warning">{t('levelWarning')}</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={webhookFilter}
          onValueChange={(v) => setWebhookFilter(v ?? 'all')}
        >
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('webhookAll')}</SelectItem>
            {webhooks.map((w) => (
              <SelectItem key={w.webhook_id} value={w.webhook_id}>
                {w.webhook_name || w.webhook_id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {logs.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-10 text-center">
            <ScrollText className="text-muted-foreground size-6" />
            <p className="text-muted-foreground mt-2 text-sm">{t('empty')}</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-border divide-y">
              {logs.map((log) => (
                <li
                  key={log.id}
                  className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge className={LEVEL_BADGE[log.level]}>
                        {log.level === 'error'
                          ? t('levelError')
                          : t('levelWarning')}
                      </Badge>
                      <span className="text-foreground font-mono text-xs">
                        {t.has(`codes.${log.code}`)
                          ? t(`codes.${log.code}`)
                          : log.code}
                      </span>
                    </div>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {log.webhook_name || log.webhook_id ? (
                        <>
                          {log.webhook_name || t('unnamedWebhook')}
                          {log.webhook_id ? ` (${log.webhook_id})` : ''}
                        </>
                      ) : (
                        t('noWebhook')
                      )}
                      {' · '}
                      {maskPhoneForLog(log.phone)}
                      {' · '}
                      {fmtDateTime(log.created_at)}
                    </p>
                    <p className="text-foreground mt-1 text-sm">
                      {log.message}
                    </p>
                  </div>
                  <div className="shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPayloadLog(log)}
                    >
                      {t('viewPayload')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {nextCursor && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load({ cursor: nextCursor, append: true })}
            disabled={loadingMore}
          >
            {loadingMore ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              t('loadMore')
            )}
          </Button>
        </div>
      )}

      <Dialog open={confirmClearOpen} onOpenChange={setConfirmClearOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('clearConfirmTitle')}</DialogTitle>
            <DialogDescription>
              {t('clearConfirmDescription')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmClearOpen(false)}
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={() => void handleClear()}
              disabled={clearing}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              {clearing ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('clear')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={payloadLog != null}
        onOpenChange={(open) => !open && setPayloadLog(null)}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('payloadTitle')}</DialogTitle>
            <DialogDescription className="flex items-start gap-1.5">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {t('payloadWarning')}
            </DialogDescription>
          </DialogHeader>
          <pre className="bg-muted max-h-96 overflow-auto rounded-lg p-3 text-xs">
            {JSON.stringify(payloadLog?.payload ?? null, null, 2)}
          </pre>
        </DialogContent>
      </Dialog>
    </section>
  );
}
