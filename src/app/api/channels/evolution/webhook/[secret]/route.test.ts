/**
 * Verificação em cadeia + roteamento de eventos do webhook Evolution
 * (SPEC 048 §6.3-§6.4). O que se prova aqui:
 *
 *   - as três checagens (secret → instanceId → instanceToken) rejeitam
 *     independentemente, e SEMPRE com 401 opaco;
 *   - o `after()` é usado (não uma promessa solta — mesma regressão que
 *     `app/api/whatsapp/webhook/route.test.ts` já trava para a Meta);
 *   - o sufixo `:NN` de dispositivo é removido do JID antes de chamar
 *     `ingestInbound` (SPEC 048 §1.2 R4);
 *   - LID sem vínculo conhecido descarta, nunca cria contato sintético
 *     (§1.2 R3 / §6.4);
 *   - READ_RECEIPT respeita a escada anti-regressão;
 *   - CONNECTION/QRCODE atualizam o estado certo, sem persistir o QR.
 */

import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';

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

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v.replace(/^cipher:/, ''),
}));

const ingestInbound = vi.fn();
vi.mock('@/lib/channels/ingest', () => ({
  ingestInbound: (...args: unknown[]) => ingestInbound(...args),
}));

const bindChannelToPhone = vi.fn(
  async ({ channelId }: { channelId: string }) => ({
    channelId,
    adopted: false,
  })
);
vi.mock('@/lib/evolution/instances', () => ({
  bindChannelToPhone: (...args: unknown[]) =>
    (bindChannelToPhone as unknown as (...a: unknown[]) => unknown)(...args),
}));

const evolutionRequest = vi.fn();
vi.mock('@/lib/evolution/client', () => ({
  evolutionRequest: (...args: unknown[]) => evolutionRequest(...args),
}));

vi.mock('@/lib/evolution/config', () => ({
  readEvolutionConfig: () => null, // desliga o backfill de LID por padrão
}));

// ------------------------------------------------------------
// Supabase de mentira — mesmo espírito de `ingest.test.ts`.
// ------------------------------------------------------------

interface RecordedOp {
  table: string;
  verb: 'select' | 'insert' | 'update' | 'upsert' | 'delete';
  payload?: unknown;
  filters: Array<[string, ...unknown[]]>;
}

type FakeResult = { data?: unknown; error?: unknown };
/** Função em vez de valor fixo: usada pelos casos em que a MESMA consulta
 *  precisa responder diferente entre tentativas (a espera do recibo). */
type FakeResults = Record<string, FakeResult | (() => FakeResult)>;

function makeDb(results: FakeResults = {}) {
  const ops: RecordedOp[] = [];
  const uploads: Array<{ path: string; contentType?: string }> = [];
  const resultMap = new Map(Object.entries(results));

  function builder(table: string) {
    const op: RecordedOp = { table, verb: 'select', filters: [] };
    let recorded = false;
    const settle = () => {
      if (!recorded) {
        ops.push(op);
        recorded = true;
      }
      const configured = resultMap.get(`${table}.${op.verb}`);
      const resolved =
        typeof configured === 'function' ? configured() : configured;
      return resolved ?? { data: null, error: null };
    };

    const chain: Record<string, unknown> = {
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve(settle()).then(resolve, reject);
      },
      insert: (payload?: unknown) => {
        op.verb = 'insert';
        op.payload = payload;
        return chain;
      },
      update: (payload?: unknown) => {
        op.verb = 'update';
        op.payload = payload;
        return chain;
      },
      upsert: (payload?: unknown) => {
        op.verb = 'upsert';
        op.payload = payload;
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
      limit: (...args: unknown[]) => {
        op.filters.push(['limit', ...args]);
        return chain;
      },
      in: (...args: unknown[]) => {
        op.filters.push(['in', ...args]);
        return chain;
      },
      maybeSingle: () => Promise.resolve(settle()),
      single: () => Promise.resolve(settle()),
    };
    return chain;
  }

  return {
    client: {
      from: (t: string) => builder(t),
      storage: {
        from: () => ({
          upload: async (
            path: string,
            _body: unknown,
            opts?: { contentType?: string }
          ) => {
            uploads.push({ path, contentType: opts?.contentType });
            return { error: null };
          },
        }),
      },
    },
    ops,
    /** Objetos gravados no bucket — o que prova que uma mídia foi (ou
     *  não foi) baixada e persistida, e COM QUE content-type. */
    uploads,
  };
}

let currentDb = makeDb();
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => currentDb.client,
}));

function opsFor(table: string, verb?: RecordedOp['verb']) {
  return currentDb.ops.filter(
    (o) => o.table === table && (verb ? o.verb === verb : true)
  );
}

// ------------------------------------------------------------

const SECRET = 'a'.repeat(64);
const INSTANCE_ID = 'remote-inst-1';
const TOKEN = 'plain-token';

const SECRET_ROW = {
  instance_id: 'inst-row-1',
  webhook_secret: SECRET,
  instance_token_encrypted: `cipher:${TOKEN}`,
};
const INSTANCE_ROW = {
  id: 'inst-row-1',
  channel_id: 'chan-1',
  account_id: 'acct-1',
  remote_instance_id: INSTANCE_ID,
};
const CHANNEL_ROW = { user_id: 'user-1' };

function baseResults(over: FakeResults = {}) {
  return {
    'evolution_instance_secrets.select': { data: SECRET_ROW, error: null },
    'evolution_instances.select': { data: INSTANCE_ROW, error: null },
    'channels.select': { data: CHANNEL_ROW, error: null },
    ...over,
  };
}

function payload(event: string, data: unknown) {
  return { event, instanceId: INSTANCE_ID, instanceToken: TOKEN, data };
}

async function post(secret: string, body: unknown) {
  const { POST } = await import('./route');
  const req = new Request('https://x.invalid/webhook', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const res = await POST(req, { params: Promise.resolve({ secret }) });
  // Roda os callbacks entregues ao `after()` — imita o runtime.
  const cbs = afterCallbacks.splice(0);
  for (const cb of cbs) await cb();
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  afterCallbacks.length = 0;
  currentDb = makeDb(baseResults());
  bindChannelToPhone.mockImplementation(async ({ channelId }) => ({
    channelId,
    adopted: false,
  }));
  // Nenhum teste deste arquivo pode tocar a rede: `storeInboundMedia`
  // baixa a mídia por URL, e sem este stub a suíte ficaria dependente
  // de DNS (e levaria segundos por caso até o timeout).
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(8),
    }))
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('verificação em cadeia', () => {
  it('401 quando o secret do path não bate com nenhuma instância', async () => {
    currentDb = makeDb(
      baseResults({
        'evolution_instance_secrets.select': { data: null, error: null },
      })
    );
    const res = await post(SECRET, payload('MESSAGE', {}));
    expect(res.status).toBe(401);
    expect(ingestInbound).not.toHaveBeenCalled();
  });

  it('401 quando o instanceId do payload não bate com o da instância do secret', async () => {
    const res = await post(SECRET, {
      event: 'MESSAGE',
      instanceId: 'outro-instance-id',
      instanceToken: TOKEN,
      data: {},
    });
    expect(res.status).toBe(401);
  });

  it('401 quando o instanceToken do payload não bate com o decriptado', async () => {
    const res = await post(SECRET, {
      event: 'MESSAGE',
      instanceId: INSTANCE_ID,
      instanceToken: 'token-errado',
      data: {},
    });
    expect(res.status).toBe(401);
  });

  it('200 imediato + processamento agendado via after() numa requisição válida', async () => {
    const res = await post(
      SECRET,
      payload('MESSAGE', {
        Info: {
          Chat: '5511999999999@s.whatsapp.net',
          ID: 'msg-1',
          IsFromMe: false,
        },
        Message: { conversation: 'oi' },
      })
    );
    expect(res.status).toBe(200);
    expect(ingestInbound).toHaveBeenCalledTimes(1);
  });
});

describe('MESSAGE — identidade', () => {
  it('remove o sufixo :NN de dispositivo antes de resolver o telefone', async () => {
    await post(
      SECRET,
      payload('MESSAGE', {
        Info: { Chat: '5511999999999:12@s.whatsapp.net', ID: 'msg-1' },
        Message: { conversation: 'oi' },
      })
    );

    const [, event] = ingestInbound.mock.calls[0];
    expect(event.fromPhone).toBe('5511999999999');
  });

  it('LID sem vínculo conhecido descarta — nunca chama ingestInbound', async () => {
    currentDb = makeDb(
      baseResults({ 'contact_identities.select': { data: null, error: null } })
    );

    await post(
      SECRET,
      payload('MESSAGE', {
        Info: { Chat: '226559659127039@lid', ID: 'msg-1' },
        Message: { conversation: 'oi' },
      })
    );

    expect(ingestInbound).not.toHaveBeenCalled();
  });

  it('LID com vínculo conhecido resolve o telefone via contact_identities', async () => {
    currentDb = makeDb(
      baseResults({
        'contact_identities.select': {
          data: { contact_id: 'contact-1' },
          error: null,
        },
        'contacts.select': { data: { phone: '5511999999999' }, error: null },
      })
    );

    await post(
      SECRET,
      payload('MESSAGE', {
        Info: { Chat: '226559659127039@lid', ID: 'msg-1' },
        Message: { conversation: 'oi' },
      })
    );

    const [, event] = ingestInbound.mock.calls[0];
    expect(event.fromPhone).toBe('5511999999999');
    expect(event.fromExternalId).toBe('226559659127039@lid');
  });

  it('SEND_MESSAGE marca fromMe: true', async () => {
    await post(
      SECRET,
      payload('SEND_MESSAGE', {
        Info: { Chat: '5511999999999@s.whatsapp.net', ID: 'msg-1' },
        Message: { conversation: 'respondendo pelo celular' },
      })
    );

    const [, event] = ingestInbound.mock.calls[0];
    expect(event.fromMe).toBe(true);
  });

  it('normaliza o sufixo :NN também no LID, para casar com contact_identities', async () => {
    // §1.2 R3 mostra o servidor devolvendo `...:11@lid` na lista de
    // Devices, mas `/user/check` grava o LID canônico (sem sufixo).
    // Sem normalizar, a mensagem de um segundo aparelho era descartada.
    currentDb = makeDb(
      baseResults({
        'contact_identities.select': {
          data: { contact_id: 'contact-1' },
          error: null,
        },
        'contacts.select': { data: { phone: '5511999999999' }, error: null },
      })
    );

    await post(
      SECRET,
      payload('MESSAGE', {
        Info: { Chat: '226559659127039:11@lid', ID: 'msg-1' },
        Message: { conversation: 'oi' },
      })
    );

    const lookup = opsFor('contact_identities', 'select')[0];
    expect(lookup.filters).toContainEqual([
      'eq',
      'external_id',
      '226559659127039@lid',
    ]);
    expect(ingestInbound).toHaveBeenCalledTimes(1);
  });

  it('NÃO cai no Sender num eco — ele é o número do próprio operador', async () => {
    // Num SEND_MESSAGE, `Sender` somos nós. Cair nele criaria contato e
    // "conversa consigo mesmo" com o número da instância.
    await post(
      SECRET,
      payload('SEND_MESSAGE', {
        Info: { Sender: '5519992496598@s.whatsapp.net', ID: 'msg-1' },
        Message: { conversation: 'oi' },
      })
    );

    expect(ingestInbound).not.toHaveBeenCalled();
  });

  it('figurinha vira image, não bolha vazia', async () => {
    await post(
      SECRET,
      payload('MESSAGE', {
        Info: { Chat: '5511999999999@s.whatsapp.net', ID: 'msg-1' },
        Message: {
          stickerMessage: {
            url: 'https://minio/x.webp',
            mimetype: 'image/webp',
          },
        },
      })
    );

    const [, event] = ingestInbound.mock.calls[0];
    expect(event.contentType).toBe('image');
    expect(event.mediaPath).toBeTruthy();
  });

  it('proto não reconhecido é descartado em vez de virar bolha vazia', async () => {
    await post(
      SECRET,
      payload('MESSAGE', {
        Info: { Chat: '5511999999999@s.whatsapp.net', ID: 'msg-1' },
        Message: { algumProtoFuturo: { foo: 'bar' } },
      })
    );

    expect(ingestInbound).not.toHaveBeenCalled();
  });

  it('reação do operador pelo aparelho não vira mensagem na thread', async () => {
    await post(
      SECRET,
      payload('SEND_MESSAGE', {
        Info: { Chat: '5511999999999@s.whatsapp.net', ID: 'msg-1' },
        Message: { reactionMessage: { key: { id: 'alvo' }, text: '👍' } },
      })
    );

    expect(ingestInbound).not.toHaveBeenCalled();
  });

  it('reação do CLIENTE continua sendo ingerida como reaction', async () => {
    await post(
      SECRET,
      payload('MESSAGE', {
        Info: { Chat: '5511999999999@s.whatsapp.net', ID: 'msg-1' },
        Message: { reactionMessage: { key: { id: 'alvo' }, text: '👍' } },
      })
    );

    const [, event] = ingestInbound.mock.calls[0];
    expect(event.kind).toBe('reaction');
    expect(event.targetProviderMessageId).toBe('alvo');
    expect(event.emoji).toBe('👍');
  });

  it('canal oficial nunca aparece — o contexto passado é sempre whatsapp_qr', async () => {
    await post(
      SECRET,
      payload('MESSAGE', {
        Info: { Chat: '5511999999999@s.whatsapp.net', ID: 'msg-1' },
        Message: { conversation: 'oi' },
      })
    );

    const [ctx] = ingestInbound.mock.calls[0];
    expect(ctx.channelType).toBe('whatsapp_qr');
    expect(ctx.channelId).toBe('chan-1');
    expect(ctx.accountId).toBe('acct-1');
  });
});

describe('READ_RECEIPT', () => {
  /** Recibo precisa das conversas do canal (escopo de tenancy) antes de
   *  resolver as mensagens. */
  function receiptDb(messageRows: Array<{ id: string; status: string }>) {
    return makeDb(
      baseResults({
        'conversations.select': { data: [{ id: 'conv-1' }], error: null },
        'messages.select': { data: messageRows, error: null },
      })
    );
  }

  it('avança o status quando incoming > current', async () => {
    currentDb = receiptDb([{ id: 'msg-1', status: 'sent' }]);

    await post(
      SECRET,
      payload('READ_RECEIPT', { Type: 'Read', MessageIDs: ['wamid.1'] })
    );

    const update = opsFor('messages', 'update')[0];
    expect(update.payload).toEqual({ status: 'read' });
    // Endereça a linha pelo id INTERNO, não pelo message_id do provedor
    // (que não é único — migração 009).
    expect(update.filters).toContainEqual(['eq', 'id', 'msg-1']);
  });

  it('NÃO regride um status já mais avançado (anti-regressão)', async () => {
    currentDb = receiptDb([{ id: 'msg-1', status: 'read' }]);

    await post(
      SECRET,
      payload('READ_RECEIPT', { Type: 'Delivered', MessageIDs: ['wamid.1'] })
    );

    expect(opsFor('messages', 'update')).toHaveLength(0);
  });

  it('decide a escada LINHA A LINHA quando duas compartilham o message_id', async () => {
    // `messages.message_id` não é único (migração 009). Antes o guard
    // lia UMA linha e escrevia em TODAS: a linha em `read` regredia, ou
    // a linha em `sent` nunca avançava, dependendo da ordem.
    currentDb = receiptDb([
      { id: 'msg-atrasada', status: 'sent' },
      { id: 'msg-adiantada', status: 'read' },
    ]);

    await post(
      SECRET,
      payload('READ_RECEIPT', { Type: 'Delivered', MessageIDs: ['wamid.1'] })
    );

    const updates = opsFor('messages', 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0].filters).toContainEqual(['eq', 'id', 'msg-atrasada']);
  });

  it('escopa a busca às conversas do canal que mandou o recibo', async () => {
    currentDb = receiptDb([{ id: 'msg-1', status: 'sent' }]);

    await post(
      SECRET,
      payload('READ_RECEIPT', { Type: 'Read', MessageIDs: ['wamid.1'] })
    );

    const convLookup = opsFor('conversations', 'select')[0];
    expect(convLookup.filters).toContainEqual(['eq', 'account_id', 'acct-1']);
    expect(convLookup.filters).toContainEqual(['eq', 'channel_id', 'chan-1']);
    const msgLookup = opsFor('messages', 'select')[0];
    expect(msgLookup.filters).toContainEqual([
      'in',
      'conversation_id',
      ['conv-1'],
    ]);
  });
});

/**
 * As duas correções que nasceram de CRONOMETRAR o teste real, não de ler
 * o código: os webhooks da Evolution correm com a nossa própria escrita,
 * e no envio de mídia eles GANHAM.
 */
describe('corrida entre o webhook e a nossa própria gravação', () => {
  const IMAGE_ECHO = {
    Info: {
      Chat: '5519992876519@s.whatsapp.net',
      Sender: '5519992496598:16@s.whatsapp.net',
      IsFromMe: true,
      ID: '3EB06F113CBB1D06DE0EDA',
      Type: 'ImageMessage',
      Timestamp: '2026-08-14T16:19:31.340950543-03:00',
    },
    Message: {
      imageMessage: { mimetype: 'image/png', caption: 'jesus' },
      base64: 'iVBORw0KGgoAAAANSUhEUg',
    },
  };

  it('eco do que o CRM já gravou não baixa a mídia nem reingere', async () => {
    // O eco de uma imagem carrega o arquivo INTEIRO em base64 (2,3 MB no
    // teste real). `ingest.ts` também descarta esse eco, mas só depois do
    // upload — deixando um objeto órfão no bucket a cada mídia enviada
    // pelo inbox.
    currentDb = makeDb(
      baseResults({
        'messages.select': { data: [{ id: 'msg-ja-gravada' }], error: null },
      })
    );

    await post(SECRET, payload('SendMessage', IMAGE_ECHO));

    expect(ingestInbound).not.toHaveBeenCalled();
    expect(currentDb.uploads).toHaveLength(0);
  });

  it('eco de algo mandado PELO CELULAR segue o caminho normal', async () => {
    // A porta acima não pode engolir o que o operador digitou fora do
    // CRM — aí não existe linha nossa, e a mensagem tem de entrar.
    currentDb = makeDb(baseResults({ 'messages.select': { data: [] } }));

    await post(SECRET, payload('SendMessage', IMAGE_ECHO));

    expect(ingestInbound).toHaveBeenCalledTimes(1);
    const [, event] = ingestInbound.mock.calls[0];
    expect(event.fromMe).toBe(true);
    expect(event.mediaPath).toBeTruthy();
  });

  it('recibo que chega ANTES da nossa linha espera e tenta de novo', async () => {
    // Medido: `POST /api/whatsapp/send` de uma imagem levou 5,6s e o
    // `Delivered` daquele mesmo id chegou antes da resposta do provedor.
    // Sem espera, o recibo não casava nada e toda mídia enviada ficava
    // presa em "enviada" para sempre.
    let attempt = 0;
    currentDb = makeDb(
      baseResults({
        'conversations.select': { data: [{ id: 'conv-1' }], error: null },
        'messages.select': () => {
          attempt += 1;
          return attempt === 1
            ? { data: [], error: null }
            : { data: [{ id: 'msg-1', status: 'sent' }], error: null };
        },
      })
    );

    await post(SECRET, {
      event: 'Receipt',
      state: 'Delivered',
      instanceId: INSTANCE_ID,
      instanceToken: TOKEN,
      data: { MessageIDs: ['3EB06F113CBB1D06DE0EDA'] },
    });

    expect(attempt).toBeGreaterThan(1);
    const update = opsFor('messages', 'update')[0];
    expect(update.payload).toEqual({ status: 'delivered' });
  });

  it('recibo que nunca casa desiste — não fica tentando para sempre', async () => {
    currentDb = makeDb(
      baseResults({
        'conversations.select': { data: [{ id: 'conv-1' }], error: null },
        'messages.select': { data: [], error: null },
      })
    );

    await post(SECRET, {
      event: 'Receipt',
      state: 'Delivered',
      instanceId: INSTANCE_ID,
      instanceToken: TOKEN,
      data: { MessageIDs: ['nunca-existiu'] },
    });

    expect(opsFor('messages', 'update')).toHaveLength(0);
    expect(opsFor('messages', 'select')).toHaveLength(3);
  });
});

describe('CONNECTION', () => {
  it('marca connected quando Connected e LoggedIn são true', async () => {
    await post(
      SECRET,
      payload('CONNECTION', { Connected: true, LoggedIn: true })
    );

    const update = opsFor('channels', 'update')[0];
    expect(update.payload).toMatchObject({ status: 'connected' });
  });

  it('marca connecting quando conectado mas ainda não logado', async () => {
    await post(
      SECRET,
      payload('CONNECTION', { Connected: true, LoggedIn: false })
    );

    const update = opsFor('channels', 'update')[0];
    expect(update.payload).toMatchObject({ status: 'connecting' });
  });

  it('marca disconnected quando nem conectado', async () => {
    await post(
      SECRET,
      payload('CONNECTION', { Connected: false, LoggedIn: false })
    );

    const update = opsFor('channels', 'update')[0];
    expect(update.payload).toMatchObject({ status: 'disconnected' });
  });
});

describe('QRCODE', () => {
  it('atualiza só last_qr_at — nunca persiste o QR em si', async () => {
    await post(
      SECRET,
      payload('QRCODE', { qrcode: 'data:image/png;base64,AAAA' })
    );

    const update = opsFor('evolution_instances', 'update')[0];
    expect(update.payload).toHaveProperty('last_qr_at');
    expect(JSON.stringify(update.payload)).not.toContain('AAAA');
  });
});

/**
 * Os nomes que o servidor REALMENTE manda.
 *
 * Os blocos acima usam os nomes de INSCRIÇÃO (`SEND_MESSAGE`,
 * `READ_RECEIPT`, `CONNECTION`) porque foi o que a F4 assumiu — e a
 * suíte inteira passou verde enquanto metade do canal não funcionava em
 * produção. O campo `event` carrega o nome do EVENTO do whatsmeow
 * (`SendMessage`, `Receipt`, `Connected`), que não bate com nenhum
 * deles. Estes casos são os que teriam pegado isso.
 */
describe('nomes reais de evento (whatsmeow)', () => {
  it('SendMessage — o eco do celular do operador chega como fromMe', async () => {
    await post(
      SECRET,
      payload('SendMessage', {
        Info: { Chat: '5511999999999@s.whatsapp.net', ID: 'msg-1' },
        Message: { conversation: 'respondi pelo aparelho' },
      })
    );

    expect(ingestInbound).toHaveBeenCalledTimes(1);
    const [, event] = ingestInbound.mock.calls[0];
    expect(event.fromMe).toBe(true);
  });

  it('Receipt — lê o `state` do ENVELOPE, não um `Type` dentro de data', async () => {
    currentDb = makeDb(
      baseResults({
        'conversations.select': { data: [{ id: 'conv-1' }], error: null },
        'messages.select': {
          data: [{ id: 'msg-1', status: 'sent' }],
          error: null,
        },
      })
    );

    await post(SECRET, {
      event: 'Receipt',
      state: 'Read',
      instanceId: INSTANCE_ID,
      instanceToken: TOKEN,
      data: { MessageIDs: ['wamid.1'] },
    });

    const update = opsFor('messages', 'update')[0];
    expect(update.payload).toEqual({ status: 'read' });
  });

  it('Connected — marca conectado, sem depender de booleanos que não vêm', async () => {
    // O payload real é `{status:"open", jid, pushName}`. Lendo
    // `Connected`/`LoggedIn` (que só existem em /instance/status), um
    // evento de CONEXÃO marcava o canal como DESCONECTADO.
    await post(
      SECRET,
      payload('Connected', {
        status: 'open',
        jid: '5519992496598:12@s.whatsapp.net',
        pushName: 'Bruno',
      })
    );

    const update = opsFor('channels', 'update')[0];
    expect(update.payload).toMatchObject({ status: 'connected' });
  });

  it('Connected — grava o jid e o telefone da instância', async () => {
    await post(
      SECRET,
      payload('Connected', {
        status: 'open',
        jid: '5519992496598:12@s.whatsapp.net',
      })
    );

    const update = opsFor('evolution_instances', 'update')[0];
    expect(update.payload).toMatchObject({
      connected_jid: '5519992496598:12@s.whatsapp.net',
      connected_phone: '5519992496598',
    });
  });

  it('LoggedOut — marca desconectado', async () => {
    await post(SECRET, payload('LoggedOut', { Reason: 'logged_out' }));

    const update = opsFor('channels', 'update')[0];
    expect(update.payload).toMatchObject({ status: 'disconnected' });
  });

  it('PairSuccess — marca conectado', async () => {
    await post(
      SECRET,
      payload('PairSuccess', {
        ID: '5519992496598:5@s.whatsapp.net',
        status: 'open',
      })
    );

    const update = opsFor('channels', 'update')[0];
    expect(update.payload).toMatchObject({ status: 'connected' });
  });

  it('QRCode — a grafia real também casa', async () => {
    await post(SECRET, payload('QRCode', { code: '2@AbCd' }));

    expect(opsFor('evolution_instances', 'update')[0].payload).toHaveProperty(
      'last_qr_at'
    );
  });
});

/**
 * O canal é o NÚMERO, não a instância (pedido do mantenedor, 2026-08-14).
 *
 * Excluir a instância e parear o mesmo WhatsApp de novo tem de devolver
 * as conversas de onde pararam. O nome da instância é rótulo; o vínculo
 * é o telefone.
 */
describe('vínculo do canal pelo número do WhatsApp', () => {
  it('reconcilia o canal pelo telefone ao conectar', async () => {
    await post(
      SECRET,
      payload('Connected', {
        status: 'open',
        jid: '5519992496598:12@s.whatsapp.net',
      })
    );

    expect(bindChannelToPhone).toHaveBeenCalledWith({
      accountId: 'acct-1',
      instanceId: 'inst-row-1',
      channelId: 'chan-1',
      // Sem o sufixo `:NN` de dispositivo — é o telefone que identifica.
      phone: '5519992496598',
    });
  });

  it('o status vai para o canal ADOTADO, não para o recém-criado', async () => {
    // Escrever no canal novo e só então adotar deixaria o canal vivo
    // (o que tem o histórico) marcado como desconectado.
    bindChannelToPhone.mockResolvedValue({
      channelId: 'chan-antigo',
      adopted: true,
    });

    await post(
      SECRET,
      payload('Connected', {
        status: 'open',
        jid: '5519992496598@s.whatsapp.net',
      })
    );

    const update = opsFor('channels', 'update')[0];
    expect(update.payload).toMatchObject({ status: 'connected' });
    expect(update.filters).toContainEqual(['eq', 'id', 'chan-antigo']);
  });

  it('não tenta reconciliar quando o evento não traz JID', async () => {
    await post(SECRET, payload('LoggedOut', { Reason: 'logged_out' }));

    expect(bindChannelToPhone).not.toHaveBeenCalled();
    expect(opsFor('channels', 'update')[0].payload).toMatchObject({
      status: 'disconnected',
    });
  });
});

/**
 * Mídia recebida (SPEC 048 §6.5).
 *
 * O primeiro áudio de teste chegou ao inbox como "Áudio indisponível":
 * `content_type` era `audio` mas `media_path` era nulo. A causa foi
 * dupla — o campo se chama `URL` (e procurávamos `url`), e o conteúdo
 * naquela URL é AES do CDN do WhatsApp, que nenhum player toca.
 */
describe('mídia recebida', () => {
  const chat = { Chat: '5511999999999@s.whatsapp.net', ID: 'msg-1' };

  it('usa o base64 decriptado que a Evolution manda junto', async () => {
    await post(
      SECRET,
      payload('MESSAGE', {
        Info: chat,
        Message: {
          audioMessage: {
            URL: 'https://mmg.whatsapp.net/v/t62/x.enc',
            base64: 'AAECAwQF',
            mimetype: 'audio/ogg; codecs=opus',
          },
        },
      })
    );

    const [, event] = ingestInbound.mock.calls[0];
    expect(event.contentType).toBe('audio');
    expect(event.mediaPath).toBeTruthy();
    // O base64 vence a URL: nada de rede quando o conteúdo já veio.
    expect(fetch).not.toHaveBeenCalled();
  });

  it('acha o base64 IRMÃO do proto dentro de Message — a forma MEDIDA', async () => {
    // Recorte fiel de um áudio de voz recebido no teste com número real.
    // O `base64` não está dentro de `audioMessage` nem no nível de
    // `data`: está ao LADO do proto, dentro de `Message`. As duas
    // fixtures que existiam aqui codificavam as duas posições erradas —
    // por isso a suíte ficou verde enquanto todo áudio e toda foto
    // entravam sem mídia, com "Áudio indisponível" no inbox.
    await post(
      SECRET,
      payload('MESSAGE', {
        Info: {
          Chat: '5519992876519@s.whatsapp.net',
          Sender: '5519992876519@s.whatsapp.net',
          SenderAlt: '240213376897243@lid',
          ID: 'ACE35C38199DD9759F85696603A8D9C3',
          IsFromMe: false,
          MediaType: 'ptt',
          PushName: 'Regina Pelatieri Goulart',
          Type: 'media',
          Timestamp: '2026-08-14T16:12:10-03:00',
        },
        Message: {
          audioMessage: {
            PTT: true,
            URL: 'https://mmg.whatsapp.net/v/t62.7117-24/541925607_x_n.enc?ccb=11-4',
            mimetype: 'audio/ogg; codecs=opus',
            seconds: 2,
            fileLength: 5584,
          },
          base64: 'T2dnUwACAAAAAAAAAAAA',
          messageContextInfo: { deviceListMetadataVersion: 2 },
        },
      })
    );

    const [, event] = ingestInbound.mock.calls[0];
    expect(event.contentType).toBe('audio');
    expect(event.mediaPath).toBeTruthy();
    // Vencendo a URL cifrada, nenhuma rede é tocada.
    expect(fetch).not.toHaveBeenCalled();
  });

  it('aceita o base64 pendurado no nível de data, e não no proto', async () => {
    await post(
      SECRET,
      payload('MESSAGE', {
        Info: chat,
        base64: 'AAECAwQF',
        Message: {
          audioMessage: { mimetype: 'audio/ogg; codecs=opus' },
        },
      })
    );

    const [, event] = ingestInbound.mock.calls[0];
    expect(event.mediaPath).toBeTruthy();
  });

  it('recusa a URL cifrada do CDN — a mensagem entra sem mídia', async () => {
    await post(
      SECRET,
      payload('MESSAGE', {
        Info: chat,
        Message: {
          audioMessage: {
            URL: 'https://mmg.whatsapp.net/v/t62/x.enc',
            mimetype: 'audio/ogg; codecs=opus',
          },
        },
      })
    );

    const [, event] = ingestInbound.mock.calls[0];
    expect(event.contentType).toBe('audio');
    // Baixar e subir esses bytes daria `media_path` preenchido e um
    // player mudo — pior que a bolha sem mídia, porque esconde o motivo.
    expect(event.mediaPath).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('usa o mediaUrl em claro quando o servidor tem MinIO/S3', async () => {
    await post(
      SECRET,
      payload('MESSAGE', {
        Info: chat,
        Message: {
          audioMessage: {
            URL: 'https://mmg.whatsapp.net/v/t62/x.enc',
            mediaUrl: 'https://minio.example/audio.ogg',
            mimetype: 'audio/ogg; codecs=opus',
          },
        },
      })
    );

    const [, event] = ingestInbound.mock.calls[0];
    expect(event.mediaPath).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith('https://minio.example/audio.ogg');
  });

  it('sobe SEM os parâmetros do mimetype — o bucket compara string literal', async () => {
    // `allowed_mime_types` do `chat-media` lista `audio/ogg` puro, e o
    // Supabase Storage compara literalmente: `audio/ogg; codecs=opus`
    // (o que o WhatsApp manda em todo áudio de voz) era recusado com
    // "mime type ... is not supported". O base64 chegava certo, era
    // decodificado certo, e o upload morria na última linha — bolha com
    // "Áudio indisponível" e nenhum erro visível na UI.
    await post(
      SECRET,
      payload('MESSAGE', {
        Info: chat,
        Message: {
          audioMessage: { mimetype: 'audio/ogg; codecs=opus' },
          base64: 'T2dnUwACAAAA',
        },
      })
    );

    expect(currentDb.uploads).toHaveLength(1);
    expect(currentDb.uploads[0].contentType).toBe('audio/ogg');
    // A extensão do objeto segue a mesma normalização.
    expect(currentDb.uploads[0].path).toMatch(/\.ogg$/);
  });

  it('nomeia o objeto pela extensão do mimetype quando não há filename', async () => {
    // Áudio de voz não tem `fileName` — é gravação, não arquivo. Sem
    // derivar do mimetype, tudo virava `media.bin` no bucket.
    const { storedFileNameFor } = await import('./route');

    expect(storedFileNameFor(null, 'audio/ogg; codecs=opus')).toBe('media.ogg');
    expect(storedFileNameFor(null, 'image/jpeg')).toBe('media.jpg');
    // Nome explícito do provedor (documento) tem prioridade.
    expect(storedFileNameFor('contrato.pdf', 'application/pdf')).toBe(
      'contrato.pdf'
    );
    // Mimetype desconhecido não inventa extensão.
    expect(storedFileNameFor(null, 'application/x-coisa')).toBe('media');
    expect(storedFileNameFor(null, null)).toBe('media');
  });

  it('lê o proto de mídia mesmo com a caixa do campo divergindo', async () => {
    await post(
      SECRET,
      payload('MESSAGE', {
        Info: chat,
        Message: {
          AudioMessage: { Base64: 'AAECAwQF', Mimetype: 'audio/ogg' },
        },
      })
    );

    const [, event] = ingestInbound.mock.calls[0];
    expect(event.contentType).toBe('audio');
    expect(event.mediaPath).toBeTruthy();
  });
});
