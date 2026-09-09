import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SUPPORTED_LOCALES } from '@/lib/i18n/locales';

import {
  EMOJI_LOCALE_BY_APP_LOCALE,
  FALLBACK_EMOJI_LOCALE,
  REQUIRED_EMOJIBASE_LOCALES,
  toEmojiLocale,
} from './locale';

describe('toEmojiLocale', () => {
  // O caso que justifica o módulo existir: a Emojibase não publica
  // `pt-BR`, e passar o locale cru faria o Frimousse cair no inglês.
  it('mapeia pt-BR para pt (a Emojibase não tem pt-BR)', () => {
    expect(toEmojiLocale('pt-BR')).toBe('pt');
  });

  it('mapeia en para en', () => {
    expect(toEmojiLocale('en')).toBe('en');
  });

  it.each([undefined, null, '', 'xx-YY', 'pt', 'PT-br', 'pt_BR'])(
    'cai no fallback para %o',
    (value) => {
      expect(toEmojiLocale(value)).toBe(FALLBACK_EMOJI_LOCALE);
    }
  );

  // Indexar o Record cru devolveria a função herdada do prototype
  // para estas chaves, e o `??` nem chegaria a rodar.
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'não confunde a chave de prototype %s com um locale',
    (value) => {
      expect(toEmojiLocale(value)).toBe(FALLBACK_EMOJI_LOCALE);
    }
  );
});

describe('EMOJI_LOCALE_BY_APP_LOCALE', () => {
  // Nota: a asserção NÃO pode ser "difere do fallback" — `en` mapeia
  // legitimamente para `en`, que é o próprio fallback. O que importa é
  // que o par seja EXPLÍCITO, e não um acidente do `??`.
  it.each(SUPPORTED_LOCALES)(
    'tem par explícito para o locale %s do app',
    (locale) => {
      expect(Object.hasOwn(EMOJI_LOCALE_BY_APP_LOCALE, locale)).toBe(true);

      const mapped = EMOJI_LOCALE_BY_APP_LOCALE[locale];
      expect(typeof mapped).toBe('string');
      expect(mapped.length).toBeGreaterThan(0);
      expect(toEmojiLocale(locale)).toBe(mapped);
    }
  );

  it('não tem entrada sobrando além dos locales do app', () => {
    expect(Object.keys(EMOJI_LOCALE_BY_APP_LOCALE).sort()).toEqual(
      [...SUPPORTED_LOCALES].sort()
    );
  });
});

describe('REQUIRED_EMOJIBASE_LOCALES', () => {
  it('cobre todo locale do app', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(REQUIRED_EMOJIBASE_LOCALES).toContain(
        EMOJI_LOCALE_BY_APP_LOCALE[locale]
      );
    }
  });

  it('não tem duplicatas', () => {
    expect(new Set(REQUIRED_EMOJIBASE_LOCALES).size).toBe(
      REQUIRED_EMOJIBASE_LOCALES.length
    );
  });

  // O guard que a SPEC pediu. `scripts/sync-emojibase.mjs` é `.mjs` e
  // não consegue importar TypeScript, então ele REPETE a lista de
  // locales. Sem esta comparação, adicionar um idioma ao app e
  // esquecer o script manda para produção um picker que dá 404 no
  // dado — falha silenciosa, só visível como spinner eterno.
  it('bate com a lista de locales do scripts/sync-emojibase.mjs', () => {
    const scriptPath = join(process.cwd(), 'scripts', 'sync-emojibase.mjs');
    const source = readFileSync(scriptPath, 'utf8');

    const match = /const LOCALES = \[([\s\S]*?)\]/.exec(source);
    expect(
      match,
      'não achei `const LOCALES = [...]` em scripts/sync-emojibase.mjs — ' +
        'se o script mudou de forma, atualize este teste junto'
    ).not.toBeNull();

    const scriptLocales = [...match![1].matchAll(/'([^']+)'/g)].map(
      (m) => m[1]
    );

    expect(scriptLocales.sort()).toEqual(
      [...REQUIRED_EMOJIBASE_LOCALES].sort()
    );
  });
});
