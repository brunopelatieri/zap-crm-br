/**
 * Testes de PARIDADE do caminho de saída (SPEC 048 §5, fase F2).
 *
 * O foco é o que os cinco caminhos de envio tinham em comum e que agora
 * existe uma vez só: escopo de conta na resolução do contato, semântica
 * da repetição por variante de telefone (quando repetir e quando NÃO
 * repetir), correção do telefone que funcionou, e as colunas gravadas.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  ChannelCapabilityError,
  ChannelNotConfiguredError,
  cloudChannelContext,
  resolveChannelContext,
  resolveChannelForConversation,
  resolveOutboundContact,
  sendAndPersistOutbound,
  sendContentViaChannel,
  sendWithPhoneVariants,
} from './send';
import { ColdSendLimitError } from './cold-send-wiring';
import { COLD_SEND_DEFAULTS } from './cold-send-limit';

const sendTextMessage = vi.fn();
const sendMediaMessage = vi.fn();
const sendTemplateMessage = vi.fn();
const sendInteractiveButtons = vi.fn();
const sendInteractiveList = vi.fn();

vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTextMessage: (...a: unknown[]) => sendTextMessage(...a),
  sendMediaMessage: (...a: unknown[]) => sendMediaMessage(...a),
  sendTemplateMessage: (...a: unknown[]) => sendTemplateMessage(...a),
  sendInteractiveButtons: (...a: unknown[]) => sendInteractiveButtons(...a),
  sendInteractiveList: (...a: unknown[]) => sendInteractiveList(...a),
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `decrypted:${v}`,
}));

const resolveInstanceByChannelId = vi.fn();
vi.mock('@/lib/evolution/instances', () => ({
  resolveInstanceByChannelId: (...a: unknown[]) =>
    resolveInstanceByChannelId(...a),
}));

/**
 * Registro com override por teste.
 *
 * Sem isto, qualquer teste de guard de capacidade passa pelo motivo
 * errado: `getAdapter('whatsapp_qr')` estoura com "no adapter
 * registered" ANTES de a capacidade ser conferida, e a asserção casa com
 * esse erro sem nunca exercitar o guard. O override dá um adaptador
 * registrado ao canal, para a recusa vir de onde ela deve vir.
 */
const { adapterOverrides } = vi.hoisted(() => ({
  adapterOverrides: new Map<string, unknown>(),
}));

vi.mock('./registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./registry')>();
  return {
    ...actual,
    getAdapter: (type: string) =>
      adapterOverrides.get(type) ?? actual.getAdapter(type as never),
  };
});

// ------------------------------------------------------------
// Supabase de mentira — mesmo espírito de `ingest.test.ts`.
// ------------------------------------------------------------

interface RecordedOp {
  table: string;
  verb: 'select' | 'insert' | 'update';
  payload?: unknown;
  filters: Array<[string, ...unknown[]]>;
}

function makeDb(
  results: Record<
    string,
    { data?: unknown; error?: unknown; count?: number }
  > = {}
) {
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
      select: (...args: unknown[]) => {
        op.filters.push(['select', ...args]);
        return chain;
      },
      eq: (...args: unknown[]) => {
        op.filters.push(['eq', ...args]);
        return chain;
      },
      gte: (...args: unknown[]) => {
        op.filters.push(['gte', ...args]);
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
      single: () => Promise.resolve(settle()),
      maybeSingle: () => Promise.resolve(settle()),
    };
    return chain;
  }

  return {
    client: {
      from: (t: string) => builder(t),
    } as unknown as SupabaseClient,
    ops,
  };
}

const CONFIG_ROW = {
  id: 'cfg-1',
  user_id: 'user-1',
  phone_number_id: 'pnid-1',
  access_token: 'cipher',
  status: 'connected',
};

function dbWithConfigAndContact(
  over: Record<string, { data?: unknown; error?: unknown }> = {}
) {
  return makeDb({
    'whatsapp_config.select': { data: CONFIG_ROW, error: null },
    'contacts.select': {
      data: { id: 'contact-1', phone: '+55 11 99999-9999' },
      error: null,
    },
    ...over,
  });
}

const CTX = cloudChannelContext({
  accountId: 'acct-1',
  phoneNumberId: 'pnid-1',
  accessToken: 'token-1',
});

/**
 * Adaptador mínimo de um canal QRCode. Só tem o que a matriz de
 * capacidades diz que o canal tem — sem `sendTemplate`, sem
 * `sendInteractive` — porque é essa a forma que o adaptador da F4 terá.
 */
const qrAdapterStub = {
  type: 'whatsapp_qr',
  capabilities: {},
  sendText: vi.fn(async () => ({ providerMessageId: 'evo.1' })),
  sendMedia: vi.fn(async () => ({ providerMessageId: 'evo.1' })),
  normalizeInbound: () => [],
};

beforeEach(() => {
  vi.clearAllMocks();
  adapterOverrides.clear();
  qrAdapterStub.sendText.mockResolvedValue({ providerMessageId: 'evo.1' });
  sendTextMessage.mockResolvedValue({ messageId: 'wamid.out' });
  sendMediaMessage.mockResolvedValue({ messageId: 'wamid.out' });
  sendTemplateMessage.mockResolvedValue({ messageId: 'wamid.out' });
  sendInteractiveButtons.mockResolvedValue({ messageId: 'wamid.out' });
  sendInteractiveList.mockResolvedValue({ messageId: 'wamid.out' });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('resolveChannelContext', () => {
  it('decripta o token e entrega a linha crua para o auto-reparo', async () => {
    const db = dbWithConfigAndContact();

    const { ctx, configRow } = await resolveChannelContext(db.client, 'acct-1');

    expect(ctx.credentials).toEqual({
      phoneNumberId: 'pnid-1',
      accessToken: 'decrypted:cipher',
    });
    expect(configRow.access_token).toBe('cipher');
    // Escopo de conta — não de usuário.
    const read = db.ops.find((o) => o.table === 'whatsapp_config')!;
    expect(read.filters).toContainEqual(['eq', 'account_id', 'acct-1']);
  });

  it('erro tipado quando a conta não tem canal configurado', async () => {
    const db = makeDb({
      'whatsapp_config.select': { data: null, error: { message: 'no rows' } },
    });

    await expect(
      resolveChannelContext(db.client, 'acct-1')
    ).rejects.toBeInstanceOf(ChannelNotConfiguredError);
  });

  it('recusa whatsapp_qr sem channelId explícito (ambíguo entre várias instâncias)', async () => {
    const db = makeDb();
    await expect(
      resolveChannelContext(db.client, 'acct-1', 'whatsapp_qr')
    ).rejects.toBeInstanceOf(ChannelNotConfiguredError);
  });

  it('resolve whatsapp_qr por channelId — credencial é o instanceToken decriptado', async () => {
    resolveInstanceByChannelId.mockResolvedValue({
      instanceId: 'inst-1',
      channelId: 'chan-qr-1',
      accountId: 'acct-1',
      remoteInstanceId: 'remote-1',
      remoteInstanceName: 'zapcrm_acct1_vendas',
      token: 'plain-instance-token',
      channelName: 'Vendas',
    });
    const db = makeDb({
      'channels.select': {
        data: {
          id: 'chan-qr-1',
          account_id: 'acct-1',
          type: 'whatsapp_qr',
          name: 'Vendas',
          status: 'connected',
        },
        error: null,
      },
    });

    const resolved = await resolveChannelContext(
      db.client,
      'acct-1',
      'whatsapp_qr',
      'chan-qr-1'
    );

    expect(resolveInstanceByChannelId).toHaveBeenCalledWith(
      'acct-1',
      'chan-qr-1'
    );
    expect(resolved.ctx.credentials).toEqual({
      instanceToken: 'plain-instance-token',
    });
    expect(resolved.ctx.channel.id).toBe('chan-qr-1');
  });
});

describe('resolveChannelForConversation', () => {
  /**
   * A regressão que este bloco trava (SPEC 048 F4.1, achado #1 da
   * revisão): antes disto TODO caminho de saída resolvia
   * `whatsapp_cloud` fixo, ignorando `conversations.channel_id`. Com a
   * F4 fazendo conversas QRCode aparecerem no inbox, responder uma
   * delas mandava a mensagem pelo NÚMERO OFICIAL da Meta — cobrada,
   * saindo de outro número, e com um wamid que o eco `SEND_MESSAGE` da
   * Evolution nunca casaria.
   */
  it('resolve o canal QRCode quando a conversa aponta para ele', async () => {
    resolveInstanceByChannelId.mockResolvedValue({
      instanceId: 'inst-1',
      channelId: 'chan-qr-1',
      accountId: 'acct-1',
      remoteInstanceId: 'remote-1',
      remoteInstanceName: 'zapcrm_acct1_vendas',
      token: 'plain-instance-token',
      channelName: 'Vendas',
    });
    const db = makeDb({
      'conversations.select': {
        data: { channel_id: 'chan-qr-1' },
        error: null,
      },
      'channels.select': {
        data: {
          id: 'chan-qr-1',
          account_id: 'acct-1',
          type: 'whatsapp_qr',
          name: 'Vendas',
          status: 'connected',
        },
        error: null,
      },
    });

    const resolved = await resolveChannelForConversation(
      db.client,
      'acct-1',
      'conv-qr'
    );

    expect(resolved.ctx.channel.type).toBe('whatsapp_qr');
    expect(resolved.ctx.credentials).toEqual({
      instanceToken: 'plain-instance-token',
    });
    // E nunca tocou a `whatsapp_config` do canal oficial.
    expect(db.ops.some((o) => o.table === 'whatsapp_config')).toBe(false);
  });

  it('resolve o canal oficial quando a conversa aponta para ele', async () => {
    const db = makeDb({
      'conversations.select': {
        data: { channel_id: 'chan-cloud-1' },
        error: null,
      },
      'channels.select': {
        data: { id: 'chan-cloud-1', type: 'whatsapp_cloud' },
        error: null,
      },
      'whatsapp_config.select': { data: CONFIG_ROW, error: null },
    });

    const resolved = await resolveChannelForConversation(
      db.client,
      'acct-1',
      'conv-cloud'
    );

    expect(resolved.ctx.channel.type).toBe('whatsapp_cloud');
    expect(resolved.ctx.credentials.phoneNumberId).toBe('pnid-1');
  });

  it('conversa sem channel_id cai no canal oficial (compat pré-059)', async () => {
    const db = makeDb({
      'conversations.select': { data: { channel_id: null }, error: null },
      'whatsapp_config.select': { data: CONFIG_ROW, error: null },
    });

    const resolved = await resolveChannelForConversation(
      db.client,
      'acct-1',
      'conv-antiga'
    );

    expect(resolved.ctx.channel.type).toBe('whatsapp_cloud');
  });

  it('falha com motivo quando o canal da conversa não existe mais', async () => {
    // Enviar pelo canal errado é pior que não enviar.
    const db = makeDb({
      'conversations.select': {
        data: { channel_id: 'chan-apagado' },
        error: null,
      },
      'channels.select': { data: null, error: null },
    });

    await expect(
      resolveChannelForConversation(db.client, 'acct-1', 'conv-orfa')
    ).rejects.toBeInstanceOf(ChannelNotConfiguredError);
  });

  it('escopa a leitura da conversa por conta', async () => {
    const db = makeDb({
      'conversations.select': { data: { channel_id: null }, error: null },
      'whatsapp_config.select': { data: CONFIG_ROW, error: null },
    });

    await resolveChannelForConversation(db.client, 'acct-1', 'conv-1');

    const read = db.ops.find((o) => o.table === 'conversations')!;
    expect(read.filters).toContainEqual(['eq', 'account_id', 'acct-1']);
  });
});

describe('resolveOutboundContact', () => {
  it('filtra por conta e devolve o telefone sanitizado', async () => {
    const db = dbWithConfigAndContact();

    const contact = await resolveOutboundContact(
      db.client,
      'acct-1',
      'contact-1'
    );

    // `sanitizePhoneForMeta` tira tudo que não é dígito, inclusive o `+`.
    expect(contact.sanitizedPhone).toBe('5511999999999');
    const read = db.ops.find((o) => o.table === 'contacts')!;
    expect(read.filters).toContainEqual(['eq', 'account_id', 'acct-1']);
  });

  it('recusa contato de outra conta com a mensagem histórica', async () => {
    const db = makeDb({ 'contacts.select': { data: null, error: null } });

    await expect(
      resolveOutboundContact(db.client, 'acct-1', 'contact-de-outro')
    ).rejects.toThrow('contact not found for this account');
  });

  it('recusa telefone que não vira E.164', async () => {
    const db = makeDb({
      'contacts.select': { data: { id: 'c', phone: '123' }, error: null },
    });

    await expect(
      resolveOutboundContact(db.client, 'acct-1', 'c')
    ).rejects.toThrow('contact phone invalid: 123');
  });
});

describe('sendContentViaChannel — o canal oficial recebe tudo o que recebia', () => {
  it('texto com citação vira `contextMessageId`', async () => {
    await sendContentViaChannel(CTX, {
      to: '+5511999999999',
      content: { kind: 'text', text: 'oi' },
      quotedProviderMessageId: 'wamid.pai',
    });

    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumberId: 'pnid-1',
        accessToken: 'token-1',
        to: '+5511999999999',
        text: 'oi',
        contextMessageId: 'wamid.pai',
      })
    );
  });

  it('template leva a linha local, os params estruturados E os posicionais', async () => {
    const templateRow = { id: 'tpl-1', header_type: 'image' };

    await sendContentViaChannel(CTX, {
      to: '+5511999999999',
      content: {
        kind: 'template',
        templateName: 'promo',
        language: 'pt_BR',
        definition: templateRow,
        components: { headerMediaUrl: 'https://signed' },
        positionalParams: ['Ana'],
      },
      quotedProviderMessageId: 'wamid.pai',
    });

    // Perder `template` aqui quebraria todo template com header de
    // mídia; perder `params`, todo envio legado.
    expect(sendTemplateMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        templateName: 'promo',
        language: 'pt_BR',
        template: templateRow,
        messageParams: { headerMediaUrl: 'https://signed' },
        params: ['Ana'],
        contextMessageId: 'wamid.pai',
      })
    );
  });

  it('mídia mapeia url→link e mantém caption/filename/citação', async () => {
    await sendContentViaChannel(CTX, {
      to: '+5511999999999',
      content: {
        kind: 'media',
        mediaKind: 'document',
        link: 'https://signed/doc.pdf',
        caption: 'contrato',
        filename: 'doc.pdf',
      },
      quotedProviderMessageId: 'wamid.pai',
    });

    expect(sendMediaMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'document',
        link: 'https://signed/doc.pdf',
        caption: 'contrato',
        filename: 'doc.pdf',
        contextMessageId: 'wamid.pai',
      })
    );
  });

  it('interativo escolhe botões ou lista pelo payload', async () => {
    await sendContentViaChannel(CTX, {
      to: '+5511999999999',
      content: {
        kind: 'interactive',
        payload: {
          kind: 'buttons',
          body: 'Escolha',
          buttons: [{ id: 'a', title: 'A' }],
        },
      },
    });
    expect(sendInteractiveButtons).toHaveBeenCalled();
    expect(sendInteractiveList).not.toHaveBeenCalled();

    await sendContentViaChannel(CTX, {
      to: '+5511999999999',
      content: {
        kind: 'interactive',
        payload: {
          kind: 'list',
          body: 'Escolha',
          button_label: 'Ver',
          sections: [{ title: 'S', rows: [{ id: 'a', title: 'A' }] }],
        },
      },
    });
    expect(sendInteractiveList).toHaveBeenCalled();
  });

  it('recusa por capacidade, com motivo, antes de tocar no provedor', async () => {
    // Canal QRCode COM adaptador registrado — senão a recusa viria do
    // registro e este teste passaria sem nunca exercitar o guard.
    adapterOverrides.set('whatsapp_qr', qrAdapterStub);
    const qrCtx = {
      ...CTX,
      channel: { ...CTX.channel, type: 'whatsapp_qr' as const },
    };

    // A matriz mede o que foi MEDIDO contra o servidor real: o canal QR
    // não tem template, e botão/lista o WhatsApp recusa com 405.
    await expect(
      sendContentViaChannel(qrCtx, {
        to: '+5511999999999',
        content: { kind: 'template', templateName: 'promo' },
      })
    ).rejects.toThrow(/does not support message templates/);

    await expect(
      sendContentViaChannel(qrCtx, {
        to: '+5511999999999',
        content: {
          kind: 'interactive',
          payload: {
            kind: 'buttons',
            body: 'Escolha',
            buttons: [{ id: 'a', title: 'A' }],
          },
        },
      })
    ).rejects.toThrow(/does not support interactive buttons/);

    expect(sendTemplateMessage).not.toHaveBeenCalled();
    expect(qrAdapterStub.sendText).not.toHaveBeenCalled();
  });

  it('deixa passar o que o canal SUPORTA', async () => {
    // Contraprova do teste acima: se o guard recusasse por engano, o
    // canal QRCode nasceria mudo.
    adapterOverrides.set('whatsapp_qr', qrAdapterStub);
    const qrCtx = {
      ...CTX,
      channel: { ...CTX.channel, type: 'whatsapp_qr' as const },
    };

    const id = await sendContentViaChannel(qrCtx, {
      to: '+5511999999999',
      content: { kind: 'text', text: 'oi' },
    });

    expect(id).toBe('evo.1');
    expect(qrAdapterStub.sendText).toHaveBeenCalledTimes(1);
  });

  it('recusa quando a matriz e o adaptador DISCORDAM', async () => {
    // `capabilities.ts` e o objeto do adaptador são duas declarações
    // independentes, e os métodos são opcionais na interface — o
    // TypeScript não amarra uma à outra. Um canal que declare
    // `templates: true` e esqueça o método precisa falhar com motivo,
    // não com `undefined is not a function` dentro do laço de variantes
    // (que o send-message traduziria como "Meta API error" + HTTP 502).
    const cloudSemTemplate = {
      type: 'whatsapp_cloud',
      capabilities: {},
      sendText: vi.fn(),
      sendMedia: vi.fn(),
      // sendTemplate ausente de propósito
      normalizeInbound: () => [],
    };
    adapterOverrides.set('whatsapp_cloud', cloudSemTemplate);

    await expect(
      sendContentViaChannel(CTX, {
        to: '+5511999999999',
        content: { kind: 'template', templateName: 'promo' },
      })
    ).rejects.toThrow(/adapter has no sendTemplate\(\)/);
  });
});

describe('sendWithPhoneVariants', () => {
  it('tenta a próxima variante quando o destinatário não está na lista', async () => {
    sendTextMessage
      .mockRejectedValueOnce(
        new Error('recipient phone number not in allowed list')
      )
      .mockResolvedValueOnce({ messageId: 'wamid.ok' });
    const onVariantRejected = vi.fn();

    const r = await sendWithPhoneVariants({
      ctx: CTX,
      sanitizedPhone: '+5511999999999',
      content: { kind: 'text', text: 'oi' },
      onVariantRejected,
    });

    expect(r.providerMessageId).toBe('wamid.ok');
    expect(onVariantRejected).toHaveBeenCalledTimes(1);
    expect(sendTextMessage).toHaveBeenCalledTimes(2);
  });

  it('NÃO repete diante de qualquer outro erro', async () => {
    // Insistir com telefones diferentes diante de um token inválido só
    // multiplicaria a falha.
    sendTextMessage.mockRejectedValue(new Error('Invalid OAuth access token'));

    await expect(
      sendWithPhoneVariants({
        ctx: CTX,
        sanitizedPhone: '+5511999999999',
        content: { kind: 'text', text: 'oi' },
      })
    ).rejects.toThrow('Invalid OAuth access token');
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
  });
});

describe('sendAndPersistOutbound', () => {
  it('grava a mensagem do motor e atualiza o preview da conversa', async () => {
    const db = dbWithConfigAndContact();

    const r = await sendAndPersistOutbound({
      db: db.client,
      accountId: 'acct-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      content: { kind: 'text', text: 'olá' },
      persist: {
        senderType: 'bot',
        contentType: 'text',
        contentText: 'olá',
        previewText: 'olá',
        extra: { ai_generated: true },
      },
    });

    expect(r).toEqual({ whatsapp_message_id: 'wamid.out' });

    const insert = db.ops.find(
      (o) => o.table === 'messages' && o.verb === 'insert'
    )!;
    expect(insert.payload).toEqual({
      conversation_id: 'conv-1',
      sender_type: 'bot',
      content_type: 'text',
      content_text: 'olá',
      ai_generated: true,
      message_id: 'wamid.out',
      status: 'sent',
    });

    const convUpdate = db.ops.find(
      (o) => o.table === 'conversations' && o.verb === 'update'
    )!;
    expect(convUpdate.payload).toMatchObject({ last_message_text: 'olá' });
  });

  it('persiste a variante que funcionou de volta no contato', async () => {
    const db = dbWithConfigAndContact();
    sendTextMessage
      .mockRejectedValueOnce(
        new Error('recipient phone number not in allowed list')
      )
      .mockResolvedValueOnce({ messageId: 'wamid.ok' });

    await sendAndPersistOutbound({
      db: db.client,
      accountId: 'acct-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      content: { kind: 'text', text: 'olá' },
      persist: {
        senderType: 'bot',
        contentType: 'text',
        contentText: 'olá',
        previewText: 'olá',
      },
    });

    // A segunda variante de `phoneVariants` insere um 0 depois do
    // primeiro dígito de país. O que importa aqui é que a variante
    // ACEITA volte para o contato, para o próximo envio ir direto.
    const fix = db.ops.find(
      (o) => o.table === 'contacts' && o.verb === 'update'
    );
    expect(fix?.payload).toEqual({ phone: '50511999999999' });
  });

  it('não finge que o envio falhou quando só o INSERT falhou', async () => {
    const db = dbWithConfigAndContact({
      'messages.insert': { data: null, error: { message: 'constraint' } },
    });

    await expect(
      sendAndPersistOutbound({
        db: db.client,
        accountId: 'acct-1',
        conversationId: 'conv-1',
        contactId: 'contact-1',
        content: { kind: 'text', text: 'olá' },
        persist: {
          senderType: 'bot',
          contentType: 'text',
          contentText: 'olá',
          previewText: 'olá',
        },
      })
    ).rejects.toThrow(/sent to Meta but DB insert failed/);
  });

  describe('teto de envio frio (SPEC 049 §6.2, D-1) — canal QR', () => {
    function dbWithQrConversation(
      over: Record<
        string,
        { data?: unknown; error?: unknown; count?: number }
      > = {}
    ) {
      return makeDb({
        'conversations.select': {
          data: { channel_id: 'chan-qr-1', last_customer_message_at: null },
          error: null,
        },
        'channels.select': {
          data: {
            id: 'chan-qr-1',
            account_id: 'acct-1',
            type: 'whatsapp_qr',
            name: 'Vendas',
            status: 'connected',
            created_at: '2020-01-01T00:00:00Z',
          },
          error: null,
        },
        'contacts.select': {
          data: { id: 'contact-1', phone: '+55 11 99999-9999' },
          error: null,
        },
        'channel_cold_sends.select': { count: 0, data: null },
        ...over,
      });
    }

    beforeEach(() => {
      adapterOverrides.set('whatsapp_qr', qrAdapterStub);
      resolveInstanceByChannelId.mockResolvedValue({
        instanceId: 'inst-1',
        channelId: 'chan-qr-1',
        accountId: 'acct-1',
        remoteInstanceId: 'remote-1',
        remoteInstanceName: 'zapcrm_acct1_vendas',
        token: 'plain-instance-token',
        channelName: 'Vendas',
      });
    });

    it('nega (ColdSendLimitError) sem tocar o adaptador quando o teto diário estourou', async () => {
      const db = dbWithQrConversation({
        'channel_cold_sends.select': { count: COLD_SEND_DEFAULTS.perDay },
      });

      await expect(
        sendAndPersistOutbound({
          db: db.client,
          accountId: 'acct-1',
          conversationId: 'conv-1',
          contactId: 'contact-1',
          content: { kind: 'text', text: 'oi' },
          persist: {
            senderType: 'bot',
            contentType: 'text',
            contentText: 'oi',
            previewText: 'oi',
          },
        })
      ).rejects.toBeInstanceOf(ColdSendLimitError);

      expect(qrAdapterStub.sendText).not.toHaveBeenCalled();
      expect(db.ops.some((o) => o.table === 'messages')).toBe(false);
    });

    it('envio frio dentro do teto: entrega e grava origin=engine em channel_cold_sends', async () => {
      const db = dbWithQrConversation();

      await sendAndPersistOutbound({
        db: db.client,
        accountId: 'acct-1',
        conversationId: 'conv-1',
        contactId: 'contact-1',
        content: { kind: 'text', text: 'oi' },
        persist: {
          senderType: 'bot',
          contentType: 'text',
          contentText: 'oi',
          previewText: 'oi',
        },
      });

      expect(qrAdapterStub.sendText).toHaveBeenCalledTimes(1);
      const record = db.ops.find(
        (o) => o.table === 'channel_cold_sends' && o.verb === 'insert'
      );
      expect(record?.payload).toEqual({
        channel_id: 'chan-qr-1',
        account_id: 'acct-1',
        contact_id: 'contact-1',
        origin: 'engine',
      });
    });

    it('conversa viva (não fria): entrega e NÃO grava consumo', async () => {
      const db = dbWithQrConversation({
        'conversations.select': {
          data: {
            channel_id: 'chan-qr-1',
            // Dentro das últimas `silenceHours` — não é frio.
            last_customer_message_at: new Date().toISOString(),
          },
          error: null,
        },
      });

      await sendAndPersistOutbound({
        db: db.client,
        accountId: 'acct-1',
        conversationId: 'conv-1',
        contactId: 'contact-1',
        content: { kind: 'text', text: 'oi' },
        persist: {
          senderType: 'bot',
          contentType: 'text',
          contentText: 'oi',
          previewText: 'oi',
        },
      });

      expect(
        db.ops.some(
          (o) => o.table === 'channel_cold_sends' && o.verb === 'insert'
        )
      ).toBe(false);
    });

    it('canal Cloud: não paga a consulta extra nem toca channel_cold_sends', async () => {
      const db = dbWithConfigAndContact();

      await sendAndPersistOutbound({
        db: db.client,
        accountId: 'acct-1',
        conversationId: 'conv-1',
        contactId: 'contact-1',
        content: { kind: 'text', text: 'oi' },
        persist: {
          senderType: 'bot',
          contentType: 'text',
          contentText: 'oi',
          previewText: 'oi',
        },
      });

      expect(db.ops.some((o) => o.table === 'channel_cold_sends')).toBe(false);
    });
  });

  describe('selo do canal de desvio (SPEC 049 §6.1 ponto 2, migração 063)', () => {
    it('canal EXPLÍCITO: a bolha carrega channel_id do canal que entregou', async () => {
      // Mesmo cenário de `dbWithQrConversation`, mas SEM `conversations.
      // channel_id` apontar para o QR — a conversa é do oficial; o
      // desvio (`channel` explícito) é o único motivo de o envio sair
      // pelo QR mesmo assim.
      adapterOverrides.set('whatsapp_qr', qrAdapterStub);
      resolveInstanceByChannelId.mockResolvedValue({
        instanceId: 'inst-1',
        channelId: 'chan-qr-1',
        accountId: 'acct-1',
        remoteInstanceId: 'remote-1',
        remoteInstanceName: 'zapcrm_acct1_vendas',
        token: 'plain-instance-token',
        channelName: 'Vendas',
      });
      const db = makeDb({
        'channels.select': {
          data: {
            id: 'chan-qr-1',
            account_id: 'acct-1',
            type: 'whatsapp_qr',
            name: 'Vendas',
            status: 'connected',
            created_at: '2020-01-01T00:00:00Z',
          },
          error: null,
        },
        'contacts.select': {
          data: { id: 'contact-1', phone: '+55 11 99999-9999' },
          error: null,
        },
        'channel_cold_sends.select': { count: 0, data: null },
      });

      await sendAndPersistOutbound({
        db: db.client,
        accountId: 'acct-1',
        channel: { type: 'whatsapp_qr', id: 'chan-qr-1' },
        conversationId: 'conv-1',
        contactId: 'contact-1',
        content: { kind: 'text', text: 'oi' },
        persist: {
          senderType: 'bot',
          contentType: 'text',
          contentText: 'oi',
          previewText: 'oi',
        },
      });

      const insert = db.ops.find(
        (o) => o.table === 'messages' && o.verb === 'insert'
      );
      expect(insert?.payload).toMatchObject({ channel_id: 'chan-qr-1' });

      // E a `conversations` consultada por `channel_id` NUNCA acontece
      // — a única leitura de `conversations` é a âncora do teto de
      // envio frio, sem filtro de canal envolvido.
      expect(
        db.ops.some((o) => o.table === 'conversations' && o.verb === 'select')
      ).toBe(true);
    });

    it('canal IMPLÍCITO (o da própria conversa): channel_id fica de fora do INSERT', async () => {
      const db = dbWithConfigAndContact();

      await sendAndPersistOutbound({
        db: db.client,
        accountId: 'acct-1',
        conversationId: 'conv-1',
        contactId: 'contact-1',
        content: { kind: 'text', text: 'oi' },
        persist: {
          senderType: 'bot',
          contentType: 'text',
          contentText: 'oi',
          previewText: 'oi',
        },
      });

      const insert = db.ops.find(
        (o) => o.table === 'messages' && o.verb === 'insert'
      );
      expect(insert?.payload).not.toHaveProperty('channel_id');
    });
  });
});

describe('ChannelCapabilityError', () => {
  it('é uma classe de erro própria, para o chamador distinguir', () => {
    expect(new ChannelCapabilityError('x')).toBeInstanceOf(Error);
    expect(new ChannelCapabilityError('x').name).toBe('ChannelCapabilityError');
  });
});
