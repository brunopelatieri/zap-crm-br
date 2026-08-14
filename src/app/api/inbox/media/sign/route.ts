import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { signStoragePath } from '@/lib/storage/sign-media';
import {
  isPrivateMediaBucket,
  parseStorageUrl,
  type PrivateMediaBucket,
} from '@/lib/storage/media-url';

/**
 * POST /api/inbox/media/sign  (viewer+)
 *
 * Body: `{ url }` (a URL guardada na linha) **ou** `{ bucket, path }`.
 * Resposta: `{ url }` — assinada, de vida curta.
 *
 * Existe porque a migração 040 tornou `chat-media` e `flow-media`
 * privados: o browser não consegue mais montar a URL sozinho, e não
 * deve — quem decide se o objeto pode ser lido é o servidor.
 *
 * ## Onde mora a autorização
 *
 * Não está escrita aqui, de propósito. `requireRole` resolve o cliente
 * de SESSÃO, e `createSignedUrl` só devolve uma URL se a política de
 * leitura da 040 deixar — "ser membro da conta dona da pasta
 * `account-<uuid>`". Reimplementar essa checagem em TypeScript criaria
 * uma segunda fonte de verdade que divergiria da política no primeiro
 * ajuste.
 *
 * Isso torna a rota genérica: serve mídia de mensagem, header de
 * template e anexo de nó de flow com o mesmo código, porque os três
 * vivem nos mesmos buckets e sob a mesma política.
 *
 * ## Por que aceita URL, e não só caminho
 *
 * Os campos que guardam mídia no banco nem sempre são nossos:
 * `header_media_url` e o `media_url` de nó de flow aceitam URL externa
 * colada pelo usuário. O cliente manda o que está gravado e esta rota
 * responde 400 para o que não for de um bucket nosso — o chamador
 * então usa a URL original, que é o comportamento certo para link de
 * terceiro.
 *
 * Respostas:
 *   200 → { url } assinada
 *   400 → payload inválido, ou a URL não aponta para um bucket nosso
 *   404 → objeto inexistente OU fora do alcance do chamador
 *         (indistinguível de propósito — um 403 confirmaria que o
 *          arquivo existe; mesma regra de `lib/inbox/assignment.ts`)
 */
export async function POST(request: Request) {
  try {
    const { supabase, userId } = await requireRole('viewer');

    // Abrir uma thread com muitas mídias dispara várias assinaturas em
    // sequência — mesmo perfil de rajada das reações, então o mesmo
    // bucket folgado.
    const limit = checkRateLimit(`media-sign:${userId}`, RATE_LIMITS.react);
    if (!limit.success) return rateLimitResponse(limit);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const target = resolveTarget(body);
    if (!target) {
      return NextResponse.json(
        {
          error:
            'Body must be { url } pointing at a managed bucket, or { bucket, path }',
        },
        { status: 400 }
      );
    }

    const signed = await signStoragePath(supabase, target.bucket, target.path);

    if (!signed) {
      return NextResponse.json({ error: 'Media not found' }, { status: 404 });
    }

    return NextResponse.json({ url: signed });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Normaliza as duas formas de payload num par `{ bucket, path }`. */
function resolveTarget(
  body: unknown
): { bucket: PrivateMediaBucket; path: string } | null {
  if (typeof body !== 'object' || body === null) return null;
  const { url, bucket, path } = body as {
    url?: unknown;
    bucket?: unknown;
    path?: unknown;
  };

  if (typeof url === 'string' && url) {
    return parseStorageUrl(url);
  }

  if (typeof bucket === 'string' && typeof path === 'string' && path) {
    // Sem `..`: o SDK do Storage trata o caminho como opaco, mas
    // normalizar aqui evita que uma travessia chegue a ser tentada.
    if (path.includes('..')) return null;
    if (!isPrivateMediaBucket(bucket)) return null;
    return { bucket, path };
  }

  return null;
}
