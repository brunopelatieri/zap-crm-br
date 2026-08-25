import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const resolveInstanceByChannelId = vi.fn();
vi.mock('@/lib/evolution/instances', () => ({
  resolveInstanceByChannelId: (...a: unknown[]) =>
    resolveInstanceByChannelId(...a),
}));

const qrSendText = vi.fn(async () => ({ providerMessageId: 'evo.1' }));
vi.mock('@/lib/channels/registry', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/channels/registry')>();
  return {
    ...actual,
    getAdapter: (type: string) =>
      type === 'whatsapp_qr'
        ? {
            type: 'whatsapp_qr',
            capabilities: {},
            sendText: qrSendText,
            sendMedia: vi.fn(),
            normalizeInbound: () => [],
          }
        : actual.getAdapter(type as never),
  };
});

// Cliente de service-role de mentira, compartilhado pelos DOIS pontos
// desta função que escalam privilégio: o pause-on-agent-send (chama
// supabaseAdmin() direto, importado de @/lib/flows/admin-client) e
// recordColdSend (chama supabaseAdmin() de dentro de
// cold-send-wiring.ts, que importa de @/lib/supabase/admin — caminho
// diferente, mesmo singleton em produção). Os dois mocks resolvem pro
// MESMO fake — construído com `makeDb()` (declarado mais abaixo) em
// cada `beforeEach` — senão um insert gravado por um caminho não
// apareceria nas asserções que checam o outro.
const adminState: { client: unknown } = { client: undefined };
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => adminState.client,
}));
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => adminState.client,
}));

import {
  sendMessageToConversation,
  SendMessageError,
  type SendMessageParams,
} from './send-message';

// A db that explodes if touched — these tests cover the param
// validation that MUST short-circuit before any query runs.
function noDb(): SupabaseClient {
  return {
    from() {
      throw new Error('db should not be queried for invalid params');
    },
  } as unknown as SupabaseClient;
}

async function expectSendError(
  params: SendMessageParams,
  status: number,
  messageMatch?: RegExp
) {
  await expect(
    sendMessageToConversation(noDb(), 'acct-1', params)
  ).rejects.toBeInstanceOf(SendMessageError);
  await sendMessageToConversation(noDb(), 'acct-1', params).catch(
    (e: SendMessageError) => {
      expect(e.status).toBe(status);
      if (messageMatch) expect(e.message).toMatch(messageMatch);
    }
  );
}

describe('sendMessageToConversation — param validation (pre-DB)', () => {
  const base = { conversationId: 'cv-1' };

  it('requires conversation_id and message_type', async () => {
    await expectSendError({ conversationId: '', messageType: 'text' }, 400);
    await expectSendError({ conversationId: 'cv-1', messageType: '' }, 400);
  });

  it('rejects an unsupported message_type', async () => {
    await expectSendError(
      { ...base, messageType: 'carrier-pigeon' },
      400,
      /Unsupported message_type/
    );
  });

  it('requires content_text for text messages', async () => {
    await expectSendError(
      { ...base, messageType: 'text' },
      400,
      /content_text is required/
    );
  });

  it('requires template_name for template messages', async () => {
    await expectSendError(
      { ...base, messageType: 'template' },
      400,
      /template_name is required/
    );
  });

  it('requires media_url for media kinds', async () => {
    for (const kind of ['image', 'video', 'document', 'audio']) {
      await expectSendError(
        { ...base, messageType: kind },
        400,
        /media_url is required/
      );
    }
  });

  it('rejects an over-long media caption (non-audio)', async () => {
    await expectSendError(
      {
        ...base,
        messageType: 'image',
        mediaUrl: 'https://x/y.jpg',
        contentText: 'a'.repeat(1025),
      },
      400,
      /1024-character limit/
    );
  });

  it('requires a valid interactive payload for interactive messages', async () => {
    // Missing payload entirely.
    await expectSendError(
      { ...base, messageType: 'interactive' },
      400,
      /payload is required/
    );
    // Too many buttons.
    await expectSendError(
      {
        ...base,
        messageType: 'interactive',
        interactivePayload: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [
            { id: 'a', title: 'A' },
            { id: 'b', title: 'B' },
            { id: 'c', title: 'C' },
            { id: 'd', title: 'D' },
          ],
        },
      },
      400,
      /at most 3 buttons/
    );
    // Over-long button title.
    await expectSendError(
      {
        ...base,
        messageType: 'interactive',
        interactivePayload: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [{ id: 'a', title: 'x'.repeat(21) }],
        },
      },
      400,
      /20-character limit/
    );
  });

  it('allows a long "caption" on audio (audio carries none) — so it reaches the DB', async () => {
    // Audio is exempt from the caption cap, so validation passes and we
    // proceed to the conversation lookup — proven by the stub throwing.
    const spy = vi.fn(() => {
      throw new Error('reached DB');
    });
    const db = { from: spy } as unknown as SupabaseClient;
    await expect(
      sendMessageToConversation(db, 'acct-1', {
        ...base,
        messageType: 'audio',
        mediaUrl: 'https://x/y.ogg',
        contentText: 'a'.repeat(2000),
      })
    ).rejects.toThrow('reached DB');
    expect(spy).toHaveBeenCalledWith('conversations');
  });
});

describe('SendMessageError', () => {
  it('carries a machine code and an HTTP status', () => {
    const e = new SendMessageError('meta_error', 'boom', 502);
    expect(e.code).toBe('meta_error');
    expect(e.status).toBe(502);
    expect(e).toBeInstanceOf(Error);
  });

  it('carrega headers opcionais (Retry-After do teto de envio frio)', () => {
    const e = new SendMessageError('cold_send_limit', 'boom', 429, {
      'Retry-After': '60',
    });
    expect(e.headers).toEqual({ 'Retry-After': '60' });
  });
});

// ---------------------------------------------------------------------------
// Teto de envio frio (SPEC 049 §6.2, D-1) — `coldSendOrigin` em canal QR.
// ---------------------------------------------------------------------------

interface QueuedResult {
  data?: unknown;
  count?: number;
  error?: unknown;
}

/**
 * Supabase de mentira, keyed por `${table}.${verb}` (mesmo espírito de
 * `send.test.ts`). Resultado capturado NA CONSTRUÇÃO do chain (ordem em
 * que o código chama `db.from()`), não na resolução.
 */
function makeDb(results: Record<string, QueuedResult>) {
  const inserts: Array<{ table: string; payload: unknown }> = [];

  function chain(table: string) {
    let verb: 'select' | 'insert' | 'update' = 'select';
    const c: Record<string, unknown> = {
      select: () => c,
      eq: () => c,
      gte: () => c,
      order: () => c,
      limit: () => c,
      insert: (payload: unknown) => {
        verb = 'insert';
        inserts.push({ table, payload });
        return c;
      },
      update: () => {
        verb = 'update';
        return c;
      },
      single: () => Promise.resolve(settle()),
      maybeSingle: () => Promise.resolve(settle()),
      then: (
        resolve: (v: unknown) => unknown,
        reject?: (e: unknown) => unknown
      ) => Promise.resolve(settle()).then(resolve, reject),
    };
    const settle = () => {
      const r = results[`${table}.${verb}`] ?? {};
      return { data: r.data ?? null, count: r.count, error: r.error ?? null };
    };
    return c;
  }

  return {
    client: { from: (t: string) => chain(t) } as unknown as SupabaseClient,
    inserts,
  };
}

const CONTACT_QR = { id: 'contact-1', phone: '+5511999999999' };
const CONVERSATION_QR = {
  id: 'conv-1',
  channel_id: 'chan-qr-1',
  contact: CONTACT_QR,
  last_customer_message_at: null,
};
const CHANNEL_QR = {
  id: 'chan-qr-1',
  account_id: 'acct-1',
  type: 'whatsapp_qr',
  name: 'Vendas',
  status: 'connected',
  created_at: '2020-01-01T00:00:00Z',
};

function dbForQr(over: Record<string, QueuedResult> = {}) {
  return makeDb({
    'conversations.select': { data: CONVERSATION_QR },
    'channels.select': { data: CHANNEL_QR },
    'channel_cold_sends.select': { count: 0, data: null },
    'messages.insert': { data: { id: 'msg-1' } },
    ...over,
  });
}

/** Fake admin db do teste corrente — trocado a cada `beforeEach` abaixo. */
let adminDb: ReturnType<typeof makeDb>;

beforeEach(() => {
  adminDb = makeDb({});
  adminState.client = adminDb.client;
  resolveInstanceByChannelId.mockReset();
  resolveInstanceByChannelId.mockResolvedValue({
    instanceId: 'inst-1',
    channelId: 'chan-qr-1',
    accountId: 'acct-1',
    remoteInstanceId: 'remote-1',
    remoteInstanceName: 'zapcrm_acct1_vendas',
    token: 'plain-instance-token',
    channelName: 'Vendas',
  });
  qrSendText.mockClear();
  qrSendText.mockResolvedValue({ providerMessageId: 'evo.1' });
});

describe('sendMessageToConversation — coldSendOrigin (canal QR)', () => {
  const base: SendMessageParams = {
    conversationId: 'conv-1',
    messageType: 'text',
    contentText: 'oi',
  };

  it('origin "human": nunca bloqueia, mesmo sobre o teto — só registra origin=human', async () => {
    const db = dbForQr({
      'channel_cold_sends.select': { count: 999 }, // bem acima de qualquer teto
    });

    const result = await sendMessageToConversation(db.client, 'acct-1', {
      ...base,
      coldSendOrigin: 'human',
    });

    expect(result.whatsappMessageId).toBe('evo.1');
    expect(qrSendText).toHaveBeenCalledTimes(1);
    // supabaseAdmin(), não `db` — 062 proíbe policy de escrita em
    // channel_cold_sends pro cliente de sessão.
    expect(db.inserts.some((i) => i.table === 'channel_cold_sends')).toBe(
      false
    );
    const record = adminDb.inserts.find(
      (i) => i.table === 'channel_cold_sends'
    );
    expect(record?.payload).toEqual({
      channel_id: 'chan-qr-1',
      account_id: 'acct-1',
      contact_id: 'contact-1',
      origin: 'human',
    });
  });

  it('origin "api": bloqueia com 429 + Retry-After quando o teto estourou', async () => {
    const db = dbForQr({
      'channel_cold_sends.select': { count: 999 },
    });

    await expect(
      sendMessageToConversation(db.client, 'acct-1', {
        ...base,
        coldSendOrigin: 'api',
      })
    ).rejects.toMatchObject({
      status: 429,
      headers: expect.objectContaining({ 'Retry-After': expect.any(String) }),
    });

    expect(qrSendText).not.toHaveBeenCalled();
    expect(db.inserts.some((i) => i.table === 'channel_cold_sends')).toBe(
      false
    );
  });

  it('origin "api": entrega e registra origin=api quando dentro do teto', async () => {
    const db = dbForQr();

    const result = await sendMessageToConversation(db.client, 'acct-1', {
      ...base,
      coldSendOrigin: 'api',
    });

    expect(result.whatsappMessageId).toBe('evo.1');
    // supabaseAdmin(), não `db` — mesma checagem dos irmãos "human"/"api
    // bloqueado" acima; um double-write reintroduziria a violação de RLS
    // que este teto existe pra evitar.
    expect(db.inserts.some((i) => i.table === 'channel_cold_sends')).toBe(
      false
    );
    const record = adminDb.inserts.find(
      (i) => i.table === 'channel_cold_sends'
    );
    expect(record?.payload).toMatchObject({ origin: 'api' });
  });

  it('coldSendOrigin omitido: comportamento de hoje — sem checagem, sem registro', async () => {
    const db = dbForQr({
      'channel_cold_sends.select': { count: 999 },
    });

    const result = await sendMessageToConversation(db.client, 'acct-1', base);

    expect(result.whatsappMessageId).toBe('evo.1');
    expect(db.inserts.some((i) => i.table === 'channel_cold_sends')).toBe(
      false
    );
  });
});
