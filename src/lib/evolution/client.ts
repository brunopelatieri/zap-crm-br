/**
 * Cliente HTTP da Evolution Go — só as chamadas de GERENCIAMENTO de
 * instância que a F3 usa (SPEC 048 §7). O adaptador de MENSAGERIA
 * (`sendText`, `normalizeInbound`, o webhook inbound) é a F4 e vive à
 * parte, em `src/lib/channels/adapters/evolution.ts` — este arquivo não
 * é aquele, de propósito: nada aqui é registrado em `registry.ts`.
 *
 * Tudo neste módulo segue o que a sondagem contra o servidor real
 * mediu (SPEC 048 §1), não o que a documentação afirma:
 *
 *   - Erro vem como `{"error":"not authorized"}` (string plana) em
 *     JSON, ou `text/plain` cru em 404 — nunca o envelope
 *     `{success,error:{code,message}}` que a referência descreve.
 *   - Sucesso convive em três formatos (`{data,message}`, objeto cru,
 *     array cru) — `unwrap()` nunca assume `body.data`.
 *   - O escopo de chave é POR ENDPOINT, não por prefixo de path — o
 *     mapa abaixo é explícito por isso mesmo.
 */

import type { EvolutionConfig } from './config';

export type EvolutionKeyScope = 'global' | 'instance';

/**
 * Escopo de chave por endpoint (SPEC 048 §1.2 R1). Deduzir pelo
 * prefixo do path produz 401 intermitente e difícil de diagnosticar —
 * por isso cada rota que este módulo chama está listada aqui, e não
 * inferida.
 */
export const EVOLUTION_KEY_SCOPE = {
  '/instance/all': 'global',
  '/instance/create': 'global',
  '/instance/delete': 'global',
  '/instance/proxy': 'global',
  '/instance/connect': 'instance',
  '/instance/qr': 'instance',
  '/instance/pair': 'instance',
  '/instance/status': 'instance',
  '/instance/disconnect': 'instance',
  '/instance/logout': 'instance',
  '/instance/reconnect': 'instance',
  '/instance/advanced-settings': 'instance',
  '/instance/logs': 'instance',
  // Mensageria (F4, SPEC 048 §2) — todas de escopo 'instance'.
  '/send/text': 'instance',
  '/send/media': 'instance',
  '/send/location': 'instance',
  '/send/poll': 'instance',
  '/message/react': 'instance',
  '/message/markread': 'instance',
  '/message/presence': 'instance',
  '/message/downloadmedia': 'instance',
} as const satisfies Record<string, EvolutionKeyScope>;

export type EvolutionErrorKind =
  'channel_auth_failed' | 'bad_request' | 'not_found' | 'channel_unavailable';

export class EvolutionApiError extends Error {
  readonly kind: EvolutionErrorKind;
  readonly status: number;

  constructor(kind: EvolutionErrorKind, status: number, message: string) {
    super(message);
    this.name = 'EvolutionApiError';
    this.kind = kind;
    this.status = status;
  }
}

function errorKindForStatus(status: number): EvolutionErrorKind {
  if (status === 401 || status === 403) return 'channel_auth_failed';
  if (status === 400) return 'bad_request';
  if (status === 404) return 'not_found';
  return 'channel_unavailable';
}

/**
 * `data.qrcode ?? data.Qrcode ?? data.qrCode` — a grafia real é
 * minúscula (SPEC 048 §1.3 R9); a referência documenta `Qrcode`. Lido
 * defensivamente porque o Swagger tipa a resposta como mapa genérico.
 */
export function unwrap(body: unknown): Record<string, unknown> {
  if (
    body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    'data' in body
  ) {
    const data = (body as { data: unknown }).data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
  }
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  // Array cru (ex.: /instance/logs) ou primitivo — nenhum chamador
  // deste módulo lê um array por chave; devolver {} evita um cast
  // enganoso em vez de um objeto que finge ter propriedades nomeadas.
  return {};
}

/**
 * A instância já está pareada — `GET /instance/qr` devolve
 * `400 {"error":"session already logged in"}` (SPEC 048 §1.3). Não é
 * uma falha: a UI fecha o diálogo de conexão como se tivesse pareado.
 */
export function isAlreadyLoggedInError(err: unknown): boolean {
  return (
    err instanceof EvolutionApiError &&
    err.status === 400 &&
    /already logged in/i.test(err.message)
  );
}

interface EvolutionRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Chave a usar. Para escopo 'instance', o token JÁ decriptado. */
  key: string;
  body?: unknown;
}

/**
 * Requisição central. Timeout via `AbortController`, leitura
 * defensiva do erro (string plana OU `text/plain` cru), nunca assume
 * o envelope da referência.
 */
export async function evolutionRequest(
  config: EvolutionConfig,
  path: string,
  { method = 'GET', key, body }: EvolutionRequestOptions
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  let response: Response;
  try {
    response = await fetch(`${config.apiUrl}${path}`, {
      method,
      headers: {
        apikey: key,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    const message = err instanceof Error ? err.message : String(err);
    throw new EvolutionApiError(
      'channel_unavailable',
      0,
      `Evolution request failed: ${message}`
    );
  } finally {
    clearTimeout(timeout);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const raw = await response.text();
  const parsed =
    contentType.includes('application/json') && raw ? safeJsonParse(raw) : null;

  if (!response.ok) {
    // 404 costuma vir como `text/plain` cru ("404 page not found"), e
    // 401 como `{"error":"not authorized"}` — string plana, não o
    // envelope {success,error:{code,message}} da referência.
    const message =
      typeof (parsed as { error?: unknown } | null)?.error === 'string'
        ? (parsed as { error: string }).error
        : ((parsed as { error?: { message?: string } } | null)?.error
            ?.message ??
          (parsed as { message?: string } | null)?.message ??
          (raw.trim() || `HTTP ${response.status}`));

    throw new EvolutionApiError(
      errorKindForStatus(response.status),
      response.status,
      message
    );
  }

  return parsed ?? raw;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
