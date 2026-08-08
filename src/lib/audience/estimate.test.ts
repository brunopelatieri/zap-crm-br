import { describe, expect, it } from 'vitest';

import { estimateAudience } from './estimate';
import { createSupabaseMock, hasOp, opArgs } from './supabase-mock';

/** Uma linha de `audience_engagement_summary` com só o que a estimativa lê. */
function summaryRow(selectedValid: number, sendable: number) {
  return [{ selected_valid_rows: selectedValid, sendable_rows: sendable }];
}

describe('estimateAudience — type "staged"', () => {
  it('lê o total do rascunho pela RPC de resumo', async () => {
    const mock = createSupabaseMock(
      () => undefined,
      (fn, args) => {
        expect(fn).toBe('audience_engagement_summary');
        expect(args.p_draft_id).toBe('draft-1');
        // Sem filtro: a estimativa descreve o rascunho inteiro, não o
        // recorte que a tabela está mostrando.
        expect(args.p_filter).toBe('all');
        expect(args.p_search).toBeNull();
        return { data: summaryRow(42, 40) };
      }
    );

    const result = await estimateAudience(mock.db, {
      type: 'staged',
      draftId: 'draft-1',
    });

    expect(result).toBe(42);
  });

  it('usa sendable_rows quando o opt-out se aplica (§6.8)', async () => {
    const mock = createSupabaseMock(
      () => undefined,
      () => ({ data: summaryRow(42, 40) })
    );

    const result = await estimateAudience(
      mock.db,
      { type: 'staged', draftId: 'draft-1' },
      { excludeOptedOut: true }
    );

    expect(result).toBe(40);
  });

  it('devolve 0 quando o rascunho não tem linha nenhuma', async () => {
    const mock = createSupabaseMock(
      () => undefined,
      () => ({ data: [] })
    );

    const result = await estimateAudience(mock.db, {
      type: 'staged',
      draftId: 'draft-1',
    });

    expect(result).toBe(0);
  });

  it('devolve null sem draftId', async () => {
    const mock = createSupabaseMock(() => ({ data: null }));
    const result = await estimateAudience(mock.db, { type: 'staged' });
    expect(result).toBeNull();
    expect(mock.calls).toHaveLength(0);
  });
});

describe('estimateAudience — opt-out (§6.8)', () => {
  it('type "all" filtra opted_out no próprio count, sem ler a lista', async () => {
    const mock = createSupabaseMock((table, ops) => {
      if (table !== 'contacts') return undefined;
      expect(opArgs(ops, 'neq')).toEqual(['opt_in_status', 'opted_out']);
      return { count: 90 };
    });

    const result = await estimateAudience(
      mock.db,
      { type: 'all' },
      { excludeOptedOut: true }
    );

    expect(result).toBe(90);
    // Uma consulta só: sem etiqueta de exclusão não há interseção para
    // descontar, então a lista de opted_out não precisa ser lida.
    expect(mock.callsFor('contacts')).toHaveLength(1);
  });

  it('type "all" não filtra nada quando a regra não se aplica', async () => {
    const mock = createSupabaseMock((table, ops) => {
      if (table !== 'contacts') return undefined;
      expect(hasOp(ops, 'neq')).toBe(false);
      return { count: 100 };
    });

    const result = await estimateAudience(mock.db, { type: 'all' });
    expect(result).toBe(100);
  });

  it('type "tags" subtrai os contatos em opt-out do conjunto', async () => {
    const mock = createSupabaseMock((table, ops) => {
      if (table === 'contact_tags') {
        return {
          data: [
            { contact_id: 'c1' },
            { contact_id: 'c2' },
            { contact_id: 'c3' },
          ],
        };
      }
      if (table === 'contacts') {
        // A leitura de opt-out pede `id`, não `contact_id`.
        expect(opArgs(ops, 'select')).toEqual(['id']);
        expect(opArgs(ops, 'eq')).toEqual(['opt_in_status', 'opted_out']);
        return { data: [{ id: 'c2' }] };
      }
      return undefined;
    });

    const result = await estimateAudience(
      mock.db,
      { type: 'tags', tagIds: ['t1'] },
      { excludeOptedOut: true }
    );

    expect(result).toBe(2);
  });

  it('não conta duas vezes quem está em opt-out E numa etiqueta excluída', async () => {
    // Base "todos" = 10 contatos, dos quais 1 em opt-out (já fora do
    // count) e 2 na etiqueta de exclusão — sendo um deles o MESMO que
    // está em opt-out. O alcance correto é 10 - 1 (opt-out, via count)
    // - 1 (o outro excluído) = 8, não 7.
    const mock = createSupabaseMock((table, ops) => {
      if (table === 'contact_tags') {
        return { data: [{ contact_id: 'c1' }, { contact_id: 'c9' }] };
      }
      if (table === 'contacts') {
        if (hasOp(ops, 'neq')) return { count: 9 };
        return { data: [{ id: 'c9' }] };
      }
      return undefined;
    });

    const result = await estimateAudience(
      mock.db,
      { type: 'all', excludeTagIds: ['t-block'] },
      { excludeOptedOut: true }
    );

    expect(result).toBe(8);
  });
});

describe('estimateAudience — número morto (§6.4)', () => {
  it('type "all" filtra whatsapp_status=invalid no próprio count', async () => {
    const mock = createSupabaseMock((table, ops) => {
      if (table !== 'contacts') return undefined;
      expect(opArgs(ops, 'neq')).toEqual(['whatsapp_status', 'invalid']);
      return { count: 88 };
    });

    const result = await estimateAudience(
      mock.db,
      { type: 'all' },
      { excludeInvalidWhatsapp: true }
    );

    expect(result).toBe(88);
    expect(mock.callsFor('contacts')).toHaveLength(1);
  });

  it('combina os dois filtros no mesmo count quando ambos se aplicam', async () => {
    const mock = createSupabaseMock((table, ops) => {
      if (table !== 'contacts') return undefined;
      const neqCalls = ops.filter((o) => o.fn === 'neq').map((o) => o.args);
      expect(neqCalls).toEqual([
        ['opt_in_status', 'opted_out'],
        ['whatsapp_status', 'invalid'],
      ]);
      return { count: 80 };
    });

    const result = await estimateAudience(
      mock.db,
      { type: 'all' },
      { excludeOptedOut: true, excludeInvalidWhatsapp: true }
    );

    expect(result).toBe(80);
  });

  it('type "tags" subtrai os contatos com número morto do conjunto', async () => {
    const mock = createSupabaseMock((table, ops) => {
      if (table === 'contact_tags') {
        return {
          data: [
            { contact_id: 'c1' },
            { contact_id: 'c2' },
            { contact_id: 'c3' },
          ],
        };
      }
      if (table === 'contacts') {
        expect(opArgs(ops, 'eq')).toEqual(['whatsapp_status', 'invalid']);
        return { data: [{ id: 'c3' }] };
      }
      return undefined;
    });

    const result = await estimateAudience(
      mock.db,
      { type: 'tags', tagIds: ['t1'] },
      { excludeInvalidWhatsapp: true }
    );

    expect(result).toBe(2);
  });
});
