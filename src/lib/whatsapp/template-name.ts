/**
 * Input mask for the Meta template `name` field.
 *
 * Meta only accepts `^[a-z0-9_]{1,512}$` — no uppercase, no accents, no
 * spaces, no punctuation. Rather than letting the user type freely and
 * bouncing the form (or, worse, the Meta API) later, the create dialog
 * rewrites the value on every keystroke and reports which rules fired
 * so the correction is visible instead of silent.
 *
 * Two design constraints shape the mapping:
 *
 *  1. Every input code point produces exactly ONE output character
 *     (invalid ones become `_` instead of vanishing). That keeps the
 *     caret math a simple prefix count, so editing in the middle of the
 *     name doesn't kick the cursor to the end — and nothing the user
 *     typed disappears without a trace.
 *  2. Cosmetic clean-up that isn't 1:1 (collapsing `__`, trimming edge
 *     underscores) is deferred to blur via `tidyTemplateName`, where
 *     there is no caret to preserve.
 */

import { TEMPLATE_LIMITS } from './template-validators';

export type TemplateNameFix =
  'uppercase' | 'accents' | 'separators' | 'truncated';

/** Stable display order, independent of which rule fired first. */
const FIX_ORDER: TemplateNameFix[] = [
  'uppercase',
  'accents',
  'separators',
  'truncated',
];

const ALLOWED_CHAR = /^[a-z0-9_]$/;
/**
 * Unicode combining marks (U+0300–U+036F) — the accent half of a
 * decomposed letter. Built from a string so the escapes stay readable
 * in source; `\p{M}` would need an ES2018 regex target.
 */
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');

export interface SanitizedTemplateName {
  /** Meta-safe value. Always matches `[a-z0-9_]*`. */
  value: string;
  /** Caret offset in `value` equivalent to the one given for the raw input. */
  caret: number;
  /** Rules that had to fire, for the "we adjusted this" hint. */
  fixes: TemplateNameFix[];
}

function mapCodePoint(cp: string, fixes: Set<TemplateNameFix>): string {
  if (ALLOWED_CHAR.test(cp)) return cp;

  // Accented Latin letters decompose into base letter + combining
  // marks, so dropping the marks turns "ã" into "a" and "Ç" into "C".
  const stripped = cp.normalize('NFD').replace(COMBINING_MARKS, '');
  const lowered = stripped.toLowerCase();
  // A few code points lowercase into two characters (e.g. "İ" → "i̇");
  // the base letter is the first one.
  const candidate = lowered.slice(0, 1);

  if (ALLOWED_CHAR.test(candidate)) {
    if (stripped !== cp) fixes.add('accents');
    if (lowered !== stripped) fixes.add('uppercase');
    return candidate;
  }

  // Spaces, punctuation, emoji, CJK — anything with no ASCII base.
  fixes.add('separators');
  return '_';
}

/**
 * Rewrite raw input into a Meta-safe template name.
 *
 * @param caretPosition caret offset in `raw` (UTF-16 units, as reported
 * by `input.selectionStart`). Defaults to the end of the string.
 */
export function sanitizeTemplateName(
  raw: string,
  caretPosition: number = raw.length
): SanitizedTemplateName {
  const fired = new Set<TemplateNameFix>();
  let value = '';
  let caret = 0;
  let consumed = 0;

  // `for…of` iterates code points, so surrogate pairs (emoji) count as
  // one character — but `consumed` tracks UTF-16 units to stay
  // comparable with `selectionStart`.
  for (const cp of raw) {
    value += mapCodePoint(cp, fired);
    consumed += cp.length;
    if (consumed <= caretPosition) caret = value.length;
  }

  if (value.length > TEMPLATE_LIMITS.nameMaxLength) {
    value = value.slice(0, TEMPLATE_LIMITS.nameMaxLength);
    fired.add('truncated');
  }

  return {
    value,
    caret: Math.min(caret, value.length),
    fixes: FIX_ORDER.filter((fix) => fired.has(fix)),
  };
}

/**
 * Blur-time clean-up: collapse the runs of `_` left behind by "olá,
 * mundo!" and drop the ones at the edges. Meta would accept them, but
 * they read like a mistake.
 */
export function tidyTemplateName(value: string): string {
  return value
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, TEMPLATE_LIMITS.nameMaxLength);
}

/** Mirror of the server-side rule, for enabling/disabling the submit. */
export function isValidTemplateName(value: string): boolean {
  return TEMPLATE_LIMITS.nameRegex.test(value);
}
