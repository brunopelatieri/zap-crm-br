// ============================================================
// Assinatura de URL de mídia — lado servidor.
//
// Depois da migração 040 os buckets `chat-media` e `flow-media` são
// PRIVADOS. Toda leitura precisa de uma URL assinada, mintada na hora.
// Este módulo é o único lugar do servidor que minta.
//
// Regra de ouro: URL ASSINADA NUNCA É PERSISTIDA. Ela expira em
// `SIGNED_URL_TTL_SECONDS`; gravá-la em `messages.media_url` ou em
// `message_templates.header_media_url` deixaria o registro com um link
// morto poucos minutos depois. O que se persiste é o CAMINHO
// (`media_path`) ou a URL pública histórica; a assinatura é sempre
// efêmera e local ao uso.
//
// Import só de servidor: recebe um `SupabaseClient` já resolvido pelo
// chamador (sessão ou service role), sem tocar em `next/headers`.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  resolveMediaRef,
  SIGNED_URL_TTL_SECONDS,
  type MediaRef,
} from './media-url';

/**
 * Minta uma URL assinada para um objeto do Storage.
 *
 * Devolve `null` quando o objeto não existe ou o chamador não pode
 * lê-lo — com o cliente de SESSÃO, a policy de leitura da 040 (membro
 * da conta dona da pasta) é quem decide, e o Storage responde erro sem
 * distinguir "não existe" de "não é sua". Isso é desejável: o chamador
 * traduz os dois para o mesmo 404.
 */
export async function signStoragePath(
  supabase: SupabaseClient,
  bucket: string,
  path: string,
  expiresIn: number = SIGNED_URL_TTL_SECONDS
): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, expiresIn);

  if (error || !data?.signedUrl) {
    console.warn('[sign-media] createSignedUrl failed:', {
      bucket,
      path,
      message: error?.message,
    });
    return null;
  }

  return data.signedUrl;
}

/**
 * Resolve uma referência de mídia para uma URL utilizável AGORA.
 *
 * É o ponto de entrada para todo consumidor servidor-side que precisa
 * entregar uma URL a terceiros (a Meta, no envio) ou baixar os bytes
 * (o handle de header de template).
 *
 * Os três casos que ela precisa distinguir, e por quê:
 *   • `storage`  → objeto nosso, bucket privado → assinar.
 *   • `external` → URL que o USUÁRIO colou (header de template, nó de
 *     flow aceitam URL de terceiro). Passa intocada — assinar não faz
 *     sentido e reescrever quebraria o caso de uso.
 *   • `proxy`    → mídia recebida, servida pela nossa rota autenticada.
 *     Não é endereçável pela Meta nem por um fetch sem cookie, então
 *     não há URL a devolver aqui; o chamador que precisar dos bytes usa
 *     a rota, não esta função.
 */
export async function resolveMediaUrlForServer(
  supabase: SupabaseClient,
  url: string | null | undefined,
  path?: string | null,
  expiresIn: number = SIGNED_URL_TTL_SECONDS
): Promise<string | null> {
  const ref: MediaRef = resolveMediaRef(url, path);

  switch (ref.kind) {
    case 'storage':
      return signStoragePath(supabase, ref.bucket, ref.path, expiresIn);
    case 'external':
      return ref.url;
    case 'proxy':
    case 'none':
      return null;
  }
}
