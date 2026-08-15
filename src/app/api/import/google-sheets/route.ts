/**
 * POST /api/import/google-sheets
 *
 * Proxy fino e vigiado para o export CSV de uma planilha pública do
 * Google (SPEC 044 §3.2.2, SPEC 052 D-8). Devolve o CSV **cru** em
 * `text/csv`, não linhas já parseadas: o cliente entrega esse texto ao
 * mesmo parser que processa um arquivo local, então existe um único
 * caminho de parsing para as três fontes.
 *
 * Rota NEUTRA de propósito (SPEC 052 D-8): a antiga
 * `/api/broadcasts/audience/google-sheets` funcionava para o
 * importador de contatos também (mesmo piso de papel —
 * `requireRole('agent')` ≡ `useCan('send-messages')`), mas o caminho e
 * o log mentiam sobre quem chama. Uma implementação, um lugar, para os
 * dois consumidores (passo 2 do disparo e — quando a F5 chegar — o
 * importador de contatos).
 *
 * Por que isto precisa ser server-side
 *
 *   1. O Google não manda CORS no endpoint de export — o navegador não
 *      consegue ler a resposta.
 *   2. Mesmo que conseguisse, a requisição sairia com os cookies do
 *      Google do próprio usuário, o que mudaria o que é "público".
 *
 * A proteção contra SSRF mora em `@/lib/spreadsheet/google-sheets`: a
 * URL colada nunca é usada; extraímos o id e reconstruímos a URL a
 * partir de uma constante.
 */

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  MAX_SHEET_BYTES,
  SheetFetchError,
  fetchGoogleSheetCsv,
} from '@/lib/spreadsheet/google-sheets';
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
    // Mesmo piso de papel dos dois consumidores hoje: importar
    // audiência faz parte de criar disparo, importar contato exige o
    // mesmo `useCan('send-messages')` na tela de contatos.
    const { userId } = await requireRole('agent');

    // Chave por usuário, não por origem: é o Google que está sendo
    // protegido, e não importa se o pedido veio do passo 2 do disparo
    // ou do importador de contatos (SPEC 052 D-8).
    const limit = checkRateLimit(
      `sheet-import:${userId}`,
      RATE_LIMITS.spreadsheetImport
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
