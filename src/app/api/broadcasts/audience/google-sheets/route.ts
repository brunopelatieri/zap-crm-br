/**
 * POST /api/broadcasts/audience/google-sheets
 *
 * Proxy fino e vigiado para o export CSV de uma planilha pública do
 * Google (SPEC 044 §3.2.2). Devolve o CSV **cru** em `text/csv`, não
 * linhas já parseadas: o cliente entrega esse texto ao mesmo Worker
 * que processa um arquivo local, então existe um único caminho de
 * parsing para as três fontes.
 *
 * Por que isto precisa ser server-side
 *
 *   1. O Google não manda CORS no endpoint de export — o navegador não
 *      consegue ler a resposta.
 *   2. Mesmo que conseguisse, a requisição sairia com os cookies do
 *      Google do próprio usuário, o que mudaria o que é "público".
 *
 * A proteção contra SSRF mora em `@/lib/audience/google-sheets`: a URL
 * colada nunca é usada; extraímos o id e reconstruímos a URL a partir
 * de uma constante.
 */

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  MAX_SHEET_BYTES,
  SheetFetchError,
  fetchGoogleSheetCsv,
} from '@/lib/audience/google-sheets';
import {
  RATE_LIMITS,
  checkRateLimit,
  rateLimitResponse,
} from '@/lib/rate-limit';

/** Códigos de erro → status HTTP. Tudo o mais é 502. */
const STATUS_BY_CODE: Record<string, number> = {
  invalid_url: 400,
  not_public: 403,
  not_found: 404,
  too_large: 413,
  timeout: 504,
  fetch_failed: 502,
};

export async function POST(request: Request) {
  try {
    // Importar audiência faz parte de criar disparo — mesmo piso de
    // papel que enviar mensagem.
    const { userId } = await requireRole('agent');

    const limit = checkRateLimit(
      `audience-import:${userId}`,
      RATE_LIMITS.audienceImport
    );
    if (!limit.success) return rateLimitResponse(limit);

    let url: unknown;
    try {
      ({ url } = await request.json());
    } catch {
      return NextResponse.json(
        { error: 'Corpo inválido', code: 'invalid_url' },
        { status: 400 }
      );
    }

    if (typeof url !== 'string' || !url.trim()) {
      return NextResponse.json(
        { error: "'url' é obrigatório", code: 'invalid_url' },
        { status: 400 }
      );
    }

    const csv = await fetchGoogleSheetCsv(url);

    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        // O tamanho já foi conferido em `fetchGoogleSheetCsv`; repetir
        // o teto aqui documenta o contrato para quem lê a rota.
        'X-Max-Bytes': String(MAX_SHEET_BYTES),
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    if (err instanceof SheetFetchError) {
      // `code` é estável e é o que a UI traduz; `error` é só para log
      // e para quem chama a rota fora do app.
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: STATUS_BY_CODE[err.code] ?? 502 }
      );
    }
    return toErrorResponse(err);
  }
}
