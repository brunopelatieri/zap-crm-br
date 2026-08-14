'use client';

import { useCallback, useEffect } from 'react';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { ChevronLeft, ChevronRight, ImageOff, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { DownloadIconButton, useMediaSrc } from './media-download';

export interface LightboxItem {
  id: string;
  type: 'image' | 'video';
  /** Nulo quando só existe `path` — é o caso do canal QRCode. */
  url: string | null;
  /** `messages.media_path` — objeto no bucket privado (migração 040). */
  path?: string | null;
  caption?: string | null;
  /** Só mídia recebida do cliente ganha botão de download — ver media-download.tsx. */
  downloadable: boolean;
}

interface MediaLightboxProps {
  items: LightboxItem[];
  /** Índice em `items`, ou `null` quando fechado. */
  index: number | null;
  onClose: () => void;
  onNavigate: (index: number) => void;
}

function LightboxImage({
  url,
  path,
  alt,
}: {
  url: string | null;
  path?: string | null;
  alt: string;
}) {
  const { src, loading, error } = useMediaSrc(url, path);

  if (error) {
    return (
      <div className="flex h-40 w-60 items-center justify-center">
        <ImageOff className="h-8 w-8 text-white/60" />
      </div>
    );
  }

  if (loading || !src) {
    return (
      <div className="flex h-40 w-60 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/40 border-t-white" />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      className="max-h-[85vh] max-w-[90vw] rounded-lg object-contain"
    />
  );
}

function LightboxVideo({
  url,
  path,
}: {
  url: string | null;
  path?: string | null;
}) {
  const { src, loading, error } = useMediaSrc(url, path);

  if (error) {
    return (
      <div className="flex h-40 w-60 items-center justify-center">
        <ImageOff className="h-8 w-8 text-white/60" />
      </div>
    );
  }

  if (loading || !src) {
    return (
      <div className="flex h-40 w-60 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/40 border-t-white" />
      </div>
    );
  }

  return (
    <video
      src={src}
      controls
      autoPlay
      className="max-h-[85vh] max-w-[90vw] rounded-lg"
    />
  );
}

/**
 * Visualizador em tela cheia para imagem/vídeo, com navegação entre TODA
 * a mídia da conversa (enviada e recebida) — não só a mensagem clicada.
 * `items` já vem filtrado/ordenado por quem chama (message-thread.tsx).
 *
 * Construído sobre os primitivos do Dialog (Base UI) em vez do
 * `<Dialog>` já estilizado em ui/dialog.tsx: aquele é pensado para uma
 * caixa central pequena (max-w-sm, padding, cantos arredondados) — aqui
 * queremos tela cheia. Reaproveitar os primitivos ainda dá foco-trap,
 * Escape-para-fechar e portal de graça.
 */
export function MediaLightbox({
  items,
  index,
  onClose,
  onNavigate,
}: MediaLightboxProps) {
  const t = useTranslations('Inbox.bubble');
  const open = index !== null;
  const current = index !== null ? (items[index] ?? null) : null;
  const hasPrev = index !== null && index > 0;
  const hasNext = index !== null && index < items.length - 1;

  const goPrev = useCallback(() => {
    if (index !== null && index > 0) onNavigate(index - 1);
  }, [index, onNavigate]);

  const goNext = useCallback(() => {
    if (index !== null && index < items.length - 1) onNavigate(index + 1);
  }, [index, items.length, onNavigate]);

  // Setas do teclado — Escape já é tratado pelo próprio Dialog.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'ArrowLeft') goPrev();
      else if (e.key === 'ArrowRight') goNext();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, goPrev, goNext]);

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 z-50 bg-black/90" />
        <DialogPrimitive.Popup className="fixed inset-0 z-50 flex items-center justify-center p-4 outline-none">
          <DialogPrimitive.Title className="sr-only">
            {t('mediaViewer')}
          </DialogPrimitive.Title>
          {current && (
            // Clicar fora da mídia fecha; clicar na mídia/controles não
            // (o wrapper interno para a propagação antes de chegar aqui).
            <div
              className="absolute inset-0 flex items-center justify-center"
              onClick={onClose}
            >
              <div
                className="relative flex max-h-full max-w-full items-center justify-center"
                onClick={(e) => e.stopPropagation()}
              >
                {current.type === 'image' ? (
                  <LightboxImage
                    url={current.url}
                    path={current.path}
                    alt={current.caption ?? ''}
                  />
                ) : (
                  <LightboxVideo
                    key={current.id}
                    url={current.url}
                    path={current.path}
                  />
                )}
                {current.downloadable && (
                  // Nem imagem nem vídeo têm um "nome de arquivo" real
                  // vindo da Meta (só documento tem) — mesmo critério da
                  // bolha de mensagem, o fallback por extensão entra.
                  <DownloadIconButton
                    url={current.url}
                    path={current.path}
                    filename={null}
                    fallbackId={current.id}
                    className="absolute right-2 bottom-2"
                  />
                )}
              </div>
            </div>
          )}

          {hasPrev && (
            <button
              type="button"
              onClick={goPrev}
              title={t('previous')}
              aria-label={t('previous')}
              className="absolute top-1/2 left-3 z-10 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white transition-colors hover:bg-black/70"
            >
              <ChevronLeft className="h-6 w-6" />
            </button>
          )}
          {hasNext && (
            <button
              type="button"
              onClick={goNext}
              title={t('next')}
              aria-label={t('next')}
              className="absolute top-1/2 right-3 z-10 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white transition-colors hover:bg-black/70"
            >
              <ChevronRight className="h-6 w-6" />
            </button>
          )}

          <DialogPrimitive.Close
            className={cn(
              'absolute top-3 right-3 z-10 rounded-full bg-black/50 p-2 text-white transition-colors hover:bg-black/70'
            )}
          >
            <X className="h-5 w-5" />
            <span className="sr-only">{t('close')}</span>
          </DialogPrimitive.Close>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
