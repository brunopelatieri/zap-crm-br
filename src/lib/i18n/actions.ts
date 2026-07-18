"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

import { LOCALE_COOKIE, isAppLocale, type AppLocale } from "@/lib/i18n/locales";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * Persists the user's language choice to the `NEXT_LOCALE` cookie and
 * re-renders the app from the root so `src/i18n/request.ts` picks up
 * the new locale on the very next request — no hard reload, same UX
 * as the theme/mode toggle already has for its own client state.
 *
 * Device-scoped by design (v1): no `profiles.locale` column, no
 * migration. Mirrors how `useTheme` persists mode/accent today.
 */
export async function setLocaleAction(locale: AppLocale): Promise<void> {
  if (!isAppLocale(locale)) {
    // Defensive — the switcher only ever passes a value from
    // SUPPORTED_LOCALES, but a stale client bundle after a deploy
    // could still send something we no longer support.
    return;
  }

  const cookieStore = await cookies();
  cookieStore.set(LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
    sameSite: "lax",
  });

  revalidatePath("/", "layout");
}
