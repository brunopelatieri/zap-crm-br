import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ASSIGNMENT_ERROR,
  claimConversation,
  reassignConversation,
} from './assignment';

// ---------------------------------------------------------------------------
// Testes de unidade do mapeamento SQLSTATE → HTTP. A garantia de
// concorrência em si (duas transações disputando a mesma linha, exatamente
// um vencedor) é do Postgres, não desta camada — não dá para provar um lock
// de linha real mockando `rpc()`. Essa prova já existe em
// scripts/verify-039-rls.sql (Parte C, duas abas do SQL editor contra o
// projeto real) e foi verificada manualmente na Fase 1.
//
// O que ESTA camada precisa garantir, e que é testável sem banco: quando o
// RPC informa que outro agente venceu a corrida, o resultado é SEMPRE um 409
// com o código certo — nunca um 500 opaco, nunca um `ok: true` por engano.
// ---------------------------------------------------------------------------

function makeSupabase(rpcResult: {
  data?: unknown;
  error?: { message: string } | null;
}) {
  return {
    rpc: vi.fn(async () => ({
      data: rpcResult.data ?? null,
      error: rpcResult.error ?? null,
    })),
  } as unknown as SupabaseClient;
}

describe('claimConversation', () => {
  it('returns ok with the row on success', async () => {
    const row = { id: 'conv-1', assigned_agent_id: 'user-1' };
    const supabase = makeSupabase({ data: row });

    const result = await claimConversation(supabase, 'conv-1');

    expect(result).toEqual({ ok: true, conversation: row });
    expect(supabase.rpc).toHaveBeenCalledWith('claim_conversation', {
      p_conversation_id: 'conv-1',
    });
  });

  // O caso mais importante: o agente que perde a corrida nunca pode ler
  // isso como sucesso, nem como um erro genérico que o chamador ignore.
  it('maps CONVERSATION_ALREADY_CLAIMED to a 409', async () => {
    const supabase = makeSupabase({
      error: { message: ASSIGNMENT_ERROR.ALREADY_CLAIMED },
    });

    const result = await claimConversation(supabase, 'conv-1');

    expect(result).toEqual({
      ok: false,
      status: 409,
      code: ASSIGNMENT_ERROR.ALREADY_CLAIMED,
      error: expect.any(String),
    });
  });

  it('maps CONVERSATION_NOT_FOUND to a generic 404 (never confirms existence)', async () => {
    const supabase = makeSupabase({
      error: { message: ASSIGNMENT_ERROR.NOT_FOUND },
    });

    const result = await claimConversation(supabase, 'conv-1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      // F-11: a mensagem não pode distinguir "não existe" de "não é sua".
      expect(result.error.toLowerCase()).not.toMatch(/permission|forbidden/);
    }
  });

  it('maps INSUFFICIENT_ROLE to a 403', async () => {
    const supabase = makeSupabase({
      error: { message: ASSIGNMENT_ERROR.INSUFFICIENT_ROLE },
    });

    const result = await claimConversation(supabase, 'conv-1');

    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('falls back to a 500 for an unrecognized error message', async () => {
    const supabase = makeSupabase({ error: { message: 'boom' } });

    const result = await claimConversation(supabase, 'conv-1');

    expect(result).toMatchObject({ ok: false, status: 500 });
  });
});

describe('reassignConversation', () => {
  it('returns ok with the row on success', async () => {
    const row = { id: 'conv-1', assigned_agent_id: 'user-2' };
    const supabase = makeSupabase({ data: row });

    const result = await reassignConversation(supabase, 'conv-1', 'user-2');

    expect(result).toEqual({ ok: true, conversation: row });
    expect(supabase.rpc).toHaveBeenCalledWith('reassign_conversation', {
      p_conversation_id: 'conv-1',
      p_target_user_id: 'user-2',
    });
  });

  it('passes null through for "release to queue"', async () => {
    const supabase = makeSupabase({ data: { id: 'conv-1' } });

    await reassignConversation(supabase, 'conv-1', null);

    expect(supabase.rpc).toHaveBeenCalledWith('reassign_conversation', {
      p_conversation_id: 'conv-1',
      p_target_user_id: null,
    });
  });

  it('maps ONLY_ADMIN_CAN_REASSIGN_TO_OTHERS to a 403', async () => {
    const supabase = makeSupabase({
      error: { message: ASSIGNMENT_ERROR.ONLY_ADMIN },
    });

    const result = await reassignConversation(supabase, 'conv-1', 'user-2');

    expect(result).toMatchObject({
      ok: false,
      status: 403,
      code: ASSIGNMENT_ERROR.ONLY_ADMIN,
    });
  });

  it('maps INVALID_ASSIGNEE to a 400 (target not a same-account agent+)', async () => {
    const supabase = makeSupabase({
      error: { message: ASSIGNMENT_ERROR.INVALID_ASSIGNEE },
    });

    const result = await reassignConversation(supabase, 'conv-1', 'outsider');

    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it('maps NOT_CONVERSATION_OWNER to a 403', async () => {
    const supabase = makeSupabase({
      error: { message: ASSIGNMENT_ERROR.NOT_OWNER },
    });

    const result = await reassignConversation(supabase, 'conv-1', 'user-2');

    expect(result).toMatchObject({ ok: false, status: 403 });
  });
});
