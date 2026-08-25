// ============================================================
// Log de erros/avisos do webhook de entrada (SPEC 055 D-11/D-13).
//
// `logIngestEvent` é BEST-EFFORT e NUNCA LANÇA — mesma disciplina de
// `dispatchWebhookEvent` (webhooks de saída): uma falha ao gravar o
// log não pode derrubar a requisição que o log está registrando.
//
// O payload é truncado em 8 KB antes de gravar (D-13) — o log é para
// depurar FORMA, não para arquivar conteúdo. Acima do limite, a linha
// grava só `{ _truncated: true, _size: N }`.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

/** 8 KB — também usado pela rota para decidir o aviso `payload_truncated`. */
export const PAYLOAD_MAX_BYTES = 8 * 1024;

export type IngestLogLevel = 'error' | 'warning';

export interface LogIngestEventParams {
  accountId: string;
  apiKeyId: string;
  webhookId?: string | null;
  webhookName?: string | null;
  level: IngestLogLevel;
  code: string;
  message: string;
  /** Como recebido, sem normalizar — é o que falhou. */
  phone?: string | null;
  contactId?: string | null;
  broadcastId?: string | null;
  /** Corpo recebido. `undefined` grava `null` (nunca envia headers). */
  payload?: unknown;
}

function truncatePayload(payload: unknown): unknown {
  if (payload === undefined) return null;

  let json: string;
  try {
    json = JSON.stringify(payload);
  } catch {
    return { _truncated: true, _size: -1 };
  }

  const size = Buffer.byteLength(json, 'utf8');
  if (size <= PAYLOAD_MAX_BYTES) return payload;
  return { _truncated: true, _size: size };
}

/**
 * Grava uma linha em `webhook_ingest_logs`. Best-effort: qualquer
 * falha (erro do Supabase, exceção síncrona) é engolida e logada no
 * console do servidor — a promessa devolvida sempre resolve.
 */
export async function logIngestEvent(
  db: SupabaseClient,
  params: LogIngestEventParams
): Promise<void> {
  try {
    const { error } = await db.from('webhook_ingest_logs').insert({
      account_id: params.accountId,
      api_key_id: params.apiKeyId,
      webhook_id: params.webhookId ?? null,
      webhook_name: params.webhookName ?? null,
      level: params.level,
      code: params.code,
      message: params.message,
      phone: params.phone ?? null,
      contact_id: params.contactId ?? null,
      broadcast_id: params.broadcastId ?? null,
      payload: truncatePayload(params.payload),
    });
    if (error) {
      console.error(
        '[ingest/log] failed to write webhook_ingest_logs row:',
        error
      );
    }
  } catch (err) {
    console.error(
      '[ingest/log] unexpected error writing webhook_ingest_logs row:',
      err
    );
  }
}
