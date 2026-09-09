// ============================================================
// Duplo de teste do `KeyValueStorage`.
//
// Existe porque `vitest.config.ts` roda em `environment: 'node'`: não
// há `localStorage` para os testes de `preferences.ts` / `recents.ts`
// usarem. Mesmo papel (e mesmo lugar, ao lado do código que serve) do
// `src/lib/audience/supabase-mock.ts`.
//
// Importado APENAS por arquivos `*.test.ts` — nunca chega ao bundle da
// aplicação.
// ============================================================

import type { KeyValueStorage } from './storage';

export interface FakeStorage extends KeyValueStorage {
  /** Conteúdo cru, para montar o estado inicial e inspecionar o final. */
  readonly map: Map<string, string>;
}

/** Storage em memória que se comporta como o `localStorage` real. */
export function createFakeStorage(
  initial: Record<string, string> = {}
): FakeStorage {
  const map = new Map<string, string>(Object.entries(initial));

  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

/**
 * Storage que estoura em toda operação.
 *
 * Cobre dois casos reais que só aparecem em produção: cota de
 * `localStorage` estourada (o cache de ~780 KB da Emojibase concorre
 * pelo mesmo espaço) e janela privada do Safari, onde `setItem` lança.
 */
export function createThrowingStorage(): KeyValueStorage {
  const boom = () => {
    throw new Error('QuotaExceededError');
  };

  return {
    getItem: boom,
    setItem: boom,
    removeItem: boom,
  };
}
