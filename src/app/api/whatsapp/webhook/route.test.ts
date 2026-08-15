/**
 * Regressão do issue #301 — a mensagem que some sem deixar log.
 *
 * O sintoma: conversas aparecendo no inbox com a thread VAZIA. O
 * contato e a conversa tinham sido criados, o INSERT da mensagem nunca
 * chegou, e nenhum erro em lugar nenhum. A causa foi uma promessa solta
 * (`processWebhook(body)` sem `await` e sem `after()`): na Vercel a
 * função pode ser congelada no instante em que a resposta sai, e o que
 * estava no meio de um write morre ali.
 *
 * `after()` entrega o callback ao runtime, que mantém a função viva até
 * ele resolver. Este arquivo existe para que trocar `after()` por uma
 * promessa solta — ou por um `await` inline, que estouraria o timeout de
 * ~20s da Meta e provocaria reentrega — quebre o build em vez de
 * reabrir o #301 em produção.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

/** Callbacks que a rota entregou ao runtime via `after()`. */
const afterCallbacks: Array<() => unknown> = [];

vi.mock('next/server', () => ({
  after: (cb: () => unknown) => {
    afterCallbacks.push(cb);
  },
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      body,
    }),
  },
}));

vi.mock('@/lib/whatsapp/webhook-signature', () => ({
  verifyMetaWebhookSignature: () => true,
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `decrypted:${v}`,
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}));

const ingestInbound = vi.fn();
vi.mock('@/lib/channels/ingest', () => ({
  ingestInbound: (...args: unknown[]) => ingestInbound(...args),
}));

const dispatchWebhookEvent = vi.fn();
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: (...args: unknown[]) => dispatchWebhookEvent(...args),
}));

/**
 * Linha de `messages` que `handleStatusUpdate` (SPEC 049 §5.5) lê para
 * resolver conta + canal do evento `message.status_updated`. `null`
 * por padrão — a maioria dos testes deste arquivo não passa por ali.
 */
let statusMessageRow: {
  conversation_id: string;
  conversations: {
    account_id: string;
    channel_id: string | null;
    channels: { type: string } | null;
  };
} | null = null;

// Só a consulta de `whatsapp_config` por `phone_number_id` é exercida
// diretamente aqui — o resto do trabalho de INGESTÃO está mockado no
// ingest. `messages`/`broadcast_recipients` ramificam por tabela porque
// `handleStatusUpdate` (não mockado) os lê de verdade.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === 'messages') {
        // Two different call shapes hit `messages` inside
        // handleStatusUpdate: an `.update(...).eq(...)` mirror (awaited
        // directly, no `.select()`) and a `.select().eq().limit()
        // .maybeSingle()` read that resolves the owning conversation —
        // this fake answers both via `.then()` for the first and
        // `.maybeSingle()` for the second.
        const chain = {
          select: () => chain,
          eq: () => chain,
          limit: () => chain,
          update: () => chain,
          maybeSingle: () =>
            Promise.resolve({ data: statusMessageRow, error: null }),
          then: (
            onF: (v: { error: null }) => unknown,
            onR?: (e: unknown) => unknown
          ) => Promise.resolve({ error: null }).then(onF, onR),
        };
        return chain;
      }
      if (table === 'broadcast_recipients') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        };
        return chain;
      }
      const chain = {
        select: () => chain,
        eq: () =>
          Promise.resolve({
            data: [
              {
                id: 'cfg-1',
                account_id: 'acct-1',
                user_id: 'user-1',
                phone_number_id: 'pnid-1',
                access_token: 'cipher',
                channel_id: 'chan-1',
              },
            ],
            error: null,
          }),
      };
      return chain;
    },
  }),
}));

import { POST } from './route';

const INBOUND = {
  entry: [
    {
      id: 'entry-1',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: {
              display_phone_number: '+551130000000',
              phone_number_id: 'pnid-1',
            },
            contacts: [{ profile: { name: 'Ana' }, wa_id: '5511999999999' }],
            messages: [
              {
                id: 'wamid.1',
                from: '5511999999999',
                timestamp: '1786000000',
                type: 'text',
                text: { body: 'oi' },
              },
            ],
          },
        },
      ],
    },
  ],
};

function request(body: unknown): Request {
  return {
    text: async () => JSON.stringify(body),
    headers: { get: () => 'sha256=fake' },
  } as unknown as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
  afterCallbacks.length = 0;
  ingestInbound.mockResolvedValue(undefined);
  dispatchWebhookEvent.mockResolvedValue(undefined);
  statusMessageRow = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

function statusRequest(status: {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
}): Request {
  return request({
    entry: [
      {
        id: 'entry-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '+551130000000',
                phone_number_id: 'pnid-1',
              },
              statuses: [status],
            },
          },
        ],
      },
    ],
  });
}

describe('POST /api/whatsapp/webhook — ack e processamento', () => {
  it('responde 200 ANTES de processar, e processa dentro de after()', async () => {
    const res = await POST(request(INBOUND));

    // 1) A Meta é reconhecida na hora: um ack lento vira reentrega, que
    //    vira mensagem duplicada.
    expect(res.status).toBe(200);

    // 2) Nada de ingestão ainda — o trabalho NÃO pode acontecer inline.
    expect(ingestInbound).not.toHaveBeenCalled();

    // 3) …e não pode ter virado promessa solta: tem de estar na mão do
    //    runtime, que mantém a função viva até resolver (#301).
    expect(afterCallbacks).toHaveLength(1);

    await afterCallbacks[0]!();
    expect(ingestInbound).toHaveBeenCalledTimes(1);
  });

  it('entrega ao ingest o instante DA META e o canal oficial', async () => {
    await POST(request(INBOUND));
    await afterCallbacks[0]!();

    const [ctx, event] = ingestInbound.mock.calls[0] as [
      { accountId: string; ownerUserId: string; channelType: string },
      { occurredAt: Date; providerMessageId: string; fromPhone: string },
    ];

    expect(ctx).toMatchObject({
      accountId: 'acct-1',
      ownerUserId: 'user-1',
      channelType: 'whatsapp_cloud',
    });
    expect(event.providerMessageId).toBe('wamid.1');
    expect(event.fromPhone).toBe('5511999999999');
    // `1786000000` em segundos — nunca `new Date()` do nosso servidor.
    expect(event.occurredAt.getTime()).toBe(1786000000 * 1000);
  });

  it('uma falha no processamento não escapa do callback', async () => {
    ingestInbound.mockRejectedValue(new Error('boom'));

    const res = await POST(request(INBOUND));
    expect(res.status).toBe(200);

    // O runtime não pode receber uma rejeição não tratada por causa de
    // uma mensagem malformada.
    await expect(afterCallbacks[0]!()).resolves.not.toThrow();
  });

  it('assinatura inválida devolve 401 e não agenda trabalho nenhum', async () => {
    vi.resetModules();
    vi.doMock('@/lib/whatsapp/webhook-signature', () => ({
      verifyMetaWebhookSignature: () => false,
    }));
    const { POST: PostWithBadSignature } = await import('./route');

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await PostWithBadSignature(request(INBOUND));

    expect(res.status).toBe(401);
    expect(afterCallbacks).toHaveLength(0);
  });
});

describe('message.status_updated carrega channel_id/channel_type (SPEC 049 §5.5)', () => {
  it('inclui channel_id e channel_type resolvidos da conversa, ao lado dos campos de sempre', async () => {
    statusMessageRow = {
      conversation_id: 'conv-1',
      conversations: {
        account_id: 'acct-1',
        channel_id: 'chan-qr-1',
        channels: { type: 'whatsapp_qr' },
      },
    };

    await POST(
      statusRequest({
        id: 'wamid.1',
        status: 'delivered',
        timestamp: '1786000000',
        recipient_id: '5511999999999',
      })
    );
    await afterCallbacks[0]!();

    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      'message.status_updated',
      expect.objectContaining({
        whatsapp_message_id: 'wamid.1',
        conversation_id: 'conv-1',
        status: 'delivered',
        channel_id: 'chan-qr-1',
        channel_type: 'whatsapp_qr',
      })
    );
  });

  it('sem linha de mensagem correspondente, não dispara webhook nenhum', async () => {
    statusMessageRow = null;

    await POST(
      statusRequest({
        id: 'wamid.missing',
        status: 'delivered',
        timestamp: '1786000000',
        recipient_id: '5511999999999',
      })
    );
    await afterCallbacks[0]!();

    expect(dispatchWebhookEvent).not.toHaveBeenCalled();
  });
});
