import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { claimConversation } from '@/lib/inbox/assignment';
import { isUuid } from '@/lib/api/uuid';

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/inbox/conversations/[id]/claim  (agent+)
 *
 * Reivindica uma conversa da fila (aba "Open") para o agente que
 * chama. É a única forma suportada de assumir uma conversa — o
 * `.update({ assigned_agent_id })` direto do browser que existia antes
 * não tinha condição nenhuma e permitia que dois agentes "vencessem"
 * a mesma corrida, cada um achando que a thread era sua.
 *
 * Respostas:
 *   200 → { conversation }  reivindicada (ou já era do chamador)
 *   409 → CONVERSATION_ALREADY_CLAIMED — outro agente venceu a corrida.
 *         O cliente deve tratar isto como estado normal: remove o item
 *         da fila e avisa, sem abrir a thread.
 *   403 → papel insuficiente (viewer)
 *   404 → não existe, ou é invisível para o chamador (indistinguível
 *         de propósito — ver `mapError` em lib/inbox/assignment.ts)
 */
export async function POST(_request: Request, { params }: Params) {
  try {
    const { supabase, userId } = await requireRole('agent');

    // Mesmo bucket do envio: é uma ação de clique no inbox, e
    // reivindicar em laço não tem uso legítimo.
    const limit = checkRateLimit(`inbox-claim:${userId}`, RATE_LIMITS.send);
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    if (!isUuid(id)) {
      return NextResponse.json(
        { error: 'Invalid conversation id' },
        { status: 400 }
      );
    }

    const result = await claimConversation(supabase, id);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, code: result.code },
        { status: result.status }
      );
    }

    return NextResponse.json({ conversation: result.conversation });
  } catch (err) {
    return toErrorResponse(err);
  }
}
