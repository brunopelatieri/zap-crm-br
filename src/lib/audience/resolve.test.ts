import { describe, expect, it } from 'vitest';

import { resolveAudienceContacts, upsertImportedContacts } from './resolve';
import { createSupabaseMock, opArgs, type QueryOp } from './supabase-mock';

const ACCOUNT = 'acct-1';
const USER = 'user-1';

function contact(
  id: string,
  phone: string,
  extra: Record<string, unknown> = {}
) {
  return { id, phone, account_id: ACCOUNT, user_id: USER, ...extra };
}

/** `range(from, to)` da cadeia, ou null se não paginou. */
function rangeOf(ops: QueryOp[]): [number, number] | null {
  const args = opArgs(ops, 'range');
  return args ? [args[0] as number, args[1] as number] : null;
}

describe('resolveAudienceContacts — type "all"', () => {
  it('pagina além do teto de 1000 linhas do PostgREST', async () => {
    // 1500 contatos: sem paginação o PostgREST devolveria 1000 e o
    // disparo alcançaria dois terços da base em silêncio.
    const all = Array.from({ length: 1500 }, (_, i) =>
      contact(`c-${i}`, `+551199999${String(i).padStart(4, '0')}`)
    );

    const mock = createSupabaseMock((table, ops) => {
      if (table !== 'contacts') return undefined;
      const range = rangeOf(ops);
      if (!range) return { data: [] };
      return { data: all.slice(range[0], range[1] + 1) };
    });

    const result = await resolveAudienceContacts(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      audience: { type: 'all' },
    });

    expect(result).toHaveLength(1500);
    // Duas páginas cheias não bastam: a terceira é o que prova que o
    // laço só para quando a página vem curta.
    expect(mock.callsFor('contacts').map((c) => rangeOf(c.ops))).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it('subtrai os contatos das etiquetas de exclusão', async () => {
    const mock = createSupabaseMock((table, ops) => {
      if (table === 'contacts') {
        const range = rangeOf(ops);
        if (!range || range[0] > 0) return { data: [] };
        return {
          data: [
            contact('c-1', '+5511999990001'),
            contact('c-2', '+5511999990002'),
          ],
        };
      }
      if (table === 'contact_tags') {
        const range = rangeOf(ops);
        if (!range || range[0] > 0) return { data: [] };
        return { data: [{ contact_id: 'c-2' }] };
      }
      return undefined;
    });

    const result = await resolveAudienceContacts(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      audience: { type: 'all', excludeTagIds: ['tag-x'] },
    });

    expect(result.map((c) => c.id)).toEqual(['c-1']);
  });
});

describe('resolveAudienceContacts — type "tags"', () => {
  it('deduplica um contato que carrega duas das etiquetas escolhidas', async () => {
    const mock = createSupabaseMock((table, ops) => {
      if (table === 'contact_tags') {
        const range = rangeOf(ops);
        if (!range || range[0] > 0) return { data: [] };
        // O mesmo contato aparece duas vezes: uma por etiqueta.
        return {
          data: [
            { contact_id: 'c-1' },
            { contact_id: 'c-1' },
            { contact_id: 'c-2' },
          ],
        };
      }
      if (table === 'contacts') {
        const ids = (opArgs(ops, 'in')?.[1] ?? []) as string[];
        return { data: ids.map((id) => contact(id, `+5511999990${id}`)) };
      }
      return undefined;
    });

    const result = await resolveAudienceContacts(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      audience: { type: 'tags', tagIds: ['t-1', 't-2'] },
    });

    expect(result.map((c) => c.id)).toEqual(['c-1', 'c-2']);
  });

  it('devolve vazio quando nenhuma etiqueta foi escolhida', async () => {
    const mock = createSupabaseMock(() => ({ data: [] }));

    const result = await resolveAudienceContacts(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      audience: { type: 'tags', tagIds: [] },
    });

    expect(result).toEqual([]);
    expect(mock.calls).toHaveLength(0);
  });
});

describe('resolveAudienceContacts — type "csv"', () => {
  it('NÃO aplica etiquetas de exclusão a uma lista importada', async () => {
    // A estimativa (estimate.ts) também ignora exclusão no ramo do csv,
    // e a UI diz isso em `excludeNotAppliedToImport`. Se o envio
    // divergisse, a tela prometeria um número e entregaria outro.
    const mock = createSupabaseMock((table, ops) => {
      if (table === 'contacts' && !opArgs(ops, 'insert')) {
        return { data: [contact('c-1', '+5511999990001')] };
      }
      if (table === 'contact_tags') return { data: [{ contact_id: 'c-1' }] };
      return undefined;
    });

    const result = await resolveAudienceContacts(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      audience: {
        type: 'csv',
        csvContacts: [{ phone: '+55 11 99999-0001' }],
        excludeTagIds: ['tag-x'],
      },
    });

    expect(result.map((c) => c.id)).toEqual(['c-1']);
    expect(mock.callsFor('contact_tags')).toHaveLength(0);
  });
});

describe('resolveAudienceContacts — type "staged"', () => {
  it('hidrata linhas já casadas por id e materializa as demais', async () => {
    const mock = createSupabaseMock((table, ops) => {
      if (table === 'broadcast_audience_staging') {
        const range = rangeOf(ops);
        if (!range || range[0] > 0) return { data: [] };
        return {
          data: [
            { phone: '+5511999990001', name: 'A', existing_contact_id: 'c-1' },
            { phone: '+5511999990002', name: 'B', existing_contact_id: null },
          ],
        };
      }
      if (table === 'contacts') {
        if (opArgs(ops, 'insert')) {
          return { data: [contact('c-2', '+5511999990002', { name: 'B' })] };
        }
        const ids = opArgs(ops, 'in');
        if (ids?.[0] === 'id') {
          return { data: [contact('c-1', '+5511999990001', { name: 'A' })] };
        }
        // Lookup por phone_normalized dentro de upsertImportedContacts —
        // nenhum contato existente para a linha sem `existing_contact_id`.
        return { data: [] };
      }
      return undefined;
    });

    const result = await resolveAudienceContacts(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      audience: { type: 'staged', draftId: 'draft-1' },
    });

    expect(result.map((c) => c.id)).toEqual(['c-1', 'c-2']);

    const stagingQuery = mock.callsFor('broadcast_audience_staging')[0];
    expect(opArgs(stagingQuery.ops, 'eq')).toEqual(['broadcast_id', 'draft-1']);
  });

  it('só lê linhas selecionadas e válidas', async () => {
    const mock = createSupabaseMock((table, ops) => {
      if (table === 'broadcast_audience_staging') {
        // A própria consulta já filtra `selected=true` e
        // `invalid_reason IS NULL` — aqui só confirmamos que os
        // filtros foram aplicados na cadeia.
        const eqCalls = ops.filter((o) => o.fn === 'eq');
        expect(eqCalls).toContainEqual({ fn: 'eq', args: ['selected', true] });
        const isCalls = ops.filter((o) => o.fn === 'is');
        expect(isCalls).toContainEqual({
          fn: 'is',
          args: ['invalid_reason', null],
        });
        return { data: [] };
      }
      return undefined;
    });

    const result = await resolveAudienceContacts(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      audience: { type: 'staged', draftId: 'draft-1' },
    });

    expect(result).toEqual([]);
  });

  it('rejeita quando draftId está ausente', async () => {
    const mock = createSupabaseMock(() => ({ data: [] }));
    await expect(
      resolveAudienceContacts(mock.db, {
        accountId: ACCOUNT,
        userId: USER,
        audience: { type: 'staged' },
      })
    ).rejects.toThrow(/draftId/);
  });

  it('escopa a leitura por account_id, não só por broadcast_id', async () => {
    // `draftId` vem de `audience_filter`, um JSONB que o dono da campanha
    // edita direto pelo PostgREST. Sob RLS um id de outra conta não
    // devolve nada; no cron (service-role) devolveria — e a audiência
    // staged alheia viraria contato e mensagem aqui. Ver o cabeçalho de
    // `resolveStagedAudience`.
    const mock = createSupabaseMock((table) => {
      if (table === 'broadcast_audience_staging') return { data: [] };
      return undefined;
    });

    await resolveAudienceContacts(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      audience: { type: 'staged', draftId: 'draft-de-outra-conta' },
    });

    const eqCalls = mock
      .callsFor('broadcast_audience_staging')[0]
      .ops.filter((o) => o.fn === 'eq');
    expect(eqCalls).toContainEqual({ fn: 'eq', args: ['account_id', ACCOUNT] });
  });
});

describe('upsertImportedContacts', () => {
  it('casa contatos existentes pela CONTA e por phone_normalized', async () => {
    // Regressão da SPEC 044 §7, item 2: filtrar por user_id fazia um
    // número já salvo por um colega parecer novo, e o insert batia no
    // UNIQUE(account_id, phone_normalized) — ou duplicava a pessoa.
    const inserted: unknown[] = [];

    const mock = createSupabaseMock((table, ops) => {
      if (table !== 'contacts') return undefined;
      const insertArgs = opArgs(ops, 'insert');
      if (insertArgs) {
        inserted.push(...(insertArgs[0] as unknown[]));
        return { data: [contact('c-new', '+5511988887777')] };
      }
      // Lookup: só o primeiro número já existe.
      return { data: [contact('c-old', '+55 (11) 97777-6666')] };
    });

    const result = await upsertImportedContacts(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      rows: [
        { phone: '5511977776666' }, // grafia diferente do mesmo número
        { phone: '+55 11 98888-7777', name: 'Nova' },
      ],
    });

    const lookup = mock.callsFor('contacts')[0];
    expect(opArgs(lookup.ops, 'eq')).toEqual(['account_id', ACCOUNT]);
    expect(opArgs(lookup.ops, 'in')?.[0]).toBe('phone_normalized');

    // Só o número realmente ausente foi inserido…
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      account_id: ACCOUNT,
      user_id: USER,
      phone: '+55 11 98888-7777',
      name: 'Nova',
    });
    // …e a ordem do arquivo é preservada.
    expect(result.map((c) => c.id)).toEqual(['c-old', 'c-new']);
  });

  it('colapsa duas grafias do mesmo número dentro do arquivo', async () => {
    const mock = createSupabaseMock((table, ops) => {
      if (table !== 'contacts') return undefined;
      if (opArgs(ops, 'insert')) {
        return { data: [contact('c-1', '+5511999990001')] };
      }
      return { data: [] };
    });

    const result = await upsertImportedContacts(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      rows: [
        { phone: '+55 11 99999-0001', name: 'Primeira' },
        { phone: '5511999990001', name: 'Segunda' },
      ],
    });

    expect(result).toHaveLength(1);
    const lookupKeys = opArgs(mock.callsFor('contacts')[0].ops, 'in')?.[1];
    expect(lookupKeys).toEqual(['5511999990001']);
  });

  it('não vai ao banco quando não há linhas', async () => {
    const mock = createSupabaseMock(() => ({ data: [] }));
    await expect(
      upsertImportedContacts(mock.db, {
        accountId: ACCOUNT,
        userId: USER,
        rows: [],
      })
    ).resolves.toEqual([]);
    expect(mock.calls).toHaveLength(0);
  });
});
