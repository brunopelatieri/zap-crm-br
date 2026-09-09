// ============================================================
// Locale do app → locale da Emojibase.
//
// A Emojibase NÃO publica `pt-BR`. O mais próximo é `pt` (CLDR), que
// traz alguns rótulos em português europeu ("telemóvel", "autocarro").
// Isso afeta só o texto de BUSCA e o rótulo lido por leitor de tela —
// o emoji renderizado é idêntico — e é infinitamente melhor do que
// cair no inglês, onde um atendente que digita "coração" não acha ❤️.
//
// O mapeamento vive aqui, e não inline no componente, por causa do
// tipo: `Record<AppLocale, EmojiLocale>` obriga toda entrada de
// `SUPPORTED_LOCALES` a ter um par. Um `useLocale() === 'pt-BR' ? 'pt'
// : 'en'` escrito no JSX pareceria idêntico e, no dia em que alguém
// adicionasse `es` ao app, serviria rótulos em inglês em silêncio.
//
// SPEC: docs/spec-066-emoji-picker-inbox.md § Configuração — i18n
// ============================================================

import type { Locale as EmojiLocale } from 'frimousse';

import {
  SUPPORTED_LOCALES,
  isAppLocale,
  type AppLocale,
} from '@/lib/i18n/locales';

export type { EmojiLocale };

/**
 * Par app → Emojibase para cada idioma suportado.
 *
 * `Record<AppLocale, …>`: adicionar um idioma em `SUPPORTED_LOCALES`
 * sem adicioná-lo aqui QUEBRA O TYPECHECK. É de propósito — o modo de
 * falha alternativo (picker em inglês para o idioma novo) é invisível
 * até um usuário reclamar.
 */
export const EMOJI_LOCALE_BY_APP_LOCALE: Record<AppLocale, EmojiLocale> = {
  'pt-BR': 'pt',
  en: 'en',
};

/** Usado quando o locale ativo não é reconhecido (ex.: cookie adulterado). */
export const FALLBACK_EMOJI_LOCALE: EmojiLocale = 'en';

/**
 * Converte o locale ativo do next-intl no `locale` que o Frimousse
 * entende.
 *
 * Passa por `isAppLocale` em vez de indexar o Record direto: indexação
 * crua devolveria a função herdada do prototype para chaves como
 * `'constructor'` ou `'toString'`, e o `??` nem chegaria a rodar. O
 * guard também garante que a única fonte de verdade da lista de
 * idiomas continua sendo `src/lib/i18n/locales.ts`.
 */
export function toEmojiLocale(locale: string | null | undefined): EmojiLocale {
  return isAppLocale(locale)
    ? EMOJI_LOCALE_BY_APP_LOCALE[locale]
    : FALLBACK_EMOJI_LOCALE;
}

/**
 * Locales da Emojibase que `scripts/sync-emojibase.mjs` precisa copiar
 * para `public/emojibase/`.
 *
 * Deduplicado: dois idiomas do app podem mapear para o mesmo dado da
 * Emojibase (um futuro `pt-PT` também usaria `pt`), e copiar duas
 * vezes o mesmo arquivo de ~780 KB não faz sentido.
 *
 * O script é `.mjs` e não consegue importar TypeScript, então ele
 * repete a lista — `locale.test.ts` compara as duas e falha se
 * divergirem, que é o que impede um idioma novo de chegar em produção
 * com 404 no dado do picker.
 */
export const REQUIRED_EMOJIBASE_LOCALES: readonly EmojiLocale[] = [
  ...new Set(
    SUPPORTED_LOCALES.map((locale) => EMOJI_LOCALE_BY_APP_LOCALE[locale])
  ),
];
