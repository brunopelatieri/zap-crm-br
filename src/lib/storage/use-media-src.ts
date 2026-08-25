'use client';

import { useEffect, useState } from 'react';
import { resolveMediaRef } from './media-url';
import { signMediaUrl } from './sign-media-client';

/**
 * Resolve uma referência de mídia para uma URL que um `<img>`,
 * `<video>`, `<audio>` ou `<a href>` consiga usar AGORA.
 *
 * Três origens, três tratamentos — e nenhuma delas é utilizável direto
 * do que está gravado na linha desde a migração 040:
 *
 *   1. **objeto nosso** (`media_path`, ou uma URL de bucket gravada
 *      antes da 040) → os buckets `chat-media`/`flow-media` são
 *      PRIVADOS; pede uma URL assinada de vida curta a
 *      `/api/inbox/media/sign`. Quem autoriza é a política de leitura
 *      do Storage, não este código.
 *   2. **rota-proxy** (`/api/whatsapp/media/[mediaId]`, mídia recebida
 *      do cliente) → fetch autenticado + blob. Um `src` direto perderia
 *      o cookie de sessão em alguns contextos, e sem o blob não dá para
 *      mostrar loading/erro nem nomear o arquivo pela extensão real.
 *   3. **URL externa** (link de terceiro colado num header de template
 *      ou num nó de flow) → usada como está.
 *
 * Vive em `lib/storage` e não no Inbox porque os consumidores estão
 * espalhados: bolha de mensagem, lightbox, pré-visualização de template,
 * construtor de flows e o passo de personalização de disparo.
 */
/**
 * URLs de proxy (`/api/whatsapp/media/<mediaId>`) já confirmadas mortas
 * nesta aba. A Meta expira mídia recebida bem mais cedo do que a
 * documentação sugere (ver investigação de 2026-08-17); sem isto, toda
 * mensagem antiga com mídia morta refaz a chamada à Graph API — e volta
 * a falhar — a cada re-render da thread (reconexão do realtime, troca
 * de aba). `mediaId` é único por objeto da Meta, então a URL nunca
 * volta a ficar viva: cache para a vida da aba, sem TTL.
 */
const deadProxyMedia = new Set<string>();

export function useMediaSrc(
  url: string | null | undefined,
  path?: string | null
) {
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
      const ref = resolveMediaRef(url, path);

      if (ref.kind === 'none') {
        if (!cancelled) setLoading(false);
        return;
      }

      if (ref.kind === 'external') {
        if (!cancelled) {
          setSrc(ref.url);
          setLoading(false);
        }
        return;
      }

      if (ref.kind === 'proxy') {
        if (deadProxyMedia.has(ref.url)) {
          if (!cancelled) {
            setError(true);
            setLoading(false);
          }
          return;
        }
        try {
          const res = await fetch(ref.url);
          if (!res.ok) throw new Error('Failed to load media');
          const blob = await res.blob();
          blobUrl = URL.createObjectURL(blob);
          if (!cancelled) setSrc(blobUrl);
        } catch {
          deadProxyMedia.add(ref.url);
          if (!cancelled) setError(true);
        } finally {
          if (!cancelled) setLoading(false);
        }
        return;
      }

      // ref.kind === 'storage' — pedir assinatura.
      try {
        const signed = await signMediaUrl({
          bucket: ref.bucket,
          path: ref.path,
        });
        if (!cancelled) setSrc(signed);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();

    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [url, path]);

  return { src, loading, error };
}
