import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { findOrCreateInboxConversation } from './find-or-create-conversation';

// ------------------------------------------------------------
// Fake Supabase mínimo — só a tabela `conversations`, nos dois modos
// que a função usa: `select().eq().eq().eq().maybeSingle()` e
// `insert().select().single()`.
// ------------------------------------------------------------
interface Script {
  existing?: { id: string; assigned_agent_id: string | null } | null;
  inserted?: { id: string; assigned_agent_id: string | null };
  insertError?: { code?: string; message?: string } | null;
}

function makeDb(script: Script): SupabaseClient {
  let mode: 'select' | 'insert' = 'select';
  let insertPayload: Record<string, unknown> | null = null;

  const builder: Record<string, unknown> = {
    select: () => builder,
    insert: (payload: Record<string, unknown>) => {
      mode = 'insert';
      insertPayload = payload;
      return builder;
    },
    eq: () => builder,
    maybeSingle: () =>
      Promise.resolve({ data: script.existing ?? null, error: null }),
    single: () => {
      if (script.insertError) {
        return Promise.resolve({ data: null, error: script.insertError });
      }
      return Promise.resolve({ data: script.inserted, error: null });
    },
  };

  return {
    from: () => builder,
    // Exposto só para o teste inspecionar o payload do INSERT.
    __insertPayload: () => insertPayload,
    __mode: () => mode,
  } as unknown as SupabaseClient;
}

describe('findOrCreateInboxConversation', () => {
  it('acha a thread existente e não tenta criar', async () => {
    const db = makeDb({
      existing: { id: 'conv-1', assigned_agent_id: 'agent-1' },
    });

    const result = await findOrCreateInboxConversation(
      db,
      'acct-1',
      'user-1',
      'contact-1',
      'chan-1'
    );

    expect(result).toEqual({
      ok: true,
      id: 'conv-1',
      assignedAgentId: 'agent-1',
    });
  });

  it('trata assigned_agent_id nulo da linha existente como null (não undefined)', async () => {
    const db = makeDb({
      existing: { id: 'conv-1', assigned_agent_id: null },
    });

    const result = await findOrCreateInboxConversation(
      db,
      'acct-1',
      'user-1',
      'contact-1',
      'chan-1'
    );

    expect(result).toEqual({ ok: true, id: 'conv-1', assignedAgentId: null });
  });

  it('cria a thread quando não existe, já ATRIBUÍDA a quem chamou', async () => {
    const db = makeDb({
      existing: null,
      inserted: { id: 'conv-new', assigned_agent_id: 'user-1' },
    });

    const result = await findOrCreateInboxConversation(
      db,
      'acct-1',
      'user-1',
      'contact-1',
      'chan-1'
    );

    expect(result).toEqual({
      ok: true,
      id: 'conv-new',
      assignedAgentId: 'user-1',
    });
    // A regra "quem fala, assume" (cabeçalho do módulo): o INSERT tem
    // que gravar assigned_agent_id = quem chamou, não deixar em branco
    // para um claim posterior.
    expect(
      (
        db as unknown as { __insertPayload: () => Record<string, unknown> }
      ).__insertPayload()
    ).toMatchObject({
      account_id: 'acct-1',
      user_id: 'user-1',
      contact_id: 'contact-1',
      channel_id: 'chan-1',
      assigned_agent_id: 'user-1',
    });
  });

  // O ramo que a extração desta função formalizou (§ cabeçalho do
  // módulo): colisão do índice único vira 409 "já sendo atendido" — NUNCA
  // re-resolve a linha vencedora, porque sob a RLS da 039 essa linha pode
  // pertencer a outro agente e ser invisível ao SELECT que já rodou.
  it('409 na colisão do índice único (23505) — nunca re-resolve', async () => {
    const db = makeDb({
      existing: null,
      insertError: { code: '23505', message: 'duplicate key' },
    });

    const result = await findOrCreateInboxConversation(
      db,
      'acct-1',
      'user-1',
      'contact-1',
      'chan-1'
    );

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: 'This contact is already being handled by another agent',
    });
  });

  it('500 para qualquer erro de INSERT que não seja violação de índice único', async () => {
    const db = makeDb({
      existing: null,
      insertError: { code: '42501', message: 'permission denied' },
    });

    const result = await findOrCreateInboxConversation(
      db,
      'acct-1',
      'user-1',
      'contact-1',
      'chan-1'
    );

    expect(result).toEqual({
      ok: false,
      status: 500,
      error: 'Failed to open a conversation for this contact',
    });
  });

  it('erro sem `code` nenhum também vira 500, não 409', async () => {
    const db = makeDb({
      existing: null,
      insertError: { message: 'network blip' },
    });

    const result = await findOrCreateInboxConversation(
      db,
      'acct-1',
      'user-1',
      'contact-1',
      'chan-1'
    );

    expect(result.ok).toBe(false);
    expect((result as { status: number }).status).toBe(500);
  });
});
