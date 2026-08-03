// ============================================================
// Tradução entre URL de mídia e caminho de objeto no Storage.
//
// Módulo PURO (sem React, sem Supabase, sem `next/headers`) para poder
// ser importado tanto por rota de API quanto por componente cliente, e
// testado isoladamente (`media-url.test.ts`).
//
// Por que existe (SPEC 040, F-40-B)
//
//   Os buckets `chat-media` e `flow-media` nasceram PÚBLICOS porque a
//   Meta precisa buscar o arquivo por URL no momento do envio
//   (023:57-61). Depois da 039 isso virou o furo mais grave do produto:
//   o texto da conversa passou a exigir sessão + atribuição, e o anexo
//   da mesma conversa não exigia nem login.
//
//   Fechar o bucket significa que toda leitura passa a precisar de uma
//   URL ASSINADA, mintada na hora por quem tem permissão. Mas os campos
//   que guardam essas URLs no banco (`messages.media_url`,
//   `message_templates.header_media_url`, `flow_nodes.config.media_url`)
//   NÃO são exclusivamente nossos: o usuário pode colar uma URL externa
//   arbitrária num header de template ou num nó de flow. Uma URL
//   assinada também não pode ser persistida — ela expira, e o registro
//   ficaria com um link morto.
//
//   Daí a divisão de trabalho deste módulo:
//     • `parseStorageUrl`  — "esta URL é nossa? de que bucket, que path?"
//     • `resolveMediaRef`  — decide entre path (assinar), proxy da Meta
//                            (fetch autenticado) e URL externa (usar
//                            como está).
//   Quem assina de fato é `lib/storage/sign-media.ts` (servidor) ou a
//   rota `/api/inbox/media/sign` (cliente) — os dois usam o que sai
//   daqui.
// ============================================================

/** Buckets cujo conteúdo passou a ser privado na migração 040. */
export const PRIVATE_MEDIA_BUCKETS = ['chat-media', 'flow-media'] as const;
export type PrivateMediaBucket = (typeof PRIVATE_MEDIA_BUCKETS)[number];

/** Prefixo da rota-proxy de mídia recebida (ver o route handler). */
export const PROXY_MEDIA_PREFIX = '/api/whatsapp/media/';

/** Monta a URL da rota-proxy para um `mediaId` da Meta. */
export function proxyMediaUrl(mediaId: string): string {
  return `${PROXY_MEDIA_PREFIX}${mediaId}`;
}

/** Extrai o `mediaId` de uma URL da rota-proxy; `null` se não for uma. */
export function parseProxyMediaUrl(url: string): string | null {
  if (!url.startsWith(PROXY_MEDIA_PREFIX)) return null;
  const id = url.slice(PROXY_MEDIA_PREFIX.length).split(/[?#]/)[0];
  return id || null;
}

export interface ParsedStorageUrl {
  bucket: PrivateMediaBucket;
  /** Caminho do objeto DENTRO do bucket (`account-<uuid>/123-foo.png`). */
  path: string;
}

/**
 * Reconhece uma URL pública (ou já assinada) de um dos nossos buckets
 * privados e devolve `{ bucket, path }`.
 *
 * O Supabase Storage serve objetos em duas formas, e as duas aparecem
 * em dados já gravados:
 *   público   → `<projeto>/storage/v1/object/public/<bucket>/<path>`
 *   assinado  → `<projeto>/storage/v1/object/sign/<bucket>/<path>?token=…`
 *
 * Devolve `null` para qualquer outra coisa — inclusive URL externa
 * colada pelo usuário, que é caso legítimo e deve passar intocada.
 */
export function parseStorageUrl(url: string): ParsedStorageUrl | null {
  if (!url) return null;

  // `object/public/` e `object/sign/` — e também `object/authenticated/`,
  // que o Storage aceita como alias de leitura autenticada.
  const match = url.match(
    /\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/?#]+)\/([^?#]+)/
  );
  if (!match) return null;

  const [, bucket, rawPath] = match;
  if (!isPrivateMediaBucket(bucket)) return null;

  // O path vem percent-encoded na URL; o SDK do Storage espera o path
  // cru. Sem o decode, um arquivo com espaço ou acento não é
  // encontrado na hora de assinar.
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    // Percent-encoding malformado: usar como veio é melhor que estourar
    // — a assinatura falha adiante e o chamador degrada para erro de
    // mídia, em vez de derrubar a request inteira.
    path = rawPath;
  }

  return { bucket: bucket as PrivateMediaBucket, path };
}

export function isPrivateMediaBucket(
  bucket: string
): bucket is PrivateMediaBucket {
  return (PRIVATE_MEDIA_BUCKETS as readonly string[]).includes(bucket);
}

/**
 * Como uma referência de mídia deve ser resolvida para exibição/envio.
 *
 * - `storage`  → objeto nosso; precisa de URL assinada.
 * - `proxy`    → mídia recebida da Meta; precisa de fetch autenticado
 *                na rota-proxy (que agora também autoriza — F-40-A).
 * - `external` → URL de terceiro colada pelo usuário; usar como está.
 * - `none`     → não há mídia.
 */
export type MediaRef =
  | { kind: 'storage'; bucket: PrivateMediaBucket; path: string }
  | { kind: 'proxy'; url: string; mediaId: string }
  | { kind: 'external'; url: string }
  | { kind: 'none' };

/**
 * Resolve a referência a partir do que está gravado na linha.
 *
 * `path` (coluna `media_path`, migração 040) tem precedência sobre
 * `url`: é a fonte de verdade para o que subimos depois da 040, e evita
 * ter de reverter a URL por regex a cada leitura. `url` cobre (a) todo
 * o histórico anterior à 040, (b) mídia recebida, e (c) URL externa.
 */
export function resolveMediaRef(
  url: string | null | undefined,
  path?: string | null
): MediaRef {
  if (path) {
    // O bucket não é persistido junto do path: `chat-media` é o único
    // que grava em `messages`, e o flow guarda a URL inteira no config
    // do nó. Se algum dia isso mudar, vira uma coluna a mais.
    return { kind: 'storage', bucket: 'chat-media', path };
  }

  if (!url) return { kind: 'none' };

  const mediaId = parseProxyMediaUrl(url);
  if (mediaId) return { kind: 'proxy', url, mediaId };

  const storage = parseStorageUrl(url);
  if (storage) {
    return { kind: 'storage', bucket: storage.bucket, path: storage.path };
  }

  return { kind: 'external', url };
}

/**
 * Validade da URL assinada, em segundos.
 *
 * 10 minutos é folgado para os dois consumidores e curto o bastante
 * para que um link vazado não seja um problema permanente:
 *   • a Meta baixa o arquivo UMA vez, no instante do envio, e re-hospeda
 *     por conta própria — não precisa da nossa URL depois disso;
 *   • o navegador do agente carrega a mídia logo após pedir a
 *     assinatura.
 */
export const SIGNED_URL_TTL_SECONDS = 600;
