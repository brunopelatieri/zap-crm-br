import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { upsertFunnel, addFunnelRecipient, IngestFunnelError } from './funnel';

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

/**
 * Simula o comportamento da RPC `upsert_webhook_funnel`: o MESMO
 * webhook_id sempre devolve o MESMO broadcastId (o índice único
 * parcial + ON CONFLICT da migração 065 garantem isso no banco de
 * verdade) — é o que prova, neste nível de teste, que dois POSTs
 * com o mesmo webhook_id não criam duas linhas em `broadcasts`.
 */
function fakeDb(
  opts: {
    broadcastIdByWebhookId?: Map<string, string>;
    rpcError?: { message: string };
    insertError?: { message: string } | null;
    insertData?: { id: string } | null;
    bumpError?: { message: string } | null;
  } = {}
): { db: SupabaseClient; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  const byWebhook = opts.broadcastIdByWebhookId ?? new Map<string, string>();
  let nextId = 1;

  const client = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === 'upsert_webhook_funnel') {
        if (opts.rpcError) {
          return Promise.resolve({ data: null, error: opts.rpcError });
        }
        const webhookId = args.p_webhook_id as string;
        let id = byWebhook.get(webhookId);
        if (!id) {
          id = `broadcast-${nextId++}`;
          byWebhook.set(webhookId, id);
        }
        return Promise.resolve({ data: id, error: null });
      }
      if (fn === 'increment_broadcast_total_recipients') {
        return Promise.resolve({ data: null, error: opts.bumpError ?? null });
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
    from: (table: string) => {
      if (table !== 'broadcast_recipients') {
        throw new Error(`unexpected table ${table}`);
      }
      return {
        insert: () => ({
          select: () => ({
            single: () =>
              Promise.resolve({
                data:
                  opts.insertData !== undefined
                    ? opts.insertData
                    : { id: 'rec-1' },
                error: opts.insertError ?? null,
              }),
          }),
        }),
      };
    },
  };

  return { db: client as unknown as SupabaseClient, calls };
}

describe('upsertFunnel', () => {
  it('passes the params through to the RPC and returns the broadcastId', async () => {
    const { db, calls } = fakeDb();

    const result = await upsertFunnel(db, {
      accountId: 'acc-1',
      userId: 'user-1',
      webhookId: '1234567890123456',
      webhookName: 'Landing page',
    });

    expect(result.broadcastId).toBeTruthy();
    expect(calls).toEqual([
      {
        fn: 'upsert_webhook_funnel',
        args: {
          p_account_id: 'acc-1',
          p_user_id: 'user-1',
          p_webhook_id: '1234567890123456',
          p_webhook_name: 'Landing page',
        },
      },
    ]);
  });

  it('the same webhook_id resolves to the same broadcastId across calls (accumulative funnel, D-5)', async () => {
    const { db } = fakeDb();

    const first = await upsertFunnel(db, {
      accountId: 'acc-1',
      userId: 'user-1',
      webhookId: 'wh-1',
      webhookName: 'Landing page',
    });
    const second = await upsertFunnel(db, {
      accountId: 'acc-1',
      userId: 'user-1',
      webhookId: 'wh-1',
      webhookName: 'Landing page (renamed)',
    });

    expect(second.broadcastId).toBe(first.broadcastId);
  });

  it('a different webhook_id resolves to a different broadcastId', async () => {
    const { db } = fakeDb();

    const first = await upsertFunnel(db, {
      accountId: 'acc-1',
      userId: 'user-1',
      webhookId: 'wh-1',
      webhookName: 'A',
    });
    const second = await upsertFunnel(db, {
      accountId: 'acc-1',
      userId: 'user-1',
      webhookId: 'wh-2',
      webhookName: 'B',
    });

    expect(second.broadcastId).not.toBe(first.broadcastId);
  });

  it('throws IngestFunnelError when the RPC errors', async () => {
    const { db } = fakeDb({ rpcError: { message: 'boom' } });

    await expect(
      upsertFunnel(db, {
        accountId: 'acc-1',
        userId: 'user-1',
        webhookId: 'wh-1',
        webhookName: 'A',
      })
    ).rejects.toBeInstanceOf(IngestFunnelError);
  });
});

describe('addFunnelRecipient', () => {
  it('inserts a pending recipient row and bumps total_recipients', async () => {
    const { db, calls } = fakeDb();

    const result = await addFunnelRecipient(db, {
      broadcastId: 'broadcast-1',
      contactId: 'contact-1',
    });

    expect(result).toEqual({ recipientRowId: 'rec-1' });
    expect(calls).toEqual([
      {
        fn: 'increment_broadcast_total_recipients',
        args: { p_broadcast_id: 'broadcast-1' },
      },
    ]);
  });

  it('throws IngestFunnelError when the recipient insert fails', async () => {
    const { db } = fakeDb({ insertError: { message: 'boom' } });

    await expect(
      addFunnelRecipient(db, {
        broadcastId: 'broadcast-1',
        contactId: 'contact-1',
      })
    ).rejects.toBeInstanceOf(IngestFunnelError);
  });

  it('throws IngestFunnelError when the total_recipients bump fails', async () => {
    const { db } = fakeDb({ bumpError: { message: 'boom' } });

    await expect(
      addFunnelRecipient(db, {
        broadcastId: 'broadcast-1',
        contactId: 'contact-1',
      })
    ).rejects.toBeInstanceOf(IngestFunnelError);
  });
});
