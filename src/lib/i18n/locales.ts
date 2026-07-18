/**
 * Single source of truth for supported app locales.
 *
 * Adding a new language is a two-step change:
 *   1. Append its tag to `SUPPORTED_LOCALES` below + a label in
 *      `LOCALE_LABELS`.
 *   2. Create `messages/<locale>.json` with the same key tree as
 *      `messages/en.json` (run the parity check in
 *      `scripts/check-i18n-parity.mjs` to confirm nothing's missing).
 *
 * Nothing else needs to know the locale list — `src/i18n/request.ts`,
 * the language switcher, and the locale cookie all import from here.
 */

export const SUPPORTED_LOCALES = ['pt-BR', 'en'] as const;

export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

/** Runtime fallback when cookie and `NEXT_PUBLIC_APP_LOCALE` are absent. */
export const DEFAULT_LOCALE: AppLocale = 'pt-BR';

/**
 * Cookie that persists the user's chosen locale across visits. Read on
 * the server in `src/i18n/request.ts` (before the first byte of HTML)
 * and written by the `setLocaleAction` server action — no `[locale]`
 * URL segment involved, matching next-intl's "without i18n routing"
 * setup.
 */
export const LOCALE_COOKIE = 'NEXT_LOCALE';

export const LOCALE_LABELS: Record<AppLocale, string> = {
  en: 'English',
  'pt-BR': 'Português (Brasil)',
};

export function isAppLocale(
  value: string | null | undefined
): value is AppLocale {
  return !!value && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
