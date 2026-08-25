import { describe, expect, it, vi, beforeEach } from 'vitest';

const evolutionRequest = vi.fn();
vi.mock('./client', () => ({
  evolutionRequest: (...args: unknown[]) => evolutionRequest(...args),
}));

let config: unknown = {
  apiUrl: 'https://evo.example.com',
  globalApiKey: 'global-key',
  maxInstancesPerAccount: 3,
  maxInstancesTotal: 20,
  instancePrefix: 'zapcrm',
  webhookPublicUrl: null,
  requestTimeoutMs: 15_000,
  mediaRequestTimeoutMs: 60_000,
};
vi.mock('./config', () => ({
  readEvolutionConfig: () => config,
}));

/**
 * Supabase de mentira, keyed por `${table}.${verb}` (mesmo espírito dos
 * outros testes de Evolution). `ops` registra toda chamada — usado pra
 * provar que `/user/check` e o upsert NÃO acontecem nos caminhos de
 * saída antecipada.
 */
type FakeResult = { data?: unknown; error?: unknown };

function makeDb(results: Record<string, FakeResult> = {}) {
  const ops: Array<{
    table: string;
    verb: string;
    payload?: unknown;
    filters: Array<[string, unknown]>;
  }> = [];

  function builder(table: string) {
    let verb = 'select';
    let payload: unknown;
    const filters: Array<[string, unknown]> = [];
    const settle = () => {
      ops.push({ table, verb, payload, filters: filters.slice() });
      return results[`${table}.${verb}`] ?? { data: null, error: null };
    };
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (key: string, value: unknown) => {
        filters.push([key, value]);
        return chain;
      },
      upsert: (p: unknown) => {
        verb = 'upsert';
        payload = p;
        return chain;
      },
      maybeSingle: () => Promise.resolve(settle()),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(settle()).then(resolve),
    };
    return chain;
  }

  return { client: { from: (t: string) => builder(t) }, ops };
}

const dbState: { client: unknown } = { client: undefined };
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => dbState.client,
}));

import { ensureContactIdentity } from './contact-identity';

beforeEach(() => {
  evolutionRequest.mockReset();
  config = {
    apiUrl: 'https://evo.example.com',
    globalApiKey: 'global-key',
    maxInstancesPerAccount: 3,
    maxInstancesTotal: 20,
    instancePrefix: 'zapcrm',
    webhookPublicUrl: null,
    requestTimeoutMs: 15_000,
    mediaRequestTimeoutMs: 60_000,
  };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('ensureContactIdentity', () => {
  it('sem contato com esse telefone, não bate /user/check nem grava nada', async () => {
    const { client, ops } = makeDb({
      'contacts.select': { data: null, error: null },
    });
    dbState.client = client;

    await ensureContactIdentity({
      accountId: 'acct-1',
      instanceToken: 'token-1',
      phone: '5511999999999',
    });

    expect(evolutionRequest).not.toHaveBeenCalled();
    expect(ops.some((o) => o.table === 'contact_identities')).toBe(false);
  });

  it('busca o contato por phone_normalized, não pela coluna phone crua', async () => {
    // Nem todo caminho de criação de contato sanitiza dígitos antes de
    // gravar (a importação por CSV grava a célula da planilha como
    // veio). `phone_normalized` (migração 022, dígitos-only sempre) é o
    // que casa independente de como o contato nasceu.
    const { client, ops } = makeDb({
      'contacts.select': { data: null, error: null },
    });
    dbState.client = client;

    await ensureContactIdentity({
      accountId: 'acct-1',
      instanceToken: 'token-1',
      phone: '5511999999999',
    });

    const lookup = ops.find((o) => o.table === 'contacts')!;
    expect(lookup.filters).toContainEqual([
      'phone_normalized',
      '5511999999999',
    ]);
    expect(lookup.filters.some(([key]) => key === 'phone')).toBe(false);
  });

  it('já tem vínculo — não bate /user/check de novo (LID não muda depois de atribuído)', async () => {
    const { client } = makeDb({
      'contacts.select': { data: { id: 'contact-1' }, error: null },
      'contact_identities.select': { data: { id: 'link-1' }, error: null },
    });
    dbState.client = client;

    await ensureContactIdentity({
      accountId: 'acct-1',
      instanceToken: 'token-1',
      phone: '5511999999999',
    });

    expect(evolutionRequest).not.toHaveBeenCalled();
  });

  it('sem EVOLUTION_API_URL/KEY configurados, nem consulta o banco', async () => {
    // A checagem de config é síncrona e de graça — tem que vir ANTES
    // dos dois round-trips ao Supabase, não depois.
    config = null;
    const { client, ops } = makeDb({
      'contacts.select': { data: { id: 'contact-1' }, error: null },
      'contact_identities.select': { data: null, error: null },
    });
    dbState.client = client;

    await ensureContactIdentity({
      accountId: 'acct-1',
      instanceToken: 'token-1',
      phone: '5511999999999',
    });

    expect(evolutionRequest).not.toHaveBeenCalled();
    expect(ops).toHaveLength(0);
  });

  it('aprende o LID via /user/check (array) e grava o upsert', async () => {
    const { client, ops } = makeDb({
      'contacts.select': { data: { id: 'contact-1' }, error: null },
      'contact_identities.select': { data: null, error: null },
    });
    dbState.client = client;
    evolutionRequest.mockResolvedValue([
      { Query: '5511999999999', LID: '225941787816134@lid' },
    ]);

    await ensureContactIdentity({
      accountId: 'acct-1',
      instanceToken: 'token-1',
      phone: '5511999999999',
    });

    expect(evolutionRequest).toHaveBeenCalledWith(
      config,
      '/user/check',
      expect.objectContaining({
        method: 'POST',
        key: 'token-1',
        body: { number: ['5511999999999'] },
      })
    );
    const upsert = ops.find(
      (o) => o.table === 'contact_identities' && o.verb === 'upsert'
    );
    expect(upsert?.payload).toEqual({
      account_id: 'acct-1',
      contact_id: 'contact-1',
      channel_type: 'whatsapp_qr',
      external_id: '225941787816134@lid',
    });
  });

  it('resposta de /user/check sem LID reconhecível — não grava nada', async () => {
    const { client, ops } = makeDb({
      'contacts.select': { data: { id: 'contact-1' }, error: null },
      'contact_identities.select': { data: null, error: null },
    });
    dbState.client = client;
    evolutionRequest.mockResolvedValue([{ Query: '5511999999999' }]);

    await ensureContactIdentity({
      accountId: 'acct-1',
      instanceToken: 'token-1',
      phone: '5511999999999',
    });

    expect(ops.some((o) => o.verb === 'upsert')).toBe(false);
  });

  it('/user/check lançando (Evolution fora do ar) não propaga', async () => {
    const { client } = makeDb({
      'contacts.select': { data: { id: 'contact-1' }, error: null },
      'contact_identities.select': { data: null, error: null },
    });
    dbState.client = client;
    evolutionRequest.mockRejectedValue(new Error('timeout'));

    await expect(
      ensureContactIdentity({
        accountId: 'acct-1',
        instanceToken: 'token-1',
        phone: '5511999999999',
      })
    ).resolves.toBeUndefined();
  });

  it('erro no upsert é logado, não lança', async () => {
    const { client } = makeDb({
      'contacts.select': { data: { id: 'contact-1' }, error: null },
      'contact_identities.select': { data: null, error: null },
      'contact_identities.upsert': { error: { message: 'boom' } },
    });
    dbState.client = client;
    evolutionRequest.mockResolvedValue([{ LID: '225941787816134@lid' }]);

    await expect(
      ensureContactIdentity({
        accountId: 'acct-1',
        instanceToken: 'token-1',
        phone: '5511999999999',
      })
    ).resolves.toBeUndefined();
  });
});
