/**
 * POST /api/channels/evolution/instances/[id]/disconnect (SPEC 048 §7)
 *
 * Pausa a sessão sem desvincular o aparelho — reconectável com
 * `POST .../reconnect`, sem novo QR.
 */

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { disconnectInstance } from '@/lib/evolution/instances';
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

    await disconnectInstance(accountId, id);
    return NextResponse.json({ success: true });
  } catch (err) {
    return toEvolutionErrorResponse(err);
  }
}
