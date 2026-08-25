import { describe, expect, it } from 'vitest';

import {
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
  evaluatePassword,
  isPasswordValid,
  normalizePassword,
  passwordsMatch,
} from './password-policy';

const VALID = 'Café123!'; // accented letter + upper + lower + digit + symbol

describe('evaluatePassword', () => {
  it('passes a password that satisfies every rule', () => {
    const result = evaluatePassword(VALID);
    expect(result).toEqual({
      minLength: true,
      maxBytes: true,
      hasUppercase: true,
      hasLowercase: true,
      hasNumber: true,
      hasSpecialChar: true,
      noControlChars: true,
    });
    expect(isPasswordValid(result)).toBe(true);
  });

  it('fails minLength under 8 characters', () => {
    const result = evaluatePassword('Ab1!');
    expect(result.minLength).toBe(false);
    expect(isPasswordValid(result)).toBe(false);
  });

  it('passes minLength at exactly the boundary', () => {
    expect(evaluatePassword('Abcdefg1!').minLength).toBe(true); // 9 chars
    expect(evaluatePassword('Abcdef1!').minLength).toBe(true); // exactly 8
    expect(evaluatePassword('Abcde1!').minLength).toBe(false); // 7 chars
  });

  it('flags each missing character class independently', () => {
    expect(evaluatePassword('lowercase1!').hasUppercase).toBe(false);
    expect(evaluatePassword('UPPERCASE1!').hasLowercase).toBe(false);
    expect(evaluatePassword('NoDigitsHere!').hasNumber).toBe(false);
    expect(evaluatePassword('NoSpecialChar123').hasSpecialChar).toBe(false);
  });

  it('recognizes every character in the documented special-char set', () => {
    const specials = '!@#$%^&*()_+-=[]{}:;,.?/~';
    for (const char of specials) {
      const result = evaluatePassword(`Abcdefg1${char}`);
      expect(result.hasSpecialChar).toBe(true);
    }
  });

  it('does not accept the symbols deliberately excluded by D-3', () => {
    // Backslash, quotes, pipe, backtick, angle brackets — Supabase's own
    // "Symbols" class accepts these, but SPEC 054 D-3 excludes them.
    const excluded = ['\\', "'", '"', '|', '`', '<', '>'];
    for (const char of excluded) {
      const result = evaluatePassword(`Abcdefg1${char}`);
      expect(result.hasSpecialChar).toBe(false);
    }
  });

  it('rejects a password over 72 UTF-8 bytes (bcrypt truncation, D-4)', () => {
    const longAscii = 'Ab1!'.padEnd(73, 'x'); // 73 single-byte chars
    expect(evaluatePassword(longAscii).maxBytes).toBe(false);
  });

  it('accepts a password at exactly 72 bytes', () => {
    const exactAscii = 'Ab1!'.padEnd(72, 'x');
    expect(new TextEncoder().encode(exactAscii).length).toBe(72);
    expect(evaluatePassword(exactAscii).maxBytes).toBe(true);
  });

  it('counts accented characters as multiple UTF-8 bytes, not 1 char = 1 byte', () => {
    // 'á' is 2 bytes in UTF-8. 40 of them = 80 bytes, over the 72-byte cap,
    // even though .length would report only 40 characters.
    const accented = 'á'.repeat(40);
    expect(accented.length).toBe(40);
    expect(new TextEncoder().encode(accented).length).toBe(80);
    expect(evaluatePassword(accented).maxBytes).toBe(false);
  });

  it('rejects a null byte and other control characters in the middle (D-5)', () => {
    // Placed mid-string, not at the edges: a control char at the very end
    // would be whitespace-adjacent trimming territory for some of these
    // (e.g. tab) — the real test is that an interior control char, which
    // normalizePassword's trim() can never remove, still gets caught.
    const withNull = 'Abcd' + String.fromCharCode(0) + 'efg1!';
    const withTab = 'Abcd' + String.fromCharCode(9) + 'efg1!';
    const withDel = 'Abcd' + String.fromCharCode(127) + 'efg1!';
    expect(evaluatePassword(withNull).noControlChars).toBe(false);
    expect(evaluatePassword(withTab).noControlChars).toBe(false);
    expect(evaluatePassword(withDel).noControlChars).toBe(false);
  });

  it('trims a trailing whitespace-like control character (tab) away entirely', () => {
    // Documents the actual behavior at the edges: trim() removes tab like
    // any other whitespace before the control-char check ever runs, so a
    // stray trailing tab (e.g. from a copy-paste) doesn't reject the
    // password — it's just discarded, same as a stray trailing space.
    const trailingTab = 'Abcdefg1!' + String.fromCharCode(9);
    expect(evaluatePassword(trailingTab).noControlChars).toBe(true);
    expect(normalizePassword(trailingTab)).toBe('Abcdefg1!');
  });

  it('allows a space in the middle (passphrase style, D-6)', () => {
    const result = evaluatePassword('Cafe Quente 123!');
    expect(result.noControlChars).toBe(true);
    expect(isPasswordValid(result)).toBe(true);
  });

  it('evaluates the trimmed form, so trailing spaces cannot fake minLength', () => {
    // 8 spaces alone reach PASSWORD_MIN_LENGTH untrimmed, but normalize to
    // an empty string — the meter and the real submitted value must agree.
    const spacesOnly = ' '.repeat(PASSWORD_MIN_LENGTH);
    expect(spacesOnly.length).toBe(PASSWORD_MIN_LENGTH);
    expect(evaluatePassword(spacesOnly).minLength).toBe(false);
  });
});

describe('normalizePassword', () => {
  it('trims leading and trailing whitespace', () => {
    expect(normalizePassword('  Café123!  ')).toBe('Café123!');
  });

  it('does not trim internal spaces', () => {
    expect(normalizePassword('  Cafe Quente 123!  ')).toBe('Cafe Quente 123!');
  });

  it('normalizes decomposed accents to their precomposed NFC form', () => {
    // 'é' as a base letter 'e' (U+0065) + combining acute accent (U+0301)
    // — two code points that render identically to the single precomposed
    // 'é' (U+00E9) but would otherwise hash differently.
    const decomposed = 'e' + String.fromCharCode(0x0301);
    const precomposed = String.fromCharCode(0x00e9);
    expect(decomposed).not.toBe(precomposed);
    expect(normalizePassword(decomposed)).toBe(precomposed);
  });

  it('is idempotent', () => {
    const once = normalizePassword('  Café123!  ');
    expect(normalizePassword(once)).toBe(once);
  });
});

describe('passwordsMatch', () => {
  it('treats a password and confirmation as matching after trimming', () => {
    // Regression: comparing raw values here disabled the submit button
    // over an invisible whitespace difference in password fields, with
    // no error message able to explain why. See SPEC 054 code review.
    expect(passwordsMatch('Abcdef1! ', 'Abcdef1!')).toBe(true);
    expect(passwordsMatch(' Abcdef1!', 'Abcdef1!  ')).toBe(true);
  });

  it('treats decomposed and precomposed accents as matching', () => {
    const decomposed = 'e' + String.fromCharCode(0x0301);
    const precomposed = String.fromCharCode(0x00e9);
    expect(passwordsMatch(decomposed, precomposed)).toBe(true);
  });

  it('is false when the passwords genuinely differ', () => {
    expect(passwordsMatch('Abcdef1!', 'Abcdef2!')).toBe(false);
  });

  it('is false when one side is empty and the other is not', () => {
    expect(passwordsMatch('', 'Abcdef1!')).toBe(false);
    expect(passwordsMatch('   ', 'Abcdef1!')).toBe(false);
  });

  it('is true when both sides are empty or whitespace-only', () => {
    expect(passwordsMatch('', '')).toBe(true);
    expect(passwordsMatch('   ', '')).toBe(true);
  });
});

describe('isPasswordValid', () => {
  it('is false if any single rule fails', () => {
    const base = evaluatePassword(VALID);
    expect(isPasswordValid(base)).toBe(true);
    for (const key of Object.keys(base) as Array<keyof typeof base>) {
      expect(isPasswordValid({ ...base, [key]: false })).toBe(false);
    }
  });
});

// Documents the constants' relationship for anyone tuning them later.
describe('exported constants', () => {
  it('PASSWORD_MIN_LENGTH and PASSWORD_MAX_BYTES are sane', () => {
    expect(PASSWORD_MIN_LENGTH).toBeGreaterThan(0);
    expect(PASSWORD_MAX_BYTES).toBeGreaterThanOrEqual(PASSWORD_MIN_LENGTH);
  });
});
