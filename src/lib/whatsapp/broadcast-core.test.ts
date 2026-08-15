import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createBroadcast,
  assertAccountCanBroadcast,
  BroadcastError,
} from './broadcast-core';

// These assertions all fire in the pure validation prologue, before
// any Supabase call — a bare stub is enough.
const db = {} as SupabaseClient;

describe('createBroadcast validation', () => {
  it('rejects a missing template_name', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: '',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('rejects an empty recipient list', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [],
      })
    ).rejects.toBeInstanceOf(BroadcastError);
  });

  it('rejects more than 1000 recipients', async () => {
    const recipients = Array.from({ length: 1001 }, () => ({
      to: '+14155550123',
    }));
    await expect(
      createBroadcast(db, 'acc', 'user', { templateName: 'promo', recipients })
    ).rejects.toMatchObject({ status: 400 });
  });
});

// SPEC 049 §5.3 — an account whose only channel is a QR code instance
// can never broadcast (`capabilities.broadcast` is false for
// `whatsapp_qr`, on purpose — bulk sends from an unofficial number are
// the fastest path to a ban). The guard has to fire BEFORE the fan-out,
// with a reason that isn't the generic "not configured".
describe('assertAccountCanBroadcast (SPEC 049 §5.3)', () => {
  function fakeDb(channelRows: { type: string }[]): {
    db: SupabaseClient;
    calls: string[];
  } {
    const calls: string[] = [];
    const client = {
      from: (table: string) => {
        calls.push(table);
        if (table === 'channels') {
          return {
            select: () => ({
              eq: () => Promise.resolve({ data: channelRows }),
            }),
          };
        }
        // whatsapp_config (or anything else): no row, so a caller that
        // gets PAST the guard falls through to the ordinary
        // "not configured" path — proving the guard didn't block it.
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({ data: null, error: { message: 'none' } }),
              maybeSingle: () => Promise.resolve({ data: null, error: null }),
            }),
          }),
        };
      },
    };
    return { db: client as unknown as SupabaseClient, calls };
  }

  it('QR-only account: rejects with channel_not_capable, never touches whatsapp_config', async () => {
    const { db: qrOnlyDb, calls } = fakeDb([{ type: 'whatsapp_qr' }]);

    await expect(
      assertAccountCanBroadcast(qrOnlyDb, 'acc')
    ).rejects.toMatchObject({
      code: 'channel_not_capable',
      status: 400,
    });
    expect(calls).toEqual(['channels']);
  });

  it('createBroadcast on a QR-only account fails with channel_not_capable before the fan-out', async () => {
    const { db: qrOnlyDb } = fakeDb([{ type: 'whatsapp_qr' }]);

    await expect(
      createBroadcast(qrOnlyDb, 'acc', 'user', {
        templateName: 'promo',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toMatchObject({ code: 'channel_not_capable', status: 400 });
  });

  it('Cloud-having account: passes the guard (falls through to the ordinary config check)', async () => {
    const { db: cloudDb } = fakeDb([{ type: 'whatsapp_cloud' }]);
    await expect(
      assertAccountCanBroadcast(cloudDb, 'acc')
    ).resolves.toBeUndefined();
  });

  it('account with both channel types: passes the guard', async () => {
    const { db: mixedDb } = fakeDb([
      { type: 'whatsapp_cloud' },
      { type: 'whatsapp_qr' },
    ]);
    await expect(
      assertAccountCanBroadcast(mixedDb, 'acc')
    ).resolves.toBeUndefined();
  });

  it('account with no channel rows: passes the guard (assumes Cloud, matches pre-channel-layer behaviour)', async () => {
    const { db: emptyDb } = fakeDb([]);
    await expect(
      assertAccountCanBroadcast(emptyDb, 'acc')
    ).resolves.toBeUndefined();
  });
});
