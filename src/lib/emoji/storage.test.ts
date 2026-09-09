import { afterEach, describe, expect, it, vi } from 'vitest';

import { browserStorage } from './storage';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browserStorage', () => {
  // O ambiente do Vitest é `node`: sem `window`, exatamente como no
  // render do servidor e no primeiro render de hidratação.
  it('devolve null quando não há window (servidor)', () => {
    expect(browserStorage()).toBeNull();
  });

  // Chrome com dados de site bloqueados lança SecurityError ao LER a
  // propriedade — não é só o setItem que falha, e é por isso que o
  // acesso está dentro do try.
  it('devolve null quando ler window.localStorage estoura', () => {
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new Error('SecurityError');
      },
    });

    expect(browserStorage()).toBeNull();
  });

  it('devolve o localStorage quando o navegador permite', () => {
    const fake = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };
    vi.stubGlobal('window', { localStorage: fake });

    expect(browserStorage()).toBe(fake);
  });
});
