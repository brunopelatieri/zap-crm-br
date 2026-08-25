/**
 * O desvio por canal, ponta a ponta (SPEC 049 §6.1 / PRD 047 §10.2).
 *
 * Por que este arquivo não mocka `sendAndPersistOutbound`
 *
 *   As quatro afirmações que a §6.1 faz são todas sobre o que acontece
 *   DENTRO do caminho de saída: por qual canal a credencial é resolvida,
 *   em qual conversa a bolha é gravada, em que ordem o consumo é
 *   contado, e qual erro vira `skip` e qual vira `fail`. Um duplo de
 *   `sendAndPersistOutbound` provaria apenas que o motor chama a função
 *   com os argumentos que este teste inventou — exatamente a fixture que
 *   repete a suposição do autor. Aqui o mock é do BANCO e do adaptador,
 *   e o `lib/channels/send.ts` real roda no meio.
 *
 *   O preço é um fake de Supabase maior; a contrapartida é que "nunca
 *   toca `whatsapp_config`" e "persiste na conversa original" são
 *   asserções sobre operações de banco de verdade.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { EvolutionApiError } from '@/lib/evolution/client';
import { COLD_SEND_DEFAULTS } from '@/lib/channels/cold-send-limit';

// ------------------------------------------------------------
// Supabase de mentira — um só cliente serve o motor E o
// `lib/channels/send.ts`, que recebe este mesmo `db` como parâmetro.
// ------------------------------------------------------------

const h = vi.hoisted(() => {
  const state = {
    /** Linha de `contacts` (dono + telefone + consentimento). */
    contact: null as Record<string, unknown> | null,
    /** Linha de `conversations` lida pelo guard e pelo teto de envio frio. */
    conversationRow: null as { last_customer_message_at: string | null } | null,
    /** Canais da conta — `loadFallbackChannels` e `resolveChannelContext`. */
    channels: [] as Record<string, unknown>[],
    automations: [] as Record<string, unknown>[],
    steps: [] as Record<string, unknown>[],
    /** Envios frios já contados nas janelas de 24h / 1h. */
    coldSendCount: 0,
    /** Erro devolvido pelo INSERT em `messages`, quando o teste quer um. */
    messageInsertError: null as { message: string } | null,
    ops: [] as {
      table: string;
      verb: string;
      payload?: unknown;
      filters: [string, string, unknown][];
    }[],
    /** `steps_executed` de cada `update` em `automation_logs`. */
    logUpdates: [] as Record<string, unknown>[],
  };

  function resolve(ops: {
    table: string;
    type: string;
    payload?: unknown;
    filters: [string, string, unknown][];
  }) {
    const { table, type, filters } = ops;
    state.ops.push({
      table,
      verb: type,
      payload: ops.payload,
      filters: filters.slice(),
    });

    const eq = (key: string) =>
      filters.find(([op, k]) => op === 'eq' && k === key)?.[2];

    if (table === 'contacts') {
      if (type === 'update') return { data: null, error: null };
      return { data: state.contact, error: null };
    }
    if (table === 'conversations') {
      if (type === 'update') return { data: null, error: null };
      // Serve as três leituras: guard de janela, `channelForConversation`
      // (sem embed `channels` → canal oficial, que é o caso do desvio) e
      // a âncora do teto de envio frio.
      return { data: state.conversationRow, error: null };
    }
    if (table === 'channels') {
      // Uma linha quando a consulta é por id (`resolveChannelContext`,
      // `loadColdSendUsage`); a lista da conta quando não é
      // (`loadFallbackChannels`).
      const id = eq('id');
      if (id !== undefined) {
        return {
          data: state.channels.find((c) => c.id === id) ?? null,
          error: null,
        };
      }
      return { data: state.channels, error: null };
    }
    if (table === 'channel_cold_sends') {
      if (type === 'insert') return { data: null, error: null };
      // `loadColdSendUsage` faz duas contagens (24h/1h) e uma leitura do
      // último envio. `sent_at: null` = nenhum envio anterior, então o
      // intervalo mínimo não entra em jogo.
      return { data: null, error: null, count: state.coldSendCount };
    }
    if (table === 'messages') {
      return { data: null, error: state.messageInsertError };
    }
    if (table === 'automations')
      return { data: state.automations, error: null };
    if (table === 'automation_logs') {
      if (type === 'insert') return { data: { id: 'log1' }, error: null };
      if (type === 'update') {
        state.logUpdates.push((ops.payload ?? {}) as Record<string, unknown>);
        return { data: null, error: null };
      }
      return { data: { steps_executed: [], status: 'success' }, error: null };
    }
    if (table === 'automation_steps') {
      let rows = state.steps.slice();
      for (const [op, k, v] of filters) {
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
      payload: undefined as unknown,
      filters: [] as [string, string, unknown][],
    };
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => ((ops.type = 'insert'), (ops.payload = p), b),
      update: (p: unknown) => ((ops.type = 'update'), (ops.payload = p), b),
      delete: () => ((ops.type = 'delete'), b),
      upsert: (p: unknown) => ((ops.type = 'upsert'), (ops.payload = p), b),
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

  const client = {
    from: (t: string) => builder(t),
    rpc: () => Promise.resolve({ error: null }),
  };

  return { state, client };
});

vi.mock('./admin-client', () => ({ supabaseAdmin: () => h.client }));

// `sendAndPersistOutbound` (lib/channels/send.ts) grava o consumo de
// envio frio direto por `@/lib/supabase/admin` (062: só service_role
// pode escrever em channel_cold_sends — nunca o `db` que recebe como
// parâmetro). Precisa do MESMO client de mentira do mock acima, senão a
// gravação tenta abrir uma conexão Supabase real e o passo do motor
// falha silenciosamente com "supabaseUrl is required".
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => h.client }));

// A instância da Evolution: o token vem daqui, NUNCA de `whatsapp_config`.
const resolveInstanceByChannelId = vi.fn();
vi.mock('@/lib/evolution/instances', () => ({
  resolveInstanceByChannelId: (...a: unknown[]) =>
    resolveInstanceByChannelId(...a),
}));

const qrAdapter = {
  sendText: vi.fn(async () => ({ providerMessageId: 'ev-1' })),
  sendMedia: vi.fn(),
  normalizeInbound: vi.fn(),
  capabilities: {},
};

vi.mock('@/lib/channels/registry', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/channels/registry')>();
  return {
    ...actual,
    getAdapter: (type: string) =>
      type === 'whatsapp_qr' ? qrAdapter : actual.getAdapter(type as never),
  };
});

import { runAutomationsForTrigger } from './engine';

const ACCOUNT = 'acct-1';
const QR_CHANNEL = 'chan-qr-1';

function hoursAgoIso(n: number): string {
  return new Date(Date.now() - n * 3_600_000).toISOString();
}

function fallbackStep(): Record<string, unknown> {
  return {
    id: 's1',
    automation_id: 'a1',
    step_type: 'send_message',
    position: 0,
    parent_step_id: null,
    step_config: {
      text: 'Ainda posso ajudar?',
      on_window_closed: 'fallback_channel',
      fallback_channel_id: QR_CHANNEL,
    },
  };
}

/** Passo seguinte, só para provar se o run continuou (skip) ou parou (fail). */
function markerStep(): Record<string, unknown> {
  return {
    id: 's2',
    automation_id: 'a1',
    step_type: 'update_contact_field',
    position: 1,
    parent_step_id: null,
    step_config: { field: 'company', value: 'reached-second-step' },
  };
}

async function run(steps = [fallbackStep(), markerStep()]) {
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
  h.state.steps = steps;
  await runAutomationsForTrigger({
    accountId: ACCOUNT,
    triggerType: 'new_message_received',
    contactId: 'c1',
    context: { conversation_id: 'conv1' },
  });
}

/** Detalhe registrado em `automation_logs` para o passo do desvio. */
function stepDetail(stepId: string): { status: string; detail: string } {
  const results = h.state.logUpdates
    .flatMap((u) => (u.steps_executed ?? []) as { step_id: string }[])
    .filter((r) => r.step_id === stepId);
  return results[results.length - 1] as unknown as {
    status: string;
    detail: string;
  };
}

function reachedSecondStep(): boolean {
  return h.state.ops.some(
    (o) =>
      o.table === 'contacts' &&
      o.verb === 'update' &&
      (o.payload as Record<string, unknown> | undefined)?.company ===
        'reached-second-step'
  );
}

beforeEach(() => {
  h.state.contact = { id: 'c1', phone: '5511999999999' };
  // Janela FECHADA: é a pré-condição do desvio.
  h.state.conversationRow = { last_customer_message_at: hoursAgoIso(30) };
  h.state.channels = [
    {
      id: QR_CHANNEL,
      account_id: ACCOUNT,
      user_id: 'u1',
      type: 'whatsapp_qr',
      name: 'Vendas',
      status: 'connected',
      // Fora do aquecimento — senão o teto diário cai para o piso e o
      // teste de "dentro da cota" passaria a depender dele.
      created_at: '2020-01-01T00:00:00Z',
    },
  ];
  h.state.coldSendCount = 0;
  h.state.messageInsertError = null;
  h.state.ops = [];
  h.state.logUpdates = [];
  qrAdapter.sendText.mockClear();
  qrAdapter.sendText.mockResolvedValue({ providerMessageId: 'ev-1' });
  resolveInstanceByChannelId.mockReset();
  resolveInstanceByChannelId.mockResolvedValue({
    instanceId: 'inst-1',
    channelId: QR_CHANNEL,
    accountId: ACCOUNT,
    remoteInstanceId: 'remote-1',
    remoteInstanceName: 'zapcrm_acct1_vendas',
    token: 'plain-instance-token',
    channelName: 'Vendas',
  });
});

describe('sendViaFallbackChannel — envio pelo canal do desvio (§6.1)', () => {
  it('entrega pelo adaptador do canal escolhido e nunca toca whatsapp_config', async () => {
    await run();

    expect(qrAdapter.sendText).toHaveBeenCalledTimes(1);
    const [ctx, params] = qrAdapter.sendText.mock.calls[0] as unknown as [
      { channel: { id: string; type: string }; credentials: unknown },
      { to: string; text: string },
    ];
    expect(ctx.channel.id).toBe(QR_CHANNEL);
    expect(ctx.channel.type).toBe('whatsapp_qr');
    expect(ctx.credentials).toEqual({ instanceToken: 'plain-instance-token' });
    expect(params.text).toBe('Ainda posso ajudar?');

    // A credencial do canal oficial não é nem consultada: o desvio existe
    // justamente para sair por outro número.
    expect(h.state.ops.some((o) => o.table === 'whatsapp_config')).toBe(false);

    const result = stepDetail('s1');
    expect(result.status).toBe('success');
    expect(result.detail).toBe('sent via fallback channel "Vendas" (ev-1)');
  });

  it('persiste a bolha na conversa ORIGINAL, não numa thread nova do canal QR', async () => {
    await run();

    const insert = h.state.ops.find(
      (o) => o.table === 'messages' && o.verb === 'insert'
    );
    expect(insert?.payload).toMatchObject({
      conversation_id: 'conv1',
      // Selo do canal de desvio (§6.1 ponto 2, migração 063): a bolha
      // carrega o id do canal que REALMENTE entregou, para a UI marcar
      // que este envio saiu de um número diferente do da conversa.
      channel_id: QR_CHANNEL,
      sender_type: 'bot',
      content_type: 'text',
      content_text: 'Ainda posso ajudar?',
      message_id: 'ev-1',
      status: 'sent',
    });

    // E o preview da lista é atualizado na mesma conversa.
    const update = h.state.ops.find(
      (o) => o.table === 'conversations' && o.verb === 'update'
    );
    expect(update?.filters).toContainEqual(['eq', 'id', 'conv1']);
  });

  it('conta o envio frio DEPOIS da entrega, com origin=engine', async () => {
    await run();

    const record = h.state.ops.find(
      (o) => o.table === 'channel_cold_sends' && o.verb === 'insert'
    );
    expect(record?.payload).toEqual({
      channel_id: QR_CHANNEL,
      account_id: ACCOUNT,
      contact_id: 'c1',
      origin: 'engine',
    });

    const sendIndex = h.state.ops.findIndex(
      (o) => o.table === 'messages' && o.verb === 'insert'
    );
    const recordIndex = h.state.ops.indexOf(record!);
    expect(recordIndex).toBeGreaterThan(sendIndex);
  });
});

describe('sendViaFallbackChannel — a fronteira skip × fail (§6.1)', () => {
  it('teto de envio frio negado vira SKIP com o texto de describeDenial(), e o run continua', async () => {
    h.state.coldSendCount = COLD_SEND_DEFAULTS.perDay;

    await run();

    // Cota é adiamento, não defeito (PRD §10.3): nada foi entregue…
    expect(qrAdapter.sendText).not.toHaveBeenCalled();
    expect(
      h.state.ops.some((o) => o.table === 'messages' && o.verb === 'insert')
    ).toBe(false);

    const result = stepDetail('s1');
    expect(result.status).toBe('skipped');
    expect(result.detail).toBe(
      `cold-send daily limit reached (${COLD_SEND_DEFAULTS.perDay}/24h)`
    );
    // …e o passo seguinte roda.
    expect(reachedSecondStep()).toBe(true);
  });

  it('channel_unavailable vira FALHA do passo (com o canal no motivo), não skip', async () => {
    // A rota foi decidida com `status = 'connected'` lido da tabela; a
    // instância caiu entre a decisão e o envio.
    qrAdapter.sendText.mockRejectedValueOnce(
      new EvolutionApiError('channel_unavailable', 502, 'instance offline')
    );

    await run();

    const result = stepDetail('s1');
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('fallback channel "Vendas"');
    expect(result.detail).toContain('instance offline');

    // Falha PARA a automação — ao contrário do skip.
    expect(reachedSecondStep()).toBe(false);
    // E nada foi gravado como enviado.
    expect(
      h.state.ops.some((o) => o.table === 'messages' && o.verb === 'insert')
    ).toBe(false);
  });

  it('canal do desvio sem instância (token ausente) falha com motivo, sem cair no canal oficial', async () => {
    resolveInstanceByChannelId.mockRejectedValueOnce(
      new Error('no Evolution instance for channel')
    );

    await run();

    const result = stepDetail('s1');
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('fallback channel "Vendas"');
    expect(qrAdapter.sendText).not.toHaveBeenCalled();
    expect(h.state.ops.some((o) => o.table === 'whatsapp_config')).toBe(false);
  });

  it('entregou mas o INSERT falhou: falha explícita, e o consumo não é contado', async () => {
    h.state.messageInsertError = { message: 'constraint' };

    await run();

    const result = stepDetail('s1');
    expect(result.status).toBe('failed');
    // O texto diz que a mensagem SAIU — é o que impede o operador (e o
    // motor, numa retentativa) de tratar isto como não-entregue.
    expect(result.detail).toContain('DB insert failed');
    expect(qrAdapter.sendText).toHaveBeenCalledTimes(1);
    expect(
      h.state.ops.some(
        (o) => o.table === 'channel_cold_sends' && o.verb === 'insert'
      )
    ).toBe(false);
  });
});

describe('sendViaFallbackChannel — guardrails que a decisão de rota já impõe', () => {
  it('contato opted-out não chega ao envio: skip antes de resolver canal algum', async () => {
    h.state.contact = {
      id: 'c1',
      phone: '5511999999999',
      opt_in_status: 'opted_out',
    };

    await run();

    expect(qrAdapter.sendText).not.toHaveBeenCalled();
    expect(resolveInstanceByChannelId).not.toHaveBeenCalled();
    const result = stepDetail('s1');
    expect(result.status).toBe('skipped');
    expect(result.detail).toBe('opted out — channel fallback suppressed');
    expect(reachedSecondStep()).toBe(true);
  });

  it('janela ABERTA não desvia: o envio segue pelo canal da conversa', async () => {
    h.state.conversationRow = { last_customer_message_at: hoursAgoIso(1) };

    await run();

    // Nenhum envio pelo canal QR: o caminho normal resolve o canal da
    // própria conversa — que aqui é o oficial, e é a `whatsapp_config`
    // que ele consulta.
    expect(qrAdapter.sendText).not.toHaveBeenCalled();
    expect(resolveInstanceByChannelId).not.toHaveBeenCalled();
    expect(h.state.ops.some((o) => o.table === 'whatsapp_config')).toBe(true);
  });
});
