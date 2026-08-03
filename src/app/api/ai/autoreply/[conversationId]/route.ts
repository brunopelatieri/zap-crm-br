import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

type Params = { params: Promise<{ conversationId: string }> };

/**
 * POST /api/ai/autoreply/[conversationId]  (agent+)
 *
 * Toggle the AI auto-reply bot for one conversation from the inbox — the
 * "Take over" / "Resume AI" banner.
 *
 * Body: { paused: boolean, assign_to_me?: boolean }
 *   - paused: true  → pause the bot here (a human is taking over). When
 *                     `assign_to_me` is set, also assign the thread to the
 *                     caller (the usual "Take over" flow). Assignment
 *                     fires the `on_conversation_assigned` trigger.
 *   - paused: false → hand the thread back to the bot: clear the pause,
 *                     reset the per-conversation reply count so it gets
 *                     fresh slots, and clear the handoff note. If the
 *                     caller currently owns the thread, unassign it too so
 *                     the bot isn't blocked by the "human owns this" gate.
 *
 * Writes go through the RLS-scoped SSR client, so a conversation outside
 * the caller's account simply isn't found (404).
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');

    // Reuse the send bucket: this is a cheap per-user inbox action and
    // toggling it in a tight loop has no legitimate use.
    const limit = checkRateLimit(`ai-takeover:${userId}`, RATE_LIMITS.send);
    if (!limit.success) return rateLimitResponse(limit);

    const { conversationId } = await params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body.paused !== 'boolean') {
      return NextResponse.json(
        { error: 'paused (boolean) is required' },
        { status: 400 }
      );
    }
    const paused = body.paused as boolean;
    const assignToMe = body.assign_to_me === true;

    // Confirm the conversation is in the caller's account before writing.
    const { data: conv, error: convErr } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (convErr) {
      console.error('[ai/autoreply] conversation lookup error:', convErr);
      return NextResponse.json(
        { error: 'Failed to load conversation' },
        { status: 500 }
      );
    }
    if (!conv) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    const update: Record<string, unknown> = { ai_autoreply_disabled: paused };

    if (paused) {
      if (assignToMe) update.assigned_agent_id = userId;
    } else {
      // Resuming hands the thread *back to the bot*. Clear the pause and
      // the handoff note, and — crucially — release ANY assignment, not
      // just the caller's own: the auto-reply eligibility gate stands
      // down whenever a human is assigned, so leaving a stale assignee
      // (e.g. the agent a prior handoff routed to) would silently keep
      // the bot muted and make "Resume AI" a no-op. This is the explicit
      // choice to let the bot own the thread again.
      //
      // "ANY assignment" deixou de ser irrestrito com a migração 039:
      // soltar a atribuição é uma reatribuição, e a política
      // `conversations_update` só a permite ao dono da thread ou a
      // admin/owner. Na prática um agente só alcança as próprias
      // conversas e as da fila — o caminho "resume para soltar a
      // conversa de outro, take over para pegá-la" está fechado no
      // banco. O `.select()` abaixo é o que impede a rota de mentir
      // quando a política recusa.
      update.assigned_agent_id = null;
      // Give the bot a fresh reply budget on this thread. This is a
      // deliberate, manual, rate-limited action (not automatable), so it
      // can't be used to bypass the per-conversation cap at scale — it's
      // a human choosing to re-engage the assistant.
      update.ai_reply_count = 0;
      update.ai_handoff_summary = null;
    }

    const { data: updated, error: upErr } = await supabase
      .from('conversations')
      .update(update)
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .select('id');
    if (upErr) {
      console.error('[ai/autoreply] update error:', upErr);
      return NextResponse.json(
        { error: 'Failed to update conversation' },
        { status: 500 }
      );
    }
    // Zero linhas sem erro = a política recusou a escrita (o PostgREST
    // não distingue "nada a atualizar" de "não pode atualizar"). Sem
    // esta checagem a rota devolveria `success: true` e a interface
    // mostraria a IA retomada numa thread que não mudou.
    if (!updated || updated.length === 0) {
      return NextResponse.json(
        { error: 'Only the assigned agent or an admin can do this' },
        { status: 403 }
      );
    }

    return NextResponse.json({ success: true, paused });
  } catch (err) {
    return toErrorResponse(err);
  }
}
