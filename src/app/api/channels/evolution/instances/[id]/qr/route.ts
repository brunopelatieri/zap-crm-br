/**
 * GET /api/channels/evolution/instances/[id]/qr (SPEC 048 §7)
 *
 * Proxy do QR — NUNCA persistido, NUNCA cacheado (PRD §11: "QR
 * interceptado = sequestro da sessão WhatsApp"). Só admin+, ao
 * contrário das outras rotas GET desta API que qualquer membro pode
 * chamar.
 *
 * `GET /instance/qr` custa ~3s fixos na Evolution (SPEC 048 §1.3 R7) —
 * não é um endpoint para polling curto; o diálogo de conexão chama
 * isto quando abre e a cada ~60s (contagem regressiva do QR), nunca
 * mais rápido que isso.
 */

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { getInstanceQr } from '@/lib/evolution/instances';
import { toEvolutionErrorResponse } from '@/lib/evolution/respond';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const { accountId, userId } = await requireRole('admin');
    const { id } = await params;

    const limit = checkRateLimit(
      `evolution:instanceQr:${userId}`,
      RATE_LIMITS.evolutionInstanceQr
    );
    if (!limit.success) return rateLimitResponse(limit);

    const result = await getInstanceQr(accountId, id);

    return new NextResponse(JSON.stringify(result), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // O QR muda a cada chamada e é sensível — nunca deixar um proxy
        // ou o browser guardar isto.
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (err) {
    return toEvolutionErrorResponse(err);
  }
}
