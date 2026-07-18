import { getRequestConfig } from 'next-intl/server';
import { cookies } from 'next/headers';

import { DEFAULT_LOCALE, LOCALE_COOKIE, isAppLocale } from '@/lib/i18n/locales';

// Locale resolution, in priority order:
//   1. The `NEXT_LOCALE` cookie — set by `setLocaleAction` when the
//      user picks a language in Settings → Appearance. Device-scoped,
//      no [locale] URL segment (the whole app is behind auth and
//      `robots: { index: false }`, so URL-based locale routing buys
//      us nothing).
//   2. `NEXT_PUBLIC_APP_LOCALE` — the deployment's default for a
//      visitor who hasn't chosen a language yet (e.g. first visit,
//      or a browser that blocks cookies).
//   3. `DEFAULT_LOCALE` ('en') as the last resort.
//
// Both cookie and env values are validated against `isAppLocale`
// before use, so a stale/invalid value (e.g. a locale that no longer
// has a `messages/*.json` file) can never trigger a failed dynamic
// import — this is what caused the "Module not found" warning when
// `.env.local` pointed at a locale with no matching dictionary yet.
export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get(LOCALE_COOKIE)?.value;
  const envLocale = process.env.NEXT_PUBLIC_APP_LOCALE;

  const locale = isAppLocale(cookieLocale)
    ? cookieLocale
    : isAppLocale(envLocale)
      ? envLocale
      : DEFAULT_LOCALE;

  const messages = (await import(`../../messages/${locale}.json`)).default;

  return {
    locale,
    messages,
  };
});
