/**
 * O par completo, dentro do motor (SPEC 049 §5.2 / §7.1).
 *
 * O que este arquivo protege — e por que ele existe separado de
 * `engine.test.ts`
 *
 *   A F6.2 é a única fase da SPEC 049 que toca o caminho de ENTRADA, e
 *   ela mexe no mesmo `handleReplyForActiveRun` que atende o canal
 *   oficial. Um erro aqui não estoura: faz o flow reprompt até desistir
 *   num canal, enquanto o outro segue perfeito. Por isso cada teste do
 *   ramo QR tem o seu GÊMEO no ramo Cloud, afirmando que ali nada mudou
 *   — é a comparação lado a lado que a §10 da SPEC exige na revisão.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface FakeOps {
  table: string;
  type: 'select' | 'insert' | 'update' | 'delete';
  payload?: unknown;
  filters: [string, ...unknown[]][];
}

const h = vi.hoisted(() => ({
  state: {
    /** `channels.type` da conversa do run. */
    channelType: 'whatsapp_cloud' as string,
    /** `conversations.channel_id` — null simula conta pré-055. */
    conversationChannelId: 'chan-1' as string | null,
    run: null as Record<string, unknown> | null,
    nodes: [] as Record<string, unknown>[],
    flow: null as Record<string, unknown> | null,
    events: [] as {
      event_type: string;
      node_key: string | null;
      payload: Record<string, unknown>;
    }[],
    runUpdates: [] as Record<string, unknown>[],
    /** Filtros de cada consulta a `messages` — prova o escopo da §1.8. */
    messageQueries: [] as [string, ...unknown[]][][],
  },
}));

vi.mock('./admin-client', () => {
  const { state } = h;

  function resolve(ops: FakeOps) {
    const { table, type } = ops;
    if (table === 'flow_runs') {
      if (type === 'update') {
        state.runUpdates.push(ops.payload as Record<string, unknown>);
        // `advanceCurrentNodeKey` lê o array devolvido pelo
        // `.select('id')` para saber se ganhou a corrida otimista.
        return { data: [{ id: state.run?.id }], error: null };
      }
      return { data: state.run ? [state.run] : [], error: null };
    }
    if (table === 'flow_run_events') {
      if (type === 'insert') {
        const p = ops.payload as {
          event_type: string;
          node_key: string | null;
          payload: Record<string, unknown>;
        };
        state.events.push(p);
        return { data: null, error: null };
      }
      // Idempotência (`isDuplicateInbound`): nunca duplicado nos testes.
      return { data: null, count: 0, error: null };
    }
    if (table === 'flow_nodes') return { data: state.nodes, error: null };
    if (table === 'flows') return { data: state.flow, error: null };
    if (table === 'conversations') {
      if (type === 'update') return { data: null, error: null };
      return { data: { channel_id: state.conversationChannelId }, error: null };
    }
    if (table === 'channels') {
      return { data: { type: state.channelType }, error: null };
    }
    if (table === 'messages') {
      state.messageQueries.push(ops.filters);
      return { data: [{ id: 'msg-row-1' }], error: null };
    }
    return { data: null, error: null };
  }

  function builder(table: string) {
    const ops: FakeOps = { table, type: 'select', filters: [] };
    const b: Record<string, unknown> = {
      select: (...a: unknown[]) => (ops.filters.push(['select', ...a]), b),
      insert: (p: unknown) => ((ops.type = 'insert'), (ops.payload = p), b),
      update: (p: unknown) => ((ops.type = 'update'), (ops.payload = p), b),
      delete: () => ((ops.type = 'delete'), b),
      upsert: (p: unknown) => ((ops.type = 'insert'), (ops.payload = p), b),
      eq: (...a: unknown[]) => (ops.filters.push(['eq', ...a]), b),
      is: (...a: unknown[]) => (ops.filters.push(['is', ...a]), b),
      in: (...a: unknown[]) => (ops.filters.push(['in', ...a]), b),
      filter: (...a: unknown[]) => (ops.filters.push(['filter', ...a]), b),
      order: (...a: unknown[]) => (ops.filters.push(['order', ...a]), b),
      limit: (...a: unknown[]) => (ops.filters.push(['limit', ...a]), b),
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
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: 'wamid.text' })),
  engineSendMedia: vi.fn(async () => ({ whatsapp_message_id: 'wamid.media' })),
  engineSendInteractiveButtons: vi.fn(async () => ({
    whatsapp_message_id: 'wamid.buttons',
  })),
  engineSendInteractiveList: vi.fn(async () => ({
    whatsapp_message_id: 'wamid.list',
  })),
}));

import { dispatchInboundToFlows } from './engine';
import {
  engineSendText,
  engineSendInteractiveButtons,
  engineSendInteractiveList,
} from './meta-send';

const ACCOUNT = 'acct-1';
const CONVERSATION = 'conv-1';

const MENU_NODE = {
  id: 'n-menu',
  flow_id: 'flow-1',
  node_key: 'menu',
  node_type: 'send_buttons',
  config: {
    text: 'Como posso ajudar?',
    buttons: [
      { reply_id: 'b1', title: 'Falar com vendas', next_node_key: 'vendas' },
      {
        reply_id: 'b2',
        title: 'Segunda via de boleto',
        next_node_key: 'boleto',
      },
    ],
  },
};

const LIST_NODE = {
  id: 'n-list',
  flow_id: 'flow-1',
  node_key: 'menu',
  node_type: 'send_list',
  config: {
    text: 'Escolha',
    button_label: 'Ver',
    sections: [
      {
        title: 'Financeiro',
        rows: [
          { reply_id: 'r1', title: 'Boleto', next_node_key: 'boleto' },
          { reply_id: 'r2', title: 'Nota fiscal', next_node_key: 'vendas' },
        ],
      },
    ],
  },
};

const END_NODES = [
  {
    id: 'n-vendas',
    flow_id: 'flow-1',
    node_key: 'vendas',
    node_type: 'end',
    config: {},
  },
  {
    id: 'n-boleto',
    flow_id: 'flow-1',
    node_key: 'boleto',
    node_type: 'end',
    config: {},
  },
];

function seed(over: { channelType?: string; menuNode?: unknown } = {}) {
  h.state.channelType = over.channelType ?? 'whatsapp_cloud';
  h.state.conversationChannelId = 'chan-1';
  h.state.nodes = [
    (over.menuNode as Record<string, unknown>) ?? MENU_NODE,
    ...END_NODES,
  ];
  h.state.flow = {
    id: 'flow-1',
    account_id: ACCOUNT,
    user_id: 'user-1',
    status: 'active',
    fallback_policy: {
      on_unknown_reply: 'reprompt',
      max_reprompts: 2,
      on_timeout_hours: 24,
      on_exhaust: 'handoff',
    },
  };
  h.state.run = {
    id: 'run-1',
    flow_id: 'flow-1',
    account_id: ACCOUNT,
    user_id: 'user-1',
    contact_id: 'contact-1',
    conversation_id: CONVERSATION,
    status: 'active',
    current_node_key: 'menu',
    last_prompt_message_id: null,
    vars: {},
    reprompt_count: 0,
  };
  h.state.events = [];
  h.state.runUpdates = [];
  h.state.messageQueries = [];
}

function inboundText(text: string) {
  return dispatchInboundToFlows({
    accountId: ACCOUNT,
    userId: 'user-1',
    contactId: 'contact-1',
    conversationId: CONVERSATION,
    message: { kind: 'text', text, meta_message_id: 'in-1' },
    isFirstInboundMessage: false,
  });
}

function inboundTap(reply_id: string) {
  return dispatchInboundToFlows({
    accountId: ACCOUNT,
    userId: 'user-1',
    contactId: 'contact-1',
    conversationId: CONVERSATION,
    message: {
      kind: 'interactive_reply',
      reply_id,
      reply_title: reply_id,
      meta_message_id: 'in-1',
    },
    isFirstInboundMessage: false,
  });
}

/** Os `node_key` por onde o run passou nesta dispatch. */
function enteredNodes(): string[] {
  return h.state.events
    .filter((e) => e.event_type === 'node_entered')
    .map((e) => e.node_key as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
});

// ============================================================
// Canal SEM botão nativo (whatsapp_qr) — a degradação
// ============================================================

describe('canal QRCode: saída degradada', () => {
  it('send_buttons vira texto numerado, e o sender interativo não é chamado', async () => {
    seed({ channelType: 'whatsapp_qr' });
    // Texto que não casa → política de fallback → reprompt reenvia o
    // MESMO nó, que é o caminho por onde o menu é montado.
    const res = await inboundText('xyz');

    expect(res.outcome).toBe('fallback_fired');
    expect(engineSendInteractiveButtons).not.toHaveBeenCalled();
    expect(engineSendText).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(engineSendText).mock.calls[0][0].text;
    expect(sent).toContain('Como posso ajudar?');
    expect(sent).toContain('1\u{FE0F}\u{20E3} Falar com vendas');
    expect(sent).toContain('2\u{FE0F}\u{20E3} Segunda via de boleto');
  });

  it('send_list achata as seções no mesmo texto numerado', async () => {
    seed({ channelType: 'whatsapp_qr', menuNode: LIST_NODE });
    await inboundText('xyz');

    expect(engineSendInteractiveList).not.toHaveBeenCalled();
    const sent = vi.mocked(engineSendText).mock.calls[0][0].text;
    expect(sent).toContain('1\u{FE0F}\u{20E3} Boleto');
    expect(sent).toContain('2\u{FE0F}\u{20E3} Nota fiscal');
  });

  it('o evento message_sent registra que o envio saiu degradado', async () => {
    seed({ channelType: 'whatsapp_qr' });
    await inboundText('xyz');
    const sentEvent = h.state.events.find(
      (e) => e.event_type === 'message_sent'
    );
    expect(sentEvent?.payload.degraded).toBe(true);
  });
});

describe('canal QRCode: entrada degradada (o que o PRD esqueceu)', () => {
  it('responder "2" avança para o next_node_key do 2º botão', async () => {
    seed({ channelType: 'whatsapp_qr' });
    const res = await inboundText('2');

    expect(res.consumed).toBe(true);
    expect(enteredNodes()).toContain('boleto');
    expect(enteredNodes()).not.toContain('vendas');
    // Avançou de verdade: nenhum reprompt saiu.
    expect(engineSendText).not.toHaveBeenCalled();
  });

  it('responder o rótulo ("segunda via") avança pelo mesmo ramo', async () => {
    seed({ channelType: 'whatsapp_qr' });
    await inboundText('segunda via');
    expect(enteredNodes()).toContain('boleto');
  });

  it('responder "1" no send_list avança pela primeira linha da 1ª seção', async () => {
    seed({ channelType: 'whatsapp_qr', menuNode: LIST_NODE });
    await inboundText('1');
    expect(enteredNodes()).toContain('boleto');
  });

  it('texto que não casa reprompta com o MESMO menu numerado', async () => {
    seed({ channelType: 'whatsapp_qr' });
    const res = await inboundText('não sei');

    expect(res.outcome).toBe('fallback_fired');
    expect(enteredNodes()).toEqual([]);
    expect(vi.mocked(engineSendText).mock.calls[0][0].text).toContain(
      '1\u{FE0F}\u{20E3} Falar com vendas'
    );
  });
});

// ============================================================
// Canal oficial (whatsapp_cloud) — INALTERADO, byte a byte
// ============================================================

describe('canal oficial: nada muda', () => {
  it('send_buttons continua saindo como botão nativo', async () => {
    await inboundText('xyz');
    expect(engineSendInteractiveButtons).toHaveBeenCalledTimes(1);
    expect(engineSendText).not.toHaveBeenCalled();
  });

  it('send_list continua saindo como lista nativa', async () => {
    seed({ menuNode: LIST_NODE });
    await inboundText('xyz');
    expect(engineSendInteractiveList).toHaveBeenCalledTimes(1);
    expect(engineSendText).not.toHaveBeenCalled();
  });

  it('"2" digitado NÃO avança o flow — cai no fallback, como sempre', async () => {
    const res = await inboundText('2');

    expect(res.outcome).toBe('fallback_fired');
    expect(enteredNodes()).toEqual([]);
    expect(engineSendInteractiveButtons).toHaveBeenCalledTimes(1);
  });

  it('o rótulo digitado NÃO avança o flow no canal oficial', async () => {
    const res = await inboundText('segunda via de boleto');
    expect(res.outcome).toBe('fallback_fired');
    expect(enteredNodes()).toEqual([]);
  });

  it('o toque no botão continua casando por reply_id', async () => {
    const res = await inboundTap('b2');
    expect(res.consumed).toBe(true);
    expect(enteredNodes()).toContain('boleto');
  });

  it('conversa sem channel_id (conta pré-055) se comporta como oficial', async () => {
    h.state.conversationChannelId = null;
    const res = await inboundText('2');
    expect(res.outcome).toBe('fallback_fired');
    expect(engineSendInteractiveButtons).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// §1.8 — last_prompt_message_id resolvido por um id não-único
// ============================================================

describe('last_prompt_message_id', () => {
  it('busca a mensagem escopada por conversa e ordenada, nunca por message_id sozinho', async () => {
    seed({ channelType: 'whatsapp_qr' });
    await inboundText('xyz');

    const query = h.state.messageQueries.at(-1)!;
    const flat = query.map((f) => f.join(':'));
    expect(flat).toContain(`eq:conversation_id:${CONVERSATION}`);
    expect(flat).toContain('eq:message_id:wamid.text');
    expect(query.some((f) => f[0] === 'order')).toBe(true);
    expect(query.some((f) => f[0] === 'limit')).toBe(true);
    // `maybeSingle()` sobre duas linhas devolve PGRST116 — o motivo de a
    // busca ter deixado de usá-lo.
    expect(h.state.runUpdates).toContainEqual({
      last_prompt_message_id: 'msg-row-1',
    });
  });
});
