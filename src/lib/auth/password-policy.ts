// Single source of truth for the password rules used at signup, password
// reset, and account settings — see docs/spec-054-senha-forte.md.

export const PASSWORD_MIN_LENGTH = 8;

// bcrypt (what Supabase Auth hashes passwords with) silently truncates
// input past 72 bytes — anything typed beyond that never affects the
// hash. Measured in UTF-8 bytes, not `.length` (UTF-16 code units),
// because accented characters common in Portuguese passwords are 2+
// bytes each. See SPEC 054 D-4.
export const PASSWORD_MAX_BYTES = 72;

// A subset of the symbol class Supabase's own "Symbols" password
// requirement accepts (`!@#$%^&*()_+-=[]{};'\:"|<>?,./`~`) — deliberately
// missing quotes, backslash, pipe, backtick and angle brackets. None of
// those are unsafe here (this password is never interpolated into HTML
// or raw SQL), they're just the ones people mistype most or that some
// text fields "helpfully" autocorrect into typographic quotes. Every
// password that passes this check would also pass Supabase's own
// "Symbols" policy if that's ever turned on. See SPEC 054 D-3.
export const PASSWORD_SPECIAL_CHARS = '!@#$%^&*()_+-=[]{}:;,.?/~';

const SPECIAL_CHAR_PATTERN = /[!@#$%^&*()_+\-=[\]{}:;,.?/~]/;

// U+0000–U+001F and U+007F. Postgres rejects a literal null byte
// (U+0000) in a text column outright ("invalid byte sequence"); the
// rest are just never something a human types into a password field on
// purpose. See SPEC 054 D-5.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

export interface PasswordRuleResult {
  minLength: boolean;
  maxBytes: boolean;
  hasUppercase: boolean;
  hasLowercase: boolean;
  hasNumber: boolean;
  hasSpecialChar: boolean;
  noControlChars: boolean;
}

/**
 * Trims surrounding whitespace and applies Unicode NFC normalization.
 *
 * Trimming (SPEC 054 D-6) catches an invisible leading/trailing space
 * picked up from a copy-paste (e.g. out of a password manager) that
 * would otherwise silently become part of the password. NFC (D-5)
 * ensures the "same" accented character typed on different keyboards/OSes
 * (a single precomposed code point vs. a base letter + combining accent)
 * always normalizes to the same byte sequence — otherwise two people
 * could type what looks like an identical password and get different
 * hashes.
 *
 * Callers must apply this to the SAME string before both evaluating the
 * rules below and submitting to Supabase — never validate the raw input
 * and submit a differently-normalized value.
 */
export function normalizePassword(password: string): string {
  return password.trim().normalize('NFC');
}

/**
 * Compares two password inputs the same way Supabase will end up storing
 * and re-deriving them — i.e. after `normalizePassword`, not as raw
 * strings. A password/confirmation pair that differs only by leading or
 * trailing whitespace normalizes to the same value and must be treated
 * as matching; comparing the raw strings instead disables a submit
 * button over a difference the user cannot see (password fields don't
 * reveal whitespace) with no error message able to explain why.
 */
export function passwordsMatch(a: string, b: string): boolean {
  return normalizePassword(a) === normalizePassword(b);
}

/**
 * Evaluates the password rules against the normalized form of `password`
 * (see `normalizePassword`) — callers pass the raw input value; this
 * function normalizes internally so a live strength meter always reflects
 * what would actually be validated and submitted, not the untrimmed
 * keystroke-by-keystroke value.
 */
export function evaluatePassword(password: string): PasswordRuleResult {
  const normalized = normalizePassword(password);
  const byteLength = new TextEncoder().encode(normalized).length;

  return {
    minLength: normalized.length >= PASSWORD_MIN_LENGTH,
    maxBytes: byteLength <= PASSWORD_MAX_BYTES,
    hasUppercase: /[A-Z]/.test(normalized),
    hasLowercase: /[a-z]/.test(normalized),
    hasNumber: /[0-9]/.test(normalized),
    hasSpecialChar: SPECIAL_CHAR_PATTERN.test(normalized),
    noControlChars: !CONTROL_CHAR_PATTERN.test(normalized),
  };
}

export function isPasswordValid(result: PasswordRuleResult): boolean {
  return (
    result.minLength &&
    result.maxBytes &&
    result.hasUppercase &&
    result.hasLowercase &&
    result.hasNumber &&
    result.hasSpecialChar &&
    result.noControlChars
  );
}
