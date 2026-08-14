import { describe, expect, it } from 'vitest';

import {
  createSupabaseMock,
  opArgs,
  type MockResult,
  type QueryOp,
} from '@/lib/audience/supabase-mock';

import {
  detectDeadNumberOnFailure,
  isWhatsappInvalid,
  markWhatsappInvalid,
  markWhatsappValid,
} from './whatsapp-status';

describe('isWhatsappInvalid', () => {
  it('true só quando whatsapp_status é invalid', () => {
    expect(isWhatsappInvalid({ whatsapp_status: 'invalid' })).toBe(true);
    expect(isWhatsappInvalid({ whatsapp_status: 'valid' })).toBe(false);
    expect(isWhatsappInvalid({})).toBe(false);
  });
});

describe('markWhatsappInvalid', () => {
  it('grava status, motivo e timestamp, e só casa quem ainda está valid', async () => {
    const updates: Record<string, unknown>[] = [];
    const filters: unknown[][] = [];
    const mock = createSupabaseMock((table, ops) => {
      if (table !== 'contacts') return undefined;
      const upd = opArgs(ops, 'update');
      if (upd) updates.push(upd[0] as Record<string, unknown>);
      filters.push(ops.filter((o) => o.fn === 'eq').map((o) => o.args));
      return { data: null };
    });

    await markWhatsappInvalid(mock.db, 'c1', 'meta_error');

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      whatsapp_status: 'invalid',
      whatsapp_status_reason: 'meta_error',
    });
    expect(updates[0].whatsapp_status_updated_at).toEqual(expect.any(String));
    expect(filters[0]).toEqual([
      ['id', 'c1'],
      ['whatsapp_status', 'valid'],
    ]);
  });

  it('não lança quando o UPDATE falha — best-effort', async () => {
    const mock = createSupabaseMock(() => ({
      data: null,
      error: { message: 'boom' },
    }));
    await expect(
      markWhatsappInvalid(mock.db, 'c1', 'consecutive_failures')
    ).resolves.toBeUndefined();
  });
});

describe('markWhatsappValid', () => {
  it('grava valid + motivo manual', async () => {
    const updates: Record<string, unknown>[] = [];
    const mock = createSupabaseMock((table, ops) => {
      if (table !== 'contacts') return undefined;
      const upd = opArgs(ops, 'update');
      if (upd) updates.push(upd[0] as Record<string, unknown>);
      return { data: null };
    });

    await markWhatsappValid(mock.db, 'c1');

    expect(updates[0]).toMatchObject({
      whatsapp_status: 'valid',
      whatsapp_status_reason: 'manual',
    });
  });

  it('lança quando o UPDATE falha — ação manual, o chamador mostra o toast', async () => {
    const mock = createSupabaseMock(() => ({
      data: null,
      error: { message: 'boom' },
    }));
    await expect(markWhatsappValid(mock.db, 'c1')).rejects.toBeTruthy();
  });
});

describe('detectDeadNumberOnFailure', () => {
  function makeDb(
    recipientRows: { status: string }[],
    handler?: (table: string, ops: QueryOp[]) => MockResult | undefined
  ) {
    const updates: Record<string, unknown>[] = [];
    const mock = createSupabaseMock((table, ops) => {
      if (handler) {
        const custom = handler(table, ops);
        if (custom !== undefined) return custom;
      }
      if (table === 'contacts') {
        const upd = opArgs(ops, 'update');
        if (upd) updates.push(upd[0] as Record<string, unknown>);
        return { data: null };
      }
      if (table === 'broadcast_recipients') {
        return { data: recipientRows };
      }
      return undefined;
    });
    return { ...mock, updates };
  }

  it('um erro 131026 marca invalid na hora, sem consultar o histórico', async () => {
    const { db, updates, callsFor } = makeDb([]);

    await detectDeadNumberOnFailure(db, {
      contactId: 'c1',
      errorMessage:
        '(#131026) Message Undeliverable: recipient not on WhatsApp',
    });

    expect(updates).toHaveLength(1);
    expect(updates[0].whatsapp_status_reason).toBe('meta_error');
    expect(callsFor('broadcast_recipients')).toHaveLength(0);
  });

  it('duas falhas seguidas (as mais recentes) marcam invalid', async () => {
    const { db, updates } = makeDb([
      { status: 'failed' },
      { status: 'failed' },
    ]);

    await detectDeadNumberOnFailure(db, {
      contactId: 'c1',
      errorMessage: 'Some generic send error',
    });

    expect(updates).toHaveLength(1);
    expect(updates[0].whatsapp_status_reason).toBe('consecutive_failures');
  });

  it('uma falha isolada (só uma tentativa no histórico) não marca invalid', async () => {
    const { db, updates } = makeDb([{ status: 'failed' }]);

    await detectDeadNumberOnFailure(db, {
      contactId: 'c1',
      errorMessage: 'Some generic send error',
    });

    expect(updates).toHaveLength(0);
  });

  it('falha + sucesso mais recente não conta como consecutivo', async () => {
    const { db, updates } = makeDb([{ status: 'failed' }, { status: 'sent' }]);

    await detectDeadNumberOnFailure(db, {
      contactId: 'c1',
      errorMessage: 'Some generic send error',
    });

    expect(updates).toHaveLength(0);
  });

  it('pede as 2 mais recentes ordenadas por created_at desc', async () => {
    let sawOrder: unknown[] | undefined;
    const { db } = makeDb(
      [{ status: 'failed' }, { status: 'failed' }],
      (table, ops) => {
        if (table === 'broadcast_recipients') {
          sawOrder = opArgs(ops, 'order');
          expect(opArgs(ops, 'limit')).toEqual([2]);
          return { data: [{ status: 'failed' }, { status: 'failed' }] };
        }
        return undefined;
      }
    );

    await detectDeadNumberOnFailure(db, { contactId: 'c1', errorMessage: '' });

    expect(sawOrder?.[0]).toBe('created_at');
  });
});
