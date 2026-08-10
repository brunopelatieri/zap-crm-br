import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MARGIN_MINUTES,
  MAX_MARGIN_MINUTES,
  MIN_MARGIN_MINUTES,
  isValidMarginMinutes,
  resolveMarginMinutes,
} from './window-trigger';

describe('isValidMarginMinutes', () => {
  it('accepts whole minutes inside the band', () => {
    expect(isValidMarginMinutes(MIN_MARGIN_MINUTES)).toBe(true);
    expect(isValidMarginMinutes(DEFAULT_MARGIN_MINUTES)).toBe(true);
    expect(isValidMarginMinutes(MAX_MARGIN_MINUTES)).toBe(true);
  });

  it('refuses anything outside the band, fractional, or not a number', () => {
    expect(isValidMarginMinutes(MIN_MARGIN_MINUTES - 1)).toBe(false);
    expect(isValidMarginMinutes(MAX_MARGIN_MINUTES + 1)).toBe(false);
    expect(isValidMarginMinutes(30.5)).toBe(false);
    expect(isValidMarginMinutes('240')).toBe(false);
    expect(isValidMarginMinutes(null)).toBe(false);
  });
});

describe('resolveMarginMinutes', () => {
  it('falls back to the default when absent or unusable', () => {
    expect(resolveMarginMinutes({})).toBe(DEFAULT_MARGIN_MINUTES);
    expect(resolveMarginMinutes(null)).toBe(DEFAULT_MARGIN_MINUTES);
    expect(resolveMarginMinutes({ margin_minutes: '240' })).toBe(
      DEFAULT_MARGIN_MINUTES
    );
    expect(resolveMarginMinutes({ margin_minutes: Number.NaN })).toBe(
      DEFAULT_MARGIN_MINUTES
    );
  });

  it('clamps instead of throwing — this is the execution path', () => {
    // Uma automação JÁ ATIVA com valor estranho (gravado antes da
    // validação existir, ou por escrita direta no banco) precisa fazer
    // algo sensato: derrubar a varredura puniria as outras contas.
    expect(resolveMarginMinutes({ margin_minutes: 1 })).toBe(
      MIN_MARGIN_MINUTES
    );
    expect(resolveMarginMinutes({ margin_minutes: 99_999 })).toBe(
      MAX_MARGIN_MINUTES
    );
    expect(resolveMarginMinutes({ margin_minutes: -5 })).toBe(
      MIN_MARGIN_MINUTES
    );
  });

  it('rounds fractional values to whole minutes', () => {
    expect(resolveMarginMinutes({ margin_minutes: 30.4 })).toBe(30);
    expect(resolveMarginMinutes({ margin_minutes: 30.6 })).toBe(31);
  });

  it('passes valid values through untouched', () => {
    expect(resolveMarginMinutes({ margin_minutes: 120 })).toBe(120);
  });
});
