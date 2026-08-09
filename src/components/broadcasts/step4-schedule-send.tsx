'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  ArrowLeft,
  CalendarClock,
  FlaskConical,
  Send,
  Loader2,
  ShieldAlert,
  Users,
  Save,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { QuotaMeter, exceedsQuota } from './quota-meter';
import { useMessagingLimit } from './messaging-limit-provider';
import { estimateAudience } from '@/lib/audience/estimate';
import type { AudienceConfig } from '@/lib/audience/estimate';
import { excludesOptedOut } from '@/lib/contacts/consent';
import {
  describeSendWindow,
  isWithinSendWindow,
  nextWindowOpening,
} from '@/lib/broadcasts/send-window';

/** O que o passo 4 devolve ao clicar em enviar/agendar (SPEC 044 §6.3). */
export interface SendOptions {
  /** ISO do agendamento. Ausente = enviar agora. */
  scheduledAt?: string;
  /** O usuário aceitou disparar fora da janela permitida. */
  windowOverride: boolean;
}

interface Step4Props {
  name: string;
  onNameChange: (name: string) => void;
  template: MessageTemplate;
  /** Variante B do teste A/B (§6.6). `null` = disparo comum. */
  variantTemplate?: MessageTemplate | null;
  /** Fatia da audiência sorteada para a variante A. */
  splitPercent?: number;
  audience: AudienceConfig;
  onSend: (options: SendOptions) => void;
  onSaveDraft?: () => void;
  onBack: () => void;
  isProcessing: boolean;
  progress: number;
}

/** `Date` → valor de um `<input type="datetime-local">` no fuso local. */
function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export function Step4ScheduleSend({
  name,
  onNameChange,
  template,
  variantTemplate = null,
  splitPercent = 50,
  audience,
  onSend,
  onSaveDraft,
  onBack,
  isProcessing,
  progress,
}: Step4Props) {
  const t = useTranslations('Broadcasts.wizard');
  const tAudience = useTranslations('Broadcasts.audience');
  const tAb = useTranslations('Broadcasts.wizard.abTest');
  const [showConfirm, setShowConfirm] = useState(false);
  const [estimatedReach, setEstimatedReach] = useState<number>(0);
  const [loadingReach, setLoadingReach] = useState(true);
  const { batchLimit, refresh: refreshQuota } = useMessagingLimit();

  // ── Agendamento (§6.3) ─────────────────────────────────────────
  const [mode, setMode] = useState<'now' | 'schedule'>('now');
  const [scheduledLocal, setScheduledLocal] = useState('');
  const [windowOverride, setWindowOverride] = useState(false);

  // O fuso é o do NAVEGADOR e vai junto na requisição: é nele que o
  // servidor (e depois o cron) avalia a janela. Sem enviá-lo, "20h"
  // seria interpretado no fuso do servidor.
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // A regra de opt-out é por categoria de template (§6.8): marketing
  // exclui quem pediu para sair, Utility/Authentication alcança. A
  // estimativa tem que usar a MESMA regra do envio, ou a tela promete um
  // alcance que o servidor não entrega.
  const optOutApplies = excludesOptedOut(template.category);

  // Mesma função que o passo 2 usa. Antes daqui havia uma segunda
  // implementação que ignorava `excludeTagIds` e `custom_field`, então
  // o usuário via um número na tela de audiência e outro na de
  // confirmação, sem nada explicando a diferença (SPEC 044 §7, item 3).
  useEffect(() => {
    let cancelled = false;
    async function calculateReach() {
      setLoadingReach(true);
      try {
        const supabase = createClient();
        const count = await estimateAudience(supabase, audience, {
          excludeOptedOut: optOutApplies,
          // Não depende da categoria do template (§6.4) — sempre true.
          excludeInvalidWhatsapp: true,
        });
        if (!cancelled) setEstimatedReach(count ?? 0);
      } finally {
        if (!cancelled) setLoadingReach(false);
      }
    }
    calculateReach();
    return () => {
      cancelled = true;
    };
  }, [audience, optOutApplies]);

  // A cota pode ter mudado entre o passo 2 e aqui — um colega pode ter
  // disparado nesse meio-tempo. Reconfere ao abrir a confirmação, que é
  // o último instante antes de queimar cota de verdade.
  async function handleOpenConfirm(open: boolean) {
    setShowConfirm(open);
    if (open) await refreshQuota();
  }

  const overQuota = exceedsQuota(estimatedReach, batchLimit);

  // Instante em que a mensagem vai SAIR — é ele que a janela julga, não
  // o momento do clique.
  const scheduledDate =
    mode === 'schedule' && scheduledLocal ? new Date(scheduledLocal) : null;
  const scheduleInvalid =
    mode === 'schedule' &&
    (!scheduledDate ||
      Number.isNaN(scheduledDate.getTime()) ||
      scheduledDate.getTime() - Date.now() < 60_000);

  const sendInstant = scheduledDate ?? new Date();
  const outsideWindow =
    !scheduleInvalid && !isWithinSendWindow(sendInstant, timeZone);
  const suggestedAt = outsideWindow
    ? nextWindowOpening(sendInstant, timeZone)
    : null;

  // O bloqueio é o padrão; o override é uma escolha explícita e
  // registrada na trilha (§6.8). Sem ele, botão desabilitado.
  const windowBlocks = outsideWindow && !windowOverride;

  // Divisão prevista do alcance (§6.6). É estimativa: quem sorteia é o
  // servidor, sobre a audiência resolvida na hora do disparo.
  const reachA = Math.round((estimatedReach * splitPercent) / 100);
  const reachB = estimatedReach - reachA;

  // Dois braços exigem pelo menos duas pessoas. O servidor recusa com
  // `ab_audience_too_small`; bloquear aqui evita a viagem.
  const abTooSmall = variantTemplate !== null && estimatedReach < 2;

  const canSubmit =
    Boolean(name.trim()) &&
    !isProcessing &&
    !overQuota &&
    !scheduleInvalid &&
    !windowBlocks &&
    !abTooSmall;

  function submit() {
    setShowConfirm(false);
    onSend({
      scheduledAt:
        mode === 'schedule' && scheduledDate
          ? scheduledDate.toISOString()
          : undefined,
      windowOverride: outsideWindow && windowOverride,
    });
  }

  const audienceLabel =
    audience.type === 'all'
      ? t('scheduleSend.audienceAll')
      : audience.type === 'tags'
        ? t('scheduleSend.audienceTags')
        : audience.type === 'csv'
          ? t('scheduleSend.audienceCsv')
          : audience.type === 'staged'
            ? t('scheduleSend.audienceStaged')
            : t('scheduleSend.audienceField');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-foreground text-lg font-semibold">
          {t('scheduleSend.title')}
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          {t('scheduleSend.subtitle')}
        </p>
      </div>

      {/* Broadcast Name */}
      <div>
        <label className="text-foreground mb-1.5 block text-sm font-medium">
          {t('scheduleSend.broadcastName')}
        </label>
        <Input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t('scheduleSend.broadcastNamePlaceholder')}
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {/* Summary Card */}
      <div className="border-border bg-card/50 space-y-3 rounded-xl border p-4">
        <p className="text-foreground text-sm font-medium">
          {t('scheduleSend.summary')}
        </p>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-muted-foreground text-xs">
              {t('scheduleSend.template')}
            </p>
            <p className="text-foreground">{template.name}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">
              {t('scheduleSend.audience')}
            </p>
            <p className="text-foreground">{audienceLabel}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">
              {t('scheduleSend.estimatedReach')}
            </p>
            <div className="flex items-center gap-1.5">
              {loadingReach ? (
                <Loader2 className="text-primary h-3 w-3 animate-spin" />
              ) : (
                <>
                  <Users className="text-primary h-3.5 w-3.5" />
                  <p className="text-foreground font-medium">
                    {estimatedReach.toLocaleString()}
                  </p>
                </>
              )}
            </div>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">
              {t('scheduleSend.language')}
            </p>
            <p className="text-foreground">{template.language ?? 'en_US'}</p>
          </div>
        </div>
      </div>

      {/* Teste A/B (§6.6): o que a audiência do card acima vira depois do
          sorteio. Sem esta linha, o usuário confirmaria "1 000 pessoas"
          e receberia duas campanhas de 500 sem aviso. */}
      {variantTemplate && (
        <div className="border-primary/20 bg-primary/5 space-y-2 rounded-xl border p-4">
          <p className="text-foreground flex items-center gap-1.5 text-sm font-medium">
            <FlaskConical className="text-primary h-4 w-4" />
            {tAb('summaryTitle')}
          </p>
          <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
            <div>
              <p className="text-muted-foreground text-xs">
                {tAb('variantLine', { variant: 'A' })}
              </p>
              <p className="text-foreground">
                {template.name} — {reachA.toLocaleString()}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">
                {tAb('variantLine', { variant: 'B' })}
              </p>
              <p className="text-foreground">
                {variantTemplate.name} — {reachB.toLocaleString()}
              </p>
            </div>
          </div>
          <p className="text-muted-foreground text-xs">{tAb('summaryHint')}</p>
          {abTooSmall && (
            <p className="text-xs text-red-400">{tAb('tooSmall')}</p>
          )}
        </div>
      )}

      {/* Nota de LGPD (§6.8). Aparece só quando a regra vale — num
          template Utility ela seria uma informação falsa. */}
      {optOutApplies && (
        <p className="text-muted-foreground text-xs">
          {tAudience('consent.excludedFromMarketing')}
        </p>
      )}

      <QuotaMeter selected={estimatedReach} compact />

      {/* ── Quando enviar (§6.3) ─────────────────────────────────── */}
      <div className="border-border bg-card/50 space-y-3 rounded-xl border p-4">
        <p className="text-foreground text-sm font-medium">
          {tAudience('schedule.title')}
        </p>

        <div className="flex flex-wrap gap-2">
          <Button
            variant={mode === 'now' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setMode('now')}
            disabled={isProcessing}
            className={
              mode === 'now'
                ? 'bg-primary text-primary-foreground'
                : 'border-border text-muted-foreground'
            }
          >
            <Send className="h-3.5 w-3.5" />
            {tAudience('schedule.now')}
          </Button>
          <Button
            variant={mode === 'schedule' ? 'default' : 'outline'}
            size="sm"
            onClick={() => {
              setMode('schedule');
              if (!scheduledLocal) {
                // Sugestão inicial: a próxima abertura da janela. Abrir o
                // campo vazio faria o usuário digitar um horário que
                // provavelmente seria recusado.
                setScheduledLocal(
                  toLocalInputValue(nextWindowOpening(new Date(), timeZone))
                );
              }
            }}
            disabled={isProcessing}
            className={
              mode === 'schedule'
                ? 'bg-primary text-primary-foreground'
                : 'border-border text-muted-foreground'
            }
          >
            <CalendarClock className="h-3.5 w-3.5" />
            {tAudience('schedule.later')}
          </Button>
        </div>

        {mode === 'schedule' && (
          <div className="space-y-1.5">
            <Input
              type="datetime-local"
              value={scheduledLocal}
              min={toLocalInputValue(new Date(Date.now() + 60_000))}
              onChange={(e) => setScheduledLocal(e.target.value)}
              disabled={isProcessing}
              className="border-border bg-muted text-foreground max-w-xs"
            />
            <p className="text-muted-foreground text-xs">
              {tAudience('schedule.timeZoneHint', { timeZone })}
            </p>
            {scheduleInvalid && (
              <p className="text-xs text-red-400">
                {tAudience('schedule.mustBeFuture')}
              </p>
            )}
          </div>
        )}

        <p className="text-muted-foreground text-xs">
          {tAudience('schedule.windowHint', { window: describeSendWindow() })}
        </p>

        {/* Fora da janela: bloqueia e oferece as duas saídas honestas —
            mover para o próximo horário permitido, ou assumir o risco. */}
        {outsideWindow && (
          <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
            <p className="flex items-center gap-1.5 text-xs text-amber-300">
              <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
              {tAudience('schedule.outsideWindow', {
                window: describeSendWindow(),
              })}
            </p>
            {suggestedAt && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setMode('schedule');
                  setScheduledLocal(toLocalInputValue(suggestedAt));
                  setWindowOverride(false);
                }}
                disabled={isProcessing}
                className="border-border text-muted-foreground"
              >
                <CalendarClock className="h-3.5 w-3.5" />
                {tAudience('schedule.moveToSuggested', {
                  when: suggestedAt.toLocaleString(),
                })}
              </Button>
            )}
            <label className="text-muted-foreground flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={windowOverride}
                onChange={(e) => setWindowOverride(e.target.checked)}
                disabled={isProcessing}
                className="mt-0.5"
              />
              <span>{tAudience('schedule.overrideLabel')}</span>
            </label>
          </div>
        )}
      </div>

      {/* Handshake de início. O envio em si roda no servidor (SPEC 044
          §6.1), então esta barra cobre só o "estamos registrando a
          campanha" — o progresso real aparece na tela de detalhe. */}
      {isProcessing && (
        <div className="border-primary/20 bg-primary/5 rounded-xl border p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="text-primary h-4 w-4 animate-spin" />
              <p className="text-foreground text-sm font-medium">
                {t('scheduleSend.starting')}
              </p>
            </div>
            <span className="text-primary text-xs font-medium">
              {progress}%
            </span>
          </div>
          <div className="bg-muted h-1.5 w-full rounded-full">
            <div
              className="bg-primary h-1.5 rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      <div className="border-border flex flex-wrap items-center justify-between gap-2 border-t pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          disabled={isProcessing}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>

        <div className="flex items-center gap-2">
          {onSaveDraft && (
            <Button
              variant="outline"
              onClick={onSaveDraft}
              disabled={!name.trim() || isProcessing}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {t('scheduleSend.saveDraft')}
            </Button>
          )}

          <Dialog open={showConfirm} onOpenChange={handleOpenConfirm}>
            <DialogTrigger
              render={
                <Button
                  disabled={!canSubmit}
                  title={
                    overQuota
                      ? tAudience('quota.blockedHint')
                      : windowBlocks
                        ? tAudience('schedule.blockedHint')
                        : undefined
                  }
                  className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                />
              }
            >
              {mode === 'schedule' ? (
                <CalendarClock className="h-4 w-4" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              {mode === 'schedule'
                ? tAudience('schedule.scheduleAction')
                : t('scheduleSend.sendNow')}
            </DialogTrigger>
            <DialogContent className="border-border bg-popover sm:max-w-md">
              <DialogHeader>
                <DialogTitle className="text-popover-foreground">
                  {t('scheduleSend.confirmTitle')}
                </DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  {t.rich('scheduleSend.confirmBody', {
                    count: estimatedReach.toLocaleString(),
                    template: template.name,
                    strong: (chunks) => (
                      <span className="text-popover-foreground font-medium">
                        {chunks}
                      </span>
                    ),
                  })}
                </DialogDescription>
              </DialogHeader>

              {/* O envio roda no servidor: vale dizer isso ANTES do
                  clique, porque muda o que o usuário precisa fazer
                  depois (nada — pode fechar a aba). */}
              <p className="text-muted-foreground text-xs">
                {mode === 'schedule'
                  ? tAudience('schedule.confirmScheduled', {
                      when: scheduledDate
                        ? scheduledDate.toLocaleString()
                        : '—',
                    })
                  : t('scheduleSend.serverSideHint')}
              </p>

              {/* Confirmar um teste A/B é confirmar DUAS campanhas. */}
              {variantTemplate && (
                <p className="border-primary/20 bg-primary/5 text-muted-foreground rounded-md border px-3 py-2 text-xs">
                  {tAb('confirmBody', {
                    templateA: template.name,
                    countA: reachA.toLocaleString(),
                    templateB: variantTemplate.name,
                    countB: reachB.toLocaleString(),
                  })}
                </p>
              )}

              {/* A cota é reconferida ao abrir este diálogo: um colega
                  pode ter disparado entre o passo 2 e agora. */}
              {overQuota && (
                <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                  {tAudience('quota.blockedHint')}
                </div>
              )}

              {/* Repetido aqui de propósito: quem marcou o override
                  precisa reencontrá-lo no último passo antes de
                  confirmar, não descobrir depois na trilha. */}
              {outsideWindow && windowOverride && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                  {tAudience('schedule.overrideConfirm', {
                    window: describeSendWindow(),
                  })}
                </div>
              )}

              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setShowConfirm(false)}
                  className="border-border text-muted-foreground"
                >
                  {t('cancel')}
                </Button>
                <Button
                  onClick={submit}
                  disabled={!canSubmit}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {mode === 'schedule' ? (
                    <CalendarClock className="h-4 w-4" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                  {mode === 'schedule'
                    ? tAudience('schedule.scheduleAction')
                    : t('scheduleSend.sendNow')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  );
}
