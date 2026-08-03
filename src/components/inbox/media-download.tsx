'use client';

import { useCallback, useState } from 'react';
import type { MouseEvent } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import { resolveMediaRef } from '@/lib/storage/media-url';
import { signMediaUrl } from '@/lib/storage/sign-media-client';

// `useMediaSrc` mora em `lib/storage` porque os consumidores vão além
// do Inbox (pré-visualização de template, construtor de flows, passo de
// disparo). Reexportado aqui para que a bolha e o lightbox continuem
// importando mídia de um lugar só.
export { useMediaSrc } from '@/lib/storage/use-media-src';

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
  fallbackId: string,
  path?: string | null
) {
  // Mesma resolução em três vias do `useMediaSrc`: objeto nosso precisa
  // de assinatura (bucket privado desde a 040), rota-proxy e URL externa
  // são buscadas diretamente.
  const ref = resolveMediaRef(url, path);
  const fetchUrl =
    ref.kind === 'storage'
      ? await signMediaUrl({ bucket: ref.bucket, path: ref.path })
      : ref.kind === 'none'
        ? null
        : ref.url;

  if (!fetchUrl) throw new Error('no media to download');

  const res = await fetch(fetchUrl);
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
  path,
  filename,
  fallbackId,
  className,
}: {
  url: string;
  /** `messages.media_path`, quando o objeto é nosso (migração 040). */
  path?: string | null;
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
        await downloadMedia(url, filename, fallbackId, path);
      } catch {
        toast.error(t('downloadFailed'));
      } finally {
        setDownloading(false);
      }
    },
    [url, path, filename, fallbackId, downloading, t]
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
