import { describe, expect, it } from 'vitest';

import {
  loadAccountEngagementStats,
  loadAudienceEngagementSummary,
  loadEngagementSeries,
} from './engagement';
import { createSupabaseMock } from './supabase-mock';

describe('loadAccountEngagementStats', () => {
  it('passa accountId e since, e devolve a única linha da RPC', async () => {
    let captured: Record<string, unknown> | undefined;
    const mock = createSupabaseMock(
      () => undefined,
      (fn, args) => {
        if (fn !== 'broadcast_account_stats') return { data: null };
        captured = args;
        return {
          data: [
            {
              campaigns_total: 3,
              campaigns_sent: 3,
              messages_sent: 10,
              messages_delivered: 8,
              messages_read: 4,
              messages_replied: 1,
              messages_failed: 2,
              contacts_reached: 7,
            },
          ],
        };
      }
    );

    const result = await loadAccountEngagementStats(
      mock.db,
      'acct-1',
      '2026-07-01T00:00:00.000Z'
    );

    expect(captured).toEqual({
      p_account_id: 'acct-1',
      p_since: '2026-07-01T00:00:00.000Z',
    });
    expect(result.messages_delivered).toBe(8);
    expect(result.contacts_reached).toBe(7);
  });

  it('sinceIso omitido vira p_since null', async () => {
    let captured: Record<string, unknown> | undefined;
    const mock = createSupabaseMock(
      () => undefined,
      (fn, args) => {
        captured = args;
        return { data: [] };
      }
    );

    await loadAccountEngagementStats(mock.db, 'acct-1');
    expect(captured?.p_since).toBeNull();
  });

  it('devolve zeros quando a RPC não traz linha nenhuma', async () => {
    const mock = createSupabaseMock(
      () => undefined,
      () => ({ data: [] })
    );

    const result = await loadAccountEngagementStats(mock.db, 'acct-1');
    expect(result.campaigns_total).toBe(0);
    expect(result.messages_sent).toBe(0);
  });

  it('propaga o erro da RPC', async () => {
    const mock = createSupabaseMock(
      () => undefined,
      () => ({ error: new Error('boom') })
    );

    await expect(loadAccountEngagementStats(mock.db, 'acct-1')).rejects.toThrow(
      'boom'
    );
  });
});

describe('loadEngagementSeries', () => {
  it('passa dias e fuso, e devolve as linhas cruas', async () => {
    let captured: Record<string, unknown> | undefined;
    const mock = createSupabaseMock(
      () => undefined,
      (fn, args) => {
        captured = args;
        return {
          data: [
            {
              day: '2026-08-06',
              campaigns: 1,
              messages_sent: 2,
              messages_delivered: 2,
              messages_read: 1,
              messages_replied: 0,
              messages_failed: 0,
              contacts_reached: 2,
            },
          ],
        };
      }
    );

    const result = await loadEngagementSeries(
      mock.db,
      'acct-1',
      30,
      'America/Sao_Paulo'
    );

    expect(captured).toEqual({
      p_account_id: 'acct-1',
      p_days: 30,
      p_time_zone: 'America/Sao_Paulo',
    });
    expect(result).toHaveLength(1);
    expect(result[0].day).toBe('2026-08-06');
  });

  it('devolve array vazio quando a RPC não traz linha nenhuma', async () => {
    const mock = createSupabaseMock(
      () => undefined,
      () => ({ data: null })
    );

    const result = await loadEngagementSeries(mock.db, 'acct-1', 30, 'UTC');
    expect(result).toEqual([]);
  });
});

describe('loadAudienceEngagementSummary', () => {
  it('recorta espaços da busca e vira null quando vazia', async () => {
    let captured: Record<string, unknown> | undefined;
    const mock = createSupabaseMock(
      () => undefined,
      (fn, args) => {
        captured = args;
        return { data: [] };
      }
    );

    await loadAudienceEngagementSummary(mock.db, 'draft-1', '   ', 'all');
    expect(captured).toEqual({
      p_draft_id: 'draft-1',
      p_search: null,
      p_filter: 'all',
    });
  });

  it('devolve zeros quando a RPC não traz linha nenhuma', async () => {
    const mock = createSupabaseMock(
      () => undefined,
      () => ({ data: [] })
    );

    const result = await loadAudienceEngagementSummary(
      mock.db,
      'draft-1',
      '',
      'all'
    );
    expect(result.total_rows).toBe(0);
    expect(result.ever_contacted).toBe(0);
  });
});
