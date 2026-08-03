'use client';

// ============================================================
// Assinatura de URL de mídia — lado cliente.
//
// Depois da migração 040 os buckets `chat-media` e `flow-media` são
// privados: o browser não consegue mais montar a URL do objeto sozinho.
// Este módulo é o único caminho do cliente até `/api/inbox/media/sign`.
//
// ⚠️ POR QUE O CACHE NÃO É OPCIONAL
//
//   Sem ele, cada montagem de componente pede uma assinatura NOVA — e
//   como a URL assinada carrega um `token` diferente a cada vez, o
//   `<img src>` muda, o navegador considera outra imagem e rebaixa o
//   arquivo inteiro. Numa thread com 30 fotos, rolar para cima e voltar
//   rebaixaria as 30. O cache por `bucket:path` mantém o `src` estável
//   entre renders e entre componentes (a bolha e o lightbox pedem a
//   mesma mídia).
//
//   O TTL local é deliberadamente MENOR que o da assinatura
//   (`SIGNED_URL_TTL_SECONDS`): assim uma URL nunca é servida do cache
//   já expirada, com folga para o request em voo.
// ============================================================

import { SIGNED_URL_TTL_SECONDS } from './media-url';

/** Margem de segurança: reassina antes de a URL de fato expirar. */
const CACHE_TTL_MS = (SIGNED_URL_TTL_SECONDS - 60) * 1000;

interface CacheEntry {
  url: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Requisições em voo, para colapsar chamadas simultâneas ao mesmo
 * objeto num único request. A bolha e o lightbox montam praticamente
 * ao mesmo tempo ao abrir uma imagem; sem isto, seriam dois POSTs.
 */
const inflight = new Map<string, Promise<string>>();

export interface SignMediaTarget {
  bucket: string;
  path: string;
}

/**
 * Devolve uma URL assinada utilizável agora para um objeto do Storage.
 *
 * Lança em falha (404 do servidor, rede, sessão expirada) — o chamador
 * traduz para o seu próprio estado de erro. Não existe fallback para a
 * URL pública: ela deixou de funcionar quando o bucket fechou, e
 * tentá-la só produziria uma imagem quebrada mais tarde.
 */
export async function signMediaUrl(target: SignMediaTarget): Promise<string> {
  const key = `${target.bucket}:${target.path}`;

  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.url;

  const pending = inflight.get(key);
  if (pending) return pending;

  const request = (async () => {
    const res = await fetch('/api/inbox/media/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(target),
    });

    if (!res.ok) {
      throw new Error(`Failed to sign media (${res.status})`);
    }

    const data = (await res.json()) as { url?: string };
    if (!data.url) throw new Error('Sign response had no url');

    cache.set(key, { url: data.url, expiresAt: Date.now() + CACHE_TTL_MS });
    return data.url;
  })().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, request);
  return request;
}

/**
 * Descarta a entrada de cache de um objeto. Útil quando um upload
 * substitui um arquivo no mesmo caminho — cenário raro (`upsert: false`
 * em `uploadAccountMedia`), mas barato de suportar.
 */
export function invalidateSignedMedia(target: SignMediaTarget): void {
  cache.delete(`${target.bucket}:${target.path}`);
}
