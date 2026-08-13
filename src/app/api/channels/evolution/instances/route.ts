/**
 * /api/channels/evolution/instances (SPEC 048 §7)
 *
 *   GET  — lista as instâncias da conta (qualquer membro vê status,
 *          igual a `channels_select`), com o estado do limite D-1 e se
 *          a integração está configurada no deployment.
 *   POST — cria uma instância (admin+): nome namespaced, `create` na
 *          VPS, guarda o token cifrado, encadeia `connect`.
 *
 * A chave global e os tokens de instância NUNCA chegam ao browser —
 * toda chamada à Evolution acontece dentro de `lib/evolution/`, com
 * `supabaseAdmin()`.
 */

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { isEvolutionConfigured } from '@/lib/evolution/config';
import {
  createEvolutionInstance,
  getInstanceLimitStatus,
  listEvolutionInstances,
} from '@/lib/evolution/instances';
import { toEvolutionErrorResponse } from '@/lib/evolution/respond';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

const MAX_LABEL_LENGTH = 60;

export async function GET() {
  try {
    // Viewer: leitura de status é aberta a qualquer membro (mesma
    // postura de `evolution_instances_select` — só a escrita é
    // admin+). O front decide o que oferecer com base no papel.
    const { accountId } = await requireRole('viewer');

    if (!isEvolutionConfigured()) {
      return NextResponse.json({
        configured: false,
        instances: [],
        limit: null,
      });
    }

    const [instances, limit] = await Promise.all([
      listEvolutionInstances(accountId),
      getInstanceLimitStatus(accountId),
    ]);

    return NextResponse.json({ configured: true, instances, limit });
  } catch (err) {
    return toEvolutionErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin');

    const limit = checkRateLimit(
      `evolution:instanceCreate:${userId}`,
      RATE_LIMITS.evolutionInstanceCreate
    );
    if (!limit.success) return rateLimitResponse(limit);

    if (!isEvolutionConfigured()) {
      return NextResponse.json(
        {
          error:
            'EVOLUTION_API_URL is not configured on this deployment — the WhatsApp QRCode channel is disabled',
        },
        { status: 503 }
      );
    }

    const body = (await request.json().catch(() => null)) as {
      label?: unknown;
    } | null;
    const label = typeof body?.label === 'string' ? body.label.trim() : '';
    if (!label) {
      return NextResponse.json(
        { error: "'label' is required" },
        { status: 400 }
      );
    }
    if (label.length > MAX_LABEL_LENGTH) {
      return NextResponse.json(
        { error: `label must be ${MAX_LABEL_LENGTH} characters or fewer` },
        { status: 400 }
      );
    }

    const result = await createEvolutionInstance({
      accountId,
      userId,
      label,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return toEvolutionErrorResponse(err);
  }
}
