/**
 * SPEC 049 §1.2 / §5.1.4 — `checkWindowGuard` precisa repassar o
 * `applicable` REAL de `resolveSessionWindow` para `resolveWindowRoute`,
 * não o literal `true` que o código carregava "enquanto só existe canal
 * Cloud" (comentário que já mentia desde que a F1 desta SPEC ligou o
 * roteamento por canal).
 *
 * Por que este teste não olha para o `kind` da rota final
 *
 *   Com a implementação REAL de `resolveSessionWindow`, um canal sem
 *   janela (`applicable: false`) sempre devolve `isOpen: true` junto —
 *   as duas rotas de `resolveWindowRoute` (regra 1 "sem restrição" e
 *   regra 2 "aberta") levam a `{ kind: 'send' }`, então comparar o
 *   resultado final não distingue qual regra decidiu. O que este teste
 *   verifica é o FIO: que `windowApplicable` chega a `resolveWindowRoute`
 *   com o valor que `resolveSessionWindow` calculou, não um literal.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  state: {
    owned: null as { id: string } | null,
    automations: [] as Record<string, unknown>[],
    steps: [] as Record<string, unknown>[],
    conversationRow: null as { last_customer_message_at: string | null } | null,
    /** `channels(type)` embutido na leitura de `channelForConversation`. */
    channelType: 'whatsapp_cloud' as 'whatsapp_cloud' | 'whatsapp_qr',
  },
}));

vi.mock('./admin-client', () => {
  const { state } = h;

  function resolve(ops: {
    table: string;
    type: string;
    select: string;
    filters: [string, string, unknown][];
  }) {
    const { table, type, select } = ops;
    if (table === 'contacts') return { data: state.owned, error: null };
    if (table === 'conversations') {
      if (type === 'update') return { data: null, error: null };
      // `channelForConversation` pede `channels(type)`; o guard pede
      // `last_customer_message_at`. O fake devolve os dois sempre — uma
      // query real nunca vê a coluna que não pediu, mas o fake não
      // precisa projetar para o teste ser válido.
      if (select.includes('channels')) {
        return {
          data: { channels: { type: state.channelType } },
          error: null,
        };
      }
      return { data: state.conversationRow, error: null };
    }
    if (table === 'automations')
      return { data: state.automations, error: null };
    if (table === 'automation_logs') {
      if (type === 'insert') return { data: { id: 'log1' }, error: null };
      if (type === 'update') return { data: null, error: null };
      return { data: { steps_executed: [], status: 'success' }, error: null };
    }
    if (table === 'automation_steps') {
      let rows = state.steps.slice();
      for (const [op, k, v] of ops.filters) {
        if (op === 'eq') rows = rows.filter((r) => r[k] === v);
        else if (op === 'gte')
          rows = rows.filter((r) => (r[k] as number) >= (v as number));
        else if (op === 'is')
          rows = rows.filter((r) => (v === null ? r[k] == null : r[k] === v));
      }
      rows.sort((a, b) => (a.position as number) - (b.position as number));
      return { data: rows, error: null };
    }
    return { data: null, error: null };
  }

  function builder(table: string) {
    const ops = {
      table,
      type: 'select',
      select: '',
      payload: undefined as unknown,
      filters: [] as [string, string, unknown][],
    };
    const b: Record<string, unknown> = {
      select: (s?: string) => ((ops.select = s ?? ''), b),
      insert: (p: unknown) => ((ops.type = 'insert'), (ops.payload = p), b),
      update: (p: unknown) => ((ops.type = 'update'), (ops.payload = p), b),
      eq: (k: string, v: unknown) => (ops.filters.push(['eq', k, v]), b),
      in: (k: string, v: unknown) => (ops.filters.push(['in', k, v]), b),
      gte: (k: string, v: unknown) => (ops.filters.push(['gte', k, v]), b),
      is: (k: string, v: unknown) => (ops.filters.push(['is', k, v]), b),
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
      from: (t: string) => builder(t),
      rpc: () => Promise.resolve({ error: null }),
    }),
  };
});

vi.mock('./meta-send', () => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: 'm1' })),
  engineSendTemplate: vi.fn(async () => ({ whatsapp_message_id: 'm1' })),
  engineSendInteractive: vi.fn(async () => ({ whatsapp_message_id: 'm1' })),
}));

const resolveWindowRouteSpy = vi.fn();
vi.mock('./window-fallback', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./window-fallback')>();
  return {
    ...actual,
    resolveWindowRoute: (
      input: Parameters<typeof actual.resolveWindowRoute>[0]
    ) => {
      resolveWindowRouteSpy(input);
      return actual.resolveWindowRoute(input);
    },
  };
});

import { runAutomationsForTrigger } from './engine';

const ACCOUNT = 'acct-1';

function hoursAgoIso(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function sendMessageStep(): Record<string, unknown> {
  return {
    id: 's-msg',
    automation_id: 'a1',
    step_type: 'send_message',
    position: 0,
    parent_step_id: null,
    step_config: { text: 'oi', on_window_closed: 'fail' },
  };
}

async function run() {
  h.state.owned = { id: 'c1' };
  h.state.automations = [
    {
      id: 'a1',
      account_id: ACCOUNT,
      user_id: 'u1',
      trigger_type: 'new_message_received',
      trigger_config: {},
      is_active: true,
    },
  ];
  h.state.steps = [sendMessageStep()];
  await runAutomationsForTrigger({
    accountId: ACCOUNT,
    triggerType: 'new_message_received',
    contactId: 'c1',
    context: { conversation_id: 'conv1' },
  });
}

beforeEach(() => {
  h.state.owned = null;
  h.state.automations = [];
  h.state.steps = [];
  h.state.conversationRow = null;
  h.state.channelType = 'whatsapp_cloud';
  resolveWindowRouteSpy.mockClear();
});

describe('checkWindowGuard repassa applicable de resolveSessionWindow (SPEC 049 §1.2/§5.1.4)', () => {
  it('canal QR (sem janela) com âncora preenchida: windowApplicable chega FALSE em resolveWindowRoute', async () => {
    h.state.channelType = 'whatsapp_qr';
    // Âncora PREENCHIDA (não nula) — se o guard ainda lesse o literal
    // `true`, esta âncora "antiga" combinada com `on_window_closed:
    // 'fail'` bloquearia o envio; o canal QR não tem janela nenhuma para
    // fechar.
    h.state.conversationRow = { last_customer_message_at: hoursAgoIso(30) };

    await run();

    expect(resolveWindowRouteSpy).toHaveBeenCalledTimes(1);
    const input = resolveWindowRouteSpy.mock.calls[0][0] as {
      windowApplicable: boolean;
    };
    expect(input.windowApplicable).toBe(false);
  });

  it('canal Cloud (com janela) com âncora preenchida: windowApplicable chega TRUE — comportamento de hoje preservado', async () => {
    h.state.channelType = 'whatsapp_cloud';
    h.state.conversationRow = { last_customer_message_at: hoursAgoIso(1) };

    await run();

    expect(resolveWindowRouteSpy).toHaveBeenCalledTimes(1);
    const input = resolveWindowRouteSpy.mock.calls[0][0] as {
      windowApplicable: boolean;
    };
    expect(input.windowApplicable).toBe(true);
  });
});
