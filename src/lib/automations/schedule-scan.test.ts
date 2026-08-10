import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================
// Varredura do gatilho `time_based` (SPEC 046 §6).
//
// Mesmo molde de mock de `window-scan.test.ts`: um builder encadeável
// que registra os filtros e resolve por tabela, com o upsert de claim
// se comportando como o banco (ON CONFLICT DO NOTHING — RETURNING vem
// vazio na segunda tentativa da mesma chave).
// ============================================================

const h = vi.hoisted(() => ({
  state: {
    automations: [] as Record<string, unknown>[],
    contactTags: [] as { contact_id: string }[],
    contacts: [] as Record<string, unknown>[],
    contactsError: false,
    claimLookupError: false,
    /** Chaves `${automation_id}|${contact_id}|${occurrence_at}` já reivindicadas. */
    existingClaims: new Set<string>(),
    claimUpserts: [] as Record<string, unknown>[],
    claimUpdates: [] as { id: unknown; patch: Record<string, unknown> }[],
    claimDeletes: 0,
    fromCalls: [] as string[],
    contactFilters: [] as [string, string, unknown][],
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

    if (table === 'automations')
      return { data: state.automations, error: null };

    if (table === 'contact_tags')
      return { data: state.contactTags, error: null };

    if (table === 'contacts') {
      state.contactFilters = ops.filters;
      if (state.contactsError) {
        return { data: null, error: { message: 'connection reset' } };
      }
      return { data: state.contacts, error: null };
    }

    if (table === 'automation_schedule_claims') {
      if (type === 'select') {
        // Leitura de quem já foi reivindicado nesta ocorrência.
        if (state.claimLookupError) {
          return { data: null, error: { message: 'connection reset' } };
        }
        const automationId = ops.filters.find(
          (f) => f[1] === 'automation_id'
        )?.[2];
        const occurrenceAt = ops.filters.find(
          (f) => f[1] === 'occurrence_at'
        )?.[2];
        const rows = [...state.existingClaims]
          .map((k) => k.split('|'))
          .filter(([a, , o]) => a === automationId && o === occurrenceAt)
          .map(([, contactId]) => ({ contact_id: contactId }));
        return { data: rows, error: null };
      }
      if (type === 'upsert') {
        const p = ops.payload as Record<string, unknown>;
        state.claimUpserts.push(p);
        const key = `${p.automation_id}|${p.contact_id}|${p.occurrence_at}`;
        if (state.existingClaims.has(key)) return { data: null, error: null };
        state.existingClaims.add(key);
        return { data: { id: `claim-${++state.nextClaimId}` }, error: null };
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
      lt: (k: string, v: unknown) => (ops.filters.push(['lt', k, v]), b),
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
  // Presente só para a asserção de que a varredura NÃO o usa (mesmo
  // aviso de engine.ts:140-155 que window-scan.ts já respeita).
  runAutomationsForTrigger: vi.fn(async () => {}),
}));

import { scanSchedules } from './schedule-scan';
import { runAutomationsForTrigger, runSingleAutomation } from './engine';

const ACCOUNT = 'acct-1';
/** Quarta-feira, 09:30 UTC — dentro da janela de disparo em tz UTC. */
const NOW = new Date('2026-08-12T09:30:00Z');

function automation(
  id: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    account_id: ACCOUNT,
    user_id: 'u1',
    name: `scheduled ${id}`,
    trigger_type: 'time_based',
    trigger_config: {
      schedule: '30 9 * * *',
      timezone: 'UTC',
      audience_tag_id: 'tag-1',
      ...((overrides.trigger_config as Record<string, unknown>) ?? {}),
    },
    is_active: true,
    ...overrides,
  };
}

beforeEach(() => {
  h.state.automations = [];
  h.state.contactTags = [{ contact_id: 'c1' }];
  h.state.contacts = [{ id: 'c1', opt_in_status: 'opted_in' }];
  h.state.contactsError = false;
  h.state.claimLookupError = false;
  h.state.existingClaims = new Set();
  h.state.claimUpserts = [];
  h.state.claimUpdates = [];
  h.state.claimDeletes = 0;
  h.state.fromCalls = [];
  h.state.contactFilters = [];
  h.state.nextClaimId = 0;
  vi.mocked(runSingleAutomation).mockClear();
  vi.mocked(runSingleAutomation).mockImplementation(async () => {});
  vi.mocked(runAutomationsForTrigger).mockClear();
});

describe('dispatch is per automation, never runAutomationsForTrigger', () => {
  it('two automations + one eligible contact = exactly 2 sends, not 4', async () => {
    h.state.automations = [automation('a1'), automation('a2')];

    const result = await scanSchedules(NOW);

    expect(runSingleAutomation).toHaveBeenCalledTimes(2);
    expect(runAutomationsForTrigger).not.toHaveBeenCalled();
    expect(result.dispatched).toBe(2);

    const ids = vi
      .mocked(runSingleAutomation)
      .mock.calls.map((call) => (call[0] as { id: string }).id)
      .sort();
    expect(ids).toEqual(['a1', 'a2']);
  });

  it('dispatches with the matched contact and time_based trigger type', async () => {
    h.state.automations = [automation('a1')];

    await scanSchedules(NOW);

    const input = vi.mocked(runSingleAutomation).mock.calls[0][1];
    expect(input.contactId).toBe('c1');
    expect(input.triggerType).toBe('time_based');
    expect(input.accountId).toBe(ACCOUNT);
  });
});

describe('claim is the lock', () => {
  it('does not dispatch again for an occurrence already claimed', async () => {
    h.state.automations = [automation('a1')];

    await scanSchedules(NOW);
    expect(runSingleAutomation).toHaveBeenCalledTimes(1);

    vi.mocked(runSingleAutomation).mockClear();
    const second = await scanSchedules(NOW);

    expect(runSingleAutomation).not.toHaveBeenCalled();
    expect(second.claimed).toBe(0);
  });

  it('a tick 4 minutes later still resolves to the same occurrence (same claim key)', async () => {
    h.state.automations = [automation('a1')];
    await scanSchedules(NOW);
    expect(runSingleAutomation).toHaveBeenCalledTimes(1);

    // Próximo ping, 4 min depois — dentro da janela de 10 min do tick,
    // então enxerga a MESMA ocorrência (09:30) e o claim já existe.
    vi.mocked(runSingleAutomation).mockClear();
    const laterTick = new Date(NOW.getTime() + 4 * 60_000);
    await scanSchedules(laterTick);

    expect(runSingleAutomation).not.toHaveBeenCalled();
  });

  it('stamps sent_at on success and failed_at (never sent_at) on a throwing dispatch', async () => {
    h.state.automations = [automation('a1')];

    await scanSchedules(NOW);
    expect(h.state.claimUpdates).toHaveLength(1);
    expect(Object.keys(h.state.claimUpdates[0].patch)).toEqual(['sent_at']);

    h.state.claimUpdates = [];
    h.state.existingClaims = new Set();
    vi.mocked(runSingleAutomation).mockRejectedValueOnce(new Error('meta 500'));

    const result = await scanSchedules(NOW);

    expect(result.failed).toBe(1);
    expect(result.dispatched).toBe(0);
    expect(h.state.claimUpdates).toHaveLength(1);
    expect(Object.keys(h.state.claimUpdates[0].patch)).toEqual(['failed_at']);
  });

  it('purges claim rows older than the retention window', async () => {
    h.state.automations = [automation('a1')];
    await scanSchedules(NOW);
    expect(h.state.claimDeletes).toBe(1);
  });
});

describe('guardrails', () => {
  it('an opted-out contact is skipped', async () => {
    h.state.automations = [automation('a1')];
    h.state.contacts = [{ id: 'c1', opt_in_status: 'opted_out' }];

    const result = await scanSchedules(NOW);

    expect(runSingleAutomation).not.toHaveBeenCalled();
    expect(result.eligible).toBe(0);
  });

  it('nothing runs outside the send window (per-automation timezone)', async () => {
    h.state.automations = [automation('a1')];

    // 03:00 UTC, ainda quarta-feira — fora do horário permitido.
    const night = await scanSchedules(new Date('2026-08-12T03:00:00Z'));

    expect(runSingleAutomation).not.toHaveBeenCalled();
    expect(night.occurrences).toBe(0);
  });

  it('fails CLOSED when the contact lookup errors', async () => {
    h.state.automations = [automation('a1')];
    h.state.contactsError = true;

    const result = await scanSchedules(NOW);

    expect(runSingleAutomation).not.toHaveBeenCalled();
    expect(result.claimed).toBe(0);
  });

  it('an automation missing schedule or audience_tag_id is skipped, not thrown', async () => {
    h.state.automations = [
      automation('a1', {
        trigger_config: { schedule: '', audience_tag_id: '' },
      }),
    ];

    const result = await scanSchedules(NOW);

    expect(runSingleAutomation).not.toHaveBeenCalled();
    expect(result.occurrences).toBe(0);
  });

  it('a cron that does not match this minute produces no occurrence', async () => {
    h.state.automations = [
      automation('a1', {
        trigger_config: {
          schedule: '0 12 * * *',
          timezone: 'UTC',
          audience_tag_id: 'tag-1',
        },
      }),
    ];

    const result = await scanSchedules(NOW);

    expect(runSingleAutomation).not.toHaveBeenCalled();
    expect(result.occurrences).toBe(0);
  });
});

describe('query shape', () => {
  it('an instance with no time_based automation costs ONE query', async () => {
    h.state.automations = [];

    const result = await scanSchedules(NOW);

    expect(result.automations).toBe(0);
    expect(h.state.fromCalls).toEqual(['automations']);
  });

  it('the contacts query is scoped by account_id — not just the tag', async () => {
    h.state.automations = [automation('a1')];

    await scanSchedules(NOW);

    expect(h.state.contactFilters).toContainEqual([
      'eq',
      'account_id',
      ACCOUNT,
    ]);
  });
});

// ============================================================
// Revisão da SPEC 046 — achados nº 2 e nº 4
// ============================================================

/** N contatos elegíveis, ids ordenáveis (c-000, c-001, …). */
function seedContacts(n: number) {
  const ids = Array.from(
    { length: n },
    (_, i) => `c-${String(i).padStart(3, '0')}`
  );
  h.state.contactTags = ids.map((id) => ({ contact_id: id }));
  h.state.contacts = ids.map((id) => ({ id, opt_in_status: 'opted_in' }));
  return ids;
}

describe('achado nº 2 — a truncagem não pode ser silenciosa nem permanente', () => {
  it('o SEGUNDO tick da mesma ocorrência entrega o lote seguinte, não zero', async () => {
    // Antes da correção, a query relia os mesmos contatos, encontrava
    // todos reivindicados e despachava zero — travando a entrega no
    // primeiro lote para sempre, sem nada no log.
    h.state.automations = [automation('a1')];
    seedContacts(150);

    const first = await scanSchedules(NOW);
    expect(first.dispatched).toBe(100); // MAX_CONTACTS_PER_OCCURRENCE
    expect(first.truncated).toBe(true);

    vi.mocked(runSingleAutomation).mockClear();
    // Segundo ping, 4 min depois: mesma ocorrência (09:30), mesma chave
    // de claim — mas os 100 já reivindicados saem da fila antes do teto.
    const second = await scanSchedules(new Date(NOW.getTime() + 4 * 60_000));

    expect(second.dispatched).toBe(50);
    expect(second.truncated).toBe(false);

    // Nenhum contato recebeu duas vezes.
    const dispatched = vi
      .mocked(runSingleAutomation)
      .mock.calls.map((c) => c[1].contactId);
    expect(new Set(dispatched).size).toBe(dispatched.length);
  });

  it('audiência dentro do teto não marca truncated', async () => {
    h.state.automations = [automation('a1')];
    seedContacts(10);

    const result = await scanSchedules(NOW);

    expect(result.dispatched).toBe(10);
    expect(result.truncated).toBe(false);
  });

  it('falha FECHADA quando a leitura de claims erra — não despacha às cegas', async () => {
    h.state.automations = [automation('a1')];
    h.state.claimLookupError = true;

    const result = await scanSchedules(NOW);

    expect(runSingleAutomation).not.toHaveBeenCalled();
    expect(result.claimed).toBe(0);
  });
});

describe('achado nº 4 — a janela é testada na OCORRÊNCIA, não em `now`', () => {
  it('ocorrência às 19:58 NÃO é perdida por um tick que chegou às 20:01', async () => {
    h.state.automations = [
      automation('a1', {
        trigger_config: {
          schedule: '58 19 * * *',
          timezone: 'UTC',
          audience_tag_id: 'tag-1',
        },
      }),
    ];

    // A janela fecha às 20h de forma EXCLUSIVA, então 19:58 é um
    // horário permitido. Antes da correção o teste era em `now`
    // (20:01, fora da janela) e este disparo legítimo era descartado
    // só porque o ping do cron chegou três minutos atrasado.
    const result = await scanSchedules(new Date('2026-08-12T20:01:00Z'));

    expect(result.occurrences).toBe(1);
    expect(runSingleAutomation).toHaveBeenCalledTimes(1);
  });

  it('ocorrência às 08:58 NÃO passa só porque o tick chegou às 09:01', async () => {
    h.state.automations = [
      automation('a1', {
        trigger_config: {
          schedule: '58 8 * * *',
          timezone: 'UTC',
          audience_tag_id: 'tag-1',
        },
      }),
    ];

    // `now` (09:01) está dentro da janela; a ocorrência (08:58) não.
    // Antes da correção este disparo passava.
    const result = await scanSchedules(new Date('2026-08-12T09:01:00Z'));

    expect(runSingleAutomation).not.toHaveBeenCalled();
    expect(result.occurrences).toBe(0);
  });

  it('agendamento de sábado nunca dispara, mesmo com o tick em horário útil', async () => {
    h.state.automations = [
      automation('a1', {
        trigger_config: {
          schedule: '0 10 * * 6',
          timezone: 'UTC',
          audience_tag_id: 'tag-1',
        },
      }),
    ];

    // Sábado, 10:00 UTC — a ocorrência existe, a janela recusa.
    const result = await scanSchedules(new Date('2026-08-15T10:00:00Z'));

    expect(runSingleAutomation).not.toHaveBeenCalled();
    expect(result.occurrences).toBe(0);
  });
});
