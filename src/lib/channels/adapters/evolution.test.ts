/**
 * Adaptador de mensageria Evolution (SPEC 048 F4 / §8.1).
 *
 * Cobre: normalização de número, corpo de requisição por endpoint,
 * leitura defensiva do id da mensagem, mapeamento do erro real (401 →
 * `channels.status = 'error'`), e que `normalizeInbound` lança (a
 * tradução mora no webhook, mesmo desenho do adaptador Cloud).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

/** Callbacks que `send()` entregou a `after()` — o backfill de LID roda
 *  aqui dentro, fora do caminho crítico (ver comentário em evolution.ts). */
const afterCallbacks: Array<() => unknown> = [];
vi.mock('next/server', () => ({
  after: (cb: () => unknown) => {
    afterCallbacks.push(cb);
  },
}));

const evolutionRequest = vi.fn();
vi.mock('@/lib/evolution/client', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/evolution/client')>();
  return {
    ...actual,
    evolutionRequest: (...args: unknown[]) => evolutionRequest(...args),
  };
});

vi.mock('@/lib/evolution/config', () => ({
  readEvolutionConfig: () => ({
    apiUrl: 'https://go.local.ia.br',
    globalApiKey: 'global-key',
    maxInstancesPerAccount: 3,
    maxInstancesTotal: 20,
    instancePrefix: 'zapcrm',
    webhookPublicUrl: 'https://crm.example',
    requestTimeoutMs: 15000,
    mediaRequestTimeoutMs: 60000,
  }),
}));

const channelsUpdate = vi.fn();
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      update: (payload: unknown) => {
        channelsUpdate(payload);
        return { eq: () => Promise.resolve({ error: null }) };
      },
    }),
  }),
}));

const ensureContactIdentity = vi.fn();
vi.mock('@/lib/evolution/contact-identity', () => ({
  ensureContactIdentity: (...args: unknown[]) => ensureContactIdentity(...args),
}));

import { EvolutionApiError } from '@/lib/evolution/client';
import { evolutionAdapter } from './evolution';
import type { ChannelContext } from '../types';

const CTX: ChannelContext = {
  accountId: 'acct-1',
  channel: {
    id: 'chan-qr-1',
    account_id: 'acct-1',
    user_id: 'user-1',
    type: 'whatsapp_qr',
    name: 'Vendas',
    identifier: null,
    status: 'connected',
    status_detail: null,
    is_default: false,
    connected_at: null,
    last_seen_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  credentials: { instanceToken: 'instance-token-1' },
};

beforeEach(() => {
  vi.clearAllMocks();
  afterCallbacks.length = 0;
});

describe('sendText', () => {
  it('envia number sem + e sem formatação, e lê o id da resposta', async () => {
    evolutionRequest.mockResolvedValue({
      data: { key: { id: 'EVO123' } },
      message: 'success',
    });

    const result = await evolutionAdapter.sendText(CTX, {
      to: '+55 (19) 99249-6598',
      text: 'oi',
    });

    expect(evolutionRequest).toHaveBeenCalledWith(
      expect.anything(),
      '/send/text',
      expect.objectContaining({
        method: 'POST',
        key: 'instance-token-1',
        body: expect.objectContaining({ number: '5519992496598', text: 'oi' }),
      })
    );
    expect(result.providerMessageId).toBe('EVO123');
    // Fecha a lacuna do backfill puramente reativo (SPEC 048 §6.4):
    // sabemos o telefone por sermos NÓS a mandar, então o vínculo
    // telefone→LID pode nascer sem depender de um inbound sortudo.
    // Agendado via after() — não roda inline, então dispara o callback
    // capturado pra provar o que ele faz.
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]!();
    expect(ensureContactIdentity).toHaveBeenCalledWith({
      accountId: 'acct-1',
      instanceToken: 'instance-token-1',
      phone: '5519992496598',
    });
  });

  it('inclui quoted quando há citação', async () => {
    evolutionRequest.mockResolvedValue({ data: { messageId: 'EVO1' } });

    await evolutionAdapter.sendText(CTX, {
      to: '5511999999999',
      text: 'oi',
      quotedProviderMessageId: 'EVO-parent',
    });

    const [, , opts] = evolutionRequest.mock.calls[0];
    expect((opts as { body: { quoted?: unknown } }).body.quoted).toEqual({
      messageId: 'EVO-parent',
    });
  });

  it('lê o id por chaves alternativas quando key.id não vem', async () => {
    evolutionRequest.mockResolvedValue({ id: 'EVO-fallback' });
    const result = await evolutionAdapter.sendText(CTX, {
      to: '5511999999999',
      text: 'oi',
    });
    expect(result.providerMessageId).toBe('EVO-fallback');
  });

  it('lê o campo `ID` maiúsculo — a grafia real do SendResponse', async () => {
    // `SendResponse` do whatsmeow é struct Go sem tag de json, então o
    // campo sai como `ID`. Procurando só `id`/`Id`, TODA mensagem
    // enviada foi gravada com `message_id` vazio: recibo de leitura
    // nunca casava e o eco `SendMessage` duplicaria cada resposta.
    evolutionRequest.mockResolvedValue({
      data: {
        ID: '3EB0C767D82B0A2F7A32',
        ServerID: 0,
        Timestamp: '2026-08-14T10:42:00-03:00',
      },
      message: 'success',
    });

    const result = await evolutionAdapter.sendText(CTX, {
      to: '5511999999999',
      text: 'oi',
    });

    expect(result.providerMessageId).toBe('3EB0C767D82B0A2F7A32');
  });

  it('lê `Info.ID` — a forma MEDIDA da resposta real de /send/*', async () => {
    // Recorte fiel do que o servidor devolveu no teste com número real.
    // O id não está na raiz: `/send/*` devolve o mesmo `MessageInfo` do
    // whatsmeow que chega no webhook. Procurar `ID` só na raiz deixou
    // TODA mensagem enviada com `message_id` vazio — a bolha original
    // ficava em ✓ e a duplicata do eco em ✓✓, porque só a duplicata
    // tinha o id que o recibo procurava.
    evolutionRequest.mockResolvedValue({
      Info: {
        Chat: '5519992876519@s.whatsapp.net',
        Sender: '5519992496598:15@s.whatsapp.net',
        IsFromMe: true,
        ID: '3EB0DD2120CF0A8A5E4270',
        ServerID: 0,
        Type: 'ExtendedTextMessage',
        Timestamp: '2026-08-14T16:11:53.091495376-03:00',
      },
      Message: { extendedTextMessage: { text: 'oi', contextInfo: {} } },
      MessageContextInfo: { stanzaID: '', participant: '' },
    });

    const result = await evolutionAdapter.sendText(CTX, {
      to: '5519992876519',
      text: 'oi',
    });

    expect(result.providerMessageId).toBe('3EB0DD2120CF0A8A5E4270');
  });

  it('`Info.ID` vence a raiz quando as duas existem', async () => {
    // Ordem importa: o nível medido é o que o eco e o recibo usam.
    evolutionRequest.mockResolvedValue({
      ID: 'ID-DA-RAIZ',
      Info: { ID: 'ID-DO-INFO' },
    });

    const result = await evolutionAdapter.sendText(CTX, {
      to: '5511999999999',
      text: 'oi',
    });

    expect(result.providerMessageId).toBe('ID-DO-INFO');
  });

  it('id vazio quando nada é reconhecível — nunca lança pós-entrega', async () => {
    // A mensagem JÁ saiu para o cliente. Lançar aqui viraria "falha de
    // envio", o operador reenviaria, e o cliente receberia duas vezes.
    evolutionRequest.mockResolvedValue({ data: { foo: 'bar' } });

    const result = await evolutionAdapter.sendText(CTX, {
      to: '5511999999999',
      text: 'oi',
    });

    expect(result.providerMessageId).toBe('');
  });
});

describe('sendMedia', () => {
  it('mapeia kind para type e inclui caption/filename quando presentes', async () => {
    evolutionRequest.mockResolvedValue({ data: { id: 'EVO2' } });

    await evolutionAdapter.sendMedia(CTX, {
      to: '5511999999999',
      kind: 'image',
      url: 'https://bucket/signed.jpg',
      caption: 'legenda',
      filename: 'foto.jpg',
    });

    const [, path, opts] = evolutionRequest.mock.calls[0];
    expect(path).toBe('/send/media');
    expect((opts as { body: Record<string, unknown> }).body).toMatchObject({
      number: '5511999999999',
      url: 'https://bucket/signed.jpg',
      type: 'image',
      caption: 'legenda',
      filename: 'foto.jpg',
    });
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]!();
    expect(ensureContactIdentity).toHaveBeenCalledWith({
      accountId: 'acct-1',
      instanceToken: 'instance-token-1',
      phone: '5511999999999',
    });
  });

  it('usa mediaRequestTimeoutMs (não requestTimeoutMs) — Evolution baixa e sobe o arquivo dentro da mesma requisição', async () => {
    evolutionRequest.mockResolvedValue({ data: { id: 'EVO2' } });

    await evolutionAdapter.sendMedia(CTX, {
      to: '5511999999999',
      kind: 'video',
      url: 'https://bucket/signed.mp4',
    });

    const [, , opts] = evolutionRequest.mock.calls[0];
    expect((opts as { timeoutMs?: number }).timeoutMs).toBe(60000);
  });
});

describe('sendLocation e sendPoll', () => {
  it('sendLocation envia latitude/longitude', async () => {
    evolutionRequest.mockResolvedValue({ data: { id: 'EVO3' } });
    await evolutionAdapter.sendLocation!(CTX, {
      to: '5511999999999',
      latitude: -22.9,
      longitude: -47.0,
      name: 'Escritório',
    });
    const [, path, opts] = evolutionRequest.mock.calls[0];
    expect(path).toBe('/send/location');
    expect((opts as { body: Record<string, unknown> }).body).toMatchObject({
      latitude: -22.9,
      longitude: -47.0,
      name: 'Escritório',
    });
  });

  it('sendPoll envia question/options e maxAnswer', async () => {
    evolutionRequest.mockResolvedValue({ data: { id: 'EVO4' } });
    await evolutionAdapter.sendPoll!(CTX, {
      to: '5511999999999',
      question: 'Qual sua cor favorita?',
      options: ['Azul', 'Verde'],
      maxAnswers: 1,
    });
    const [, path, opts] = evolutionRequest.mock.calls[0];
    expect(path).toBe('/send/poll');
    expect((opts as { body: Record<string, unknown> }).body).toMatchObject({
      question: 'Qual sua cor favorita?',
      options: ['Azul', 'Verde'],
      maxAnswer: 1,
    });
  });
});

describe('backfill de LID (SPEC 048 §6.4) — vive no send() compartilhado', () => {
  // Regressão: o backfill só era chamado de sendText/sendMedia — um
  // contato cujo primeiro contato de saída fosse localização, enquete
  // ou reação nunca ganhava o vínculo telefone→LID. Mover pra dentro de
  // send() cobre todo endpoint que carregue `number`, de graça.
  it('sendLocation, sendPoll e sendReaction também agendam o backfill via after()', async () => {
    evolutionRequest.mockResolvedValue({ data: { id: 'EVO5' } });

    await evolutionAdapter.sendLocation!(CTX, {
      to: '5511999999999',
      latitude: -22.9,
      longitude: -47.0,
    });
    await evolutionAdapter.sendPoll!(CTX, {
      to: '5511999999999',
      question: 'oi',
      options: ['a', 'b'],
    });
    await evolutionAdapter.sendReaction!(CTX, {
      to: '5511999999999',
      targetProviderMessageId: 'msg-1',
      emoji: '👍',
    });

    expect(afterCallbacks).toHaveLength(3);
    for (const cb of afterCallbacks) await cb();
    expect(ensureContactIdentity).toHaveBeenCalledTimes(3);
    expect(ensureContactIdentity).toHaveBeenCalledWith({
      accountId: 'acct-1',
      instanceToken: 'instance-token-1',
      phone: '5511999999999',
    });
  });
});

describe('mapeamento de erro real', () => {
  it('401/403 marca o canal como error com o detalhe', async () => {
    evolutionRequest.mockRejectedValue(
      new EvolutionApiError('channel_auth_failed', 401, 'not authorized')
    );

    await expect(
      evolutionAdapter.sendText(CTX, { to: '5511999999999', text: 'oi' })
    ).rejects.toThrow('not authorized');

    expect(channelsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        status_detail: 'not authorized',
      })
    );
  });

  it('erro que não é de autenticação NÃO mexe no status do canal', async () => {
    evolutionRequest.mockRejectedValue(
      new EvolutionApiError('bad_request', 400, 'bad payload')
    );

    await expect(
      evolutionAdapter.sendText(CTX, { to: '5511999999999', text: 'oi' })
    ).rejects.toThrow('bad payload');

    expect(channelsUpdate).not.toHaveBeenCalled();
  });
});

describe('capacidades e normalizeInbound', () => {
  it('carrega exatamente a matriz de capacidades do canal QR', () => {
    expect(evolutionAdapter.type).toBe('whatsapp_qr');
    expect(evolutionAdapter.capabilities.interactiveButtons).toBe(false);
    expect(evolutionAdapter.capabilities.poll).toBe(true);
  });

  it('normalizeInbound lança — a tradução mora na rota do webhook', () => {
    expect(() => evolutionAdapter.normalizeInbound({})).toThrow(/webhook/);
  });
});
