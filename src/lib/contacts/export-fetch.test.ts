import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CONTACT_EXPORT_MAX_ROWS,
  fetchAllRows,
  fetchContactsForExport,
} from './export-fetch';

describe('fetchAllRows', () => {
  it('continua enquanto o lote vier cheio e para no primeiro incompleto', async () => {
    const page0 = Array.from({ length: 1000 }, (_, i) => i);
    const page1 = Array.from({ length: 250 }, (_, i) => 1000 + i);
    const calls: [number, number][] = [];

    const rows = await fetchAllRows<number>((from, to) => {
      calls.push([from, to]);
      if (from === 0) return Promise.resolve({ data: page0, error: null });
      if (from === 1000) return Promise.resolve({ data: page1, error: null });
      throw new Error('não deveria buscar uma terceira página');
    });

    expect(calls).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(rows).toHaveLength(1250);
  });

  it('para na primeira página quando ela já vem incompleta', async () => {
    const rows = await fetchAllRows<number>(() =>
      Promise.resolve({ data: [1, 2, 3], error: null })
    );
    expect(rows).toEqual([1, 2, 3]);
  });

  it('propaga erro da query', async () => {
    await expect(
      fetchAllRows(() =>
        Promise.resolve({ data: null, error: { message: 'boom' } })
      )
    ).rejects.toThrow('boom');
  });
});

/** Builder mínimo, encadeável e "then-ável" — cobre tanto as queries
 *  que terminam em `.range()` (retorna Promise) quanto as que são
 *  aguardadas direto após `.select()`/`.order()` (então o builder
 *  precisa ser awaitable também). */
function stubTable(data: unknown[]) {
  const result = { data, error: null };
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    order: () => builder,
    range: () => Promise.resolve(result),
    then: (resolve: (v: typeof result) => void) => resolve(result),
  };
  return builder;
}

function makeSupabaseStub(tables: Record<string, unknown[]>): SupabaseClient {
  return {
    from: (table: string) => stubTable(tables[table] ?? []),
    rpc: () => Promise.resolve({ data: [], error: null }),
  } as unknown as SupabaseClient;
}

describe('fetchContactsForExport — teto de linhas', () => {
  it('escopo de seleção acima do teto: truncated, sem consultar o banco', async () => {
    const ids = Array.from(
      { length: CONTACT_EXPORT_MAX_ROWS + 1 },
      (_, i) => `id-${i}`
    );
    const supabase = {
      from: () => {
        throw new Error('não deveria consultar o banco quando já truncado');
      },
    } as unknown as SupabaseClient;

    const result = await fetchContactsForExport(
      supabase,
      { mode: 'selection', ids },
      ['name', 'phone']
    );

    expect(result.truncated).toBe(true);
    expect(result.total).toBe(CONTACT_EXPORT_MAX_ROWS + 1);
    expect(result.rows).toEqual([]);
  });

  it('escopo de filtro acima do teto: corta após a primeira página', async () => {
    const supabase = makeSupabaseStub({
      contacts: [],
    });
    // Sobrescreve `from('contacts')` para devolver um count acima do teto
    // na primeira (e única) página consultada.
    let contactsCalls = 0;
    const stubbed = {
      ...supabase,
      from: (table: string) => {
        if (table === 'contacts') {
          contactsCalls++;
          const builder = {
            select: () => builder,
            order: () => builder,
            range: () =>
              Promise.resolve({
                data: [],
                count: CONTACT_EXPORT_MAX_ROWS + 500,
                error: null,
              }),
            or: () => builder,
          };
          return builder;
        }
        return (supabase as unknown as { from: (t: string) => unknown }).from(
          table
        );
      },
    } as unknown as SupabaseClient;

    const result = await fetchContactsForExport(
      stubbed,
      { mode: 'filter', search: '', tagIds: [], channelIds: [] },
      ['name', 'phone']
    );

    expect(result.truncated).toBe(true);
    expect(result.total).toBe(CONTACT_EXPORT_MAX_ROWS + 500);
    expect(contactsCalls).toBe(1); // não buscou uma segunda página à toa
  });
});

describe('fetchContactsForExport — chunking de ids acima de CONTACT_ID_CHUNK', () => {
  it('agrega etiquetas de todos os contatos mesmo quando eles passam de um único `.in()` (bug real: URL de ~18KB com 500 ids derrubava a conexão)', async () => {
    const CONTACT_COUNT = 250; // > CONTACT_ID_CHUNK (200) — força 2 chunks
    const contacts = Array.from({ length: CONTACT_COUNT }, (_, i) => ({
      id: `c${i}`,
      user_id: 'u1',
      account_id: 'a1',
      phone: `5511900${String(i).padStart(4, '0')}`,
      created_at: '2026-08-01T00:00:00Z',
      updated_at: '2026-08-01T00:00:00Z',
    }));
    const contactTags = contacts.map((c) => ({
      contact_id: c.id,
      tag_id: 't0',
    }));

    let contactTagsInCalls = 0;

    const supabase = {
      from: (table: string) => {
        if (table === 'contacts') {
          const builder: {
            _ids?: string[];
            select: () => typeof builder;
            in: (col: string, ids: string[]) => typeof builder;
            order: () => typeof builder;
            then: (resolve: (v: unknown) => void) => void;
          } = {
            select: () => builder,
            in: (_col, ids) => {
              builder._ids = ids;
              return builder;
            },
            order: () => builder,
            then: (resolve) =>
              resolve({
                data: contacts.filter((c) => builder._ids?.includes(c.id)),
                error: null,
              }),
          };
          return builder;
        }
        if (table === 'tags') {
          return {
            select: () =>
              Promise.resolve({
                data: [{ id: 't0', name: 'vip' }],
                error: null,
              }),
          };
        }
        if (table === 'contact_tags') {
          const builder: {
            _ids?: string[];
            select: () => typeof builder;
            in: (col: string, ids: string[]) => typeof builder;
            range: () => Promise<unknown>;
          } = {
            select: () => builder,
            in: (_col, ids) => {
              contactTagsInCalls++;
              builder._ids = ids;
              return builder;
            },
            range: () =>
              Promise.resolve({
                data: contactTags.filter((r) =>
                  builder._ids?.includes(r.contact_id)
                ),
                error: null,
              }),
          };
          return builder;
        }
        // Tabelas não pedidas neste teste (channels/conversations/
        // contact_custom_values/contact_notes) — vazio, não usadas.
        const empty = {
          select: () => empty,
          in: () => empty,
          order: () => empty,
          range: () => Promise.resolve({ data: [], error: null }),
          then: (resolve: (v: unknown) => void) =>
            resolve({ data: [], error: null }),
        };
        return empty;
      },
      rpc: () => Promise.resolve({ data: [], error: null }),
    } as unknown as SupabaseClient;

    const result = await fetchContactsForExport(
      supabase,
      { mode: 'selection', ids: contacts.map((c) => c.id) },
      ['tags']
    );

    expect(result.rows).toHaveLength(CONTACT_COUNT);
    expect(
      result.rows.every(
        (r) => r.tagNames.length === 1 && r.tagNames[0] === 'vip'
      )
    ).toBe(true);
    // Prova que o caso realmente exercitou mais de um chunk de `.in()`,
    // não só um chunk único que por acaso cobre tudo.
    expect(contactTagsInCalls).toBeGreaterThan(1);
  });
});

describe('fetchContactsForExport — junção de relacionamentos', () => {
  it('etiquetas e canais saem distintos e ordenados; janela nula quando o canal é QR ou não resolve', async () => {
    const supabase = makeSupabaseStub({
      contacts: [
        {
          id: 'c1',
          user_id: 'u1',
          account_id: 'a1',
          phone: '5511900000001',
          created_at: '2026-08-01T00:00:00Z',
          updated_at: '2026-08-01T00:00:00Z',
        },
        {
          id: 'c2',
          user_id: 'u1',
          account_id: 'a1',
          phone: '5511900000002',
          created_at: '2026-08-01T00:00:00Z',
          updated_at: '2026-08-01T00:00:00Z',
        },
      ],
      tags: [
        { id: 't1', name: 'vip' },
        { id: 't2', name: 'lead' },
      ],
      contact_tags: [
        { contact_id: 'c1', tag_id: 't1' },
        { contact_id: 'c1', tag_id: 't2' },
      ],
      channels: [
        { id: 'ch-cloud', name: 'Oficial', type: 'whatsapp_cloud' },
        { id: 'ch-qr', name: 'QR Principal', type: 'whatsapp_qr' },
      ],
      conversations: [
        // c1: duas conversas, a mais recente é a QR — janela deve ser
        // null (QR não tem regra), mesmo com âncora recente.
        {
          contact_id: 'c1',
          channel_id: 'ch-cloud',
          last_message_at: '2026-08-01T10:00:00.000Z',
          last_customer_message_at: '2026-08-01T09:00:00.000Z',
        },
        {
          contact_id: 'c1',
          channel_id: 'ch-qr',
          last_message_at: '2026-08-10T10:00:00.000Z',
          last_customer_message_at: null,
        },
        // c2: conversa aponta para um canal que não existe mais —
        // janela deve ser null (não afirma "fechada" sem saber o canal).
        {
          contact_id: 'c2',
          channel_id: 'ch-deleted',
          last_message_at: '2026-08-02T10:00:00.000Z',
          last_customer_message_at: '2026-08-02T09:00:00.000Z',
        },
      ],
      contact_custom_values: [
        { contact_id: 'c1', custom_field_id: 'f1', value: 'Ouro' },
      ],
      contact_notes: [
        {
          contact_id: 'c1',
          note_text: 'oi',
          created_at: '2026-08-01T00:00:00Z',
        },
      ],
    });

    const result = await fetchContactsForExport(
      supabase,
      { mode: 'selection', ids: ['c1', 'c2'] },
      ['tags', 'channels', 'custom_fields', 'notes', 'last_interaction']
    );

    expect(result.truncated).toBe(false);
    expect(result.rows).toHaveLength(2);

    const c1 = result.rows.find((r) => r.contact.id === 'c1')!;
    expect(c1.tagNames).toEqual(['lead', 'vip']); // ordenado por nome
    expect(c1.channelNames).toEqual(['Oficial', 'QR Principal']); // distintas, ordenadas
    expect(c1.customValues).toEqual({ f1: 'Ouro' });
    expect(c1.notes).toEqual([
      { created_at: '2026-08-01T00:00:00Z', note_text: 'oi' },
    ]);
    expect(c1.lastMessageAt).toBe('2026-08-10T10:00:00.000Z'); // a mais recente
    expect(c1.sessionWindowOpen).toBeNull(); // conversa mais recente é QR

    const c2 = result.rows.find((r) => r.contact.id === 'c2')!;
    expect(c2.channelNames).toEqual([]); // canal apagado não vira nome
    expect(c2.lastMessageAt).toBe('2026-08-02T10:00:00.000Z');
    expect(c2.sessionWindowOpen).toBeNull(); // canal não resolvido
  });

  it('sem campos relacionais pedidos, não popula tags/canais/notas', async () => {
    const supabase = makeSupabaseStub({
      contacts: [
        {
          id: 'c1',
          user_id: 'u1',
          account_id: 'a1',
          phone: '5511900000001',
          created_at: '2026-08-01T00:00:00Z',
          updated_at: '2026-08-01T00:00:00Z',
        },
      ],
    });

    const result = await fetchContactsForExport(
      supabase,
      { mode: 'selection', ids: ['c1'] },
      ['name', 'phone']
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      tagNames: [],
      channelNames: [],
      customValues: {},
      notes: [],
      lastMessageAt: null,
      sessionWindowOpen: null,
    });
  });
});
