/**
 * POST /api/channels/evolution/instances/[id]/logout (SPEC 048 §7)
 *
 * Desvincula o aparelho — a instância precisa de um QR (ou código)
 * novo para voltar a falar com o WhatsApp.
 */

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { logoutInstance } from '@/lib/evolution/instances';
import { toEvolutionErrorResponse } from '@/lib/evolution/respond';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

type Params = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Params) {
  try {
    const { accountId, userId } = await requireRole('admin');
    const { id } = await params;

    const limit = checkRateLimit(
      `evolution:instanceAction:${userId}`,
      RATE_LIMITS.evolutionInstanceAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    await logoutInstance(accountId, id);
    return NextResponse.json({ success: true });
  } catch (err) {
    return toEvolutionErrorResponse(err);
  }
}
