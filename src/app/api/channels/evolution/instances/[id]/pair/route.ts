/**
 * POST /api/channels/evolution/instances/[id]/pair (SPEC 048 §7)
 *
 * Alternativa ao QR: informa o telefone, devolve um código de 8
 * dígitos para digitar no aparelho. Admin+, mesma sensibilidade do QR.
 */

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { pairInstanceByPhone } from '@/lib/evolution/instances';
import { toEvolutionErrorResponse } from '@/lib/evolution/respond';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const { accountId, userId } = await requireRole('admin');
    const { id } = await params;

    const limit = checkRateLimit(
      `evolution:instanceAction:${userId}`,
      RATE_LIMITS.evolutionInstanceAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      phone?: unknown;
    } | null;
    const phone = typeof body?.phone === 'string' ? body.phone.trim() : '';
    if (!/^\d{10,15}$/.test(phone)) {
      return NextResponse.json(
        {
          error:
            "'phone' must be digits only (DDI+DDD+number, e.g. 5511999999999)",
        },
        { status: 400 }
      );
    }

    const result = await pairInstanceByPhone(accountId, id, phone);
    return NextResponse.json(result);
  } catch (err) {
    return toEvolutionErrorResponse(err);
  }
}
