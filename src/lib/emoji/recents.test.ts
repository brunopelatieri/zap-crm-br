import { describe, expect, it, vi } from 'vitest';

import { createFakeStorage, createThrowingStorage } from './fake-storage';
import {
  MAX_RECENTS,
  clearRecents,
  mergeRecent,
  pushRecent,
  readRecents,
  recentsKey,
} from './recents';

const USER = 'user-1';

const THUMBS = String.fromCodePoint(0x1f44d);
const THUMBS_MEDIUM = String.fromCodePoint(0x1f44d, 0x1f3fd);
const CHECK = String.fromCodePoint(0x2705);
const PRAY = String.fromCodePoint(0x1f64f);

/** Monta o blob no formato corrente, para os testes de leitura. */
function storedBlob(items: unknown[], version = 1): string {
  return JSON.stringify({ version, items });
}

describe('recentsKey', () => {
  it('leva o id do usuário no sufixo', () => {
    expect(recentsKey(USER)).toBe('zapcrm:emoji:recents:user-1');
  });
});

describe('readRecents', () => {
  it('devolve lista vazia com storage vazio', () => {
    expect(readRecents(createFakeStorage(), USER)).toEqual([]);
  });

  it('devolve lista vazia com storage null (render no servidor)', () => {
    expect(readRecents(null, USER)).toEqual([]);
  });

  it('devolve lista vazia — sem estourar — quando getItem falha', () => {
    const storage = createThrowingStorage();

    expect(() => readRecents(storage, USER)).not.toThrow();
    expect(readRecents(storage, USER)).toEqual([]);
  });

  it.each(['{', 'nao é json', '[]', 'null', '"texto"', '42'])(
    'devolve lista vazia com blob inválido (%s)',
    (raw) => {
      const storage = createFakeStorage({ [recentsKey(USER)]: raw });

      expect(readRecents(storage, USER)).toEqual([]);
    }
  );

  // Descarte, não migração: são emojis recentes, o custo de perder é
  // um clique a mais, e código de migração aqui nunca seria exercitado.
  it('descarta blob de versão diferente', () => {
    const storage = createFakeStorage({
      [recentsKey(USER)]: storedBlob(
        [{ emoji: THUMBS, label: 'joinha', usedAt: 1 }],
        99
      ),
    });

    expect(readRecents(storage, USER)).toEqual([]);
  });

  it('devolve lista vazia quando items não é array', () => {
    const storage = createFakeStorage({
      [recentsKey(USER)]: JSON.stringify({ version: 1, items: 'nope' }),
    });

    expect(readRecents(storage, USER)).toEqual([]);
  });

  it('filtra entradas malformadas sem invalidar as válidas', () => {
    const storage = createFakeStorage({
      [recentsKey(USER)]: storedBlob([
        { emoji: THUMBS, label: 'joinha', usedAt: 3 },
        null,
        {},
        { emoji: 1, label: 'numero', usedAt: 2 },
        { emoji: CHECK, label: '', usedAt: 2 },
        { emoji: '', label: 'vazio', usedAt: 2 },
        { emoji: PRAY, label: 'oracao', usedAt: Number.NaN },
        { emoji: CHECK, label: 'check', usedAt: 1 },
      ]),
    });

    expect(readRecents(storage, USER)).toEqual([
      { emoji: THUMBS, label: 'joinha', usedAt: 3 },
      { emoji: CHECK, label: 'check', usedAt: 1 },
    ]);
  });

  // A faixa de recentes usa o caractere como `key` do React —
  // duplicata vinda de blob editado à mão ou merge de duas abas é bug
  // de renderização, não aviso cosmético.
  it('deduplica na leitura, preservando a primeira ocorrência', () => {
    const storage = createFakeStorage({
      [recentsKey(USER)]: storedBlob([
        { emoji: THUMBS, label: 'primeiro', usedAt: 3 },
        { emoji: THUMBS, label: 'duplicado', usedAt: 2 },
        { emoji: CHECK, label: 'check', usedAt: 1 },
      ]),
    });

    expect(readRecents(storage, USER)).toEqual([
      { emoji: THUMBS, label: 'primeiro', usedAt: 3 },
      { emoji: CHECK, label: 'check', usedAt: 1 },
    ]);
  });

  it('aplica o teto mesmo num blob adulterado com itens demais', () => {
    const items = Array.from({ length: MAX_RECENTS + 10 }, (_, i) => ({
      emoji: `e${i}`,
      label: `label ${i}`,
      usedAt: i,
    }));
    const storage = createFakeStorage({
      [recentsKey(USER)]: storedBlob(items),
    });

    expect(readRecents(storage, USER)).toHaveLength(MAX_RECENTS);
  });

  it('não deixa chave extra de blob editado à mão vazar para o estado', () => {
    const storage = createFakeStorage({
      [recentsKey(USER)]: storedBlob([
        { emoji: THUMBS, label: 'joinha', usedAt: 1, malicioso: '<script>' },
      ]),
    });

    expect(readRecents(storage, USER)).toEqual([
      { emoji: THUMBS, label: 'joinha', usedAt: 1 },
    ]);
  });
});

describe('pushRecent', () => {
  it('registra o primeiro uso preservando emoji e rótulo', () => {
    const storage = createFakeStorage();

    const result = pushRecent(
      storage,
      USER,
      { emoji: THUMBS, label: 'joinha' },
      1_000
    );

    expect(result).toEqual([{ emoji: THUMBS, label: 'joinha', usedAt: 1_000 }]);
    expect(readRecents(storage, USER)).toEqual(result);
  });

  it('ordena por uso mais recente e deduplica (MRU)', () => {
    const storage = createFakeStorage();

    pushRecent(storage, USER, { emoji: THUMBS, label: 'joinha' }, 1);
    pushRecent(storage, USER, { emoji: CHECK, label: 'check' }, 2);
    const result = pushRecent(
      storage,
      USER,
      { emoji: THUMBS, label: 'joinha' },
      3
    );

    expect(result.map((r) => r.emoji)).toEqual([THUMBS, CHECK]);
    expect(result[0].usedAt).toBe(3);
  });

  // 👍 e 👍🏽 são caracteres diferentes e o atendente escolheu cada um.
  it('trata tons de pele diferentes como entradas separadas', () => {
    const storage = createFakeStorage();

    pushRecent(storage, USER, { emoji: THUMBS, label: 'joinha' }, 1);
    const result = pushRecent(
      storage,
      USER,
      { emoji: THUMBS_MEDIUM, label: 'joinha tom medio' },
      2
    );

    expect(result.map((r) => r.emoji)).toEqual([THUMBS_MEDIUM, THUMBS]);
  });

  it('respeita o teto e descarta o mais antigo', () => {
    const storage = createFakeStorage();

    for (let i = 0; i < MAX_RECENTS + 5; i++) {
      pushRecent(storage, USER, { emoji: `e${i}`, label: `label ${i}` }, i);
    }

    const result = readRecents(storage, USER);
    expect(result).toHaveLength(MAX_RECENTS);
    expect(result[0].emoji).toBe(`e${MAX_RECENTS + 4}`);
    expect(result.map((r) => r.emoji)).not.toContain('e0');
  });

  // Sem o fallback de rótulo, gravaríamos uma entrada que a leitura
  // seguinte rejeita — e a faixa de recentes nunca cresceria.
  it('usa o próprio caractere quando o rótulo vem vazio', () => {
    const storage = createFakeStorage();

    const result = pushRecent(storage, USER, { emoji: THUMBS, label: '' }, 1);

    expect(result).toEqual([{ emoji: THUMBS, label: THUMBS, usedAt: 1 }]);
    expect(readRecents(storage, USER)).toEqual(result);
  });

  it('ignora emoji sem caractere, devolvendo a lista atual', () => {
    const storage = createFakeStorage();
    pushRecent(storage, USER, { emoji: THUMBS, label: 'joinha' }, 1);

    const result = pushRecent(storage, USER, { emoji: '', label: 'vazio' }, 2);

    expect(result).toEqual([{ emoji: THUMBS, label: 'joinha', usedAt: 1 }]);
  });

  // O refactor que extraiu `mergeRecent` (achado de code review) não
  // pode reintroduzir uma gravação redundante aqui: emoji inválido não
  // muda a lista, então não há por que tocar o storage.
  it('não grava no storage quando o emoji é inválido', () => {
    const storage = createFakeStorage();
    const setItem = vi.spyOn(storage, 'setItem');
    pushRecent(storage, USER, { emoji: THUMBS, label: 'joinha' }, 1);
    setItem.mockClear();

    pushRecent(storage, USER, { emoji: '', label: 'vazio' }, 2);

    expect(setItem).not.toHaveBeenCalled();
  });

  // A UI confia no retorno para não reler o storage — precisa seguir
  // correta mesmo quando a gravação falha por cota.
  it('devolve a lista atualizada mesmo quando a gravação estoura', () => {
    const result = pushRecent(
      createThrowingStorage(),
      USER,
      { emoji: THUMBS, label: 'joinha' },
      1
    );

    expect(result).toEqual([{ emoji: THUMBS, label: 'joinha', usedAt: 1 }]);
  });

  it('não estoura com storage null', () => {
    expect(() =>
      pushRecent(null, USER, { emoji: THUMBS, label: 'joinha' }, 1)
    ).not.toThrow();
  });

  it('devolve exatamente o que a leitura seguinte produziria', () => {
    const storage = createFakeStorage();

    pushRecent(storage, USER, { emoji: THUMBS, label: 'joinha' }, 1);
    const returned = pushRecent(
      storage,
      USER,
      { emoji: CHECK, label: 'check' },
      2
    );

    expect(returned).toEqual(readRecents(storage, USER));
  });

  it('isola a lista por usuário', () => {
    const storage = createFakeStorage();

    pushRecent(storage, 'user-a', { emoji: THUMBS, label: 'joinha' }, 1);
    pushRecent(storage, 'user-b', { emoji: CHECK, label: 'check' }, 1);

    expect(readRecents(storage, 'user-a').map((r) => r.emoji)).toEqual([
      THUMBS,
    ]);
    expect(readRecents(storage, 'user-b').map((r) => r.emoji)).toEqual([CHECK]);
  });

  it('usa Date.now() quando o horário não é injetado', () => {
    const storage = createFakeStorage();
    const before = Date.now();

    const [entry] = pushRecent(storage, USER, {
      emoji: THUMBS,
      label: 'joinha',
    });

    expect(entry.usedAt).toBeGreaterThanOrEqual(before);
    expect(entry.usedAt).toBeLessThanOrEqual(Date.now());
  });
});

// Extraída de `pushRecent` para que `useEmojiRecents()` funda um pick
// sobre o estado em memória sem reler o storage a cada clique (achado
// de code review). `pushRecent` acima já cobre o comportamento
// combinado (leitura + merge + gravação); estes testes cobrem a
// função pura isolada, sem storage.
describe('mergeRecent', () => {
  it('insere o primeiro item numa lista vazia', () => {
    const result = mergeRecent([], { emoji: THUMBS, label: 'joinha' }, 1);

    expect(result).toEqual([{ emoji: THUMBS, label: 'joinha', usedAt: 1 }]);
  });

  it('reordena MRU e deduplica', () => {
    const current = [
      { emoji: THUMBS, label: 'joinha', usedAt: 1 },
      { emoji: CHECK, label: 'check', usedAt: 2 },
    ];

    const result = mergeRecent(current, { emoji: THUMBS, label: 'joinha' }, 3);

    expect(result.map((r) => r.emoji)).toEqual([THUMBS, CHECK]);
    expect(result[0].usedAt).toBe(3);
  });

  it('respeita o teto, descartando o mais antigo', () => {
    // MRU: índice 0 é o MAIS recente. `e0` foi o primeiro escolhido
    // (mais antigo), então fica por ÚLTIMO na lista — é ele que deve
    // sair quando o teto for excedido.
    const current = Array.from({ length: MAX_RECENTS }, (_, i) => ({
      emoji: `e${MAX_RECENTS - 1 - i}`,
      label: `label ${MAX_RECENTS - 1 - i}`,
      usedAt: MAX_RECENTS - 1 - i,
    }));
    expect(current.at(-1)?.emoji).toBe('e0');

    const result = mergeRecent(current, { emoji: 'novo', label: 'novo' }, 999);

    expect(result).toHaveLength(MAX_RECENTS);
    expect(result[0].emoji).toBe('novo');
    expect(result.map((r) => r.emoji)).not.toContain('e0');
  });

  // O sinal que `pushRecent` e o hook usam para decidir se vale a pena
  // gravar: emoji sem caractere não produz lista nova.
  it('devolve a MESMA referência quando o emoji não tem caractere', () => {
    const current = [{ emoji: THUMBS, label: 'joinha', usedAt: 1 }];

    const result = mergeRecent(current, { emoji: '', label: 'vazio' }, 2);

    expect(result).toBe(current);
  });

  it('usa Date.now() quando o horário não é injetado', () => {
    const before = Date.now();

    const [entry] = mergeRecent([], { emoji: THUMBS, label: 'joinha' });

    expect(entry.usedAt).toBeGreaterThanOrEqual(before);
    expect(entry.usedAt).toBeLessThanOrEqual(Date.now());
  });
});

describe('clearRecents', () => {
  it('esvazia a lista do usuário', () => {
    const storage = createFakeStorage();
    pushRecent(storage, USER, { emoji: THUMBS, label: 'joinha' }, 1);

    clearRecents(storage, USER);

    expect(readRecents(storage, USER)).toEqual([]);
  });

  it('não afeta outros usuários', () => {
    const storage = createFakeStorage();
    pushRecent(storage, 'user-a', { emoji: THUMBS, label: 'joinha' }, 1);
    pushRecent(storage, 'user-b', { emoji: CHECK, label: 'check' }, 1);

    clearRecents(storage, 'user-a');

    expect(readRecents(storage, 'user-a')).toEqual([]);
    expect(readRecents(storage, 'user-b')).toHaveLength(1);
  });

  it('não estoura com storage null nem quando removeItem falha', () => {
    expect(() => clearRecents(null, USER)).not.toThrow();
    expect(() => clearRecents(createThrowingStorage(), USER)).not.toThrow();
  });
});
