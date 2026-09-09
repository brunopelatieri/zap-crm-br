import { describe, expect, it } from 'vitest';

import { createFakeStorage, createThrowingStorage } from './fake-storage';
import {
  DEFAULT_SKIN_TONE,
  SKIN_TONES,
  isSkinTone,
  readSkinTone,
  skinToneKey,
  writeSkinTone,
} from './preferences';

const USER = 'user-1';

describe('skinToneKey', () => {
  it('leva o id do usuário no sufixo', () => {
    expect(skinToneKey(USER)).toBe('zapcrm:emoji:skin-tone:user-1');
  });
});

describe('isSkinTone', () => {
  it.each(SKIN_TONES)('aceita o tom %s', (tone) => {
    expect(isSkinTone(tone)).toBe(true);
  });

  it.each(['roxo', '', 'NONE', 'medium light', null, undefined, 3, {}, []])(
    'rejeita %o',
    (value) => {
      expect(isSkinTone(value)).toBe(false);
    }
  );

  // `in` ou truthy aceitariam estas chaves porque o Record herda do
  // prototype de Object — o teste é por `=== true` justamente por isso.
  it.each(['toString', 'constructor', 'hasOwnProperty', '__proto__'])(
    'rejeita a chave de prototype %s',
    (value) => {
      expect(isSkinTone(value)).toBe(false);
    }
  );
});

describe('readSkinTone / writeSkinTone', () => {
  it('devolve o padrão com storage vazio', () => {
    expect(readSkinTone(createFakeStorage(), USER)).toBe(DEFAULT_SKIN_TONE);
  });

  it.each(SKIN_TONES)('faz ida e volta do tom %s', (tone) => {
    const storage = createFakeStorage();

    writeSkinTone(storage, USER, tone);

    expect(readSkinTone(storage, USER)).toBe(tone);
  });

  it.each(['roxo', '', 'null', 'toString', '{"tone":"dark"}'])(
    'cai no padrão quando o valor gravado é inválido (%s)',
    (stored) => {
      const storage = createFakeStorage({ [skinToneKey(USER)]: stored });

      expect(readSkinTone(storage, USER)).toBe(DEFAULT_SKIN_TONE);
    }
  );

  it('devolve o padrão com storage null (render no servidor)', () => {
    expect(readSkinTone(null, USER)).toBe(DEFAULT_SKIN_TONE);
  });

  it('não propaga erro quando getItem estoura', () => {
    const storage = createThrowingStorage();

    expect(() => readSkinTone(storage, USER)).not.toThrow();
    expect(readSkinTone(storage, USER)).toBe(DEFAULT_SKIN_TONE);
  });

  // Cota estourada / janela privada do Safari: perder a preferência é
  // aceitável, derrubar o composer no meio do atendimento não é.
  it('não propaga erro quando setItem estoura', () => {
    expect(() =>
      writeSkinTone(createThrowingStorage(), USER, 'dark')
    ).not.toThrow();
  });

  it('não estoura ao gravar com storage null', () => {
    expect(() => writeSkinTone(null, USER, 'dark')).not.toThrow();
  });

  // Duas contas na mesma estação é cenário comum em PME.
  it('isola a preferência por usuário', () => {
    const storage = createFakeStorage();

    writeSkinTone(storage, 'user-a', 'dark');
    writeSkinTone(storage, 'user-b', 'light');

    expect(readSkinTone(storage, 'user-a')).toBe('dark');
    expect(readSkinTone(storage, 'user-b')).toBe('light');
    expect(readSkinTone(storage, 'user-c')).toBe(DEFAULT_SKIN_TONE);
  });
});

describe('SKIN_TONES', () => {
  it('lista os seis tons do Frimousse, com o neutro incluído', () => {
    expect(SKIN_TONES).toHaveLength(6);
    expect(SKIN_TONES).toContain('none');
    expect(new Set(SKIN_TONES).size).toBe(SKIN_TONES.length);
  });

  it('tem o padrão entre os tons válidos', () => {
    expect(isSkinTone(DEFAULT_SKIN_TONE)).toBe(true);
  });
});
