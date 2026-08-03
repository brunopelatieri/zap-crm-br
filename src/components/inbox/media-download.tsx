'use client';

import { useCallback, useEffect, useState } from 'react';
import type { MouseEvent } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';

/**
 * Resolve uma `media_url` para algo que um `<img>`/blob consumidor
 * consiga usar. URLs da rota-proxy (`/api/whatsapp/media/[mediaId]`,
 * mídia recebida do cliente) precisam de fetch autenticado — um
 * `<img src>` direto perderia o cookie de sessão em alguns contextos, e
 * sem o blob não dá para mostrar loading/erro nem nomear o arquivo pela
 * extensão real depois. URLs públicas (bucket `chat-media`, mídia que o
 * AGENTE enviou) são usadas como estão.
 *
 * Compartilhado entre a miniatura na bolha (`MediaImage`) e o
 * lightbox — mesma lógica, dois tamanhos de exibição.
 */
export function useProxyMediaSrc(url: string) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let blobUrl: string | null = null;
    setLoading(true);
    setError(false);
    setSrc(null);

    async function load() {
      if (!url) return;
      if (url.startsWith('/api/whatsapp/media/')) {
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error('Failed to load media');
          const blob = await res.blob();
          blobUrl = URL.createObjectURL(blob);
          if (!cancelled) setSrc(blobUrl);
        } catch {
          if (!cancelled) setError(true);
        } finally {
          if (!cancelled) setLoading(false);
        }
      } else {
        setSrc(url);
        setLoading(false);
      }
    }
    load();

    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [url]);

  return { src, loading, error };
}

// ------------------------------------------------------------------
// Download de mídia recebida do cliente — compartilhado entre a bolha
// de mensagem e o lightbox (mesmo botão, dois lugares).
//
// `message.media_url` para mensagens inbound é sempre a rota-proxy
// `/api/whatsapp/media/[mediaId]` (mesma origem, autenticada — nunca o
// bucket `chat-media`, que só recebe mídia que o AGENTE envia pelo
// composer). Um `<a href download>` direto funcionaria para essa URL
// same-origin, mas passamos por blob mesmo assim para poder nomear o
// arquivo pela extensão real (o MIME só chega no header da resposta,
// nunca é persistido em `messages`) e para dar feedback de loading/erro
// — a rota faz uma chamada de rede à Meta a cada download, então não é
// instantânea.
// ------------------------------------------------------------------

/**
 * MIMEs cujo subtipo não é a extensão de arquivo usual. Cobre o
 * allow-list de `023_chat_media.sql` + os tipos que a Meta manda em
 * mídia inbound; qualquer coisa fora daqui cai no fallback (subtipo
 * após a `/`), que já acerta a maioria (`video/mp4` → `mp4`).
 */
const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
    'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    'pptx',
  'audio/mpeg': 'mp3',
  'video/3gpp': '3gp',
};

function guessExtension(mimeType: string): string {
  const clean = mimeType.split(';')[0].trim().toLowerCase();
  if (MIME_EXTENSIONS[clean]) return MIME_EXTENSIONS[clean];
  const subtype = clean.split('/')[1];
  return subtype ? subtype.replace(/^x-/, '') : 'bin';
}

/** Baixa via blob + link efêmero, em vez de deixar o navegador navegar
 * para a URL — é o que força "Salvar como" mesmo numa aba já aberta. */
export async function downloadMedia(
  url: string,
  suggestedName: string | null | undefined,
  fallbackId: string
) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('download failed');
  const blob = await res.blob();
  const filename =
    (suggestedName?.trim() || null) ??
    `${fallbackId.slice(0, 8)}.${guessExtension(blob.type)}`;
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}

export function DownloadIconButton({
  url,
  filename,
  fallbackId,
  className,
}: {
  url: string;
  filename: string | null | undefined;
  fallbackId: string;
  className?: string;
}) {
  const t = useTranslations('Inbox.bubble');
  const [downloading, setDownloading] = useState(false);

  const handleClick = useCallback(
    async (e: MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      if (downloading) return;
      setDownloading(true);
      try {
        await downloadMedia(url, filename, fallbackId);
      } catch {
        toast.error(t('downloadFailed'));
      } finally {
        setDownloading(false);
      }
    },
    [url, filename, fallbackId, downloading, t]
  );

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={downloading}
      title={t('download')}
      aria-label={t('download')}
      className={cn(
        'inline-flex items-center justify-center rounded-full bg-black/50 p-1.5 text-white transition-colors hover:bg-black/70 disabled:opacity-60',
        className
      )}
    >
      {downloading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Download className="h-3.5 w-3.5" />
      )}
    </button>
  );
}
