import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EvolutionApiError,
  evolutionRequest,
  isAlreadyLoggedInError,
  unwrap,
} from './client';
import type { EvolutionConfig } from './config';

const config: EvolutionConfig = {
  apiUrl: 'https://evo.example.com',
  globalApiKey: 'global-key',
  maxInstancesPerAccount: 3,
  maxInstancesTotal: 20,
  instancePrefix: 'zapcrm',
  webhookPublicUrl: null,
  requestTimeoutMs: 15_000,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain' },
  });
}

describe('evolutionRequest', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sucesso: devolve o corpo já parseado (envelope {data,message})', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { data: { Connected: true }, message: 'success' })
    );
    const result = await evolutionRequest(config, '/instance/status', {
      key: 'token-abc',
    });
    expect(result).toEqual({ data: { Connected: true }, message: 'success' });
  });

  it('manda o header apikey e a URL correta', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: {} }));
    await evolutionRequest(config, '/instance/qr', { key: 'token-abc' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://evo.example.com/instance/qr');
    expect((init.headers as Record<string, string>).apikey).toBe('token-abc');
  });

  it('401 com erro em string plana ({"error":"not authorized"}) mapeia para channel_auth_failed', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { error: 'not authorized' })
    );
    await expect(
      evolutionRequest(config, '/instance/status', { key: 'bad-token' })
    ).rejects.toMatchObject({
      name: 'EvolutionApiError',
      kind: 'channel_auth_failed',
      status: 401,
      message: 'not authorized',
    });
  });

  it('404 em text/plain cru mapeia para not_found com o texto como mensagem', async () => {
    fetchMock.mockResolvedValueOnce(textResponse(404, '404 page not found'));
    await expect(
      evolutionRequest(config, '/instance/does-not-exist', {
        key: 'token-abc',
      })
    ).rejects.toMatchObject({
      kind: 'not_found',
      status: 404,
      message: '404 page not found',
    });
  });

  it('400 mapeia para bad_request', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { error: 'token is required' })
    );
    await expect(
      evolutionRequest(config, '/instance/create', {
        method: 'POST',
        key: config.globalApiKey,
        body: { name: 'x' },
      })
    ).rejects.toMatchObject({ kind: 'bad_request', status: 400 });
  });

  it('5xx mapeia para channel_unavailable', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(500, { error: 'internal error' })
    );
    await expect(
      evolutionRequest(config, '/instance/status', { key: 'token-abc' })
    ).rejects.toMatchObject({ kind: 'channel_unavailable', status: 500 });
  });

  it('falha de rede (fetch rejeita) mapeia para channel_unavailable com status 0', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(
      evolutionRequest(config, '/instance/status', { key: 'token-abc' })
    ).rejects.toMatchObject({ kind: 'channel_unavailable', status: 0 });
  });

  it('lê o envelope alternativo {error:{message}} da referência (defensivo)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, {
        error: { code: 'BAD_REQUEST', message: 'nested message' },
      })
    );
    await expect(
      evolutionRequest(config, '/instance/create', {
        method: 'POST',
        key: config.globalApiKey,
      })
    ).rejects.toMatchObject({ message: 'nested message' });
  });
});

describe('unwrap', () => {
  it('devolve body.data quando presente', () => {
    expect(unwrap({ data: { a: 1 }, message: 'success' })).toEqual({ a: 1 });
  });

  it('devolve o objeto cru quando não há campo data (advanced-settings)', () => {
    expect(unwrap({ alwaysOnline: false })).toEqual({ alwaysOnline: false });
  });

  it('devolve {} para valores não-objeto (ex.: array cru dos logs)', () => {
    expect(unwrap([{ level: 'INFO' }])).toEqual({});
    expect(unwrap(null)).toEqual({});
    expect(unwrap('raw string')).toEqual({});
  });
});

describe('isAlreadyLoggedInError', () => {
  it('true para 400 "session already logged in"', () => {
    const err = new EvolutionApiError(
      'bad_request',
      400,
      'session already logged in'
    );
    expect(isAlreadyLoggedInError(err)).toBe(true);
  });

  it('false para outros erros 400', () => {
    const err = new EvolutionApiError('bad_request', 400, 'token is required');
    expect(isAlreadyLoggedInError(err)).toBe(false);
  });

  it('false para erros que não são EvolutionApiError', () => {
    expect(isAlreadyLoggedInError(new Error('session already logged in'))).toBe(
      false
    );
  });
});
