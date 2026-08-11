import { describe, expect, it } from 'vitest';
import {
  isValidTemplateName,
  sanitizeTemplateName,
  tidyTemplateName,
} from './template-name';
import { TEMPLATE_LIMITS } from './template-validators';

describe('sanitizeTemplateName', () => {
  it('leaves an already-valid name untouched', () => {
    const result = sanitizeTemplateName('order_confirmation_v2');
    expect(result.value).toBe('order_confirmation_v2');
    expect(result.fixes).toEqual([]);
  });

  it('lowercases, strips accents and replaces spaces', () => {
    const result = sanitizeTemplateName('Confirmação de Pedido');
    expect(result.value).toBe('confirmacao_de_pedido');
    expect(result.fixes).toEqual(['uppercase', 'accents', 'separators']);
  });

  it('turns punctuation and emoji into underscores instead of dropping them', () => {
    expect(sanitizeTemplateName('promo-50%!').value).toBe('promo_50__');
    expect(sanitizeTemplateName('festa🎉').value).toBe('festa_');
  });

  it('handles cedilla and tilde without changing the character count', () => {
    const result = sanitizeTemplateName('ação');
    expect(result.value).toBe('acao');
    expect(result.fixes).toEqual(['accents']);
  });

  it('maps the caret onto the sanitized value', () => {
    // Caret sits right after "Olá " (4 UTF-16 units) → after "ola_".
    expect(sanitizeTemplateName('Olá mundo', 4).caret).toBe(4);
    // A surrogate pair counts as 2 units in, 1 char out.
    expect(sanitizeTemplateName('a🎉b', 3).caret).toBe(2);
    expect(sanitizeTemplateName('abc', 0).caret).toBe(0);
  });

  it('truncates past the Meta limit and reports it', () => {
    const result = sanitizeTemplateName(
      'a'.repeat(TEMPLATE_LIMITS.nameMaxLength + 10)
    );
    expect(result.value).toHaveLength(TEMPLATE_LIMITS.nameMaxLength);
    expect(result.fixes).toContain('truncated');
    expect(result.caret).toBe(TEMPLATE_LIMITS.nameMaxLength);
  });

  it('always produces a value the server validator accepts', () => {
    for (const raw of ['Olá, Mundo!', 'ÁÉÍÓÚ çÇ', '   ', '日本語 テスト']) {
      expect(sanitizeTemplateName(raw).value).toMatch(/^[a-z0-9_]*$/);
    }
  });
});

describe('tidyTemplateName', () => {
  it('collapses underscore runs and trims the edges', () => {
    expect(tidyTemplateName('__promo_50____off__')).toBe('promo_50_off');
  });
  it('leaves a clean name alone', () => {
    expect(tidyTemplateName('order_confirmation')).toBe('order_confirmation');
  });
  it('can empty out a name made only of separators', () => {
    expect(tidyTemplateName('___')).toBe('');
  });
});

describe('isValidTemplateName', () => {
  it('rejects an empty name', () => {
    expect(isValidTemplateName('')).toBe(false);
  });
  it('accepts what the mask produces', () => {
    expect(
      isValidTemplateName(tidyTemplateName(sanitizeTemplateName('Olá!').value))
    ).toBe(true);
  });
});
