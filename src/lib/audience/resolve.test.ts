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
  it('hidrata linhas já casadas por id e materializa as demais por telefone', async () => {
    const mock = createSupabaseMock((table, ops) => {
      if (table === 'broadcast_audience_staging') {
        const range = rangeOf(ops);
        if (!range || range[0] > 0) return { data: [] };
        return {
          data: [
            {
              phone: '+5511999990001',
              name: 'A',
              email: null,
              company: null,
              tag_names: null,
              existing_contact_id: 'c-1',
            },
            {
              phone: '+5511999990002',
              name: 'B',
              email: null,
              company: null,
              tag_names: null,
              existing_contact_id: null,
            },
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
        // Lookup por phone_normalized (linha sem existing_contact_id).
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

  it('exclui em silêncio um contato apagado entre a triagem e o envio, em vez de recriá-lo', async () => {
    // Achado de revisão pós-057: re-derivar por telefone ressuscitava um
    // contato deletado (ex.: pedido de exclusão LGPD) como um contato
    // NOVO. A hidratação por id restaura o comportamento pré-057 — a
    // linha some da audiência, sem virar contato novo.
    const mock = createSupabaseMock((table, ops) => {
      if (table === 'broadcast_audience_staging') {
        const range = rangeOf(ops);
        if (!range || range[0] > 0) return { data: [] };
        return {
          data: [
            {
              phone: '+5511999990001',
              name: 'Apagado',
              email: null,
              company: null,
              tag_names: null,
              existing_contact_id: 'c-deleted',
            },
          ],
        };
      }
      if (table === 'contacts') {
        // `contactsByIds` não acha nada — o contato foi apagado.
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

  it('preenche email/company e vincula tags também nas linhas já casadas por id (D-2/F3)', async () => {
    const upserts: Record<string, unknown>[] = [];
    const mock = createSupabaseMock((table, ops) => {
      if (table === 'broadcast_audience_staging') {
        const range = rangeOf(ops);
        if (!range || range[0] > 0) return { data: [] };
        return {
          data: [
            {
              phone: '+5511999990001',
              name: 'A',
              email: 'a@example.com',
              company: null,
              tag_names: ['vip'],
              existing_contact_id: 'c-1',
            },
          ],
        };
      }
      if (table === 'contacts') {
        const upsertArgs = opArgs(ops, 'upsert');
        if (upsertArgs) {
          upserts.push(...(upsertArgs[0] as Record<string, unknown>[]));
          return { data: null };
        }
        return { data: [contact('c-1', '+5511999990001', { email: null })] };
      }
      if (table === 'tags') return { data: [{ id: 'tag-vip', name: 'vip' }] };
      if (table === 'contact_tags') return { data: null };
      return undefined;
    });

    const result = await resolveAudienceContacts(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      audience: { type: 'staged', draftId: 'draft-1' },
    });

    // O contato hidratado por id também recebe o preenchimento — o
    // próprio objeto devolvido já reflete o e-mail novo (achado de
    // revisão: `fillMissingContactFields` mutava só o banco antes).
    expect(result[0].email).toBe('a@example.com');
    expect(upserts[0]).toMatchObject({ id: 'c-1', email: 'a@example.com' });
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
    expect(result.contacts.map((c) => c.id)).toEqual(['c-old', 'c-new']);
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

    expect(result.contacts).toHaveLength(1);
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
    ).resolves.toEqual({ contacts: [], tagsSkipped: [], tagsCreated: [] });
    expect(mock.calls).toHaveLength(0);
  });

  // SPEC 057 F2 — D-2: contato novo recebe os 4 campos.
  it('contato novo grava email e company junto de phone/name', async () => {
    const inserted: Record<string, unknown>[] = [];
    const mock = createSupabaseMock((table, ops) => {
      if (table !== 'contacts') return undefined;
      const insertArgs = opArgs(ops, 'insert');
      if (insertArgs) {
        inserted.push(...(insertArgs[0] as Record<string, unknown>[]));
        return { data: [contact('c-new', '+5511999990001')] };
      }
      return { data: [] };
    });

    await upsertImportedContacts(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      rows: [
        {
          phone: '+5511999990001',
          name: 'Nova',
          email: 'nova@example.com',
          company: 'Acme',
        },
      ],
    });

    expect(inserted[0]).toMatchObject({
      phone: '+5511999990001',
      name: 'Nova',
      email: 'nova@example.com',
      company: 'Acme',
    });
  });

  // SPEC 057 F2 — D-2: campo já preenchido nunca é sobrescrito, nem por
  // vazio nem por um valor diferente (R-2).
  it('contato existente com email preenchido não é sobrescrito por vazio nem por valor diferente', async () => {
    const upserts: Record<string, unknown>[] = [];
    const mock = createSupabaseMock((table, ops) => {
      if (table !== 'contacts') return undefined;
      const upsertArgs = opArgs(ops, 'upsert');
      if (upsertArgs) {
        upserts.push(...(upsertArgs[0] as Record<string, unknown>[]));
        return { data: null };
      }
      // c-1 já tem email curado; c-2 tem company vazia.
      return {
        data: [
          contact('c-1', '+5511999990001', {
            email: 'curated@example.com',
            company: null,
          }),
          contact('c-2', '+5511999990002', { email: null, company: 'Old Co' }),
        ],
      };
    });

    const result = await upsertImportedContacts(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      rows: [
        // Planilha traz email VAZIO para c-1 — email curado sobrevive.
        { phone: '+5511999990001', email: '', company: 'New Co' },
        // Planilha traz email DIFERENTE para c-2 (que não tinha) — deve
        // preencher; company já preenchida em c-2 não deve mudar.
        {
          phone: '+5511999990002',
          email: 'new@example.com',
          company: 'Other Co',
        },
      ],
    });

    expect(result.contacts).toHaveLength(2);
    // c-1: só company (estava vazia) é preenchida; email não muda. As
    // colunas NOT NULL (account_id/user_id/phone) acompanham o upsert.
    const c1Upsert = upserts.find((u) => u.id === 'c-1');
    expect(c1Upsert).toMatchObject({
      id: 'c-1',
      account_id: ACCOUNT,
      user_id: USER,
      phone: '+5511999990001',
      company: 'New Co',
    });
    expect(c1Upsert).not.toHaveProperty('email');
    // c-2: só email (estava vazio) é preenchido; company não muda.
    const c2Upsert = upserts.find((u) => u.id === 'c-2');
    expect(c2Upsert).toMatchObject({ id: 'c-2', email: 'new@example.com' });
    expect(c2Upsert).not.toHaveProperty('company');

    // Achado de revisão pós-057: o preenchimento também precisa refletir
    // no objeto devolvido, não só no banco — é o que `resolveVariables`
    // usaria para personalizar o disparo que ACABOU de trazer o dado.
    const c1 = result.contacts.find((c) => c.id === 'c-1');
    const c2 = result.contacts.find((c) => c.id === 'c-2');
    expect(c1?.company).toBe('New Co');
    expect(c1?.email).toBe('curated@example.com');
    expect(c2?.email).toBe('new@example.com');
    expect(c2?.company).toBe('Old Co');
  });

  // SPEC 057 F3 — D-1: admin+ cria etiquetas ausentes e vincula; agent
  // vincula só as existentes e a chamada devolve `tagsSkipped`.
  it('admin+ cria etiquetas ausentes; agent só vincula as existentes', async () => {
    const tagInserts: unknown[] = [];
    const contactTagUpserts: unknown[] = [];
    let tagsReadCount = 0;

    function buildMock() {
      return createSupabaseMock((table, ops) => {
        if (table === 'contacts') {
          if (opArgs(ops, 'upsert')) return { data: null };
          return { data: [contact('c-1', '+5511999990001')] };
        }
        if (table === 'tags') {
          const insertArgs = opArgs(ops, 'insert');
          if (insertArgs) {
            tagInserts.push(...(insertArgs[0] as unknown[]));
            return { data: [{ id: 'tag-new', name: 'novaetiqueta' }] };
          }
          tagsReadCount++;
          return { data: [{ id: 'tag-vip', name: 'vip' }] };
        }
        if (table === 'contact_tags') {
          const upsertArgs = opArgs(ops, 'upsert');
          if (upsertArgs)
            contactTagUpserts.push(...(upsertArgs[0] as unknown[]));
          return { data: null };
        }
        return undefined;
      });
    }

    const adminMock = buildMock();
    const admin = await upsertImportedContacts(adminMock.db, {
      accountId: ACCOUNT,
      userId: USER,
      canCreateTags: true,
      rows: [{ phone: '+5511999990001', tagNames: ['vip', 'novaetiqueta'] }],
    });
    expect(admin.tagsCreated).toEqual(['novaetiqueta']);
    expect(admin.tagsSkipped).toEqual([]);
    expect(tagInserts).toEqual([
      {
        user_id: USER,
        account_id: ACCOUNT,
        name: 'novaetiqueta',
        color: expect.any(String),
      },
    ]);
    // R-5: uma única leitura de `tags` para TODOS os nomes, não uma por contato.
    expect(tagsReadCount).toBe(1);

    tagInserts.length = 0;
    const agentMock = buildMock();
    const agent = await upsertImportedContacts(agentMock.db, {
      accountId: ACCOUNT,
      userId: USER,
      canCreateTags: false,
      rows: [{ phone: '+5511999990001', tagNames: ['vip', 'novaetiqueta'] }],
    });
    expect(agent.tagsCreated).toEqual([]);
    expect(agent.tagsSkipped).toEqual(['novaetiqueta']);
    expect(tagInserts).toHaveLength(0);
    // "vip" (já existente) ainda é vinculada normalmente.
    expect(contactTagUpserts.length).toBeGreaterThan(0);
  });
});
