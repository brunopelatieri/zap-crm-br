"use client";

import { useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { setLocaleAction } from "@/lib/i18n/actions";
import { SUPPORTED_LOCALES, LOCALE_LABELS, isAppLocale } from "@/lib/i18n/locales";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Language switcher — lives in Settings → Appearance next to the
 * mode/accent controls. Writes the `NEXT_LOCALE` cookie via a server
 * action, then `router.refresh()` re-renders the server tree (root
 * layout re-resolves `getLocale()`/`getMessages()`) with the new
 * dictionary. No `[locale]` URL segment, no hard reload — same
 * "changes live" feel as the theme picker.
 */
export function LanguageSwitcher() {
  const t = useTranslations("Settings.appearance");
  const locale = useLocale();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleChange(value: string | null) {
    if (!value || !isAppLocale(value) || value === locale) return;

    startTransition(async () => {
      await setLocaleAction(value);
      router.refresh();
      toast.success(t("languageChanged", { language: LOCALE_LABELS[value] }));
    });
  }

  return (
    <Select value={locale} onValueChange={handleChange} disabled={isPending}>
      <SelectTrigger
        aria-label={t("language")}
        className="w-full max-w-xs bg-card"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SUPPORTED_LOCALES.map((l) => (
          <SelectItem key={l} value={l}>
            {LOCALE_LABELS[l]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
