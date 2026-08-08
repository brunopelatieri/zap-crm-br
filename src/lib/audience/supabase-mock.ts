/**
 * Mock encadeável do cliente Supabase — apenas para testes.
 *
 * O PostgREST tem uma API fluente (`from().select().in().range()`) cujo
 * terminal é um thenable. Reproduzir isso à mão em cada arquivo de teste
 * dava um builder ligeiramente diferente por vez, e as diferenças
 * escondiam justamente o que se quer testar: qual consulta foi montada.
 *
 * Aqui o builder é um só e GRAVA a cadeia. O teste recebe
 * `(table, ops)` e decide o que devolver — então a asserção pode ser
 * sobre a consulta ("paginou?", "filtrou por account_id?") e não só
 * sobre o resultado.
 *
 * Não é exportado por `index`; vive junto do código que testa.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface QueryOp {
  fn: string;
  args: unknown[];
}

export interface QueryCall {
  table: string;
  ops: QueryOp[];
}

export interface MockResult {
  data?: unknown;
  error?: unknown;
  /** Para `.select('*', { count: 'exact', head: true })`. */
  count?: number | null;
}

export type QueryHandler = (
  table: string,
  ops: QueryOp[]
) => MockResult | undefined;

/** Métodos do query builder que apenas acumulam e devolvem `this`. */
const CHAINABLE = [
  'select',
  'insert',
  'update',
  'upsert',
  'delete',
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'like',
  'ilike',
  'in',
  'is',
  'order',
  'limit',
  'range',
  'single',
  'maybeSingle',
] as const;

export interface SupabaseMock {
  db: SupabaseClient;
  /** Toda cadeia resolvida, na ordem. */
  calls: QueryCall[];
  /** Cadeias de uma tabela específica. */
  callsFor: (table: string) => QueryCall[];
}

/**
 * Monta um cliente falso. `handler` devolve `{ data, error }` para cada
 * cadeia; devolver `undefined` vira `{ data: null, error: null }`.
 */
export function createSupabaseMock(
  handler: QueryHandler,
  rpcHandler?: (fn: string, args: Record<string, unknown>) => MockResult
): SupabaseMock {
  const calls: QueryCall[] = [];

  function from(table: string) {
    const ops: QueryOp[] = [];

    const builder: Record<string, unknown> = {
      then(
        onFulfilled: (value: MockResult) => unknown,
        onRejected?: (reason: unknown) => unknown
      ) {
        calls.push({ table, ops: [...ops] });
        let result: MockResult;
        try {
          result = handler(table, ops) ?? { data: null, error: null };
        } catch (err) {
          return Promise.reject(err).then(onFulfilled, onRejected);
        }
        return Promise.resolve({
          data: result.data ?? null,
          error: result.error ?? null,
          count: result.count ?? null,
        }).then(onFulfilled, onRejected);
      },
    };

    for (const fn of CHAINABLE) {
      builder[fn] = (...args: unknown[]) => {
        ops.push({ fn, args });
        return builder;
      };
    }

    return builder;
  }

  const db = {
    from,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      const result = rpcHandler?.(fn, args) ?? { data: null, error: null };
      return { data: result.data ?? null, error: result.error ?? null };
    },
  } as unknown as SupabaseClient;

  return {
    db,
    calls,
    callsFor: (table: string) => calls.filter((c) => c.table === table),
  };
}

/** Lê os argumentos da primeira ocorrência de um método na cadeia. */
export function opArgs(ops: QueryOp[], fn: string): unknown[] | undefined {
  return ops.find((o) => o.fn === fn)?.args;
}

/** True quando a cadeia contém o método. */
export function hasOp(ops: QueryOp[], fn: string): boolean {
  return ops.some((o) => o.fn === fn);
}
