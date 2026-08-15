import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { loadColdSendUsage } from './cold-send-usage';

/**
 * Supabase de mentira que devolve um resultado por chamada a `.from()`,
 * na ORDEM em que `loadColdSendUsage` as constrói (last24h, lastHour,
 * lastColdSendAt, instanceCreatedAt) — a mesma ordem do array passado a
 * `Promise.all`, que é síncrona antes do `await`.
 */
function makeDb(results: Array<{ count?: number; data?: unknown }>) {
  let i = 0;
  const tables: string[] = [];

  function chain() {
    // Capturado NA CONSTRUÇÃO (ordem em que `loadColdSendUsage` chama
    // `db.from()`), não na resolução — `Promise.all` não garante que os
    // `.then()` disparem na ordem do array.
    const r = results[i++] ?? {};
    const settled = { data: r.data ?? null, count: r.count, error: null };
    const c = {
      select: () => c,
      eq: () => c,
      gte: () => c,
      order: () => c,
      limit: () => c,
      maybeSingle: () => Promise.resolve(settled),
      then: (
        resolve: (v: unknown) => unknown,
        reject?: (e: unknown) => unknown
      ) => Promise.resolve(settled).then(resolve, reject),
    };
    return c;
  }

  return {
    client: {
      from: (table: string) => {
        tables.push(table);
        return chain();
      },
    } as unknown as SupabaseClient,
    tables,
  };
}

describe('loadColdSendUsage', () => {
  it('reúne as três contagens e a data de criação do canal', async () => {
    const now = new Date('2026-08-14T12:00:00Z');
    const { client } = makeDb([
      { count: 7 }, // last24h
      { count: 2 }, // lastHour
      { data: { sent_at: '2026-08-14T11:50:00Z' } }, // lastColdSendAt
      { data: { created_at: '2026-01-01T00:00:00Z' } }, // channels.created_at
    ]);

    const usage = await loadColdSendUsage(client, 'chan-1', now);

    expect(usage).toEqual({
      last24h: 7,
      lastHour: 2,
      lastColdSendAt: new Date('2026-08-14T11:50:00Z'),
      instanceCreatedAt: new Date('2026-01-01T00:00:00Z'),
    });
  });

  it('nenhum envio frio ainda: contagens zero e lastColdSendAt nulo', async () => {
    const now = new Date('2026-08-14T12:00:00Z');
    const { client } = makeDb([
      { count: 0 },
      { count: 0 },
      { data: null },
      { data: { created_at: '2026-08-01T00:00:00Z' } },
    ]);

    const usage = await loadColdSendUsage(client, 'chan-1', now);

    expect(usage.last24h).toBe(0);
    expect(usage.lastHour).toBe(0);
    expect(usage.lastColdSendAt).toBeNull();
  });

  it('canal apagado fora do fluxo normal: cai no piso conservador (now)', async () => {
    const now = new Date('2026-08-14T12:00:00Z');
    const { client } = makeDb([
      { count: 0 },
      { count: 0 },
      { data: null },
      { data: null }, // channels.select não encontrou a linha
    ]);

    const usage = await loadColdSendUsage(client, 'chan-1', now);

    expect(usage.instanceCreatedAt).toEqual(now);
  });

  it('count nulo (falha silenciosa do provedor) vira zero, não NaN', async () => {
    const now = new Date('2026-08-14T12:00:00Z');
    const { client } = makeDb([
      {},
      {},
      { data: null },
      { data: { created_at: '2026-08-01T00:00:00Z' } },
    ]);

    const usage = await loadColdSendUsage(client, 'chan-1', now);

    expect(usage.last24h).toBe(0);
    expect(usage.lastHour).toBe(0);
  });
});
