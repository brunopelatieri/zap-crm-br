import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { insertContactNotes, IngestNotesError } from './notes';

/** Mutable box so the test can read what was inserted after the await. */
function fakeDb(opts: { error?: { message: string } } = {}): {
  db: SupabaseClient;
  box: { inserted: unknown[] };
} {
  const box = { inserted: [] as unknown[] };
  const client = {
    from: (table: string) => {
      if (table !== 'contact_notes')
        throw new Error(`unexpected table ${table}`);
      return {
        insert: (rows: unknown[]) => {
          box.inserted = rows;
          return Promise.resolve({ error: opts.error ?? null });
        },
      };
    },
  };
  return { db: client as unknown as SupabaseClient, box };
}

describe('insertContactNotes', () => {
  it('is a no-op when notes is empty (no DB call)', async () => {
    let called = false;
    const db = {
      from: () => {
        called = true;
        throw new Error('should not be called');
      },
    } as unknown as SupabaseClient;

    const result = await insertContactNotes(db, {
      accountId: 'acc',
      userId: 'user',
      contactId: 'contact',
      notes: [],
    });

    expect(result).toEqual({ inserted: 0 });
    expect(called).toBe(false);
  });

  it('inserts one row per note, carrying account_id/user_id/contact_id', async () => {
    const { db, box } = fakeDb();

    const result = await insertContactNotes(db, {
      accountId: 'acc-1',
      userId: 'user-1',
      contactId: 'contact-1',
      notes: ['primeira nota', 'segunda nota'],
    });

    expect(result).toEqual({ inserted: 2 });
    expect(box.inserted).toEqual([
      {
        contact_id: 'contact-1',
        account_id: 'acc-1',
        user_id: 'user-1',
        note_text: 'primeira nota',
      },
      {
        contact_id: 'contact-1',
        account_id: 'acc-1',
        user_id: 'user-1',
        note_text: 'segunda nota',
      },
    ]);
  });

  it('throws IngestNotesError on a DB error', async () => {
    const { db } = fakeDb({ error: { message: 'boom' } });

    await expect(
      insertContactNotes(db, {
        accountId: 'acc',
        userId: 'user',
        contactId: 'contact',
        notes: ['x'],
      })
    ).rejects.toBeInstanceOf(IngestNotesError);
  });
});
