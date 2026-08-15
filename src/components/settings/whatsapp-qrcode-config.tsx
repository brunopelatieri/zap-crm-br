'use client';

// ============================================================
// WhatsappQrcodeConfig — Settings → WhatsApp QRCode
//
// Gerenciamento de instâncias Evolution Go (PRD 047 / SPEC 048 §7,
// §9.1). Leitura é aberta a qualquer membro (mesma postura da RLS de
// `evolution_instances`); toda mutação é admin+, gated tanto pelo
// `<RequireRole>` aqui quanto pelas rotas server-side.
//
// Sem `EVOLUTION_API_URL` configurada, a aba aparece DESABILITADA com
// instruções — nunca some da navegação, nunca 503 silencioso (é a
// armadilha "agendamento não dispara, sem erro" do AGENTS.md).
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Loader2,
  LogOut,
  Pencil,
  Plug,
  Plus,
  QrCode,
  RefreshCw,
  Smartphone,
  Trash2,
  Unplug,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RequireRole } from '@/components/auth/require-role';
import { useAuth } from '@/hooks/use-auth';
import { SettingsPanelHead } from './settings-panel-head';

// ------------------------------------------------------------
// Tipos — espelham o que as rotas /api/channels/evolution/instances
// devolvem (src/lib/evolution/instances.ts).
// ------------------------------------------------------------

interface InstanceSummary {
  id: string;
  channelId: string;
  name: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'error' | 'disabled';
  statusDetail: string | null;
  connectedPhone: string | null;
  connectedJid: string | null;
  isDefault: boolean;
  lastQrAt: string | null;
  createdAt: string;
}

interface LimitStatus {
  allowed: boolean;
  reason?: 'account_limit' | 'deployment_limit';
  accountLimit: number;
  accountCount: number;
  maxTotal: number;
  totalCount: number;
}

interface ListResponse {
  configured: boolean;
  instances: InstanceSummary[];
  limit: LimitStatus | null;
}

/** Consumo do teto de envio frio por instância (SPEC 049 §6.2, F6.1) —
 *  espelha o que `/api/channels/cold-send-limits` devolve em `instances`. */
interface ColdSendInstanceUsage {
  channelId: string;
  last24h: number;
  dailyLimit: number;
  warmingUp: boolean;
}

const QR_TTL_SECONDS = 60;
const STATUS_POLL_MS = 4000;

async function readError(res: Response, fallback: string): Promise<string> {
  const payload = await res.json().catch(() => ({}));
  return typeof payload?.error === 'string' ? payload.error : fallback;
}

export function WhatsappQrcodeConfig() {
  const t = useTranslations('Settings.whatsappQrcode');
  const { canEditSettings } = useAuth();

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<ListResponse | null>(null);
  const [coldSendUsage, setColdSendUsage] = useState<
    Record<string, ColdSendInstanceUsage>
  >({});
  const [createOpen, setCreateOpen] = useState(false);
  const [connectTarget, setConnectTarget] = useState<InstanceSummary | null>(
    null
  );
  const [editTarget, setEditTarget] = useState<InstanceSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<InstanceSummary | null>(
    null
  );
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/channels/evolution/instances', {
        cache: 'no-store',
      });
      if (!res.ok) {
        toast.error(await readError(res, t('loadFailed')));
        return;
      }
      setData((await res.json()) as ListResponse);
    } catch (err) {
      console.error('[WhatsappQrcodeConfig] load error:', err);
      toast.error(t('networkError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  // Consumo do teto de envio frio (SPEC 049 §6.2) — silencioso de
  // propósito em caso de falha: é um dado informativo, e uma rede
  // instável aqui não pode travar a tela de instâncias.
  const loadColdSendUsage = useCallback(async () => {
    try {
      const res = await fetch('/api/channels/cold-send-limits', {
        cache: 'no-store',
      });
      if (!res.ok) return;
      const payload = (await res.json()) as {
        instances?: ColdSendInstanceUsage[];
      };
      const byChannel: Record<string, ColdSendInstanceUsage> = {};
      for (const usage of payload.instances ?? []) {
        byChannel[usage.channelId] = usage;
      }
      setColdSendUsage(byChannel);
    } catch {
      // Silencioso — ver comentário acima.
    }
  }, []);

  useEffect(() => {
    void load();
    void loadColdSendUsage();
  }, [load, loadColdSendUsage]);

  async function runAction(
    instance: InstanceSummary,
    path: string,
    successMessage: string,
    errorFallback: string
  ) {
    setBusyId(instance.id);
    try {
      const res = await fetch(
        `/api/channels/evolution/instances/${instance.id}/${path}`,
        { method: 'POST' }
      );
      if (!res.ok) {
        toast.error(await readError(res, errorFallback));
        return;
      }
      toast.success(successMessage);
      await load();
    } catch (err) {
      console.error(`[WhatsappQrcodeConfig] ${path} error:`, err);
      toast.error(t('networkError'));
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  if (!data?.configured) {
    return (
      <section className="animate-in fade-in-50 space-y-6 duration-200">
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <QrCode className="text-muted-foreground size-8" />
            <p className="text-foreground text-sm font-medium">
              {t('notConfiguredTitle')}
            </p>
            <p className="text-muted-foreground max-w-md text-sm">
              {t('notConfiguredDesc')}
            </p>
            <pre className="bg-muted mt-2 max-w-full overflow-x-auto rounded-md px-3 py-2 text-left text-xs">
              {
                'EVOLUTION_API_URL=https://evo.seudominio.com.br\nEVOLUTION_GLOBAL_API_KEY=...'
              }
            </pre>
          </CardContent>
        </Card>
      </section>
    );
  }

  const { instances, limit } = data;

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          <RequireRole min="admin">
            <Button
              onClick={() => setCreateOpen(true)}
              disabled={limit ? !limit.allowed : false}
            >
              <Plus className="size-4" />
              {t('newInstance')}
            </Button>
          </RequireRole>
        }
      />

      <Alert
        variant="destructive"
        className="border-amber-500/40 bg-amber-500/10"
      >
        <AlertTriangle className="text-amber-400" />
        <AlertTitle>
          {t('riskBannerTitle')}
        </AlertTitle>
        <AlertDescription className="text-amber-100/80">
          {t('riskBannerBody')}
        </AlertDescription>
      </Alert>

      {limit && (
        <Card>
          <CardContent className="space-y-2 py-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-foreground font-medium">
                {t('usageLabel', {
                  used: limit.accountCount,
                  limit: limit.accountLimit,
                })}
              </span>
              {!limit.allowed && (
                <Badge className="border-border bg-muted text-muted-foreground text-[10px] tracking-wide uppercase">
                  {limit.reason === 'deployment_limit'
                    ? t('limitReasonDeployment')
                    : t('limitReasonAccount')}
                </Badge>
              )}
            </div>
            <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
              <div
                className="bg-primary h-full rounded-full transition-all"
                style={{
                  width: `${Math.min(100, (limit.accountCount / Math.max(1, limit.accountLimit)) * 100)}%`,
                }}
              />
            </div>
          </CardContent>
        </Card>
      )}

      {instances.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-10 text-center">
            <Smartphone className="text-muted-foreground size-6" />
            <p className="text-muted-foreground mt-2 text-sm">
              {t('noInstances')}
            </p>
            {canEditSettings ? (
              <p className="text-muted-foreground mt-1 text-xs">
                {t.rich('createOneHint', {
                  bold: (chunks: React.ReactNode) => (
                    <span className="text-foreground">{chunks}</span>
                  ),
                })}
              </p>
            ) : (
              <p className="text-muted-foreground mt-1 text-xs">
                {t('askAdminHint')}
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {instances.map((instance) => (
            <InstanceCard
              key={instance.id}
              instance={instance}
              coldSendUsage={coldSendUsage[instance.channelId]}
              busy={busyId === instance.id}
              onConnect={() => setConnectTarget(instance)}
              onEdit={() => setEditTarget(instance)}
              onDelete={() => setDeleteTarget(instance)}
              onDisconnect={() =>
                runAction(
                  instance,
                  'disconnect',
                  t('disconnectSuccess', { name: instance.name }),
                  t('disconnectError')
                )
              }
              onLogout={() =>
                runAction(
                  instance,
                  'logout',
                  t('logoutSuccess', { name: instance.name }),
                  t('logoutError')
                )
              }
              onReconnect={() =>
                runAction(
                  instance,
                  'reconnect',
                  t('reconnectSuccess', { name: instance.name }),
                  t('reconnectError')
                )
              }
            />
          ))}
        </div>
      )}

      <CreateInstanceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(instanceId, channelId) => {
          void load();
          setConnectTarget({
            id: instanceId,
            channelId,
            name: '',
            status: 'connecting',
            statusDetail: null,
            connectedPhone: null,
            connectedJid: null,
            isDefault: false,
            lastQrAt: null,
            createdAt: new Date().toISOString(),
          });
        }}
      />

      {connectTarget && (
        <ConnectDialog
          instance={connectTarget}
          onOpenChange={(open) => {
            if (!open) setConnectTarget(null);
          }}
          onConnected={() => {
            setConnectTarget(null);
            void load();
          }}
        />
      )}

      {editTarget && (
        <EditInstanceDialog
          instance={editTarget}
          onOpenChange={(open) => {
            if (!open) setEditTarget(null);
          }}
          onSaved={() => {
            setEditTarget(null);
            void load();
          }}
        />
      )}

      {deleteTarget && (
        <DeleteInstanceDialog
          instance={deleteTarget}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
          onDeleted={() => {
            setDeleteTarget(null);
            void load();
          }}
        />
      )}
    </section>
  );
}

// ------------------------------------------------------------
// Card de instância
// ------------------------------------------------------------

const STATUS_DOT: Record<InstanceSummary['status'], string> = {
  connected: 'bg-emerald-500',
  connecting: 'bg-amber-500',
  disconnected: 'bg-red-500',
  error: 'bg-red-500',
  disabled: 'bg-muted-foreground',
};

function InstanceCard({
  instance,
  coldSendUsage,
  busy,
  onConnect,
  onEdit,
  onDelete,
  onDisconnect,
  onLogout,
  onReconnect,
}: {
  instance: InstanceSummary;
  coldSendUsage?: ColdSendInstanceUsage;
  busy: boolean;
  onConnect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onDisconnect: () => void;
  onLogout: () => void;
  onReconnect: () => void;
}) {
  const t = useTranslations('Settings.whatsappQrcode');
  const isDisabled = instance.status === 'disabled';
  const isConnected = instance.status === 'connected';

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                className={`size-2 shrink-0 rounded-full ${STATUS_DOT[instance.status]}`}
              />
              <span className="text-foreground truncate text-sm font-medium">
                {instance.name}
              </span>
            </div>
            <p className="text-muted-foreground mt-1 text-xs">
              {t(`status.${instance.status}`)}
              {instance.statusDetail ? ` · ${instance.statusDetail}` : ''}
            </p>
            {instance.connectedPhone && (
              <p className="text-muted-foreground mt-0.5 font-mono text-xs">
                {instance.connectedPhone}
              </p>
            )}
            {coldSendUsage && (
              <p className="text-muted-foreground mt-1 text-xs">
                {t('coldSendUsageLabel', {
                  used: coldSendUsage.last24h,
                  limit: coldSendUsage.dailyLimit,
                })}
                {coldSendUsage.warmingUp && (
                  <Badge className="border-border bg-muted text-muted-foreground ml-1.5 text-[10px] tracking-wide uppercase">
                    {t('coldSendWarmingUp')}
                  </Badge>
                )}
              </p>
            )}
          </div>
        </div>

        {!isDisabled && (
          <RequireRole min="admin">
            <div className="flex flex-wrap gap-1.5">
              {!isConnected && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={onConnect}
                >
                  <QrCode className="size-3.5" />
                  {t('actionConnect')}
                </Button>
              )}
              {isConnected && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={onDisconnect}
                >
                  <Unplug className="size-3.5" />
                  {t('actionDisconnect')}
                </Button>
              )}
              {instance.status === 'disconnected' && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={onReconnect}
                >
                  <Plug className="size-3.5" />
                  {t('actionReconnect')}
                </Button>
              )}
              {(isConnected || instance.status === 'connecting') && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={onLogout}
                >
                  <LogOut className="size-3.5" />
                  {t('actionLogout')}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={onEdit}
              >
                <Pencil className="size-3.5" />
                {t('actionEdit')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={onDelete}
                className="border-red-500/40 bg-red-500/10 text-red-300 hover:border-red-500/60 hover:bg-red-500/20 hover:text-red-200"
              >
                <Trash2 className="size-3.5" />
                {t('actionDelete')}
              </Button>
            </div>
          </RequireRole>
        )}
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------
// Criar instância
// ------------------------------------------------------------

function CreateInstanceDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (instanceId: string, channelId: string) => void;
}) {
  const t = useTranslations('Settings.whatsappQrcode');
  const [label, setLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setLabel('');
    setSubmitting(false);
  }

  async function handleCreate() {
    const trimmed = label.trim();
    if (!trimmed) {
      toast.error(t('labelRequired'));
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/channels/evolution/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: trimmed }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(
          typeof payload?.error === 'string' ? payload.error : t('createError')
        );
        return;
      }
      toast.success(t('createSuccess', { name: trimmed }));
      if (payload.connectWarning) {
        toast.warning(t('connectWarning', { reason: payload.connectWarning }));
      }
      onCreated(payload.instanceId, payload.channelId);
      reset();
      onOpenChange(false);
    } catch (err) {
      console.error('[CreateInstanceDialog] create error:', err);
      toast.error(t('networkError'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="border-border bg-popover sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {t('newInstanceDialogTitle')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('newInstanceDialogDesc')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="qr-instance-label" className="text-muted-foreground">
            {t('labelLabel')}
          </Label>
          <Input
            id="qr-instance-label"
            value={label}
            maxLength={60}
            placeholder={t('labelPlaceholder')}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t('cancel')}
          </Button>
          <Button onClick={handleCreate} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('creating')}
              </>
            ) : (
              t('create')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------
// Conectar — QR + código de pareamento, com polling de status
// ------------------------------------------------------------

function ConnectDialog({
  instance,
  onOpenChange,
  onConnected,
}: {
  instance: InstanceSummary;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
}) {
  const t = useTranslations('Settings.whatsappQrcode');
  const [tab, setTab] = useState<'qr' | 'pair'>('qr');
  const [qrLoading, setQrLoading] = useState(true);
  const [qrError, setQrError] = useState<string | null>(null);
  const [qrcode, setQrcode] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(QR_TTL_SECONDS);
  const [phone, setPhone] = useState('');
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairSubmitting, setPairSubmitting] = useState(false);
  const connectedRef = useRef(false);

  const fetchQr = useCallback(async () => {
    setQrLoading(true);
    setQrError(null);
    setQrcode(null);
    try {
      const res = await fetch(
        `/api/channels/evolution/instances/${instance.id}/qr`,
        { cache: 'no-store' }
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setQrError(
          typeof payload?.error === 'string' ? payload.error : t('qrError')
        );
        return;
      }
      if (payload.alreadyConnected) {
        connectedRef.current = true;
        toast.success(t('qrAlreadyConnected'));
        onConnected();
        return;
      }
      setQrcode(payload.qrcode ?? null);
      setSecondsLeft(QR_TTL_SECONDS);
    } catch (err) {
      console.error('[ConnectDialog] qr error:', err);
      setQrError(t('networkError'));
    } finally {
      setQrLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance.id, t]);

  useEffect(() => {
    if (tab === 'qr') void fetchQr();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Contagem regressiva do QR (SPEC 048 §9.1 — ~60s, botão manual para
  // gerar outro em vez de refetch automático).
  useEffect(() => {
    if (tab !== 'qr' || !qrcode) return;
    const id = setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [tab, qrcode]);

  // Polling de status — rede de segurança (o evento CONNECTION do
  // webhook, quando a F4 chegar, fecha o diálogo mais rápido que isto).
  useEffect(() => {
    const id = setInterval(async () => {
      if (connectedRef.current) return;
      try {
        const res = await fetch(
          `/api/channels/evolution/instances/${instance.id}/status`,
          { cache: 'no-store' }
        );
        if (!res.ok) return;
        const payload = (await res.json()) as {
          connected: boolean;
          loggedIn: boolean;
        };
        if (payload.connected && payload.loggedIn) {
          connectedRef.current = true;
          toast.success(t('pairSuccess'));
          onConnected();
        }
      } catch {
        // Silencioso: é polling de segurança, não a fonte da verdade.
      }
    }, STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [instance.id, onConnected, t]);

  async function handlePair() {
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 10) {
      toast.error(t('pairPhoneInvalid'));
      return;
    }
    setPairSubmitting(true);
    setPairingCode(null);
    try {
      const res = await fetch(
        `/api/channels/evolution/instances/${instance.id}/pair`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: digits }),
        }
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(
          typeof payload?.error === 'string' ? payload.error : t('pairError')
        );
        return;
      }
      setPairingCode(payload.pairingCode ?? null);
    } catch (err) {
      console.error('[ConnectDialog] pair error:', err);
      toast.error(t('networkError'));
    } finally {
      setPairSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {t('connectDialogTitle')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('connectDialogDesc')}
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as 'qr' | 'pair')}>
          <TabsList className="w-full">
            <TabsTrigger value="qr">{t('qrTab')}</TabsTrigger>
            <TabsTrigger value="pair">{t('pairTab')}</TabsTrigger>
          </TabsList>

          <TabsContent value="qr" className="mt-4">
            <div className="flex flex-col items-center gap-3">
              {qrLoading && (
                <div className="flex h-56 w-56 items-center justify-center">
                  <Loader2 className="text-primary size-6 animate-spin" />
                </div>
              )}
              {!qrLoading && qrError && (
                <p className="text-destructive text-center text-sm">
                  {qrError}
                </p>
              )}
              {!qrLoading && !qrError && qrcode && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={qrcode}
                  alt={t('qrAlt')}
                  className="size-56 rounded-md border"
                />
              )}
              {!qrLoading && qrcode && (
                <p className="text-muted-foreground text-xs">
                  {secondsLeft > 0
                    ? t('qrExpiresIn', { seconds: secondsLeft })
                    : t('qrExpired')}
                </p>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void fetchQr()}
                disabled={qrLoading}
              >
                <RefreshCw className="size-3.5" />
                {t('generateNewQr')}
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="pair" className="mt-4">
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label
                  htmlFor="qr-pair-phone"
                  className="text-muted-foreground"
                >
                  {t('pairPhoneLabel')}
                </Label>
                <Input
                  id="qr-pair-phone"
                  value={phone}
                  placeholder={t('pairPhonePlaceholder')}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </div>
              <Button
                onClick={handlePair}
                disabled={pairSubmitting}
                className="w-full"
              >
                {pairSubmitting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Smartphone className="size-4" />
                )}
                {t('pairGenerateCode')}
              </Button>
              {pairingCode && (
                <div className="border-border rounded-md border p-3 text-center">
                  <p className="text-foreground font-mono text-2xl tracking-widest">
                    {pairingCode}
                  </p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {t('pairCodeHint')}
                  </p>
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t('close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------
// Editar — só o rótulo local (flags avançadas ficam para outra fase).
// ------------------------------------------------------------

function EditInstanceDialog({
  instance,
  onOpenChange,
  onSaved,
}: {
  instance: InstanceSummary;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const t = useTranslations('Settings.whatsappQrcode');
  const [label, setLabel] = useState(instance.name);
  const [submitting, setSubmitting] = useState(false);

  async function handleSave() {
    const trimmed = label.trim();
    if (!trimmed) {
      toast.error(t('labelRequired'));
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/channels/evolution/instances/${instance.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: trimmed }),
        }
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(
          typeof payload?.error === 'string' ? payload.error : t('editError')
        );
        return;
      }
      toast.success(t('editSuccess'));
      onSaved();
    } catch (err) {
      console.error('[EditInstanceDialog] save error:', err);
      toast.error(t('networkError'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {t('editDialogTitle')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="qr-edit-label" className="text-muted-foreground">
            {t('labelLabel')}
          </Label>
          <Input
            id="qr-edit-label"
            value={label}
            maxLength={60}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t('cancel')}
          </Button>
          <Button onClick={handleSave} disabled={submitting}>
            {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------
// Excluir — confirmação por digitação (padrão do projeto para ação
// destrutiva). O CANAL é preservado (status='disabled'); só a
// instância é apagada na VPS e no banco.
// ------------------------------------------------------------

function DeleteInstanceDialog({
  instance,
  onOpenChange,
  onDeleted,
}: {
  instance: InstanceSummary;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const t = useTranslations('Settings.whatsappQrcode');
  const [confirmText, setConfirmText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const canConfirm = confirmText.trim() === instance.name;

  async function handleDelete() {
    if (!canConfirm) return;
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/channels/evolution/instances/${instance.id}`,
        { method: 'DELETE' }
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(
          typeof payload?.error === 'string' ? payload.error : t('deleteError')
        );
        return;
      }
      toast.success(t('deleteSuccess', { name: instance.name }));
      onDeleted();
    } catch (err) {
      console.error('[DeleteInstanceDialog] delete error:', err);
      toast.error(t('networkError'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {t('deleteDialogTitle')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('deleteWarning')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="qr-delete-confirm" className="text-muted-foreground">
            {t.rich('deleteTypeToConfirm', {
              name: instance.name,
              bold: (chunks: React.ReactNode) => (
                <span className="text-foreground font-medium">{chunks}</span>
              ),
            })}
          </Label>
          <Input
            id="qr-delete-confirm"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={instance.name}
          />
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t('cancel')}
          </Button>
          <Button
            onClick={handleDelete}
            disabled={!canConfirm || submitting}
            className="bg-red-600 text-white hover:bg-red-700"
          >
            {submitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
            {t('actionDelete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
