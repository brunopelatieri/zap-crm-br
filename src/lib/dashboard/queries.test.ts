import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  loadActivity,
  loadConversationsSeries,
  loadMetrics,
  loadResponseTime,
} from './queries';

// ---------------------------------------------------------------------------
// Migração 039 trocou o dashboard de "RLS plana por conta" para RPCs
// `SECURITY DEFINER` escopadas por `account_id` — precisamente porque
// `conversations`/`messages` viraram visíveis por linha, e sem essa troca
// um agente recém-chegado veria "Conversas ativas: 0" na mesma tela em que
// o admin vê o total da conta. Fase 4 item 4.5.
//
// O que é testável aqui, sem banco: que o código do cliente nunca introduz
// um parâmetro por-usuário nas chamadas RPC (só `accountId`), e que, dado o
// mesmo retorno de RPC, o resultado é byte-idêntico não importa "quem"
// chamou — não há nenhum branch de papel no caminho do cliente. A garantia
// de que a RPC em si filtra por `is_account_member` e não por
// `assigned_agent_id` é responsabilidade do banco (migração 039,
// verificação 15 de scripts/verify-039-rls.sql).
// ---------------------------------------------------------------------------

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

function makeDb(overrides: {
  rpc?: Record<string, unknown>;
  from?: Record<string, { data?: unknown[]; count?: number }>;
  rpcCalls?: RpcCall[];
}) {
  const rpcCalls = overrides.rpcCalls ?? [];

  function builder(table: string) {
    const tableConfig = overrides.from?.[table] ?? { data: [], count: 0 };
    const b: Record<string, unknown> = {};
    const chain = () => b;
    for (const m of ['select', 'eq', 'gte', 'lt', 'order', 'limit']) {
      b[m] = vi.fn(chain);
    }
    b.then = (resolve: (v: unknown) => unknown) =>
      resolve({
        data: tableConfig.data ?? [],
        count: tableConfig.count ?? 0,
        error: null,
      });
    return b;
  }

  return {
    from: vi.fn((table: string) => builder(table)),
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return { data: overrides.rpc?.[fn] ?? [], error: null };
    }),
  } as unknown as SupabaseClient;
}

describe('loadMetrics', () => {
  it('scopes dashboard_counts by accountId only — no per-caller parameter', async () => {
    const rpcCalls: RpcCall[] = [];
    const db = makeDb({
      rpc: {
        dashboard_counts: [
          {
            open_conversations: 12,
            new_conversations_today: 3,
            new_conversations_yesterday: 1,
            agent_messages_today: 40,
            agent_messages_yesterday: 30,
          },
        ],
      },
      rpcCalls,
    });

    await loadMetrics(db, 'acct-1');

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe('dashboard_counts');
    expect(rpcCalls[0].args).toMatchObject({ p_account_id: 'acct-1' });
    expect(Object.keys(rpcCalls[0].args)).not.toContain('p_user_id');
  });

  it('returns identical numbers for two different callers given the same account data', async () => {
    const countsRow = [
      {
        open_conversations: 12,
        new_conversations_today: 3,
        new_conversations_yesterday: 1,
        agent_messages_today: 40,
        agent_messages_yesterday: 30,
      },
    ];
    // Two independent "sessions" (e.g. an agent and an admin) — the
    // client code has no branch on who's asking, only on accountId.
    const dbAsAgent = makeDb({ rpc: { dashboard_counts: countsRow } });
    const dbAsAdmin = makeDb({ rpc: { dashboard_counts: countsRow } });

    const [asAgent, asAdmin] = await Promise.all([
      loadMetrics(dbAsAgent, 'acct-1'),
      loadMetrics(dbAsAdmin, 'acct-1'),
    ]);

    expect(asAgent).toEqual(asAdmin);
    expect(asAgent.activeConversations.current).toBe(12);
  });

  it('throws when the RPC errors (e.g. the account guard rejects)', async () => {
    const db = makeDb({});
    (db.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: null,
      error: { message: 'boom' },
    });

    await expect(loadMetrics(db, 'acct-1')).rejects.toBeTruthy();
  });
});

describe('loadConversationsSeries', () => {
  it('scopes dashboard_message_series by accountId and buckets by local day', async () => {
    const rpcCalls: RpcCall[] = [];
    const db = makeDb({
      rpc: {
        dashboard_message_series: [
          { created_at: new Date().toISOString(), sender_type: 'customer' },
          { created_at: new Date().toISOString(), sender_type: 'agent' },
        ],
      },
      rpcCalls,
    });

    const series = await loadConversationsSeries(db, 'acct-1', 7);

    expect(rpcCalls[0]).toMatchObject({
      fn: 'dashboard_message_series',
      args: { p_account_id: 'acct-1' },
    });
    expect(series).toHaveLength(7);
    const totalIncoming = series.reduce((s, p) => s + p.incoming, 0);
    const totalOutgoing = series.reduce((s, p) => s + p.outgoing, 0);
    expect(totalIncoming).toBe(1);
    expect(totalOutgoing).toBe(1);
  });
});

describe('loadResponseTime', () => {
  it('scopes dashboard_response_samples by accountId', async () => {
    const rpcCalls: RpcCall[] = [];
    const db = makeDb({ rpc: { dashboard_response_samples: [] }, rpcCalls });

    await loadResponseTime(db, 'acct-1');

    expect(rpcCalls[0]).toMatchObject({
      fn: 'dashboard_response_samples',
      args: { p_account_id: 'acct-1' },
    });
  });
});

describe('loadActivity', () => {
  it('scopes dashboard_recent_inbound by accountId, not by assignment', async () => {
    const rpcCalls: RpcCall[] = [];
    const db = makeDb({ rpc: { dashboard_recent_inbound: [] }, rpcCalls });

    await loadActivity(db, 'acct-1');

    const msgCall = rpcCalls.find((c) => c.fn === 'dashboard_recent_inbound');
    expect(msgCall).toBeDefined();
    expect(msgCall).toMatchObject({ args: { p_account_id: 'acct-1' } });
  });
});
