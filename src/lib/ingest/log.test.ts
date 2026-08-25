import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { logIngestEvent } from './log';

const BASE_PARAMS = {
  accountId: 'acc-1',
  apiKeyId: 'key-1',
  webhookId: '1234567890123456',
  webhookName: 'Landing page',
  level: 'error' as const,
  code: 'invalid_phone',
  message: 'Phone number failed Brazilian validation: invalid_ddd',
};

describe('logIngestEvent', () => {
  it('never rejects when the DB insert returns an error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = {
      from: () => ({
        insert: () => Promise.resolve({ error: { message: 'boom' } }),
      }),
    } as unknown as SupabaseClient;

    await expect(logIngestEvent(db, BASE_PARAMS)).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('never rejects when the DB client throws synchronously', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = {
      from: () => {
        throw new Error('client is down');
      },
    } as unknown as SupabaseClient;

    await expect(logIngestEvent(db, BASE_PARAMS)).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('never rejects when the insert promise itself rejects', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = {
      from: () => ({
        insert: () => Promise.reject(new Error('network error')),
      }),
    } as unknown as SupabaseClient;

    await expect(logIngestEvent(db, BASE_PARAMS)).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('writes the payload untouched when under 8 KB', async () => {
    let insertedRow: Record<string, unknown> | null = null;
    const db = {
      from: () => ({
        insert: (row: Record<string, unknown>) => {
          insertedRow = row;
          return Promise.resolve({ error: null });
        },
      }),
    } as unknown as SupabaseClient;

    const payload = { phone: '5519992496598', name: 'Maria' };
    await logIngestEvent(db, { ...BASE_PARAMS, payload });

    expect(insertedRow).not.toBeNull();
    expect((insertedRow as unknown as { payload: unknown }).payload).toEqual(
      payload
    );
  });

  it('replaces a payload over 8 KB with a truncation marker', async () => {
    let insertedRow: Record<string, unknown> | null = null;
    const db = {
      from: () => ({
        insert: (row: Record<string, unknown>) => {
          insertedRow = row;
          return Promise.resolve({ error: null });
        },
      }),
    } as unknown as SupabaseClient;

    const bigPayload = { blob: 'x'.repeat(9000) };
    await logIngestEvent(db, { ...BASE_PARAMS, payload: bigPayload });

    const written = (insertedRow as unknown as { payload: unknown })
      .payload as { _truncated: boolean; _size: number };
    expect(written._truncated).toBe(true);
    expect(written._size).toBeGreaterThan(8 * 1024);
  });

  it('defaults omitted optional fields to null', async () => {
    let insertedRow: Record<string, unknown> | null = null;
    const db = {
      from: () => ({
        insert: (row: Record<string, unknown>) => {
          insertedRow = row;
          return Promise.resolve({ error: null });
        },
      }),
    } as unknown as SupabaseClient;

    await logIngestEvent(db, {
      accountId: 'acc-1',
      apiKeyId: 'key-1',
      level: 'error',
      code: 'invalid_webhook_id',
      message: "'webhook_id' must be a numeric string with at least 16 digits",
    });

    expect(insertedRow).toMatchObject({
      webhook_id: null,
      webhook_name: null,
      phone: null,
      contact_id: null,
      broadcast_id: null,
      payload: null,
    });
  });
});
