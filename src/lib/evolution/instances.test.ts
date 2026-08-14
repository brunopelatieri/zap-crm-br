/**
 * `bindChannelToPhone` — o canal QRCode é o NÚMERO, não a instância.
 *
 * O cenário real que originou a regra: o mantenedor excluiu a instância
 * pelo CRM e pareou o mesmo WhatsApp de novo. Como cada criação abre um
 * `channels` novo e `conversations.channel_id` é NOT NULL (059), todo o
 * histórico do número ficava preso ao canal velho — conversas invisíveis
 * em vez de apagadas, que é o pior tipo de perda.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v,
  encrypt: (v: string) => v,
}));

vi.mock('@/lib/evolution/config', () => ({
  readEvolutionConfig: () => null,
}));

interface RecordedOp {
  table: string;
  verb: 'select' | 'insert' | 'update' | 'delete';
  payload?: unknown;
  filters: Array<[string, ...unknown[]]>;
}

type Result = { data?: unknown; error?: unknown; count?: number };

/**
 * Fake com FILA por `tabela.verbo`: `bindChannelToPhone` faz DOIS
 * `channels.select` diferentes (o canal atual, depois o canal do
 * número), e um mapa simples devolveria a mesma linha para os dois.
 */
function makeDb(queues: Record<string, Result[]>) {
  const ops: RecordedOp[] = [];
  const pending = new Map<string, Result[]>(
    Object.entries(queues).map(([k, v]) => [k, [...v]])
  );

  function builder(table: string) {
    const op: RecordedOp = { table, verb: 'select', filters: [] };
    let recorded = false;
    const settle = (): Result => {
      if (!recorded) {
        ops.push(op);
        recorded = true;
      }
      const queue = pending.get(`${table}.${op.verb}`);
      const next = queue?.shift();
      return next ?? { data: null, error: null, count: 0 };
    };

    const chain: Record<string, unknown> = {
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve(settle()).then(resolve, reject);
      },
      update: (payload?: unknown) => {
        op.verb = 'update';
        op.payload = payload;
        return chain;
      },
      delete: () => {
        op.verb = 'delete';
        return chain;
      },
      select: (...args: unknown[]) => {
        op.filters.push(['select', ...args]);
        return chain;
      },
      eq: (...args: unknown[]) => {
        op.filters.push(['eq', ...args]);
        return chain;
      },
      neq: (...args: unknown[]) => {
        op.filters.push(['neq', ...args]);
        return chain;
      },
      order: (...args: unknown[]) => {
        op.filters.push(['order', ...args]);
        return chain;
      },
      limit: (...args: unknown[]) => {
        op.filters.push(['limit', ...args]);
        return chain;
      },
      maybeSingle: () => Promise.resolve(settle()),
      single: () => Promise.resolve(settle()),
    };
    return chain;
  }

  return { client: { from: (t: string) => builder(t) }, ops };
}

let currentDb = makeDb({});
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => currentDb.client,
}));

import { bindChannelToPhone } from './instances';

const INPUT = {
  accountId: 'acct-1',
  instanceId: 'inst-nova',
  channelId: 'chan-nova',
  phone: '5519992496598',
};

function opsFor(table: string, verb?: RecordedOp['verb']) {
  return currentDb.ops.filter(
    (o) => o.table === table && (verb ? o.verb === verb : true)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('sem canal anterior para o número', () => {
  beforeEach(() => {
    currentDb = makeDb({
      'channels.select': [
        { data: { name: 'bruno', identifier: null } }, // canal atual
        { data: null }, // nenhum canal anterior com este número
      ],
    });
  });

  it('carimba o identifier e devolve o próprio canal', async () => {
    const result = await bindChannelToPhone(INPUT);

    expect(result).toEqual({ channelId: 'chan-nova', adopted: false });
    const update = opsFor('channels', 'update')[0];
    expect(update.payload).toEqual({ identifier: '5519992496598' });
  });

  it('não reaponta a instância nem apaga canal nenhum', async () => {
    await bindChannelToPhone(INPUT);

    expect(opsFor('evolution_instances', 'update')).toHaveLength(0);
    expect(opsFor('channels', 'delete')).toHaveLength(0);
  });
});

describe('número repareado — canal anterior existe', () => {
  function planWithPrevious(
    conversationCount = 0,
    over: Record<string, Result[]> = {}
  ) {
    return makeDb({
      'channels.select': [
        { data: { name: 'bruno teste 2', identifier: null } },
        { data: { id: 'chan-antiga' } },
      ],
      'conversations.select': [{ count: conversationCount }],
      ...over,
    });
  }

  it('reaponta a instância para o canal que já atendia o número', async () => {
    currentDb = planWithPrevious();

    const result = await bindChannelToPhone(INPUT);

    expect(result).toEqual({ channelId: 'chan-antiga', adopted: true });
    const repoint = opsFor('evolution_instances', 'update')[0];
    expect(repoint.payload).toEqual({ channel_id: 'chan-antiga' });
    expect(repoint.filters).toContainEqual(['eq', 'id', 'inst-nova']);
  });

  it('reativa o canal adotado e leva o rótulo novo junto', async () => {
    currentDb = planWithPrevious();

    await bindChannelToPhone(INPUT);

    const adopted = opsFor('channels', 'update').find((o) =>
      o.filters.some(
        ([verb, col, val]) =>
          verb === 'eq' && col === 'id' && val === 'chan-antiga'
      )
    );
    expect(adopted?.payload).toMatchObject({
      identifier: '5519992496598',
      status: 'connected',
      status_detail: null,
      // O operador acabou de escolher este nome ao recriar a instância.
      name: 'bruno teste 2',
    });
  });

  it('apaga o canal recém-criado, que ficou sem instância e sem conversa', async () => {
    currentDb = planWithPrevious();

    await bindChannelToPhone(INPUT);

    const del = opsFor('channels', 'delete')[0];
    expect(del.filters).toContainEqual(['eq', 'id', 'chan-nova']);
  });

  it('procura o canal anterior escopado por conta, tipo e número', async () => {
    currentDb = planWithPrevious();

    await bindChannelToPhone(INPUT);

    const lookup = opsFor('channels', 'select')[1];
    expect(lookup.filters).toContainEqual(['eq', 'account_id', 'acct-1']);
    expect(lookup.filters).toContainEqual(['eq', 'type', 'whatsapp_qr']);
    expect(lookup.filters).toContainEqual([
      'eq',
      'identifier',
      '5519992496598',
    ]);
    expect(lookup.filters).toContainEqual(['neq', 'id', 'chan-nova']);
  });

  it('ABORTA a adoção se o canal novo já tem conversas — nunca órfã histórico', async () => {
    // Fora do fluxo normal (mensagem só trafega depois do pareamento),
    // mas dois canais separados incomodam; histórico órfão é perda.
    currentDb = planWithPrevious(3);

    const result = await bindChannelToPhone(INPUT);

    expect(result).toEqual({ channelId: 'chan-nova', adopted: false });
    expect(opsFor('evolution_instances', 'update')).toHaveLength(0);
    expect(opsFor('channels', 'delete')).toHaveLength(0);
  });

  it('não apaga o canal novo se o reaponte da instância falhou', async () => {
    currentDb = planWithPrevious(0, {
      'evolution_instances.update': [{ error: { message: 'boom' } }],
    });

    const result = await bindChannelToPhone(INPUT);

    expect(result.adopted).toBe(false);
    expect(opsFor('channels', 'delete')).toHaveLength(0);
  });

  it('cai para disabled quando o canal novo não pode ser apagado', async () => {
    currentDb = planWithPrevious(0, {
      'channels.delete': [{ error: { message: 'fk violation' } }],
    });

    const result = await bindChannelToPhone(INPUT);

    expect(result.adopted).toBe(true);
    const fallback = opsFor('channels', 'update').at(-1);
    expect(fallback?.payload).toMatchObject({ status: 'disabled' });
  });
});

describe('identifier já correto', () => {
  it('não reescreve o identifier à toa', async () => {
    currentDb = makeDb({
      'channels.select': [
        { data: { name: 'bruno', identifier: '5519992496598' } },
        { data: null },
      ],
    });

    await bindChannelToPhone(INPUT);

    expect(opsFor('channels', 'update')).toHaveLength(0);
  });
});
