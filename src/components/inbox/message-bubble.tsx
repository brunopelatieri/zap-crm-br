'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { Message, MessageReaction } from '@/types';
import {
  Clock,
  Check,
  CheckCheck,
  XCircle,
  FileText,
  MapPin,
  LayoutTemplate,
  ImageOff,
  CornerDownLeft,
  Sparkles,
  Maximize2,
} from 'lucide-react';
import { format } from 'date-fns';
import { ReplyQuote } from './reply-quote';
import { MessageReactions } from './message-reactions';
import { InteractivePreview } from '@/components/interactive/interactive-preview';
import { TemplatePreview } from '@/components/interactive/template-preview';
import { DownloadIconButton, useMediaSrc } from './media-download';
import { useTranslations } from 'next-intl';

interface MessageBubbleProps {
  message: Message;
  /** Pre-computed quote info for messages that reply to another. */
  reply?: { authorLabel: string; preview: string } | null;
  reactions?: MessageReaction[];
  currentUserId?: string;
  onToggleReaction?: (emoji: string) => void;
  /** Agent/bot name (outgoing) or contact name (incoming), shown atop the bubble. */
  senderName?: string;
  /** Abre o lightbox nesta mensagem — só passado para image/video. */
  onOpenMedia?: (messageId: string) => void;
}

function StatusIcon({ status }: { status: Message['status'] }) {
  switch (status) {
    case 'sending':
      return <Clock className="text-muted-foreground h-3 w-3" />;
    case 'sent':
      return <Check className="text-muted-foreground h-3 w-3" />;
    case 'delivered':
      return <CheckCheck className="text-muted-foreground h-3 w-3" />;
    case 'read':
      return <CheckCheck className="h-3 w-3 text-blue-400" />;
    case 'failed':
      return <XCircle className="h-3 w-3 text-red-400" />;
    default:
      return null;
  }
}

function MediaUnavailable({
  label,
  t,
}: {
  label: string;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="bg-muted/40 text-muted-foreground flex items-center gap-2 rounded-lg px-3 py-2 text-xs">
      <ImageOff className="text-muted-foreground h-4 w-4 shrink-0" />
      <span>{t('unavailable', { label })}</span>
    </div>
  );
}

// ------------------------------------------------------------------
// Wrappers de mídia.
//
// Desde a migração 040 nenhuma origem de mídia é utilizável direto do
// que está gravado na linha: objeto nosso precisa de URL assinada
// (bucket privado), mídia recebida precisa de fetch autenticado na
// rota-proxy. Só URL externa continua servindo como está.
//
// `useMediaSrc` resolve os três casos, mas é um hook — por isso cada
// tipo de mídia ganha seu componentezinho, em vez de um `switch` com
// hooks dentro.
// ------------------------------------------------------------------

function MediaImage({
  url,
  path,
  alt,
}: {
  url: string;
  path?: string | null;
  alt: string;
}) {
  const { src, loading, error } = useMediaSrc(url, path);
  // Erro do fetch (proxy) e erro de render do <img> (URL pública que
  // carrega mas não decodifica) são duas falhas distintas — a segunda
  // só é detectável depois que o hook já devolveu um `src`.
  const [renderError, setRenderError] = useState(false);

  if (error || renderError) {
    return (
      <div className="bg-muted flex h-40 w-60 items-center justify-center rounded-lg">
        <ImageOff className="text-muted-foreground h-8 w-8" />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="bg-muted flex h-40 w-60 items-center justify-center rounded-lg">
        <div className="border-primary h-5 w-5 animate-spin rounded-full border-2 border-t-transparent" />
      </div>
    );
  }

  return (
    <img
      src={src ?? ''}
      alt={alt}
      className="max-h-64 max-w-60 rounded-lg object-cover"
      onError={() => setRenderError(true)}
    />
  );
}

function MediaVideo({ url, path }: { url: string; path?: string | null }) {
  const { src, loading, error } = useMediaSrc(url, path);

  if (error) {
    return (
      <div className="bg-muted flex h-40 w-60 items-center justify-center rounded-lg">
        <ImageOff className="text-muted-foreground h-8 w-8" />
      </div>
    );
  }
  if (loading || !src) {
    return (
      <div className="bg-muted flex h-40 w-60 items-center justify-center rounded-lg">
        <div className="border-primary h-5 w-5 animate-spin rounded-full border-2 border-t-transparent" />
      </div>
    );
  }
  return <video src={src} controls className="max-h-64 max-w-60 rounded-lg" />;
}

function MediaAudio({ url, path }: { url: string; path?: string | null }) {
  const { src, loading, error } = useMediaSrc(url, path);

  if (error) return null;
  if (loading || !src) {
    return (
      <div className="bg-muted flex h-10 w-60 items-center justify-center rounded-lg">
        <div className="border-primary h-4 w-4 animate-spin rounded-full border-2 border-t-transparent" />
      </div>
    );
  }
  return <audio src={src} controls className="max-w-60" />;
}

/**
 * Link "abrir documento". Precisa resolver antes de virar `href`: um
 * `<a>` apontando para a URL pública de um bucket privado abriria uma
 * aba com erro do Storage.
 *
 * Enquanto resolve, o link fica desabilitado (`aria-disabled` + sem
 * `href`) em vez de sumir — o cartão não deve pular de layout.
 */
function DocumentLink({
  url,
  path,
  label,
}: {
  url: string;
  path?: string | null;
  label: string;
}) {
  const { src } = useMediaSrc(url, path);

  return (
    <a
      href={src ?? undefined}
      aria-disabled={!src}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'flex min-w-0 flex-1 items-center gap-2',
        !src && 'pointer-events-none opacity-70'
      )}
    >
      <FileText className="text-muted-foreground h-5 w-5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </a>
  );
}

function MessageContent({
  message,
  t,
  onOpenMedia,
}: {
  message: Message;
  t: ReturnType<typeof useTranslations>;
  onOpenMedia?: (messageId: string) => void;
}) {
  switch (message.content_type) {
    case 'text':
      return (
        <p className="text-sm break-words whitespace-pre-wrap">
          {message.content_text}
        </p>
      );

    case 'image': {
      // Botão de download só na mídia RECEBIDA (sender_type='customer')
      // — o que o agente envia já é o próprio arquivo que ele escolheu
      // no computador dele; não há nada novo para salvar.
      const canDownload =
        message.sender_type === 'customer' && !!message.media_url;
      return (
        <div>
          {message.media_url ? (
            <div
              className={cn(
                'relative inline-block',
                onOpenMedia && 'cursor-zoom-in'
              )}
              onClick={() => onOpenMedia?.(message.id)}
            >
              <MediaImage
                url={message.media_url}
                path={message.media_path}
                alt="Shared image"
              />
              {canDownload && (
                <DownloadIconButton
                  url={message.media_url}
                  path={message.media_path}
                  filename={null}
                  fallbackId={message.id}
                  className="absolute top-1.5 right-1.5"
                />
              )}
            </div>
          ) : (
            <MediaUnavailable label={t('photo')} t={t} />
          )}
          {message.content_text && (
            <p className="mt-1 text-sm break-words whitespace-pre-wrap">
              {message.content_text}
            </p>
          )}
        </div>
      );
    }

    case 'video': {
      const canDownload =
        message.sender_type === 'customer' && !!message.media_url;
      return (
        <div>
          {message.media_url ? (
            <div className="relative inline-block">
              <MediaVideo url={message.media_url} path={message.media_path} />
              {/* Botão explícito (não a área toda) — o clique em cima do
                  <video> precisa continuar chegando aos controles nativos
                  (play/pause/seek) sem abrir o lightbox por engano. */}
              {onOpenMedia && (
                <button
                  type="button"
                  onClick={() => onOpenMedia(message.id)}
                  title={t('expand')}
                  aria-label={t('expand')}
                  className="absolute top-1.5 left-1.5 inline-flex items-center justify-center rounded-full bg-black/50 p-1.5 text-white transition-colors hover:bg-black/70"
                >
                  <Maximize2 className="h-3.5 w-3.5" />
                </button>
              )}
              {canDownload && (
                <DownloadIconButton
                  url={message.media_url}
                  path={message.media_path}
                  filename={null}
                  fallbackId={message.id}
                  className="absolute top-1.5 right-1.5"
                />
              )}
            </div>
          ) : (
            <MediaUnavailable label={t('video')} t={t} />
          )}
          {message.content_text && (
            <p className="mt-1 text-sm break-words whitespace-pre-wrap">
              {message.content_text}
            </p>
          )}
        </div>
      );
    }

    case 'audio': {
      const canDownload =
        message.sender_type === 'customer' && !!message.media_url;
      return (
        <div className="flex items-center gap-2">
          {message.media_url ? (
            <>
              <MediaAudio url={message.media_url} path={message.media_path} />
              {canDownload && (
                <DownloadIconButton
                  url={message.media_url}
                  path={message.media_path}
                  filename={null}
                  fallbackId={message.id}
                  className="bg-muted-foreground/20 text-foreground hover:bg-muted-foreground/30 shrink-0"
                />
              )}
            </>
          ) : (
            <MediaUnavailable label={t('audio')} t={t} />
          )}
        </div>
      );
    }

    case 'document': {
      if (!message.media_url) {
        return (
          <MediaUnavailable
            label={message.content_text || t('document')}
            t={t}
          />
        );
      }
      const canDownload = message.sender_type === 'customer';
      // `<a>` e `<button>` são dois elementos interativos — não podem
      // ficar um dentro do outro (HTML inválido, o parser fecharia a
      // tag errado). O link de "abrir" e o botão de "baixar" ficam
      // lado a lado dentro do mesmo cartão, não aninhados.
      return (
        <div className="bg-muted/50 hover:bg-muted flex items-center gap-2 rounded-lg px-3 py-2 text-sm">
          <DocumentLink
            url={message.media_url}
            path={message.media_path}
            label={message.content_text || t('document')}
          />
          {canDownload && (
            <DownloadIconButton
              url={message.media_url}
              path={message.media_path}
              filename={message.content_text}
              fallbackId={message.id}
              className="bg-muted-foreground/20 text-foreground hover:bg-muted-foreground/30 shrink-0"
            />
          )}
        </div>
      );
    }

    case 'template':
      return (
        <div>
          <span className="bg-primary/20 text-primary mb-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium">
            <LayoutTemplate className="h-3 w-3" />
            {t('template')}
          </span>
          {message.template_preview ? (
            // Full fidelity: header/body/footer/buttons rendered like the
            // template appears on the recipient's phone (migration 037).
            <TemplatePreview preview={message.template_preview} />
          ) : (
            // Older sends predate migration 037 (or the template row
            // wasn't found locally at send time) — fall back to plain text.
            message.content_text && (
              <p className="mt-1 text-sm break-words whitespace-pre-wrap">
                {message.content_text}
              </p>
            )
          )}
        </div>
      );

    case 'location':
      return (
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="text-muted-foreground h-4 w-4 shrink-0" />
          <span>{message.content_text || t('locationShared')}</span>
        </div>
      );

    case 'interactive': {
      // Three cases share content_type='interactive':
      //  - OUTBOUND with payload (composer / automation / Flow send after
      //    migration 035): render the buttons/list as they appear on the phone.
      //  - INBOUND tap (customer chose an option, sender_type='customer'):
      //    no payload; show the tapped option's title with a reply affordance
      //    so agents can tell it's a tap, not the customer typing.
      //  - OUTBOUND with NO payload (legacy bot/Flow sends from before
      //    migration 035 backfilled the column): show the body text plainly —
      //    it is our own message, NOT a customer tap.
      if (message.interactive_payload) {
        return <InteractivePreview payload={message.interactive_payload} />;
      }
      if (message.sender_type === 'customer') {
        return (
          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground inline-flex items-center gap-1 text-[10px] font-medium tracking-wide uppercase">
              <CornerDownLeft className="h-3 w-3" />
              {t('buttonReply')}
            </span>
            <p className="text-sm break-words whitespace-pre-wrap">
              {message.content_text || t('interactiveReply')}
            </p>
          </div>
        );
      }
      return (
        <p className="text-sm break-words whitespace-pre-wrap">
          {message.content_text || t('interactiveReply')}
        </p>
      );
    }

    default:
      return (
        <p className="text-sm break-words whitespace-pre-wrap">
          {message.content_text || t('unsupported')}
        </p>
      );
  }
}

export function MessageBubble({
  message,
  reply,
  reactions,
  currentUserId,
  onToggleReaction,
  senderName,
  onOpenMedia,
}: MessageBubbleProps) {
  const t = useTranslations('Inbox.bubble');

  const isAgent =
    message.sender_type === 'agent' || message.sender_type === 'bot';
  const time = format(new Date(message.created_at), 'HH:mm');

  // Row alignment + width cap are owned by <MessageActions> so its hover
  // group matches the bubble's content area, not the full row.
  return (
    <div className={cn('flex flex-col', isAgent ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'relative rounded-2xl px-3 py-2',
          // Outgoing bubbles use a fixed pale-green fill (not the themed
          // `--primary`) so agent messages are always visually distinct
          // from the accent color. Text/timestamp/badge below are all
          // dark neutrals chosen for contrast against that light fill.
          isAgent
            ? 'bg-[#E1F7C9] text-neutral-900 rounded-br-md'
            : 'bg-muted text-foreground rounded-bl-md'
        )}
      >
        {senderName && (
          <p
            className={cn(
              'mb-0.5 truncate text-xs font-semibold',
              isAgent ? 'text-neutral-900/70' : 'text-foreground/70'
            )}
          >
            {senderName}
          </p>
        )}
        {reply && (
          <ReplyQuote
            authorLabel={reply.authorLabel}
            preview={reply.preview}
            onPrimary={isAgent}
          />
        )}
        <MessageContent message={message} t={t} onOpenMedia={onOpenMedia} />
        <div
          className={cn(
            'mt-1 flex items-center gap-1',
            isAgent ? 'justify-end' : 'justify-start'
          )}
        >
          {/* AI badge — only on replies the auto-reply bot generated
              (always outbound, so it sits on the primary fill). Lets
              agents tell an AI reply from their own / a Flow's at a
              glance. */}
          {message.ai_generated && (
            <span
              className={cn(
                'inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[9px] leading-none font-semibold tracking-wide uppercase',
                isAgent
                  ? 'bg-neutral-900/10 text-neutral-900'
                  : 'bg-primary-foreground/20 text-primary-foreground'
              )}
              title={t('aiBadgeTitle')}
            >
              <Sparkles className="h-2.5 w-2.5" />
              {t('aiBadge')}
            </span>
          )}
          <span
            className={cn(
              'text-[10px]',
              // Outbound bubbles sit on the fixed pale-green fill, so the
              // timestamp must read against that (not the neutral
              // foreground) — otherwise it goes low-contrast in light
              // mode. Inbound bubbles use the muted surface.
              isAgent ? 'text-neutral-900/60' : 'text-muted-foreground'
            )}
          >
            {time}
          </span>
          {isAgent && <StatusIcon status={message.status} />}
        </div>
      </div>
      {reactions && reactions.length > 0 && onToggleReaction && (
        <MessageReactions
          reactions={reactions}
          currentUserId={currentUserId}
          onToggle={onToggleReaction}
        />
      )}
    </div>
  );
}
