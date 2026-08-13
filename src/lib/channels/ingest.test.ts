/**
 * Testes de PARIDADE da ingestão (SPEC 048 §5, fase F2).
 *
 * O que se prova aqui não é que o ingest "funciona" — é que ele faz
 * exatamente o que o `processMessage()` da rota do webhook fazia:
 * mesmas colunas, mesma ordem, mesmos curto-circuitos. Cada teste
 * corresponde a uma decisão que já custou um incidente.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { ingestInbound, type IngestContext } from './ingest';
import type { NormalizedMessage, NormalizedReaction } from './types';

// ------------------------------------------------------------
// Dependências de borda: aqui interessa o que o ingest ESCREVE, não o
// que os motores fazem com o que ele dispara.
// ------------------------------------------------------------

const findExistingContact = vi.fn();
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: (...args: unknown[]) => findExistingContact(...args),
  isUniqueViolation: () => false,
}));

const setContactOptIn = vi.fn();
vi.mock('@/lib/contacts/consent', () => ({
  setContactOptIn: (...args: unknown[]) => setContactOptIn(...args),
}));

const dispatchInboundToFlows = vi.fn();
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: (...args: unknown[]) =>
    dispatchInboundToFlows(...args),
}));

const runAutomationsForTrigger = vi.fn();
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: (...args: unknown[]) =>
    runAutomationsForTrigger(...args),
}));

const dispatchInboundToAiReply = vi.fn();
vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: (...args: unknown[]) =>
    dispatchInboundToAiReply(...args),
}));

const dispatchWebhookEvent = vi.fn();
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: (...args: unknown[]) => dispatchWebhookEvent(...args),
}));

// ------------------------------------------------------------
// Supabase de mentira: registra cada operação na ordem em que
// aconteceu. É a ordem que este PR precisa provar.
// ------------------------------------------------------------

interface RecordedOp {
  table: string;
  verb: 'select' | 'insert' | 'update' | 'upsert' | 'delete';
  payload?: unknown;
  filters: Array<[string, ...unknown[]]>;
}

interface FakeDb {
  client: SupabaseClient;
  ops: RecordedOp[];
  /** Resultado por `${table}.${verb}` — o que faltar devolve vazio. */
  results: Map<string, { data?: unknown; error?: unknown; count?: number }>;
}

function makeDb(
  results: Record<
    string,
    { data?: unknown; error?: unknown; count?: number }
  > = {}
): FakeDb {
  const ops: RecordedOp[] = [];
  const resultMap = new Map(Object.entries(results));

  function builder(table: string) {
    const op: RecordedOp = { table, verb: 'select', filters: [] };
    let recorded = false;

    const settle = () => {
      if (!recorded) {
        ops.push(op);
        recorded = true;
      }
      return (
        resultMap.get(`${table}.${op.verb}`) ?? { data: null, error: null }
      );
    };

    const chain: Record<string, unknown> = {
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve(settle()).then(resolve, reject);
      },
    };

    for (const verb of ['insert', 'update', 'upsert', 'delete'] as const) {
      chain[verb] = (payload?: unknown) => {
        op.verb = verb;
        op.payload = payload;
        return chain;
      };
    }
    chain.select = (...args: unknown[]) => {
      op.filters.push(['select', ...args]);
      return chain;
    };
    for (const method of [
      'eq',
      'or',
      'not',
      'is',
      'gte',
      'in',
      'order',
      'limit',
    ] as const) {
      chain[method] = (...args: unknown[]) => {
        op.filters.push([method, ...args]);
        return chain;
      };
    }
    chain.single = () => Promise.resolve(settle());
    chain.maybeSingle = () => Promise.resolve(settle());

    return chain;
  }

  return {
    client: {
      from: (table: string) => builder(table),
    } as unknown as SupabaseClient,
    ops,
    results: resultMap,
  };
}

const CONTACT = { id: 'contact-1', name: 'Ana', phone: '+5511999999999' };
const CONVERSATION = { id: 'conv-1', unread_count: 2 };

function ctxFor(
  db: FakeDb,
  channelType: 'whatsapp_cloud' | 'whatsapp_qr' = 'whatsapp_cloud'
): IngestContext {
  return {
    db: db.client,
    accountId: 'acct-1',
    ownerUserId: 'user-1',
    channelType,
  };
}

function textMessage(over: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    kind: 'message',
    fromPhone: '+5511999999999',
    pushName: 'Ana',
    providerMessageId: 'wamid.1',
    fromMe: false,
    contentType: 'text',
    text: 'oi',
    occurredAt: new Date('2026-08-12T12:00:00.000Z'),
    ...over,
  };
}

/** Estado padrão: contato e conversa já existem. */
function existingThread(extra: Record<string, unknown> = {}) {
  findExistingContact.mockResolvedValue(CONTACT);
  return makeDb({
    'conversations.select': { data: [CONVERSATION], error: null },
    'messages.select': { data: null, error: null, count: 3 },
    ...extra,
  });
}

function opsFor(db: FakeDb, table: string, verb?: RecordedOp['verb']) {
  return db.ops.filter(
    (o) => o.table === table && (verb ? o.verb === verb : true)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  dispatchInboundToFlows.mockResolvedValue({ consumed: false });
  runAutomationsForTrigger.mockResolvedValue(undefined);
  dispatchWebhookEvent.mockResolvedValue(undefined);
  dispatchInboundToAiReply.mockResolvedValue(undefined);
  setContactOptIn.mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('ingestInbound — mensagem', () => {
  it('grava a mensagem com o instante DO PROVEDOR, não o do servidor', async () => {
    const db = existingThread();
    const occurredAt = new Date('2026-08-12T09:30:00.000Z');

    await ingestInbound(ctxFor(db), textMessage({ occurredAt }));

    const insert = opsFor(db, 'messages', 'insert')[0];
    expect(insert.payload).toMatchObject({
      conversation_id: 'conv-1',
      sender_type: 'customer',
      content_type: 'text',
      content_text: 'oi',
      message_id: 'wamid.1',
      status: 'delivered',
      created_at: occurredAt.toISOString(),
    });
  });

  it('incrementa unread_count a partir do valor da conversa carregada', async () => {
    const db = existingThread();

    await ingestInbound(ctxFor(db), textMessage());

    const update = opsFor(db, 'conversations', 'update')[0];
    expect(update.payload).toMatchObject({
      last_message_text: 'oi',
      unread_count: 3,
    });
  });

  it('usa o rótulo do tipo CRU no preview quando não há texto', async () => {
    const db = existingThread();

    await ingestInbound(
      ctxFor(db),
      textMessage({
        text: null,
        contentType: 'image',
        providerContentLabel: 'sticker',
      })
    );

    const update = opsFor(db, 'conversations', 'update')[0];
    expect(update.payload).toMatchObject({ last_message_text: '[sticker]' });
  });

  it('não grava a mensagem duas vezes quando o INSERT falha', async () => {
    const db = existingThread({
      'messages.insert': { data: null, error: { message: 'boom' } },
    });

    await ingestInbound(ctxFor(db), textMessage());

    // Abortou: nada de flows, automações ou webhook de saída.
    expect(dispatchInboundToFlows).not.toHaveBeenCalled();
    expect(dispatchWebhookEvent).not.toHaveBeenCalled();
  });
});

describe('ingestInbound — eco do operador (fromMe)', () => {
  it('não grava como mensagem do cliente o que saiu do aparelho do operador', async () => {
    // O canal QRCode devolve `SEND_MESSAGE` do que o operador digitou no
    // próprio celular. Gravar isso como `sender_type: 'customer'` faria
    // a mensagem contar como não-lida, disparar automações de conteúdo e
    // — o pior — a IA responder ao próprio operador.
    const db = existingThread();

    await ingestInbound(
      ctxFor(db, 'whatsapp_qr'),
      textMessage({ fromMe: true, text: 'respondendo pelo celular' })
    );

    expect(opsFor(db, 'messages', 'insert')).toHaveLength(0);
    expect(opsFor(db, 'conversations', 'update')).toHaveLength(0);
    expect(runAutomationsForTrigger).not.toHaveBeenCalled();
    expect(dispatchInboundToAiReply).not.toHaveBeenCalled();
  });

  it('a conversa continua sendo aberta antes da recusa', async () => {
    // O eco ainda é sinal de que existe uma conversa com essa pessoa —
    // desistir antes de resolver contato/conversa perderia isso.
    findExistingContact.mockResolvedValue(CONTACT);
    const db = makeDb({
      'conversations.select': { data: [], error: null },
      'conversations.insert': { data: CONVERSATION, error: null },
    });

    await ingestInbound(
      ctxFor(db, 'whatsapp_qr'),
      textMessage({ fromMe: true })
    );

    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      'conversation.created',
      expect.objectContaining({ conversation_id: 'conv-1' })
    );
  });

  it('o canal oficial nunca entra nesse ramo', async () => {
    const db = existingThread();

    await ingestInbound(ctxFor(db), textMessage({ fromMe: false }));

    expect(opsFor(db, 'messages', 'insert')).toHaveLength(1);
  });
});

describe('ingestInbound — janela de sessão de 24h', () => {
  it('escreve a âncora com filtro monotônico no canal oficial', async () => {
    const db = existingThread();
    const occurredAt = new Date('2026-08-12T09:30:00.000Z');

    await ingestInbound(ctxFor(db), textMessage({ occurredAt }));

    const anchor = opsFor(db, 'conversations', 'update')[1];
    expect(anchor.payload).toEqual({
      last_customer_message_at: occurredAt.toISOString(),
    });
    // O `.or(...)` é o que impede uma reentrega fora de ordem de puxar a
    // âncora para trás.
    expect(anchor.filters).toContainEqual([
      'or',
      `last_customer_message_at.is.null,last_customer_message_at.lt.${occurredAt.toISOString()}`,
    ]);
  });

  it('NÃO escreve a âncora num canal sem janela de 24h', async () => {
    const db = existingThread();

    await ingestInbound(ctxFor(db, 'whatsapp_qr'), textMessage());

    const anchorWrites = opsFor(db, 'conversations', 'update').filter((o) =>
      Object.prototype.hasOwnProperty.call(
        o.payload as object,
        'last_customer_message_at'
      )
    );
    expect(anchorWrites).toHaveLength(0);
    // E, por consequência, não tenta marcar reabertura de janela.
    expect(opsFor(db, 'automation_window_claims')).toHaveLength(0);
  });

  it('marca reabertura só quando a âncora AVANÇOU', async () => {
    const db = existingThread({
      // `.select('id')` do UPDATE da âncora devolvendo linha = avançou.
      'conversations.update': { data: [{ id: 'conv-1' }], error: null },
    });

    await ingestInbound(ctxFor(db), textMessage());

    expect(opsFor(db, 'automation_window_claims', 'update')).toHaveLength(1);
  });

  it('não marca reabertura numa reentrega fora de ordem', async () => {
    const db = existingThread({
      // Filtro monotônico não casou → zero linhas.
      'conversations.update': { data: [], error: null },
    });

    await ingestInbound(ctxFor(db), textMessage());

    expect(opsFor(db, 'automation_window_claims')).toHaveLength(0);
  });
});

describe('ingestInbound — gatilhos', () => {
  it('respeita a ORDEM: opt-out → flow runner → automações → IA', async () => {
    // A ordem não é estética. O opt-out precisa estar GRAVADO quando a
    // automação de confirmação rodar; o flow runner precisa ter dito se
    // consumiu antes de as automações de conteúdo dispararem; e a IA só
    // pode falar depois que ninguém determinístico assumiu. Uma
    // reordenação aqui muda o produto sem quebrar nada visivelmente —
    // por isso a asserção é sobre a sequência de chamadas, e não sobre
    // cada uma isoladamente.
    const db = existingThread();

    // `detectOptOut` só casa quando a mensagem INTEIRA é o pedido.
    await ingestInbound(ctxFor(db), textMessage({ text: 'SAIR' }));

    const order = (m: typeof setContactOptIn) => m.mock.invocationCallOrder[0];

    expect(order(setContactOptIn)).toBeLessThan(order(dispatchInboundToFlows));
    expect(order(dispatchInboundToFlows)).toBeLessThan(
      order(runAutomationsForTrigger)
    );
    // `message.received` (webhook de saída) fecha a sequência.
    const lastWebhook = dispatchWebhookEvent.mock.invocationCallOrder.at(-1)!;
    expect(order(runAutomationsForTrigger)).toBeLessThan(lastWebhook);
  });

  it('suprime gatilhos de conteúdo quando um flow consome a mensagem', async () => {
    const db = existingThread();
    dispatchInboundToFlows.mockResolvedValue({ consumed: true });

    await ingestInbound(ctxFor(db), textMessage());

    expect(runAutomationsForTrigger).not.toHaveBeenCalled();
    expect(dispatchInboundToAiReply).not.toHaveBeenCalled();
  });

  it('dispara new_message_received + keyword_match quando ninguém consumiu', async () => {
    const db = existingThread();

    await ingestInbound(ctxFor(db), textMessage());

    const triggers = runAutomationsForTrigger.mock.calls.map(
      (c) => (c[0] as { triggerType: string }).triggerType
    );
    expect(triggers).toEqual(['new_message_received', 'keyword_match']);
  });

  it('acrescenta interactive_reply num toque de botão', async () => {
    const db = existingThread();

    await ingestInbound(
      ctxFor(db),
      textMessage({ contentType: 'interactive', interactiveReplyId: 'opt-1' })
    );

    const triggers = runAutomationsForTrigger.mock.calls.map(
      (c) => (c[0] as { triggerType: string }).triggerType
    );
    expect(triggers).toContain('interactive_reply');
    // Toque em botão nunca vira resposta da IA.
    expect(dispatchInboundToAiReply).not.toHaveBeenCalled();
  });

  it('marca first_inbound_message quando não havia mensagem do cliente', async () => {
    const db = existingThread({
      'messages.select': { data: null, error: null, count: 0 },
    });

    await ingestInbound(ctxFor(db), textMessage());

    const triggers = runAutomationsForTrigger.mock.calls.map(
      (c) => (c[0] as { triggerType: string }).triggerType
    );
    expect(triggers[0]).toBe('first_inbound_message');
  });
});

describe('ingestInbound — opt-out', () => {
  it('registra o descadastro e cala a IA, sem suprimir automações', async () => {
    const db = existingThread();

    await ingestInbound(ctxFor(db), textMessage({ text: 'SAIR' }));

    expect(setContactOptIn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        contactId: 'contact-1',
        status: 'opted_out',
        source: 'inbound_keyword',
      })
    );
    // A confirmação de descadastro é trabalho de automação
    // determinística — os gatilhos continuam disparando.
    expect(runAutomationsForTrigger).toHaveBeenCalled();
    // Responder "SAIR" com um texto de LLM é o oposto do pedido.
    expect(dispatchInboundToAiReply).not.toHaveBeenCalled();
  });
});

describe('ingestInbound — reações', () => {
  const reaction: NormalizedReaction = {
    kind: 'reaction',
    fromPhone: '+5511999999999',
    pushName: 'Ana',
    targetProviderMessageId: 'wamid.alvo',
    emoji: '👍',
    occurredAt: new Date('2026-08-12T12:00:00.000Z'),
  };

  it('não insere em messages nem mexe no preview da conversa', async () => {
    const db = existingThread({
      'messages.select': { data: { id: 'msg-interno' }, error: null },
    });

    await ingestInbound(ctxFor(db), reaction);

    expect(opsFor(db, 'messages', 'insert')).toHaveLength(0);
    expect(opsFor(db, 'conversations', 'update')).toHaveLength(0);
    expect(opsFor(db, 'message_reactions', 'upsert')).toHaveLength(1);
  });

  it('emoji vazio remove a reação', async () => {
    const db = existingThread({
      'messages.select': { data: { id: 'msg-interno' }, error: null },
    });

    await ingestInbound(ctxFor(db), { ...reaction, emoji: '' });

    expect(opsFor(db, 'message_reactions', 'delete')).toHaveLength(1);
    expect(opsFor(db, 'message_reactions', 'upsert')).toHaveLength(0);
  });

  it('abre a conversa (e emite conversation.created) antes de desistir de uma reação órfã', async () => {
    // Conversa inexistente → criada agora; alvo da reação nunca recebido.
    findExistingContact.mockResolvedValue(CONTACT);
    const db = makeDb({
      'conversations.select': { data: [], error: null },
      'conversations.insert': { data: CONVERSATION, error: null },
      'messages.select': { data: null, error: null },
    });

    await ingestInbound(ctxFor(db), reaction);

    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      'conversation.created',
      expect.objectContaining({ conversation_id: 'conv-1' })
    );
    expect(opsFor(db, 'message_reactions')).toHaveLength(0);
  });
});

describe('ingestInbound — idempotência de reentrega', () => {
  it('ignora a reentrega num canal que reentrega', async () => {
    const db = existingThread({
      'messages.select': { data: { id: 'msg-ja-gravada' }, error: null },
    });

    await ingestInbound(ctxFor(db, 'whatsapp_qr'), textMessage());

    expect(opsFor(db, 'messages', 'insert')).toHaveLength(0);
  });

  it('não paga a consulta extra no canal oficial', async () => {
    const db = existingThread();

    await ingestInbound(ctxFor(db), textMessage());

    // A única leitura em `messages` é a contagem de mensagens do
    // cliente (o `count: 'exact', head: true`).
    const reads = opsFor(db, 'messages', 'select');
    expect(reads).toHaveLength(1);
    expect(reads[0].filters).toContainEqual([
      'select',
      'id',
      { count: 'exact', head: true },
    ]);
  });
});
