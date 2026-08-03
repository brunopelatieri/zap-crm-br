'use client';

import { Reply, ExternalLink, Phone, Copy, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TemplatePreviewPayload, TemplateButton } from '@/types';
import { useMediaSrc } from '@/lib/storage/use-media-src';

/**
 * WhatsApp-style read-only render of a sent TEMPLATE message (header,
 * body, footer, buttons) — the template equivalent of
 * `InteractivePreview`. Unlike interactive reply buttons, template
 * buttons come in four Meta types with distinct on-phone affordances,
 * so each gets its own icon instead of the single "tap to reply" look.
 */
// Partial + fallback (not a plain Record): template_preview is a JSONB
// blob re-read from the DB, so a button type outside today's union
// (e.g. OTP/FLOW if the Meta sync ever passes them through) must fall
// back to a generic icon instead of crashing the thread render.
const BUTTON_ICON: Partial<Record<TemplateButton['type'], typeof Reply>> = {
  QUICK_REPLY: Reply,
  URL: ExternalLink,
  PHONE_NUMBER: Phone,
  COPY_CODE: Copy,
};

function HeaderMedia({
  media,
}: {
  media: NonNullable<TemplatePreviewPayload['headerMedia']>;
}) {
  // `header_media_url` tem DUAS origens: um link público que o usuário
  // colou, ou um arquivo que subimos para o bucket `chat-media`. Até a
  // migração 040 os dois eram buscáveis do mesmo jeito; com o bucket
  // privado, o segundo precisa de URL assinada. `useMediaSrc` distingue
  // os casos — o link externo passa intocado.
  const { src, loading } = useMediaSrc(media.url);

  if (loading || !src) {
    return (
      <div className="bg-muted flex h-24 w-full items-center justify-center">
        <div className="border-primary h-4 w-4 animate-spin rounded-full border-2 border-t-transparent" />
      </div>
    );
  }

  switch (media.type) {
    case 'image':
      return (
        <img
          src={src}
          alt="Template header"
          className="max-h-48 w-full object-cover"
        />
      );
    case 'video':
      return <video src={src} controls className="max-h-48 w-full" />;
    case 'document':
      return (
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="bg-muted/50 hover:bg-muted flex items-center gap-2 px-3 py-2 text-sm"
        >
          <FileText className="text-muted-foreground h-5 w-5 shrink-0" />
          {/* Nome vem da URL ESTÁVEL, não da assinada: a assinada
              termina em `?token=…` e o `.pop()` devolveria o token. */}
          <span className="truncate">
            {media.url.split('?')[0].split('/').pop()}
          </span>
        </a>
      );
  }
}

export function TemplatePreview({
  preview,
  className,
}: {
  preview: TemplatePreviewPayload;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'bg-card text-foreground ring-border w-full max-w-[260px] overflow-hidden rounded-lg shadow-sm ring-1',
        className
      )}
    >
      {preview.headerMedia ? <HeaderMedia media={preview.headerMedia} /> : null}
      <div className="px-3 py-2">
        {preview.header ? (
          <p className="mb-1 text-sm font-semibold break-words">
            {preview.header}
          </p>
        ) : null}
        <p className="text-sm break-words whitespace-pre-wrap">
          {preview.body}
        </p>
        {preview.footer ? (
          <p className="text-muted-foreground mt-1 text-[11px] break-words">
            {preview.footer}
          </p>
        ) : null}
      </div>

      {preview.buttons && preview.buttons.length > 0 ? (
        <div className="border-border flex flex-col border-t">
          {preview.buttons.map((btn, i) => {
            const Icon = BUTTON_ICON[btn.type] ?? Reply;
            return (
              <button
                key={i}
                type="button"
                disabled
                className="border-border text-primary flex items-center justify-center gap-1.5 border-t py-2 text-sm font-medium first:border-t-0"
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="truncate">{btn.text}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
