import { describe, expect, it } from 'vitest';

import { stageAudience } from './stage';
import { createSupabaseMock, opArgs } from './supabase-mock';

const ACCOUNT = 'acct-1';
const USER = 'user-1';
const TEMPLATE = 'promo';
const LANG = 'pt_BR';

function templateFound(table: string) {
  return table === 'message_templates' ? { data: { id: 'tpl-1' } } : undefined;
}

describe('stageAudience — csv', () => {
  it('cruza telefones válidos com contatos existentes, sem materializar', async () => {
    const inserted: unknown[][] = [];

    const mock = createSupabaseMock((table, ops) => {
      const found = templateFound(table);
      if (found) return found;

      if (table === 'contacts') {
        // Cross-reference: só a primeira linha já é contato.
        return { data: [{ id: 'c-1', phone: '+5511999990001' }] };
      }
      if (table === 'broadcasts') {
        if (opArgs(ops, 'insert')) return { data: { id: 'draft-1' } };
        return undefined;
      }
      if (table === 'broadcast_audience_staging') {
        inserted.push(opArgs(ops, 'insert')?.[0] as unknown[]);
        return { data: null };
      }
      return undefined;
    });

    const result = await stageAudience(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      templateName: TEMPLATE,
      templateLanguage: LANG,
      audience: {
        type: 'csv',
        rows: [
          { phone: '+5511999990001', name: 'Alice', sourceRow: 2 },
          { phone: '+5511999990002', name: 'Bob', sourceRow: 3 },
        ],
        invalidRows: [
          { sourceRow: 4, rawPhone: 'abc', reason: 'invalid_phone' },
        ],
      },
    });

    expect(result.draftId).toBe('draft-1');
    expect(result.summary).toEqual({
      read: 3,
      valid: 2,
      duplicates: 0,
      invalid: 1,
      existingContacts: 1,
    });

    // Nunca insere/atualiza `contacts` — a materialização é do envio.
    expect(mock.callsFor('contacts').some((c) => opArgs(c.ops, 'insert'))).toBe(
      false
    );

    expect(inserted).toHaveLength(1);
    const rows = inserted[0] as Record<string, unknown>[];
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      phone: '+5511999990001',
      existing_contact_id: 'c-1',
      invalid_reason: null,
    });
    expect(rows[1]).toMatchObject({
      phone: '+5511999990002',
      existing_contact_id: null,
      invalid_reason: null,
    });
    expect(rows[2]).toMatchObject({
      phone: 'abc',
      invalid_reason: 'invalid_phone',
      source_row: 4,
    });
  });

  it('desmarca automaticamente quem está em cooldown após o stage (§6.2)', async () => {
    const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];

    const mock = createSupabaseMock(
      (table, ops) => {
        const found = templateFound(table);
        if (found) return found;
        if (table === 'contacts') return { data: [] };
        if (table === 'broadcasts') {
          if (opArgs(ops, 'insert')) return { data: { id: 'draft-3' } };
          return undefined;
        }
        if (table === 'broadcast_audience_staging') return { data: null };
        return undefined;
      },
      (fn, args) => {
        rpcCalls.push({ fn, args });
        return { data: 2 };
      }
    );

    await stageAudience(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      templateName: TEMPLATE,
      templateLanguage: LANG,
      audience: {
        type: 'csv',
        rows: [{ phone: '+5511999990001', name: 'Alice', sourceRow: 2 }],
        invalidRows: [],
      },
    });

    expect(rpcCalls).toEqual([
      {
        fn: 'triage_set_selection',
        args: {
          p_draft_id: 'draft-3',
          p_selected: false,
          p_search: null,
          p_filter: 'cooldown',
        },
      },
    ]);
  });

  it('não derruba o stage se o auto-deselect de cooldown falhar', async () => {
    const mock = createSupabaseMock(
      (table, ops) => {
        const found = templateFound(table);
        if (found) return found;
        if (table === 'contacts') return { data: [] };
        if (table === 'broadcasts') {
          if (opArgs(ops, 'insert')) return { data: { id: 'draft-4' } };
          return undefined;
        }
        if (table === 'broadcast_audience_staging') return { data: null };
        return undefined;
      },
      () => ({ error: new Error('boom') })
    );

    const result = await stageAudience(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      templateName: TEMPLATE,
      templateLanguage: LANG,
      audience: {
        type: 'csv',
        rows: [{ phone: '+5511999990001', name: 'Alice', sourceRow: 2 }],
        invalidRows: [],
      },
    });

    expect(result.draftId).toBe('draft-4');
  });

  it('rejeita quando o template não existe para a conta', async () => {
    const mock = createSupabaseMock((table) =>
      table === 'message_templates' ? { data: null } : undefined
    );

    await expect(
      stageAudience(mock.db, {
        accountId: ACCOUNT,
        userId: USER,
        templateName: TEMPLATE,
        templateLanguage: LANG,
        audience: { type: 'csv', rows: [], invalidRows: [] },
      })
    ).rejects.toMatchObject({ code: 'template_not_found' });
  });

  it('rejeita um arquivo vazio', async () => {
    const mock = createSupabaseMock((table) => templateFound(table));

    await expect(
      stageAudience(mock.db, {
        accountId: ACCOUNT,
        userId: USER,
        templateName: TEMPLATE,
        templateLanguage: LANG,
        audience: { type: 'csv', rows: [], invalidRows: [] },
      })
    ).rejects.toMatchObject({ code: 'empty_audience' });
  });
});

describe('stageAudience — tags', () => {
  it('resolve contatos por etiqueta e aplica excludeTagIds', async () => {
    const inserted: unknown[][] = [];

    const mock = createSupabaseMock((table, ops) => {
      const found = templateFound(table);
      if (found) return found;

      if (table === 'contact_tags') {
        const inArgs = opArgs(ops, 'in');
        if (inArgs?.[0] === 'tag_id') {
          return { data: [{ contact_id: 'c-1' }, { contact_id: 'c-2' }] };
        }
        return { data: [] };
      }
      if (table === 'contacts') {
        const ids = (opArgs(ops, 'in')?.[1] ?? []) as string[];
        return {
          data: ids.map((id) => ({ id, phone: `+551199999${id}` })),
        };
      }
      if (table === 'broadcasts') {
        if (opArgs(ops, 'insert')) return { data: { id: 'draft-2' } };
        return undefined;
      }
      if (table === 'broadcast_audience_staging') {
        inserted.push(opArgs(ops, 'insert')?.[0] as unknown[]);
        return { data: null };
      }
      return undefined;
    });

    const result = await stageAudience(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      templateName: TEMPLATE,
      templateLanguage: LANG,
      audience: { type: 'tags', tagIds: ['t-1'] },
    });

    expect(result.draftId).toBe('draft-2');
    expect(result.summary.valid).toBe(2);
    const rows = inserted[0] as Record<string, unknown>[];
    expect(rows.map((r) => r.existing_contact_id)).toEqual(['c-1', 'c-2']);
    // Contatos já existentes: nenhuma linha nasce inválida.
    expect(rows.every((r) => r.invalid_reason === null)).toBe(true);
  });

  it('rejeita quando o filtro não encontra nenhum contato', async () => {
    const mock = createSupabaseMock((table) => {
      const found = templateFound(table);
      if (found) return found;
      return { data: [] };
    });

    await expect(
      stageAudience(mock.db, {
        accountId: ACCOUNT,
        userId: USER,
        templateName: TEMPLATE,
        templateLanguage: LANG,
        audience: { type: 'tags', tagIds: ['t-empty'] },
      })
    ).rejects.toMatchObject({ code: 'empty_audience' });
  });
});
