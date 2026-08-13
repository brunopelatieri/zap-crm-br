/**
 * GET /api/channels/evolution/instances/[id]/status (SPEC 048 §7)
 *
 * Status ao vivo — qualquer membro pode ver (mesma postura de
 * `evolution_instances_select`: leitura é aberta, escrita é admin+).
 * Usado pelo polling de segurança do diálogo de conexão (o evento
 * `CONNECTION` do webhook, quando a F4 chegar, é o caminho rápido; isto
 * é só a rede de segurança).
 */

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { getInstanceLiveStatus } from '@/lib/evolution/instances';
import { toEvolutionErrorResponse } from '@/lib/evolution/respond';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const { accountId, userId } = await requireRole('viewer');
    const { id } = await params;

    const limit = checkRateLimit(
      `evolution:instanceAction:${userId}`,
      RATE_LIMITS.evolutionInstanceAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const result = await getInstanceLiveStatus(accountId, id);
    return NextResponse.json(result);
  } catch (err) {
    return toEvolutionErrorResponse(err);
  }
}
