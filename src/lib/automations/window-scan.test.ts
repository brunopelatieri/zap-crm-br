import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================
// Varredura de janela de 24h (SPEC 045 §5.5).
//
// O mock do cliente service-role segue o molde de `engine.test.ts`: um
// builder encadeável que registra os filtros e resolve por tabela. A
// diferença é que aqui o CLAIM precisa se comportar como o banco — um
// upsert com ON CONFLICT DO NOTHING devolve linha na primeira vez e
// NADA na segunda —, porque é exatamente essa distinção que a varredura
// usa para decidir se dispara.
// ============================================================

const h = vi.hoisted(() => ({
  state: {
    automations: [] as Record<string, unknown>[],
    conversations: [] as Record<string, unknown>[],
    contacts: [] as Record<string, unknown>[],
    flowRuns: [] as Record<string, unknown>[],
    /** Simula erro transitório nas consultas de guardrail. */
    contactsError: false,
    flowRunsError: false,
    /** Chaves `${automation_id}|${conversation_id}|${anchor}` já reivindicadas. */
    existingClaims: new Set<string>(),
    claimUpserts: [] as Record<string, unknown>[],
    claimUpdates: [] as { id: unknown; patch: Record<string, unknown> }[],
    claimDeletes: 0,
    fromCalls: [] as string[],
    /** Filtros da última consulta a `conversations` (fase B). */
    conversationFilters: [] as [string, string, unknown][],
    nextClaimId: 0,
  },
}));

vi.mock('./admin-client', () => {
  const { state } = h;

  function resolve(ops: {
    table: string;
    type: string;
    payload?: unknown;
    filters: [string, string, unknown][];
  }) {
    const { table, type } = ops;

    if (table === 'automations') return { data: state.automations, error: null };

    if (table === 'conversations') {
      state.conversationFilters = ops.filters;
      return { data: state.conversations, error: null };
    }

    if (table === 'contacts') {
      if (state.contactsError) {
        return { data: null, error: { message: 'connection reset' } };
      }
      return { data: state.contacts, error: null };
    }

    if (table === 'flow_runs') {
      if (state.flowRunsError) {
        return { data: null, error: { message: 'connection reset' } };
      }
      return { data: state.flowRuns, error: null };
    }

    if (table === 'automation_window_claims') {
      if (type === 'upsert') {
        const p = ops.payload as Record<string, unknown>;
        state.claimUpserts.push(p);
        const key = `${p.automation_id}|${p.conversation_id}|${p.window_anchor}`;
        // ON CONFLICT DO NOTHING: RETURNING vem vazio na colisão.
        if (state.existingClaims.has(key)) return { data: null, error: null };
        state.existingClaims.add(key);
        return {
          data: { id: `claim-${++state.nextClaimId}` },
          error: null,
        };
      }
      if (type === 'update') {
        const idFilter = ops.filters.find((f) => f[1] === 'id');
        state.claimUpdates.push({
          id: idFilter?.[2],
          patch: ops.payload as Record<string, unknown>,
        });
        return { data: null, error: null };
      }
      if (type === 'delete') {
        state.claimDeletes++;
        return { data: null, error: null };
      }
    }

    return { data: null, error: null };
  }

  function builder(table: string) {
    const ops = {
      table,
      type: 'select',
      payload: undefined as unknown,
      filters: [] as [string, string, unknown][],
    };
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => ((ops.type = 'insert'), (ops.payload = p), b),
      update: (p: unknown) => ((ops.type = 'update'), (ops.payload = p), b),
      upsert: (p: unknown) => ((ops.type = 'upsert'), (ops.payload = p), b),
      delete: () => ((ops.type = 'delete'), b),
      eq: (k: string, v: unknown) => (ops.filters.push(['eq', k, v]), b),
      in: (k: string, v: unknown) => (ops.filters.push(['in', k, v]), b),
      is: (k: string, v: unknown) => (ops.filters.push(['is', k, v]), b),
      gt: (k: string, v: unknown) => (ops.filters.push(['gt', k, v]), b),
      lt: (k: string, v: unknown) => (ops.filters.push(['lt', k, v]), b),
      lte: (k: string, v: unknown) => (ops.filters.push(['lte', k, v]), b),
      order: () => b,
      limit: () => b,
      single: () => Promise.resolve(resolve(ops)),
      maybeSingle: () => Promise.resolve(resolve(ops)),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(resolve(ops)).then(onF, onR),
    };
    return b;
  }

  return {
    supabaseAdmin: () => ({
      from: (t: string) => {
        state.fromCalls.push(t);
        return builder(t);
      },
    }),
  };
});

vi.mock('./engine', () => ({
  runSingleAutomation: vi.fn(async () => {}),
  // Presente só para a asserção de que a varredura NÃO o usa (§5.5.3).
  runAutomationsForTrigger: vi.fn(async () => {}),
}));

import { scanSessionWindows } from './window-scan';
import { runAutomationsForTrigger, runSingleAutomation } from './engine';

const ACCOUNT = 'acct-1';
/** Quarta-feira, 12:00 em São Paulo — dentro da janela de disparo. */
const NOW = new Date('2026-08-12T15:00:00Z');
const HOUR = 3_600_000;

/** Âncora que deixa `minutes` de janela restante em relação a NOW. */
function anchorWithRemaining(minutes: number): string {
  return new Date(NOW.getTime() - 24 * HOUR + minutes * 60_000).toISOString();
}

function automation(id: string, marginMinutes = 240) {
  return {
    id,
    account_id: ACCOUNT,
    user_id: 'u1',
    name: `reengage ${id}`,
    trigger_type: 'session_window_expiring',
    trigger_config: { margin_minutes: marginMinutes },
    is_active: true,
  };
}

/**
 * Conversa elegível por padrão: janela fechando em 1h e a última palavra
 * foi NOSSA (agente respondeu depois do cliente) — guardrail 6.
 */
function conversation(
  id: string,
  contactId: string,
  overrides: Record<string, unknown> = {}
) {
  const anchor = anchorWithRemaining(60);
  return {
    id,
    contact_id: contactId,
    last_customer_message_at: anchor,
    last_message_at: new Date(new Date(anchor).getTime() + 60_000).toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  h.state.automations = [];
  h.state.conversations = [];
  h.state.contacts = [];
  h.state.flowRuns = [];
  h.state.contactsError = false;
  h.state.flowRunsError = false;
  h.state.existingClaims = new Set();
  h.state.claimUpserts = [];
  h.state.claimUpdates = [];
  h.state.claimDeletes = 0;
  h.state.fromCalls = [];
  h.state.conversationFilters = [];
  h.state.nextClaimId = 0;
  vi.mocked(runSingleAutomation).mockClear();
  vi.mocked(runSingleAutomation).mockImplementation(async () => {});
  vi.mocked(runAutomationsForTrigger).mockClear();
});

// ============================================================
// Achado nº 1 da 2ª revisão — o teste que a SPEC pede por nome.
// ============================================================

describe('dispatch is per automation, not per trigger (SPEC 045 §5.5.3)', () => {
  it('two automations + one eligible conversation = exactly 2 sends, not 4', async () => {
    h.state.automations = [automation('a1'), automation('a2')];
    h.state.conversations = [conversation('conv1', 'c1')];

    const result = await scanSessionWindows(NOW);

    // O bug que este teste trava: passar por runAutomationsForTrigger
    // executaria TODAS as automações do trigger a cada claim — 2 claims
    // × 2 automações = 4 execuções, 2 mensagens duplicadas ao cliente, e
    // a tabela de claims registrando exatamente 2 linhas (ou seja, uma
    // auditoria dizendo que está tudo certo).
    expect(runSingleAutomation).toHaveBeenCalledTimes(2);
    expect(runAutomationsForTrigger).not.toHaveBeenCalled();

    const dispatchedAutomationIds = vi
      .mocked(runSingleAutomation)
      .mock.calls.map((call) => (call[0] as { id: string }).id)
      .sort();
    expect(dispatchedAutomationIds).toEqual(['a1', 'a2']);
    expect(result.dispatched).toBe(2);
  });

  it('passes conversation_id in the context so send steps do no extra lookups', async () => {
    h.state.automations = [automation('a1')];
    h.state.conversations = [conversation('conv1', 'c1')];

    await scanSessionWindows(NOW);

    const input = vi.mocked(runSingleAutomation).mock.calls[0][1];
    expect(input.contactId).toBe('c1');
    expect(input.triggerType).toBe('session_window_expiring');
    expect(input.context?.conversation_id).toBe('conv1');
    // Interpolável por {{ vars.* }} — 60 min restantes na fixture.
    expect(input.context?.vars?.minutes_remaining).toBe('60');
  });
});

// ============================================================
// Claim / idempotência (§5.5.2) e ciclo de vida (§5.5.5)
// ============================================================

describe('claim is the lock (SPEC 045 §5.5.2)', () => {
  it('does not dispatch again for a window already claimed', async () => {
    h.state.automations = [automation('a1')];
    const conv = conversation('conv1', 'c1');
    h.state.conversations = [conv];

    await scanSessionWindows(NOW);
    expect(runSingleAutomation).toHaveBeenCalledTimes(1);

    // Segundo tick, mesma conversa e mesma âncora: o banco recusa a
    // segunda inserção e a varredura segue sem enviar nada.
    vi.mocked(runSingleAutomation).mockClear();
    const second = await scanSessionWindows(NOW);

    expect(runSingleAutomation).not.toHaveBeenCalled();
    expect(second.eligible).toBe(1);
    expect(second.claimed).toBe(0);
  });

  it('re-opens eligibility when the customer writes again (new anchor)', async () => {
    h.state.automations = [automation('a1')];
    h.state.conversations = [conversation('conv1', 'c1')];
    await scanSessionWindows(NOW);
    expect(runSingleAutomation).toHaveBeenCalledTimes(1);

    // O cliente respondeu: a âncora avançou, a chave do claim é outra.
    vi.mocked(runSingleAutomation).mockClear();
    const newAnchor = anchorWithRemaining(90);
    h.state.conversations = [
      conversation('conv1', 'c1', {
        last_customer_message_at: newAnchor,
        last_message_at: new Date(
          new Date(newAnchor).getTime() + 60_000
        ).toISOString(),
      }),
    ];
    await scanSessionWindows(NOW);

    expect(runSingleAutomation).toHaveBeenCalledTimes(1);
  });

  it('two distinct automations both claim the same conversation', async () => {
    // Item 4 de §5.6: `automation_id` está na chave DE PROPÓSITO — ele
    // impede a MESMA automação de disparar duas vezes na mesma janela,
    // não duas automações distintas de disparar cada uma a sua.
    h.state.automations = [automation('a1'), automation('a2')];
    h.state.conversations = [conversation('conv1', 'c1')];

    const result = await scanSessionWindows(NOW);
    expect(result.claimed).toBe(2);
  });

  it('stamps sent_at on success and failed_at (never sent_at) on a throwing dispatch', async () => {
    h.state.automations = [automation('a1')];
    h.state.conversations = [conversation('conv1', 'c1')];

    await scanSessionWindows(NOW);
    expect(h.state.claimUpdates).toHaveLength(1);
    expect(Object.keys(h.state.claimUpdates[0].patch)).toEqual(['sent_at']);

    h.state.claimUpdates = [];
    h.state.existingClaims = new Set();
    vi.mocked(runSingleAutomation).mockRejectedValueOnce(new Error('meta 500'));

    const result = await scanSessionWindows(NOW);

    expect(result.failed).toBe(1);
    expect(result.dispatched).toBe(0);
    expect(h.state.claimUpdates).toHaveLength(1);
    expect(Object.keys(h.state.claimUpdates[0].patch)).toEqual(['failed_at']);
  });

  it('purges claim rows older than the retention window', async () => {
    h.state.automations = [automation('a1')];
    await scanSessionWindows(NOW);
    expect(h.state.claimDeletes).toBe(1);
  });
});

// ============================================================
// Guardrails (§5.6)
// ============================================================

describe('guardrails (SPEC 045 §5.6)', () => {
  it('item 6: does not re-engage when the customer is the one waiting on US', async () => {
    h.state.automations = [automation('a1')];
    const anchor = anchorWithRemaining(60);
    // Cliente perguntou e ninguém respondeu: a última palavra é dele.
    h.state.conversations = [
      conversation('conv1', 'c1', {
        last_customer_message_at: anchor,
        last_message_at: anchor,
      }),
    ];

    const result = await scanSessionWindows(NOW);

    expect(runSingleAutomation).not.toHaveBeenCalled();
    expect(result.eligible).toBe(0);
  });

  it('item 6: the same conversation becomes eligible once an agent replies', async () => {
    h.state.automations = [automation('a1')];
    h.state.conversations = [conversation('conv1', 'c1')];

    await scanSessionWindows(NOW);

    expect(runSingleAutomation).toHaveBeenCalledTimes(1);
  });

  it('item 2: an opted-out contact is skipped', async () => {
    h.state.automations = [automation('a1')];
    h.state.conversations = [conversation('conv1', 'c1')];
    h.state.contacts = [{ id: 'c1', opt_in_status: 'opted_out' }];

    const result = await scanSessionWindows(NOW);

    expect(runSingleAutomation).not.toHaveBeenCalled();
    expect(result.eligible).toBe(0);
  });

  it('item 7: a contact in the middle of an active Flow is skipped', async () => {
    h.state.automations = [automation('a1')];
    h.state.conversations = [conversation('conv1', 'c1')];
    h.state.flowRuns = [{ contact_id: 'c1' }];

    const result = await scanSessionWindows(NOW);

    expect(runSingleAutomation).not.toHaveBeenCalled();
    expect(result.eligible).toBe(0);
  });

  it('item 7: a contact whose flow run timed out is NOT skipped', async () => {
    h.state.automations = [automation('a1')];
    h.state.conversations = [conversation('conv1', 'c1')];
    // A query filtra status='active'; um run encerrado não volta nela.
    h.state.flowRuns = [];

    await scanSessionWindows(NOW);

    expect(runSingleAutomation).toHaveBeenCalledTimes(1);
  });

  it('item 8: only unassigned conversations are scanned', async () => {
    h.state.automations = [automation('a1')];
    h.state.conversations = [conversation('conv1', 'c1')];

    await scanSessionWindows(NOW);

    expect(h.state.conversationFilters).toContainEqual([
      'is',
      'assigned_agent_id',
      null,
    ]);
  });

  it('fails CLOSED when the consent lookup errors', async () => {
    // Um guardrail de consentimento que falha aberto é pior que nenhum:
    // um erro transitório mandaria mensagem exatamente para quem pediu
    // para não receber, e ninguém auditaria porque "o guardrail existe".
    h.state.automations = [automation('a1')];
    h.state.conversations = [conversation('conv1', 'c1')];
    h.state.contactsError = true;

    const result = await scanSessionWindows(NOW);

    expect(runSingleAutomation).not.toHaveBeenCalled();
    expect(result.claimed).toBe(0);
  });

  it('fails CLOSED when the active-flow lookup errors', async () => {
    h.state.automations = [automation('a1')];
    h.state.conversations = [conversation('conv1', 'c1')];
    h.state.flowRunsError = true;

    const result = await scanSessionWindows(NOW);

    expect(runSingleAutomation).not.toHaveBeenCalled();
    expect(result.claimed).toBe(0);
  });

  it('item 9: nothing runs outside the send window', async () => {
    h.state.automations = [automation('a1')];
    h.state.conversations = [conversation('conv1', 'c1')];

    // 03:00 em São Paulo, quarta-feira.
    const night = await scanSessionWindows(new Date('2026-08-12T06:00:00Z'));
    expect(night.skipped).toBe('outside_send_window');
    // Nem a fase A roda: a varredura sai antes de qualquer query.
    expect(h.state.fromCalls).toHaveLength(0);

    // Sábado ao meio-dia — fora pelo dia da semana, não pela hora.
    const weekend = await scanSessionWindows(new Date('2026-08-15T15:00:00Z'));
    expect(weekend.skipped).toBe('outside_send_window');
    expect(runSingleAutomation).not.toHaveBeenCalled();
  });
});

// ============================================================
// Recorte das queries (§5.5, §5.2)
// ============================================================

describe('query shape', () => {
  it('an instance with no automation of this trigger costs ONE query', async () => {
    h.state.automations = [];

    const result = await scanSessionWindows(NOW);

    expect(result.skipped).toBe('no_automations');
    expect(h.state.fromCalls).toEqual(['automations']);
  });

  it('phase B is scoped by account_id and status=open so the partial index applies', async () => {
    h.state.automations = [automation('a1')];
    h.state.conversations = [conversation('conv1', 'c1')];

    await scanSessionWindows(NOW);

    expect(h.state.conversationFilters).toContainEqual([
      'eq',
      'account_id',
      ACCOUNT,
    ]);
    // Literal: sem ele o índice PARCIAL de §5.2 não é aproveitado.
    expect(h.state.conversationFilters).toContainEqual(['eq', 'status', 'open']);
  });

  it('the eligibility band is exactly margin_minutes wide, ending at window close', async () => {
    h.state.automations = [automation('a1', 120)];
    h.state.conversations = [];

    await scanSessionWindows(NOW);

    const gt = h.state.conversationFilters.find((f) => f[0] === 'gt');
    const lte = h.state.conversationFilters.find((f) => f[0] === 'lte');
    // Limite inferior EXCLUSIVO: uma âncora de exatamente 24h atrás tem
    // a janela fechada (fechamento exclusivo, igual computeSessionWindow).
    expect(gt?.[2]).toBe(new Date(NOW.getTime() - 24 * HOUR).toISOString());
    expect(lte?.[2]).toBe(
      new Date(NOW.getTime() - 24 * HOUR + 120 * 60_000).toISOString()
    );
  });

  it('a conversation outside the margin is not returned by the band', async () => {
    // Margem de 60 min, conversa com 200 min de janela restante: o
    // predicado do banco a exclui. Aqui o mock devolve o que mandarmos,
    // então a asserção real é sobre o limite superior calculado.
    h.state.automations = [automation('a1', 60)];
    await scanSessionWindows(NOW);

    const lte = h.state.conversationFilters.find((f) => f[0] === 'lte');
    const upperBound = new Date(String(lte?.[2])).getTime();
    const anchorOf200MinLeft = new Date(anchorWithRemaining(200)).getTime();
    expect(anchorOf200MinLeft).toBeGreaterThan(upperBound);
  });
});
