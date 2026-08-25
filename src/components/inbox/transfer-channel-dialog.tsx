'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { QrCode, BadgeCheck, AlertTriangle, Loader2, Send } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { can } from '@/lib/channels/capabilities';
import { useAccountChannels } from '@/lib/channels/use-account-channels';
import { useTransferChannels } from '@/hooks/use-transfer-channels';
import { formatPhoneForDisplay } from '@/lib/phone/br';

interface TransferChannelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Conversa ATUAL — a rota resolve o contato e o canal de origem a partir dela. */
  sourceConversationId: string;
  contactId: string;
  currentChannelId: string;
  /**
   * Pré-seleciona este canal, pulando a escolha — usado pela ficha do
   * contato (§4.1, entrada secundária), onde o operador já clicou "falar
   * por este canal" num item específico.
   */
  initialChannelId?: string;
  /** A transferência deu certo — devolve o id da thread de DESTINO para o chamador navegar (§4.2). */
  onTransferred: (conversationId: string) => void;
}

/**
 * O diálogo único que os dois pontos de entrada da SPEC 056 abrem
 * (composer, na faixa de janela expirada; ficha do contato, por canal
 * sem thread ainda). Mostra as três coisas do §4.1 ANTES de qualquer
 * campo de texto: por qual número o contato vai receber, que a
 * conversa continua lá, e o aviso de risco quando o destino não tem
 * janela de 24h.
 */
export function TransferChannelDialog({
  open,
  onOpenChange,
  sourceConversationId,
  contactId,
  currentChannelId,
  initialChannelId,
  onTransferred,
}: TransferChannelDialogProps) {
  const t = useTranslations('Inbox.transferChannel');
  const accountChannels = useAccountChannels();
  const { evaluations, loading, refetch } = useTransferChannels(
    contactId,
    currentChannelId
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  // Selecionado ficou inelegível ENQUANTO o diálogo estava aberto (não
  // na abertura) — distinto de "nunca houve seleção", para não mostrar
  // o aviso antes do operador ter escolhido algo.
  const [selectionLost, setSelectionLost] = useState(false);

  const eligible = useMemo(
    () => evaluations.filter((e) => e.eligible),
    [evaluations]
  );
  const ineligible = useMemo(
    () => evaluations.filter((e) => !e.eligible),
    [evaluations]
  );

  // Ao abrir (só na TRANSIÇÃO fechado→aberto, via ref): pré-seleciona o
  // pedido pela ficha (se elegível), senão o primeiro elegível. Reseta o
  // rascunho — este diálogo não guarda estado entre uma transferência e
  // a próxima.
  //
  // Antes dependia de `eligible.length` (com eslint-disable) para não
  // reabrir a cada recálculo de `eligible` — mas contagem igual não
  // significa MEMBRO igual: se o canal A perde elegibilidade no mesmo
  // instante em que B ganha, o comprimento não muda e o efeito nunca
  // rodava de novo, deixando `selectedId` preso em A. O ref abaixo
  // resolve isso separando "a abertura" (que reseta tudo) de "o
  // conjunto elegível mudou com o diálogo já aberto" (tratado a seguir,
  // sem apagar o texto que o operador já digitou).
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!justOpened) return;
    setText('');
    setSelectionLost(false);
    // Releitura forçada — não confia no que `useTransferChannels` já
    // tinha calculado antes de o diálogo abrir (pode ter minutos/horas,
    // um canal pode ter caído nesse meio-tempo). Se a resposta mudar o
    // conjunto elegível, o segundo efeito abaixo corrige a seleção.
    refetch();
    const preferred =
      initialChannelId &&
      eligible.some((e) => e.channel.id === initialChannelId)
        ? initialChannelId
        : (eligible[0]?.channel.id ?? null);
    setSelectedId(preferred);
  }, [open, initialChannelId, eligible, refetch]);

  // Com o diálogo já aberto, o canal selecionado pode sair de `eligible`
  // (a janela dele fechou, a instância caiu). Nunca troca por outro
  // canal em silêncio — isso moveria o destino da mensagem sem o
  // operador perceber; em vez disso limpa a seleção e avisa, mantendo o
  // texto já digitado.
  useEffect(() => {
    if (!open || !selectedId) return;
    if (eligible.some((e) => e.channel.id === selectedId)) return;
    setSelectedId(null);
    setSelectionLost(true);
  }, [open, selectedId, eligible]);

  const selected = eligible.find((e) => e.channel.id === selectedId);
  // O aviso de risco (§4.1 ponto 3) é sobre o canal não falar com a
  // Meta — não sobre a direção da transferência.
  const selectedIsRisky = selected
    ? !can(selected.channel.type, 'sessionWindow24h')
    : false;

  const handleConfirm = async () => {
    if (!selected || !text.trim() || sending) return;
    setSending(true);
    try {
      const res = await fetch('/api/inbox/conversations/transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: sourceConversationId,
          channel_id: selected.channel.id,
          text: text.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(errorMessage(data.code, data.error, t));
        return;
      }
      toast.success(t('sent', { channel: selected.channel.name }));
      onOpenChange(false);
      onTransferred(data.conversation_id as string);
    } catch {
      toast.error(t('networkError'));
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>

        {/* A frase do D-2 — nunca "enviar sem transferir": a resposta do
            contato volta pelo número que enviou, então a conversa vai
            junto, sempre. */}
        <p className="text-muted-foreground text-xs">{t('explanation')}</p>

        {loading ? (
          <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('loadingChannels')}
          </div>
        ) : eligible.length === 0 ? (
          <p className="text-muted-foreground py-4 text-sm">
            {t('noEligibleChannel')}
          </p>
        ) : (
          <div className="space-y-1.5">
            {eligible.map(({ channel }) => {
              const row = accountChannels.byId.get(channel.id);
              const isSelected = channel.id === selectedId;
              return (
                <button
                  key={channel.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(channel.id);
                    setSelectionLost(false);
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                    isSelected
                      ? 'border-primary bg-primary/10'
                      : 'border-border hover:bg-muted'
                  )}
                >
                  {channel.type === 'whatsapp_qr' ? (
                    <QrCode className="text-muted-foreground h-4 w-4 shrink-0" />
                  ) : (
                    <BadgeCheck className="text-muted-foreground h-4 w-4 shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-foreground truncate font-medium">
                      {channel.name}
                    </p>
                    {row?.identifier && (
                      <p className="text-muted-foreground truncate text-xs">
                        {formatPhoneForDisplay(row.identifier)}
                      </p>
                    )}
                  </div>
                </button>
              );
            })}

            {/* D-3: mostra o QUE existe mas não serve agora, com o
                motivo — nunca some, porque a razão (janela fechada)
                pode deixar de valer no minuto seguinte. */}
            {ineligible
              .filter((e) => e.reason === 'session_window_closed')
              .map(({ channel }) => (
                <div
                  key={channel.id}
                  className="border-border flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-left text-sm opacity-60"
                >
                  <BadgeCheck className="text-muted-foreground h-4 w-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-foreground truncate font-medium">
                      {channel.name}
                    </p>
                    <p className="text-muted-foreground truncate text-xs">
                      {t('windowClosedHint')}
                    </p>
                  </div>
                </div>
              ))}
          </div>
        )}

        {/* O canal escolhido deixou de ser destino válido ENQUANTO o
            diálogo já estava aberto (janela fechou, instância caiu).
            Nunca troca por outro em silêncio — o operador escolhe de
            novo, com o texto que já digitou preservado. */}
        {selectionLost && !selected && (
          <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
            <p className="text-xs text-amber-400">
              {t('selectionBecameUnavailable')}
            </p>
          </div>
        )}

        {selected && selectedIsRisky && (
          <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
            <p className="text-xs text-amber-400">{t('riskWarning')}</p>
          </div>
        )}

        {/* Fica visível mesmo sem seleção válida (não só quando
            `selected`) — se não fosse, perder a seleção no meio do
            preenchimento (acima) apagaria o rascunho da tela junto,
            mesmo com o texto preservado em memória. */}
        {eligible.length > 0 && (
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('messagePlaceholder')}
            rows={3}
            autoFocus
            className="border-border bg-muted text-foreground placeholder-muted-foreground focus:border-primary/50 w-full resize-none rounded-xl border px-4 py-2.5 text-sm transition-colors outline-none"
          />
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            disabled={!selected || !text.trim() || sending}
            onClick={handleConfirm}
          >
            {sending ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Send className="mr-1 h-4 w-4" />
            )}
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function errorMessage(
  code: string | undefined,
  fallback: string | undefined,
  t: ReturnType<typeof useTranslations>
): string {
  switch (code) {
    case 'contact_opted_out':
      return t('errorOptedOut');
    case 'session_window_closed':
      return t('errorWindowClosed');
    case 'not_connected':
      return t('errorNotConnected');
    default:
      return fallback ?? t('errorGeneric');
  }
}
