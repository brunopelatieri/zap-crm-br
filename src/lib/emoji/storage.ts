// ============================================================
// Storage injetável da camada de emoji.
//
// Por que uma interface em vez de chamar `localStorage` direto:
// `vitest.config.ts` roda com `environment: 'node'` e o projeto não
// tem jsdom nem testing-library — `localStorage` simplesmente NÃO
// EXISTE no ambiente de teste. Receber um `KeyValueStorage` por
// parâmetro deixa preferências e recentes testáveis sem browser e sem
// mock global, que é o que permite cobrir os casos de borda que
// realmente quebram (blob corrompido, cota estourada, storage negado).
//
// `browserStorage()` é o ÚNICO ponto desta pasta que toca em `window`.
// Todo o resto é função pura.
//
// SPEC: docs/spec-066-emoji-picker-inbox.md § Configuração
// ============================================================

/** Subconjunto de `Storage` que a camada de emoji usa. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * O `localStorage` do navegador, ou `null` quando indisponível.
 *
 * Devolve `null` — em vez de estourar — nos três casos reais:
 *
 *   1. render no servidor / primeiro render de hidratação (`window`
 *      indefinido);
 *   2. navegador com dados de site bloqueados, onde só LER a
 *      propriedade `window.localStorage` já lança `SecurityError` —
 *      não é apenas o `setItem` que falha, e é por isso que o acesso
 *      está dentro do try;
 *   3. modos de privacidade que expõem a API mas negam o acesso.
 *
 * Todo consumidor desta pasta aceita `null` e cai no padrão, então o
 * seletor de emojis continua funcionando com as preferências
 * desligadas em vez de derrubar o composer.
 */
export function browserStorage(): KeyValueStorage | null {
  if (typeof window === 'undefined') return null;

  try {
    return window.localStorage;
  } catch {
    // Acesso negado pelo navegador — preferência é best-effort.
    return null;
  }
}
