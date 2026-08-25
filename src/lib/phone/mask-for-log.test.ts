import { describe, expect, it } from 'vitest';

import { maskPhoneForLog } from './mask-for-log';

describe('maskPhoneForLog', () => {
  it('returns an em dash for null/undefined/empty', () => {
    expect(maskPhoneForLog(null)).toBe('—');
    expect(maskPhoneForLog(undefined)).toBe('—');
    expect(maskPhoneForLog('')).toBe('—');
  });

  it('masks every digit when there are 6 or fewer', () => {
    expect(maskPhoneForLog('12345')).toBe('*****');
    expect(maskPhoneForLog('123456')).toBe('******');
  });

  it('keeps the first 4 and last 2 digits visible, masking the middle', () => {
    // 5519992496598 — 13 dígitos. Mantém os 4 primeiros (5519) e os 2
    // últimos (98); mascara os 7 do meio.
    expect(maskPhoneForLog('5519992496598')).toBe('5519*******98');
  });

  it('preserves non-digit formatting characters at their original positions', () => {
    // "+55 (19) 99249-6598" — os parênteses/espaço/traço não são
    // dígitos e não entram na contagem de posição a mascarar.
    const result = maskPhoneForLog('+55 (19) 99249-6598');
    expect(result).toBe('+55 (19) *****-**98');
  });

  it('never changes the string length', () => {
    const input = '+55 (19) 99249-6598';
    expect(maskPhoneForLog(input)).toHaveLength(input.length);
  });
});
