/**
 * Erro tipado → resposta HTTP, para as rotas de
 * `/api/channels/evolution/instances/*` (SPEC 048 §7). Um `catch` só,
 * em toda rota:
 *
 *   } catch (err) {
 *     return toEvolutionErrorResponse(err);
 *   }
 */

import { NextResponse } from 'next/server';

import { ForbiddenError, UnauthorizedError } from '@/lib/auth/account';
import { EvolutionApiError } from './client';
import {
  EvolutionNotConfiguredError,
  InstanceLimitReachedError,
  InstanceNotFoundError,
} from './instances';

export function toEvolutionErrorResponse(err: unknown): NextResponse {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }

  if (err instanceof EvolutionNotConfiguredError) {
    return NextResponse.json({ error: err.message }, { status: 503 });
  }

  if (err instanceof InstanceLimitReachedError) {
    return NextResponse.json(
      { error: err.message, reason: err.decision.reason },
      { status: 409 }
    );
  }

  if (err instanceof InstanceNotFoundError) {
    return NextResponse.json({ error: err.message }, { status: 404 });
  }

  if (err instanceof EvolutionApiError) {
    // bad_request/not_found refletem o que FOI PEDIDO (ex.: telefone
    // inválido no pareamento) — repassados como estão. auth_failed e
    // channel_unavailable são falhas do LADO SERVIDOR (token rotacionado
    // na VPS, VPS fora do ar) — 502/503, nunca 4xx do nosso lado.
    const status =
      err.kind === 'bad_request'
        ? 400
        : err.kind === 'not_found'
          ? 404
          : err.kind === 'channel_auth_failed'
            ? 502
            : 503;
    return NextResponse.json(
      { error: `Evolution API error: ${err.message}`, kind: err.kind },
      { status }
    );
  }

  console.error('[evolution] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}
