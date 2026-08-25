import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// SPEC 056 F2 — POST /api/inbox/conversations/transfer
//
// O foco aqui é a ROTA: as duas guardas que o envio comum não tem
// (elegibilidade do destino e opt-out), a ORDEM delas em relação ao
// find-or-create, e o id de destino na resposta. A entrega em si é
// mockada na fronteira `sendMessageToConversation` — ela já tem testes
// próprios em `send-message` e `channels/send`.
// ---------------------------------------------------------------------------

const conversationInserts: Array<Record<string, unknown>> = [];

// Cenário por teste.
let sourceConversation: Record<string, unknown> | null = null;
let contactRow: Record<string, unknown> | null = null;
let channelRow: Record<string, unknown> | null = null;
/** Thread do contato NO CANAL DE DESTINO (para a janela e o find-or-create). */
let targetThread: Record<string, unknown> | null = null;

const SOURCE = {
  id: 'conv-cloud',
  contact_id: 'contact-1',
  channel_id: 'chan-cloud',
};

const QR_CHANNEL = {
  id: 'chan-qr',
  name: 'Vendas (QRCode)',
  type: 'whatsapp_qr',
  status: 'connected',
};

function makeSupabaseMock() {
  function builder(table: string) {
    let didInsert = false;
    let selected = '';
    const eqs: Record<string, unknown> = {};

    const selectResult = () => {
      switch (table) {
        case 'profiles':
          return { data: { account_id: 'acct-1' }, error: null };
        case 'contacts':
          return { data: contactRow, error: null };
        case 'channels':
          return { data: channelRow, error: null };
        case 'conversations':
          // Três consultas diferentes batem nesta tabela; o `select` as
          // distingue sem depender da ordem das chamadas.
          if ('id' in eqs) return { data: sourceConversation, error: null };
          if (selected.includes('last_customer_message_at'))
            return { data: targetThread, error: null };
          return { data: targetThread, error: null };
        default:
          return { data: null, error: null };
      }
    };

    const insertResult = () => {
      if (table === 'conversations') {
        return {
          data: { id: 'conv-qr-new', assigned_agent_id: 'user-1' },
          error: null,
        };
      }
      return { data: null, error: null };
    };

    const terminal = () =>
      Promise.resolve(didInsert ? insertResult() : selectResult());

    const b: Record<string, unknown> = {};
    b.select = vi.fn((cols?: string) => {
      selected = cols ?? '';
      return b;
    });
    b.eq = vi.fn((col: string, val: unknown) => {
      eqs[col] = val;
      return b;
    });
    for (const m of ['order', 'limit', 'update', 'delete', 'in']) {
      b[m] = vi.fn(() => b);
    }
    b.insert = vi.fn((payload: Record<string, unknown>) => {
      didInsert = true;
      if (table === 'conversations') conversationInserts.push(payload);
      return b;
    });
    b.single = vi.fn(terminal);
    b.maybeSingle = vi.fn(terminal);
    b.then = (resolve: (v: unknown) => unknown) =>
      resolve(didInsert ? insertResult() : selectResult());
    return b;
  }

  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: 'user-1' } },
        error: null,
      })),
    },
    from: vi.fn((table: string) => builder(table)),
    rpc: vi.fn(async (_fn: string, args: Record<string, unknown>) => ({
      data: { id: args.p_conversation_id, assigned_agent_id: 'user-1' },
      error: null,
    })),
  };
}

let supabaseMock = makeSupabaseMock();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => supabaseMock),
}));

const { sendMessageToConversation } = vi.hoisted(() => ({
  // Parâmetros declarados (e não `async () =>`) para que
  // `mock.calls[0][2]` seja tipado — é neles que o teste confere a
  // thread de DESTINO, que é o coração desta rota.
  sendMessageToConversation: vi.fn(
    async (
      _db: unknown,
      _accountId: string,
      _params: Record<string, unknown>
    ) => ({
      messageId: 'msg-1',
      whatsappMessageId: 'evo-1',
    })
  ),
}));

// `SendMessageError` é preservada: a rota faz `instanceof` nela.
vi.mock('@/lib/whatsapp/send-message', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/whatsapp/send-message')>();
  return { ...actual, sendMessageToConversation };
});

import { POST } from './route';

function post(overrides: Record<string, unknown> = {}) {
  return POST(
    new Request('http://localhost/api/inbox/conversations/transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation_id: 'conv-cloud',
        channel_id: 'chan-qr',
        text: 'Oi! Continuamos por aqui.',
        ...overrides,
      }),
    })
  );
}

beforeEach(() => {
  conversationInserts.length = 0;
  sourceConversation = SOURCE;
  contactRow = { id: 'contact-1', opt_in_status: 'opted_in' };
  channelRow = QR_CHANNEL;
  targetThread = null;
  supabaseMock = makeSupabaseMock();
  sendMessageToConversation.mockClear();
});

describe('POST transfer — caminho feliz (Cloud → QRCode)', () => {
  it('cria a thread de destino, envia por ela e devolve o id para a UI navegar', async () => {
    const res = await post();
    const json = await res.json();

    expect(res.status).toBe(200);
    // O id de destino é o que a F3 usa para levar o operador junto (§4.2).
    expect(json.conversation_id).toBe('conv-qr-new');

    // A thread nasceu no canal de DESTINO, atribuída a quem transferiu.
    expect(conversationInserts).toHaveLength(1);
    expect(conversationInserts[0]).toMatchObject({
      account_id: 'acct-1',
      contact_id: 'contact-1',
      channel_id: 'chan-qr',
      assigned_agent_id: 'user-1',
    });

    // O envio foi para a thread NOVA — nunca para a de origem. É o que
    // impede a conversa partida do §1.1: a resposta do cliente volta
    // pelo canal QR e cai nesta mesma thread.
    expect(sendMessageToConversation).toHaveBeenCalledTimes(1);
    const params = sendMessageToConversation.mock.calls[0][2];
    expect(params.conversationId).toBe('conv-qr-new');
    expect(params.messageType).toBe('text');
    expect(params.senderId).toBe('user-1');
    // A ação é o vetor de envio frio mais provável do sistema.
    expect(params.coldSendOrigin).toBe('human');
  });

  it('reaproveita a thread de destino existente em vez de criar uma segunda', async () => {
    targetThread = { id: 'conv-qr-old', assigned_agent_id: 'user-1' };

    const res = await post();
    expect(res.status).toBe(200);

    expect(conversationInserts).toHaveLength(0);
    const params = sendMessageToConversation.mock.calls[0][2];
    expect(params.conversationId).toBe('conv-qr-old');
  });
});

describe('POST transfer — guarda 1: consentimento (D-4)', () => {
  // O teste mais importante do arquivo. Precisa provar as DUAS coisas:
  // uma implementação que só bloqueasse o envio passaria numa asserção
  // e falharia na outra — e é justamente ela que deixaria uma thread
  // nascida para uma mensagem que nunca sairia.
  it('contato em opt-out: recusa 403 SEM criar conversa e SEM enviar', async () => {
    contactRow = { id: 'contact-1', opt_in_status: 'opted_out' };

    const res = await post();
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.code).toBe('contact_opted_out');

    expect(conversationInserts).toHaveLength(0);
    expect(sendMessageToConversation).not.toHaveBeenCalled();
  });

  it('opt_in_status desconhecido não bloqueia — só `opted_out` bloqueia', async () => {
    contactRow = { id: 'contact-1', opt_in_status: 'unknown' };
    const res = await post();
    expect(res.status).toBe(200);
  });
});

describe('POST transfer — guarda 2: elegibilidade do destino (§4.3)', () => {
  it('canal de outra conta responde 400 (nunca 404, que confirmaria o id)', async () => {
    channelRow = null; // o .eq('account_id') não encontrou nada

    const res = await post();
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe('bad_request');
    expect(conversationInserts).toHaveLength(0);
    expect(sendMessageToConversation).not.toHaveBeenCalled();
  });

  it('instância caída no momento do POST: erro ANTES de criar a thread', async () => {
    // A UI monta o menu com o canal conectado; entre abrir o diálogo e
    // confirmar, a instância pode cair.
    channelRow = { ...QR_CHANNEL, status: 'disconnected' };

    const res = await post();
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe('not_connected');
    expect(conversationInserts).toHaveLength(0);
    expect(sendMessageToConversation).not.toHaveBeenCalled();
  });

  it('D-3: destino com janela de 24h FECHADA é recusado', async () => {
    // O sentido QR→Oficial com o contato que nunca escreveu para o
    // número oficial: sem esta guarda, o envio livre falharia na Meta
    // ou custaria um template que o operador não pediu.
    channelRow = {
      id: 'chan-cloud-2',
      name: 'Oficial',
      type: 'whatsapp_cloud',
      status: 'connected',
    };
    targetThread = null; // nunca escreveu por lá

    const res = await post();
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe('session_window_closed');
    expect(conversationInserts).toHaveLength(0);
  });

  it('D-3: destino com janela de 24h ABERTA é aceito', async () => {
    channelRow = {
      id: 'chan-cloud-2',
      name: 'Oficial',
      type: 'whatsapp_cloud',
      status: 'connected',
    };
    targetThread = {
      id: 'conv-cloud-2',
      assigned_agent_id: 'user-1',
      last_customer_message_at: new Date().toISOString(),
    };

    const res = await post();
    expect(res.status).toBe(200);
    expect(sendMessageToConversation).toHaveBeenCalledTimes(1);
  });

  it('transferir para o canal da própria conversa é recusado', async () => {
    channelRow = {
      id: 'chan-cloud',
      name: 'Oficial',
      type: 'whatsapp_cloud',
      status: 'connected',
    };

    const res = await post({ channel_id: 'chan-cloud' });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe('same_channel');
  });
});

describe('POST transfer — validação e escopo', () => {
  it('400 sem texto', async () => {
    const res = await post({ text: '   ' });
    expect(res.status).toBe(400);
    expect(sendMessageToConversation).not.toHaveBeenCalled();
  });

  it('400 sem channel_id', async () => {
    const res = await post({ channel_id: undefined });
    expect(res.status).toBe(400);
  });

  it('404 quando a conversa de origem não é desta conta (ou a RLS a esconde)', async () => {
    sourceConversation = null;

    const res = await post();
    expect(res.status).toBe(404);
    expect(conversationInserts).toHaveLength(0);
    expect(sendMessageToConversation).not.toHaveBeenCalled();
  });
});
