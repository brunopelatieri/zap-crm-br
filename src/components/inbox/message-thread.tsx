'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { useAccountMembers } from '@/hooks/use-account-members';
import { usePresence } from '@/hooks/use-presence';
import { PresenceDot } from '@/components/presence/presence-dot';
import { presenceLabel } from '@/lib/presence';
import { cn } from '@/lib/utils';
import { formatPhoneForDisplay } from '@/lib/phone/br';
import type {
  Conversation,
  Message,
  MessageReaction,
  Contact,
  ConversationStatus,
  MessageTemplate,
  InteractiveMessagePayload,
} from '@/types';
import {
  MessageSquare,
  ChevronDown,
  UserPlus,
  Check,
  Clock,
  ArrowLeft,
  RefreshCw,
  PanelRightOpen,
  PanelRightClose,
  AlertTriangle,
  QrCode,
  BadgeCheck,
} from 'lucide-react';
import { format, isToday, isYesterday } from 'date-fns';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { MessageBubble } from './message-bubble';
import { MediaLightbox, type LightboxItem } from './media-lightbox';
import { resolveMediaRef } from '@/lib/storage/media-url';
import {
  channelTypeOf,
  useAccountChannels,
} from '@/lib/channels/use-account-channels';
import { MessageActions } from './message-actions';
import {
  MessageComposer,
  CHAT_MEDIA_BUCKET,
  type SendMediaPayload,
} from './message-composer';
import { resolveSessionWindow } from '@/lib/channels/session-window';
import { deleteAccountMedia } from '@/lib/storage/upload-media';
import { TemplatePicker } from './template-picker';
import { AiThreadBanner } from './ai-thread-banner';
import { buildReplyPreview } from './reply-quote';
import { toast } from 'sonner';

interface ReplyDraft {
  id: string;
  authorLabel: string;
  preview: string;
}

function renderTemplateBody(body: string, params: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, raw) => {
    const idx = Number(raw) - 1;
    return params[idx] ?? `{{${raw}}}`;
  });
}

interface MessageThreadProps {
  conversation: Conversation | null;
  contact: Contact | null;
  messages: Message[];
  onMessagesLoaded: (messages: Message[]) => void;
  onNewMessage: (message: Message) => void;
  onUpdateMessage: (id: string, updates: Partial<Message>) => void;
  onStatusChange: (conversationId: string, status: ConversationStatus) => void;
  onAssignChange: (
    conversationId: string,
    assignedAgentId: string | null
  ) => void;
  /**
   * On mobile, the thread is shown full-screen with the conversation list
   * hidden. This callback lets the page deselect the active conversation
   * and reveal the list again. Rendered as a back-arrow in the header on
   * mobile only.
   */
  onBack?: () => void;
  /**
   * Increment to force the messages + reactions fetch effects to refire.
   * Parent bumps this on realtime reconnect / tab visibility → visible
   * so the open thread catches up on any events sent while the WS was
   * disconnected or the tab was throttled. Optional so existing callers
   * keep working.
   */
  resyncToken?: number;
  /**
   * Fired by the manual-refresh button in the thread header. The parent
   * typically bumps the same `resyncToken` it controls — this gives the
   * user a way to force a refetch when they suspect realtime missed an
   * event (or they're impatient). Optional so existing callers keep
   * working; the button is only rendered when this is provided.
   */
  onRefresh?: () => void;
  /**
   * Desktop-only contact-panel toggle. The page owns the open/closed
   * state (it's the one that renders the sidebar), so the thread just
   * reflects it and asks the page to flip it. Both optional so existing
   * callers keep working; the toggle button only renders when
   * `onToggleContactPanel` is wired up.
   */
  contactPanelOpen?: boolean;
  onToggleContactPanel?: () => void;
}

function formatDateSeparator(
  dateStr: string,
  t: ReturnType<typeof useTranslations>
): string {
  const date = new Date(dateStr);
  if (isToday(date)) return t('today');
  if (isYesterday(date)) return t('yesterday');
  return format(date, 'MMMM d, yyyy');
}

function groupMessagesByDate(messages: Message[]) {
  const groups: { date: string; messages: Message[] }[] = [];
  let currentDate = '';

  for (const msg of messages) {
    const day = format(new Date(msg.created_at), 'yyyy-MM-dd');
    if (day !== currentDate) {
      currentDate = day;
      groups.push({ date: msg.created_at, messages: [msg] });
    } else {
      groups[groups.length - 1].messages.push(msg);
    }
  }

  return groups;
}

const STATUS_OPTIONS: {
  label: string;
  value: ConversationStatus;
  color: string;
}[] = [
  { label: 'Open', value: 'open', color: 'text-primary' },
  { label: 'Pending', value: 'pending', color: 'text-amber-400' },
  { label: 'Closed', value: 'closed', color: 'text-muted-foreground' },
];

/**
 * WhatsApp-style doodle background applied to the chat area (both the
 * active thread and the empty state). The SVG tile lives at
 * `/public/inbox-doodle.svg`; the slate-950 colour sits underneath so
 * the doodles read as a subtle pattern rather than a stark grid.
 *
 * Defined once at module scope so the two render paths can't drift —
 * if we ever switch the asset, both spots update together.
 */
const DOODLE_BG_CLASSES =
  "bg-background bg-[url('/inbox-doodle.svg')] bg-repeat";

export function MessageThread({
  conversation,
  contact,
  messages,
  onMessagesLoaded,
  onNewMessage,
  onUpdateMessage,
  onStatusChange,
  onAssignChange,
  onBack,
  resyncToken = 0,
  onRefresh,
  contactPanelOpen,
  onToggleContactPanel,
}: MessageThreadProps) {
  const t = useTranslations('Inbox.messageThread');
  const tTimer = useTranslations('Inbox.sessionTimer');
  const tQuote = useTranslations('Inbox.replyQuote');
  const tBubble = useTranslations('Inbox.bubble');

  const { user } = useAuth();
  // Admin/owner podem mover uma conversa para QUALQUER colega; um
  // agente comum só pode reivindicar para si (a lista fica restrita a
  // "eu mesmo") ou devolver à fila — espelha exatamente o gate do RPC
  // `reassign_conversation` (`ONLY_ADMIN_CAN_REASSIGN_TO_OTHERS`), só
  // que aqui evita renderizar uma opção que o servidor recusaria.
  const canReassignToOthers = useCan('reassign-conversation');
  // Só quem PODE mandar mensagem corre o risco de assumir uma conversa
  // sem querer (F-07 da SPEC original: o primeiro envio reivindica a
  // conversa automaticamente) — usado pelo aviso de "está vendo a
  // carteira de outro agente" logo abaixo (SPEC 042, D7 §5).
  const canSend = useCan('send-messages');
  const { getPresence, getRow, now } = usePresence();
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const { members: profiles } = useAccountMembers();
  const [reactions, setReactions] = useState<MessageReaction[]>([]);
  // Purely visual spin state for the manual-refresh button. The actual
  // refetch is fire-and-forget through `onRefresh` (which bumps the
  // parent's resyncToken); the 700ms spin is just feedback so the click
  // doesn't feel like a no-op. Cleared via the timer ref on unmount.
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);
  const handleRefreshClick = useCallback(() => {
    if (isRefreshing || !onRefresh) return;
    setIsRefreshing(true);
    onRefresh();
    refreshTimerRef.current = setTimeout(() => {
      setIsRefreshing(false);
      refreshTimerRef.current = null;
    }, 700);
  }, [isRefreshing, onRefresh]);
  const [replyTo, setReplyTo] = useState<ReplyDraft | null>(null);
  const accountChannels = useAccountChannels();

  // 24-hour session timer (SPEC 045 §5.1/§5.9). `computeSessionWindow`
  // is the single source of truth shared with the server-side guard in
  // the automations engine — no more local truncated-hours math here.
  //
  // While the thread is still loading, `messages` is empty and there's
  // no last-customer-message to find; that resolves to `null`, which
  // `computeSessionWindow` treats as CLOSED. That's the safe default
  // for "don't know yet" — the previous local calculation defaulted to
  // OPEN here, letting an agent type and send free-form text before the
  // real state loaded, only to get a 400 from Meta.
  const sessionInfo = useMemo(() => {
    const lastCustomerMsg = [...messages]
      .reverse()
      .find((m) => m.sender_type === 'customer');

    // PRD 047 §7.1.1. Num canal sem janela (instância QRCode), `applicable`
    // vem `false` e a faixa some inteira — nem aberta, nem fechada.
    // Mostrar "expirada" numa thread que não tem janela seria alarme
    // falso sobre uma regra que não existe ali; mostrar contagem
    // regressiva seria inventar um prazo.
    //
    // O tipo vem de `useAccountChannels`, e NÃO de `conversation.channel`:
    // o `CONVERSATION_SELECT` não faz embed de `channels`, então aquele
    // campo chega sempre indefinido. Lendo só dele, toda thread caía no
    // padrão `whatsapp_cloud` e uma conversa do QRCode exibia
    // "23h restantes" — um prazo que não existe naquele canal
    // (PRD 047 §7.1.1). O `conversation.channel` continua tendo
    // precedência para quem um dia hidratar de verdade.
    const { applicable, isOpen, minutesRemaining } = resolveSessionWindow(
      conversation?.channel?.type ??
        channelTypeOf(accountChannels, conversation?.channel_id),
      lastCustomerMsg ? new Date(lastCustomerMsg.created_at) : null
    );

    if (!applicable) {
      return { hidden: true, expired: false, remaining: '' };
    }

    if (!isOpen) {
      return { hidden: false, expired: true, remaining: tTimer('expired') };
    }

    const remaining =
      minutesRemaining >= 60
        ? tTimer('xhRemaining', { hours: Math.floor(minutesRemaining / 60) })
        : tTimer('xmRemaining', { minutes: minutesRemaining });

    return { hidden: false, expired: false, remaining };
  }, [
    messages,
    tTimer,
    conversation?.channel?.type,
    conversation?.channel_id,
    accountChannels,
  ]);

  // Selo de canal no cabeçalho (SPEC 049 §4.2). A lista já mostra o
  // selo por linha (F4.5); falta o cabeçalho da thread pelo mesmo
  // motivo do timer acima: um agente que abriu a conversa por link
  // direto (`?c=`) não passou pela lista e não viu selo nenhum. Mesmo
  // gate `count > 1` — numa conta de canal único é ruído puro.
  const threadChannel = conversation?.channel_id
    ? accountChannels.byId.get(conversation.channel_id)
    : undefined;
  const showChannelBadge = accountChannels.count > 1 && !!threadChannel;

  // Tipo do canal desta thread — mesma leitura de `sessionInfo` acima
  // (channelTypeOf sobre `useAccountChannels`, nunca `conversation.channel`,
  // que não é hidratado por `CONVERSATION_SELECT`). Alimenta o composer
  // (SPEC 049 §4.3): a matriz de capacidades decide o que ele oferece.
  const threadChannelType =
    conversation?.channel?.type ??
    channelTypeOf(accountChannels, conversation?.channel_id);

  // Store latest callback in a ref so fetchMessages doesn't need to
  // depend on `onMessagesLoaded` — otherwise parent re-renders cause
  // fetchMessages to change → useEffect re-fires → refetch → realtime
  // UPDATE on conversations.unread_count → parent re-renders → LOOP.
  // The ref is written inside an effect so the mutation doesn't happen
  // during render (React 19 refs rule); consumers only read `.current`
  // inside the async fetch completion, which runs after the render.
  const onMessagesLoadedRef = useRef(onMessagesLoaded);
  useEffect(() => {
    onMessagesLoadedRef.current = onMessagesLoaded;
  });

  const conversationId = conversation?.id;
  const hasUnread = (conversation?.unread_count ?? 0) > 0;

  // Fetch messages whenever the selected conversation changes. Kept
  // separate from the unread-reset effect so that incoming messages
  // arriving while the thread is open don't trigger a full refetch —
  // they only flip hasUnread, which only the reset effect listens to.
  useEffect(() => {
    if (!conversationId) return;

    const supabase = createClient();
    let cancelled = false;

    (async () => {
      setLoading(true);

      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true });

      if (cancelled) return;

      if (error) {
        console.error('Failed to fetch messages:', error);
      } else {
        onMessagesLoadedRef.current(data ?? []);
      }

      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus —
    // realtime is best-effort and any message events sent while the WS
    // was disconnected or throttled are otherwise lost.
  }, [conversationId, resyncToken]);

  // Reactions fetch — pulls the current state from the DB. Kept separate
  // from the channel subscription below so a `resyncToken` bump just
  // refetches the rows without also tearing down and rebuilding the
  // realtime channel.
  useEffect(() => {
    if (!conversationId) {
      setReactions([]);
      return;
    }
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from('message_reactions')
        .select('*')
        .eq('conversation_id', conversationId);
      if (cancelled) return;
      if (error) {
        console.error('Failed to fetch reactions:', error);
        return;
      }
      setReactions((data as MessageReaction[]) ?? []);
    })();

    return () => {
      cancelled = true;
    };
  }, [conversationId, resyncToken]);

  // Reactions realtime subscription per conversation. Subscribing here
  // (not at the page level) keeps the channel scoped to the visible
  // conversation and avoids cross-conversation chatter on a busy inbox.
  useEffect(() => {
    if (!conversationId) return;
    const supabase = createClient();

    const channel = supabase
      .channel(`reactions:${conversationId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'message_reactions',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const row = payload.new as MessageReaction;
          setReactions((prev) => {
            if (prev.some((r) => r.id === row.id)) return prev;
            // Swap any matching optimistic temp row for the real one so
            // the pill doesn't double up after a successful POST.
            const tempIdx = prev.findIndex(
              (r) =>
                r.id.startsWith('temp-') &&
                r.message_id === row.message_id &&
                r.actor_type === row.actor_type &&
                r.actor_id === row.actor_id
            );
            if (tempIdx >= 0) {
              const copy = prev.slice();
              copy[tempIdx] = row;
              return copy;
            }
            return [...prev, row];
          });
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'message_reactions',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const row = payload.new as MessageReaction;
          setReactions((prev) => prev.map((r) => (r.id === row.id ? row : r)));
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'message_reactions',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const old = payload.old as Partial<MessageReaction>;
          if (!old?.id) return;
          setReactions((prev) => prev.filter((r) => r.id !== old.id));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [conversationId]);

  // Clear any in-progress reply draft when the active conversation changes —
  // a quote pulled from conversation A shouldn't bleed into conversation B.
  useEffect(() => {
    setReplyTo(null);
  }, [conversationId]);

  // Reset the server-side unread_count to 0 whenever an unread count
  // surfaces on the active conversation — covers both (a) opening a
  // conversation that had unread messages and (b) new messages arriving
  // while the user is already viewing the thread (webhook server-bumps
  // unread_count to N+1; the realtime UPDATE propagates it into the
  // client, which re-runs this effect and flips it back to 0).
  //
  // Guarding on hasUnread prevents the eq-update loop: once unread_count
  // is 0 the condition is false, so no further UPDATE is issued.
  useEffect(() => {
    if (!conversationId || !hasUnread) return;
    const supabase = createClient();
    supabase
      .from('conversations')
      .update({ unread_count: 0 })
      .eq('id', conversationId)
      // `.select()` não é decorativo: sem ele, uma recusa silenciosa da
      // RLS (ex.: a conversa acabou de ser reatribuída para outro
      // agente entre o render e este UPDATE) volta como SUCESSO com 0
      // linhas afetadas — indistinguível de "atualizei". Sem checar
      // `data`, `hasUnread` nunca zeraria no servidor e este efeito
      // reexecutaria a cada render, num loop de UPDATE.
      .select('id')
      .then(({ data, error }) => {
        if (error) {
          console.error('Failed to reset unread_count:', error);
        } else if (!data || data.length === 0) {
          console.warn(
            '[message-thread] unread_count reset affected 0 rows — the conversation may have been reassigned away',
            { conversationId }
          );
        }
      });
  }, [conversationId, hasUnread]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      const el = scrollRef.current;
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const handleSend = useCallback(
    async (text: string, replyToId?: string) => {
      if (!conversation) return;

      const tempId = `temp-${Date.now()}`;

      // Optimistic update — shows the message immediately with "sending" status
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: 'agent',
        content_type: 'text',
        content_text: text,
        status: 'sending',
        created_at: new Date().toISOString(),
        reply_to_message_id: replyToId,
      };
      onNewMessage(optimisticMsg);
      setReplyTo(null);

      try {
        const res = await fetch('/api/whatsapp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: 'text',
            content_text: text,
            reply_to_message_id: replyToId,
          }),
        });

        const payload = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = payload?.error || `HTTP ${res.status}`;
          console.error('Failed to send message:', reason);
          toast.error(`Failed to send: ${reason}`);
          // Mark the optimistic bubble as failed so the user sees what happened
          onUpdateMessage(tempId, { status: 'failed' });
          return;
        }

        // Success — the realtime INSERT event will replace the temp bubble
        // with the real DB row. If realtime hasn't arrived yet, at least
        // flip status to 'sent' so the UI stops showing "sending".
        onUpdateMessage(tempId, { status: 'sent' });
      } catch (err) {
        console.error('Failed to send message:', err);
        const reason = err instanceof Error ? err.message : 'network error';
        toast.error(`Failed to send: ${reason}`);
        onUpdateMessage(tempId, { status: 'failed' });
      }
    },
    [conversation, onNewMessage, onUpdateMessage]
  );

  const handleSendMedia = useCallback(
    async (payload: SendMediaPayload) => {
      if (!conversation) return;

      // Documents show their filename in our own bubble (and to the
      // recipient as the Meta caption when no caption was typed); other
      // kinds use the caption as-is. Audio carries no caption.
      const contentText =
        payload.kind === 'document'
          ? payload.caption || payload.filename || 'Document'
          : payload.caption;

      const tempId = `temp-${Date.now()}`;
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: 'agent',
        content_type: payload.kind,
        content_text: contentText,
        media_url: payload.mediaUrl,
        // O caminho no bucket acompanha a mensagem otimista para que a
        // bolha já resolva a mídia pelo mesmo caminho que usará quando o
        // servidor devolver a linha real — sem isto, a pré-visualização
        // dependeria da URL pública, que deixou de funcionar quando o
        // bucket virou privado (migração 040).
        media_path: payload.path,
        status: 'sending',
        created_at: new Date().toISOString(),
        reply_to_message_id: payload.replyToId,
      };
      onNewMessage(optimisticMsg);
      setReplyTo(null);

      try {
        const res = await fetch('/api/whatsapp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: payload.kind,
            media_url: payload.mediaUrl,
            media_path: payload.path,
            content_text: contentText,
            filename: payload.filename,
            reply_to_message_id: payload.replyToId,
          }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = data?.error || `HTTP ${res.status}`;
          console.error('Failed to send media:', reason);
          toast.error(`Failed to send: ${reason}`);
          onUpdateMessage(tempId, { status: 'failed' });
          // The upload never reached the recipient — GC the orphaned
          // object rather than leaving it in the public bucket forever.
          void deleteAccountMedia(CHAT_MEDIA_BUCKET, payload.path).catch(
            () => {}
          );
          return;
        }

        onUpdateMessage(tempId, { status: 'sent' });
      } catch (err) {
        console.error('Failed to send media:', err);
        const reason = err instanceof Error ? err.message : 'network error';
        toast.error(`Failed to send: ${reason}`);
        onUpdateMessage(tempId, { status: 'failed' });
        void deleteAccountMedia(CHAT_MEDIA_BUCKET, payload.path).catch(
          () => {}
        );
      }
    },
    [conversation, onNewMessage, onUpdateMessage]
  );

  const handleSendInteractive = useCallback(
    async (payload: InteractiveMessagePayload, replyToId?: string) => {
      if (!conversation) return;

      const tempId = `temp-${Date.now()}`;
      // Optimistic bubble — renders the buttons/list immediately via the
      // interactive_payload, same as the persisted row will.
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: 'agent',
        content_type: 'interactive',
        content_text: payload.body,
        interactive_payload: payload,
        status: 'sending',
        created_at: new Date().toISOString(),
        reply_to_message_id: replyToId,
      };
      onNewMessage(optimisticMsg);

      try {
        const res = await fetch('/api/whatsapp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: 'interactive',
            interactive_payload: payload,
            reply_to_message_id: replyToId,
          }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = data?.error || `HTTP ${res.status}`;
          console.error('Failed to send interactive message:', reason);
          toast.error(`Failed to send: ${reason}`);
          onUpdateMessage(tempId, { status: 'failed' });
          return;
        }

        onUpdateMessage(tempId, { status: 'sent' });
      } catch (err) {
        console.error('Failed to send interactive message:', err);
        const reason = err instanceof Error ? err.message : 'network error';
        toast.error(`Failed to send: ${reason}`);
        onUpdateMessage(tempId, { status: 'failed' });
      }
    },
    [conversation, onNewMessage, onUpdateMessage]
  );

  const handleStatusChange = useCallback(
    async (status: ConversationStatus) => {
      if (!conversation) return;

      const supabase = createClient();
      const { data, error } = await supabase
        .from('conversations')
        .update({ status })
        // `.select()` para acusar uma recusa silenciosa da RLS — sem
        // ele, 0 linhas afetadas volta como sucesso e a UI mentiria
        // (`onStatusChange` seria chamado mesmo sem nada ter mudado).
        .select('id')
        .eq('id', conversation.id);

      if (error) {
        console.error('Failed to update status:', error);
        toast.error(t('statusUpdateFailed'));
        return;
      }
      if (!data || data.length === 0) {
        toast.error(t('statusUpdateFailed'));
        return;
      }

      onStatusChange(conversation.id, status);
    },
    [conversation, onStatusChange, t]
  );

  const handleOpenTemplates = useCallback(() => {
    setTemplateModalOpen(true);
  }, []);

  const handleSendTemplate = useCallback(
    async (
      template: MessageTemplate,
      values: {
        body: string[];
        headerText?: string;
        buttonParams?: Record<number, string>;
      }
    ) => {
      if (!conversation) return;

      const renderedBody = renderTemplateBody(template.body_text, values.body);
      const tempId = `temp-${Date.now()}`;

      // Optimistic bubble — renders header/body/footer/buttons immediately
      // via template_preview, same as the persisted row will (mirrors how
      // handleSendInteractive pre-fills interactive_payload above).
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: 'agent',
        content_type: 'template',
        content_text: renderedBody,
        template_name: template.name,
        template_preview: {
          header:
            template.header_type === 'text' && template.header_content
              ? renderTemplateBody(
                  template.header_content,
                  values.headerText ? [values.headerText] : []
                )
              : undefined,
          headerMedia:
            (template.header_type === 'image' ||
              template.header_type === 'video' ||
              template.header_type === 'document') &&
            template.header_media_url
              ? { type: template.header_type, url: template.header_media_url }
              : undefined,
          body: renderedBody,
          footer: template.footer_text,
          buttons: template.buttons,
        },
        status: 'sending',
        created_at: new Date().toISOString(),
      };
      onNewMessage(optimisticMsg);

      try {
        const res = await fetch('/api/whatsapp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: 'template',
            template_name: template.name,
            template_language: template.language,
            // Structured params drive the new send-builder path
            // (header media + URL button substitution). Body values
            // are mirrored under both shapes so the route can fall
            // back if the template row isn't found locally.
            template_message_params: {
              body: values.body,
              headerText: values.headerText,
              buttonParams: values.buttonParams,
            },
            template_params: values.body,
            content_text: renderedBody,
          }),
        });

        const payload = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = payload?.error || `HTTP ${res.status}`;
          console.error('Failed to send template:', reason);
          toast.error(`Failed to send template: ${reason}`);
          onUpdateMessage(tempId, { status: 'failed' });
          return;
        }

        onUpdateMessage(tempId, { status: 'sent' });
      } catch (err) {
        console.error('Failed to send template:', err);
        const reason = err instanceof Error ? err.message : 'network error';
        toast.error(`Failed to send template: ${reason}`);
        onUpdateMessage(tempId, { status: 'failed' });
      }
    },
    [conversation, onNewMessage, onUpdateMessage]
  );

  // Build a quick id → Message map so reply quotes can be rendered without
  // an extra fetch — the thread already holds the full conversation.
  const messagesById = useMemo(() => {
    const map = new Map<string, Message>();
    for (const m of messages) map.set(m.id, m);
    return map;
  }, [messages]);

  // ------------------------------------------------------------------
  // Lightbox — mídia (imagem/vídeo) de toda a conversa, não só a
  // mensagem clicada. Guarda o id da mensagem em vez do índice: novas
  // mensagens chegando via realtime mudariam a posição no array, e um
  // índice preso ficaria apontando pra mídia errada.
  // ------------------------------------------------------------------
  const lightboxItems = useMemo<LightboxItem[]>(
    () =>
      messages
        .filter(
          (m) =>
            (m.content_type === 'image' || m.content_type === 'video') &&
            // NÃO é `!!m.media_url`: o canal WhatsApp QRCode preenche só
            // `media_path` (SPEC 048 §6.5), e filtrar pela URL deixava
            // toda imagem recebida por ele FORA da galeria — a bolha
            // renderizava, o clique para ampliar não fazia nada.
            resolveMediaRef(m.media_url, m.media_path).kind !== 'none'
        )
        .map((m) => ({
          id: m.id,
          type: m.content_type as 'image' | 'video',
          url: m.media_url ?? null,
          path: m.media_path ?? null,
          caption: m.content_text ?? null,
          downloadable: m.sender_type === 'customer',
        })),
    [messages]
  );
  const [lightboxMessageId, setLightboxMessageId] = useState<string | null>(
    null
  );
  const lightboxIndex = lightboxMessageId
    ? lightboxItems.findIndex((item) => item.id === lightboxMessageId)
    : -1;
  const openLightbox = useCallback((messageId: string) => {
    setLightboxMessageId(messageId);
  }, []);
  const closeLightbox = useCallback(() => setLightboxMessageId(null), []);
  const navigateLightbox = useCallback(
    (nextIndex: number) => {
      const item = lightboxItems[nextIndex];
      if (item) setLightboxMessageId(item.id);
    },
    [lightboxItems]
  );

  // Bucket reactions by their target message_id for O(1) per-bubble lookup.
  const reactionsByMessageId = useMemo(() => {
    const map = new Map<string, MessageReaction[]>();
    for (const r of reactions) {
      const bucket = map.get(r.message_id);
      if (bucket) bucket.push(r);
      else map.set(r.message_id, [r]);
    }
    return map;
  }, [reactions]);

  const contactDisplayName = contact?.name || contact?.phone || 'Customer';

  // Author label for a quoted message: "You" when we sent the parent,
  // contact name when the customer sent it.
  const authorLabelFor = useCallback(
    (m: Message): string => {
      const isAgentMsg = m.sender_type === 'agent' || m.sender_type === 'bot';
      return isAgentMsg ? 'You' : contactDisplayName;
    },
    [contactDisplayName]
  );

  // Name shown atop each bubble: for agent sends, the conversation's
  // assigned agent (not "you", regardless of who is signed in — the
  // conversation ownership is what identifies the sender to the
  // customer), the automation label for bot sends, or the contact's
  // name for inbound messages.
  const senderNameFor = useCallback(
    (m: Message): string => {
      if (m.sender_type === 'bot') return tBubble('bot');
      if (m.sender_type === 'agent') {
        const assigned = profiles.find(
          (p) => p.user_id === conversation?.assigned_agent_id
        );
        if (assigned?.full_name) return assigned.full_name;
        const sender = profiles.find((p) => p.user_id === m.sender_id);
        return sender?.full_name || t('assigned');
      }
      return contactDisplayName || tBubble('customerFallback');
    },
    [profiles, conversation?.assigned_agent_id, contactDisplayName, tBubble, t]
  );

  const handleStartReply = useCallback(
    (msg: Message) => {
      setReplyTo({
        id: msg.id,
        authorLabel: authorLabelFor(msg),
        preview: buildReplyPreview(msg, tQuote),
      });
    },
    [authorLabelFor]
  );

  // Single reaction-set primitive. emoji === "" removes; otherwise adds/swaps.
  // The "toggle" semantic (pill click) is computed at the call site where the
  // current reactions for the bubble are already in scope — keeps this
  // function dependency-free w.r.t. the reaction list.
  const postReaction = useCallback(
    async (messageId: string, emoji: string) => {
      if (!user?.id || !conversation) {
        console.warn('[reactions] missing user or conversation');
        return;
      }
      if (messageId.startsWith('temp-')) {
        toast.error('Wait for the message to finish sending');
        return;
      }

      const convId = conversation.id;
      const userId = user.id;
      let snapshot: MessageReaction[] = [];

      // Functional updater — captures the freshest reactions list, never a
      // stale closure. Snapshot stored for rollback on POST failure.
      setReactions((prev) => {
        snapshot = prev;
        const own = prev.find(
          (r) =>
            r.message_id === messageId &&
            r.actor_type === 'agent' &&
            r.actor_id === userId
        );
        if (emoji === '') return own ? prev.filter((r) => r !== own) : prev;
        if (own) return prev.map((r) => (r === own ? { ...own, emoji } : r));
        return [
          ...prev,
          {
            id: `temp-${Date.now()}`,
            message_id: messageId,
            conversation_id: convId,
            actor_type: 'agent',
            actor_id: userId,
            emoji,
            created_at: new Date().toISOString(),
          },
        ];
      });

      try {
        const res = await fetch('/api/whatsapp/react', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message_id: messageId, emoji }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload?.error || `HTTP ${res.status}`);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'network error';
        toast.error(`Reaction failed: ${reason}`);
        setReactions(snapshot);
      }
    },
    [conversation, user?.id]
  );

  const handleAssignChange = useCallback(
    async (agentId: string | null) => {
      if (!conversation) return;

      // Reivindicar uma conversa LIVRE precisa passar pelo RPC atômico
      // (`claim_conversation`, via /claim) — é o `WHERE
      // assigned_agent_id IS NULL` dele que serializa dois agentes
      // clicando a mesma conversa no mesmo instante (F-02 do SPEC). O
      // RPC por trás de /assign (`reassign_conversation`) faz um
      // UPDATE incondicional; usá-lo aqui reabriria exatamente essa
      // corrida. Qualquer outra mudança (devolver à fila, transferir
      // uma conversa que já tem dono) não tem essa corrida — o estado
      // de origem já é inequívoco — e vai por /assign.
      const isClaimFromQueue =
        agentId !== null && conversation.assigned_agent_id == null;
      const endpoint = isClaimFromQueue
        ? `/api/inbox/conversations/${conversation.id}/claim`
        : `/api/inbox/conversations/${conversation.id}/assign`;

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          ...(isClaimFromQueue
            ? {}
            : {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ assigned_agent_id: agentId }),
              }),
        });
        const json = await res.json().catch(() => ({}));

        if (!res.ok) {
          console.error('Failed to update assignment:', json?.error);
          toast.error(json?.error ?? t('assignUpdateFailed'));
          return;
        }

        const updatedAgentId =
          (json?.conversation?.assigned_agent_id as
            string | null | undefined) ?? agentId;
        onAssignChange(conversation.id, updatedAgentId);
      } catch (err) {
        console.error('Failed to update assignment:', err);
        toast.error(t('assignUpdateFailed'));
      }
    },
    [conversation, onAssignChange, t]
  );

  // Empty state — same WhatsApp-style doodle background as the active
  // thread below, so swapping between empty/selected doesn't change the
  // pattern under the user's eye.
  if (!conversation || !contact) {
    return (
      <div
        className={cn(
          'flex flex-1 flex-col items-center justify-center',
          DOODLE_BG_CLASSES
        )}
      >
        <div className="bg-muted flex h-16 w-16 items-center justify-center rounded-full">
          <MessageSquare className="text-muted-foreground h-8 w-8" />
        </div>
        <h3 className="text-muted-foreground mt-4 text-sm font-medium">
          {t('selectConversation')}
        </h3>
        <p className="text-muted-foreground mt-1 text-xs">
          {t('selectConversationHint')}
        </p>
      </div>
    );
  }

  const displayPhone = formatPhoneForDisplay(contact.phone);
  const displayName = contact.name || displayPhone;
  const messageGroups = groupMessagesByDate(messages);
  const currentStatus = STATUS_OPTIONS.find(
    (s) => s.value === conversation.status
  );
  const assignedAgentId = conversation.assigned_agent_id ?? null;
  const currentAssignee = profiles.find((p) => p.user_id === assignedAgentId);
  // Um agente comum só pode reivindicar para si mesmo — passar para um
  // TERCEIRO exige admin/owner (`reassign_conversation` recusaria com
  // `ONLY_ADMIN_CAN_REASSIGN_TO_OTHERS`). Restringir a lista aqui evita
  // oferecer uma opção que o servidor vai rejeitar.
  const assignableProfiles = canReassignToOthers
    ? profiles
    : profiles.filter((p) => p.user_id === user?.id);
  const assignLabel = assignedAgentId
    ? (currentAssignee?.full_name ?? t('assigned'))
    : t('assign');

  return (
    // `min-w-0` is load-bearing: the page already puts min-w-0 on the
    // thread's flex *wrapper* (issue #165), but this root keeps the
    // default `min-width: auto`, so a single wide message (long unbroken
    // URL/word) expands the whole thread past its flex share and the chat
    // paints on top of the contact sidebar at lg+ — outgoing bubbles get
    // clipped and the hover toolbar overlaps the Tags panel. Letting the
    // root shrink lets the bubbles' break-words / max-w caps apply.
    // Issue #257.
    <div className={cn('flex min-w-0 flex-1 flex-col', DOODLE_BG_CLASSES)}>
      {/* Header — solid card surface sits on top of the doodle so the
          name/avatar/dropdowns stay legible. */}
      <div className="border-border bg-card flex items-center justify-between gap-2 border-b px-3 py-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          {/* Back-to-list button — mobile only. Hidden on lg+ where the
              conversation list is always visible next to the thread. */}
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label={t('backToConversations')}
              className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md lg:hidden"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          )}
          <div className="bg-muted text-foreground flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-sm font-medium">
            {displayName.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <h2 className="text-foreground truncate text-sm font-semibold">
              {displayName}
            </h2>
            <p className="text-muted-foreground truncate text-xs">
              {displayPhone}
            </p>
          </div>
          {/* Selo de canal (SPEC 049 §4.2) — só com mais de um canal. */}
          {showChannelBadge && threadChannel && (
            <Badge
              variant="outline"
              className="border-border text-muted-foreground ml-1 hidden gap-1 text-[10px] sm:ml-2 sm:inline-flex"
              title={t('channelBadgeTitle', { channel: threadChannel.name })}
            >
              {threadChannel.type === 'whatsapp_qr' ? (
                <QrCode className="h-3 w-3" />
              ) : (
                <BadgeCheck className="h-3 w-3" />
              )}
              {threadChannel.name}
            </Badge>
          )}

          {/* Session timer badge — hidden on the narrowest phones so
              the name + back arrow keep their room, e oculto por
              completo em canal sem janela de 24h (PRD 047 §7.1.1). */}
          {!sessionInfo.hidden && (
            <Badge
              variant="outline"
              className={cn(
                'border-border ml-1 hidden gap-1 text-[10px] sm:ml-2 sm:inline-flex',
                sessionInfo.expired ? 'text-red-400' : 'text-primary'
              )}
            >
              <Clock className="h-3 w-3" />
              {sessionInfo.remaining}
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Contact-panel toggle — desktop only. The contact sidebar
              eats a chunk of horizontal width that crowds the thread on
              smaller laptops; this lets agents reclaim it when they just
              want to read and reply. Hidden on mobile, where the sidebar
              never renders as a permanent panel anyway. Issue #258. */}
          {onToggleContactPanel && (
            <button
              type="button"
              onClick={onToggleContactPanel}
              aria-label={
                contactPanelOpen ? t('hideContactPanel') : t('showContactPanel')
              }
              title={contactPanelOpen ? t('hideContact') : t('showContact')}
              aria-pressed={contactPanelOpen}
              className={cn(
                'hover:bg-muted hover:text-foreground hidden h-7 w-7 items-center justify-center rounded-md transition-colors lg:inline-flex',
                contactPanelOpen ? 'text-primary' : 'text-muted-foreground'
              )}
            >
              {contactPanelOpen ? (
                <PanelRightClose className="h-4 w-4" />
              ) : (
                <PanelRightOpen className="h-4 w-4" />
              )}
            </button>
          )}

          {/* Manual refresh — forces a refetch of the messages + the
              conversation list (the parent bumps its resyncToken). Useful
              when realtime missed an event or the agent just wants to be
              sure nothing's stale. Only rendered when the parent wires
              up `onRefresh`. */}
          {onRefresh && (
            <button
              type="button"
              onClick={handleRefreshClick}
              disabled={isRefreshing}
              aria-label={t('refreshConversation')}
              title={t('refresh')}
              className={cn(
                'text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:opacity-60'
              )}
            >
              <RefreshCw
                className={cn('h-3.5 w-3.5', isRefreshing && 'animate-spin')}
              />
            </button>
          )}

          {/* Status dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(
                'hover:bg-muted inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs',
                currentStatus?.color ?? 'text-muted-foreground'
              )}
            >
              {currentStatus ? t(`status${currentStatus.label}`) : t('status')}
              <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="border-border bg-popover"
            >
              {STATUS_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => handleStatusChange(opt.value)}
                  className={cn('text-sm', opt.color)}
                >
                  {t(`status${opt.label}`)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Assign dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(
                'hover:bg-muted inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs',
                assignedAgentId ? 'text-primary' : 'text-muted-foreground'
              )}
            >
              <UserPlus className="h-3 w-3" />
              <span className="hidden sm:inline">{assignLabel}</span>
              <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="border-border bg-popover"
            >
              {assignableProfiles.length === 0 ? (
                <DropdownMenuItem
                  disabled
                  className="text-muted-foreground text-sm"
                >
                  {t('noTeammates')}
                </DropdownMenuItem>
              ) : (
                assignableProfiles.map((p) => {
                  const isSelected = p.user_id === assignedAgentId;
                  const presence = getPresence(p.user_id);
                  return (
                    <DropdownMenuItem
                      key={p.id}
                      onClick={() => handleAssignChange(p.user_id)}
                      className={cn(
                        'text-sm',
                        isSelected ? 'text-primary' : 'text-popover-foreground'
                      )}
                    >
                      <PresenceDot
                        status={presence}
                        label={presenceLabel(
                          presence,
                          getRow(p.user_id)?.last_seen_at ?? null,
                          now
                        )}
                        className="mr-2"
                      />
                      <span className="flex-1">
                        {p.full_name}
                        {p.user_id === user?.id ? t('me') : ''}
                      </span>
                      {isSelected && <Check className="ml-2 h-3 w-3" />}
                    </DropdownMenuItem>
                  );
                })
              )}
              {assignedAgentId && (
                <>
                  <DropdownMenuSeparator className="bg-border" />
                  <DropdownMenuItem
                    onClick={() => handleAssignChange(null)}
                    className="text-muted-foreground text-sm"
                  >
                    {t('unassign')}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Messages Area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="border-primary h-5 w-5 animate-spin rounded-full border-2 border-t-transparent" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12">
            <p className="text-muted-foreground text-sm">
              {t('noMessagesYet')}
            </p>
            <p className="text-muted-foreground text-xs">
              {t('sendTemplateHint')}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {messageGroups.map((group) => (
              <div key={group.date}>
                {/* Date separator */}
                <div className="mb-4 flex items-center justify-center">
                  <span className="bg-muted text-muted-foreground rounded-full px-3 py-1 text-[10px] font-medium">
                    {formatDateSeparator(group.date, t)}
                  </span>
                </div>
                {/* Messages */}
                <div className="space-y-2">
                  {group.messages.map((msg) => {
                    const parent = msg.reply_to_message_id
                      ? messagesById.get(msg.reply_to_message_id)
                      : null;
                    const reply = parent
                      ? {
                          authorLabel:
                            parent.sender_type === 'agent' ||
                            parent.sender_type === 'bot'
                              ? t('me')
                              : contact?.name || contact?.phone || 'Unknown',
                          preview: buildReplyPreview(parent, tQuote),
                        }
                      : null;
                    const msgReactions = reactionsByMessageId.get(msg.id);
                    // Toggle is computed at the call site — `msgReactions`
                    // and `user?.id` are already in scope, no extra hook.
                    const handlePillToggle = (emoji: string) => {
                      const own = msgReactions?.find(
                        (r) =>
                          r.actor_type === 'agent' && r.actor_id === user?.id
                      );
                      const next = own?.emoji === emoji ? '' : emoji;
                      void postReaction(msg.id, next);
                    };
                    return (
                      <MessageActions
                        key={msg.id}
                        message={msg}
                        onReply={() => handleStartReply(msg)}
                        onReact={(emoji) => {
                          if (emoji) void postReaction(msg.id, emoji);
                        }}
                      >
                        <MessageBubble
                          message={msg}
                          reply={reply}
                          reactions={msgReactions}
                          currentUserId={user?.id}
                          onToggleReaction={handlePillToggle}
                          senderName={senderNameFor(msg)}
                          onOpenMedia={openLightbox}
                        />
                      </MessageActions>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Aviso de assunção implícita (SPEC 042, D7 §5). Aparece sempre
          que a thread ABERTA pertence a OUTRO agente — não só quando
          chegou aqui pelo seletor "ver como": um admin também pode
          abrir a conversa de um colega por deep-link ou notificação
          (ver o comentário sobre D7 em `inbox/page.tsx`), e o risco é
          o mesmo nos dois casos. F-07 da SPEC original faz o primeiro
          ENVIO reivindicar a conversa automaticamente no servidor — sem
          este aviso, um admin "só dando uma olhada" rouba a conversa do
          colega ao responder, sem perceber. */}
      {assignedAgentId && assignedAgentId !== user?.id && canSend && (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs sm:px-4">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
          <p className="text-amber-600 dark:text-amber-400">
            {t('assignedElsewhereWarning', {
              name: currentAssignee?.full_name ?? t('assigned'),
            })}
          </p>
        </div>
      )}

      {/* AI auto-reply banner — take over an active bot, or resume it
          after a handoff. Renders nothing unless the account has
          auto-reply configured. */}
      <AiThreadBanner
        conversationId={conversation.id}
        disabled={conversation.ai_autoreply_disabled ?? false}
        handoffSummary={conversation.ai_handoff_summary}
        assignedAgentId={assignedAgentId}
        currentUserId={user?.id}
        onChange={(patch) => {
          if ('assigned_agent_id' in patch) {
            onAssignChange(conversation.id, patch.assigned_agent_id ?? null);
          }
        }}
      />

      {/* Composer */}
      <MessageComposer
        conversationId={conversation.id}
        channelType={threadChannelType}
        sessionExpired={sessionInfo.expired}
        onSend={handleSend}
        onSendMedia={handleSendMedia}
        onSendInteractive={handleSendInteractive}
        onOpenTemplates={handleOpenTemplates}
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
      />

      <TemplatePicker
        open={templateModalOpen}
        onOpenChange={setTemplateModalOpen}
        onSelect={handleSendTemplate}
        contact={contact}
      />

      <MediaLightbox
        items={lightboxItems}
        index={lightboxIndex >= 0 ? lightboxIndex : null}
        onClose={closeLightbox}
        onNavigate={navigateLightbox}
      />
    </div>
  );
}
