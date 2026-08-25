import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { applyCustomValues, IngestCustomValuesError } from './custom-values';

function fakeDb(opts: {
  fields: { id: string; field_name: string }[];
  upsertError?: { message: string } | null;
  fieldsError?: { message: string } | null;
}): { db: SupabaseClient; box: { upserted: unknown[] | null } } {
  const box: { upserted: unknown[] | null } = { upserted: null };
  const client = {
    from: (table: string) => {
      if (table === 'custom_fields') {
        return {
          select: () => ({
            eq: () =>
              Promise.resolve({
                data: opts.fields,
                error: opts.fieldsError ?? null,
              }),
          }),
        };
      }
      if (table === 'contact_custom_values') {
        return {
          upsert: (rows: unknown[]) => {
            box.upserted = rows;
            return Promise.resolve({ error: opts.upsertError ?? null });
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { db: client as unknown as SupabaseClient, box };
}

describe('applyCustomValues', () => {
  it('is a no-op when entries is empty (no DB call)', async () => {
    const db = {
      from: () => {
        throw new Error('should not be called');
      },
    } as unknown as SupabaseClient;

    const result = await applyCustomValues(db, {
      accountId: 'acc',
      contactId: 'contact',
      entries: [],
    });

    expect(result).toEqual({ outcomes: [], warnings: [] });
  });

  it('matches case-insensitively and upserts by contact_id/custom_field_id', async () => {
    const { db, box } = fakeDb({
      fields: [{ id: 'field-1', field_name: 'CPF' }],
    });

    const result = await applyCustomValues(db, {
      accountId: 'acc',
      contactId: 'contact-1',
      entries: [{ field: 'cpf', value: '123.456.789-00' }],
    });

    expect(result.outcomes).toEqual([{ field: 'cpf', status: 'matched' }]);
    expect(result.warnings).toEqual([]);
    expect(box.upserted).toEqual([
      {
        contact_id: 'contact-1',
        custom_field_id: 'field-1',
        value: '123.456.789-00',
      },
    ]);
  });

  it('skips a field with no matching definition and warns custom_field_not_found', async () => {
    const { db, box } = fakeDb({ fields: [] });

    const result = await applyCustomValues(db, {
      accountId: 'acc',
      contactId: 'contact-1',
      entries: [{ field: 'origem', value: 'landing_page_bf' }],
    });

    expect(result.outcomes).toEqual([{ field: 'origem', status: 'not_found' }]);
    expect(result.warnings).toEqual([
      {
        code: 'custom_field_not_found',
        message: "Custom field 'origem' does not exist in this account",
      },
    ]);
    // Nada casou — o upsert nem deveria rodar.
    expect(box.upserted).toBeNull();
  });

  it('skips an ambiguous match (two definitions differing only by case) and writes nothing for it', async () => {
    const { db, box } = fakeDb({
      fields: [
        { id: 'field-1', field_name: 'CPF' },
        { id: 'field-2', field_name: 'cpf' },
      ],
    });

    const result = await applyCustomValues(db, {
      accountId: 'acc',
      contactId: 'contact-1',
      entries: [{ field: 'CPF', value: '123' }],
    });

    expect(result.outcomes).toEqual([{ field: 'CPF', status: 'ambiguous' }]);
    expect(result.warnings).toEqual([
      {
        code: 'custom_field_ambiguous',
        message:
          "Custom field 'CPF' matches more than one definition in this account (differing only by case) — skipped",
      },
    ]);
    expect(box.upserted).toBeNull();
  });

  it('does not touch fields absent from the payload (never DELETE-then-INSERT)', async () => {
    // Achado C: contact-detail-view.tsx apaga TODOS os valores do
    // contato antes de reinserir. Este módulo nunca chama `.delete()`
    // em contact_custom_values — só upsert dos campos que vieram.
    const { db, box } = fakeDb({
      fields: [{ id: 'field-1', field_name: 'origem' }],
    });

    await applyCustomValues(db, {
      accountId: 'acc',
      contactId: 'contact-1',
      entries: [{ field: 'origem', value: 'lp' }],
    });

    expect(box.upserted).toEqual([
      { contact_id: 'contact-1', custom_field_id: 'field-1', value: 'lp' },
    ]);
    // A prova estrutural: o fakeDb só implementa select/upsert para
    // custom_fields/contact_custom_values — um .delete() chamado
    // lançaria "unexpected table" ou "not a function", o que já faria
    // este teste falhar antes desta asserção.
  });

  it('deduplicates repeated field names in the payload, last value wins', async () => {
    const { db, box } = fakeDb({
      fields: [{ id: 'field-1', field_name: 'origem' }],
    });

    await applyCustomValues(db, {
      accountId: 'acc',
      contactId: 'contact-1',
      entries: [
        { field: 'origem', value: 'primeiro' },
        { field: 'origem', value: 'segundo' },
      ],
    });

    expect(box.upserted).toEqual([
      { contact_id: 'contact-1', custom_field_id: 'field-1', value: 'segundo' },
    ]);
  });

  it('throws IngestCustomValuesError when loading custom_fields fails', async () => {
    const { db } = fakeDb({
      fields: [],
      fieldsError: { message: 'boom' },
    });

    await expect(
      applyCustomValues(db, {
        accountId: 'acc',
        contactId: 'contact-1',
        entries: [{ field: 'x', value: 'y' }],
      })
    ).rejects.toBeInstanceOf(IngestCustomValuesError);
  });

  it('throws IngestCustomValuesError when the upsert fails', async () => {
    const { db } = fakeDb({
      fields: [{ id: 'field-1', field_name: 'x' }],
      upsertError: { message: 'boom' },
    });

    await expect(
      applyCustomValues(db, {
        accountId: 'acc',
        contactId: 'contact-1',
        entries: [{ field: 'x', value: 'y' }],
      })
    ).rejects.toBeInstanceOf(IngestCustomValuesError);
  });
});
