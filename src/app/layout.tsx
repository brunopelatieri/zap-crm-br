import type { Metadata, Viewport } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { Inter } from 'next/font/google';
import Script from 'next/script';
import './globals.css';
import { ThemeProvider } from '@/hooks/use-theme';
import { ThemedToaster } from '@/components/themed-toaster';
import {
  DEFAULT_MODE,
  DEFAULT_THEME,
  MODE_STORAGE_KEY,
  MODES,
  STORAGE_KEY,
  THEME_IDS,
} from '@/lib/themes';

const inter = Inter({
  variable: '--font-sans',
  subsets: ['latin'],
});

// export const metadata: Metadata = {
//   title: {
//     default: 'Zap CRM BR',
//     template: '%s — Zap CRM BR',
//   },
//   description: 'Zap CRM BR template para WhatsApp Brasil.',
//   robots: {
//     index: false,
//     follow: false,
//   },
//   formatDetection: {
//     email: false,
//     address: false,
//     telephone: false,
//   },
// };

// export const viewport: Viewport = {
//   themeColor: '#fafbfc',
//   colorScheme: 'light dark',
// };

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || '';
const SITE_NAME = 'Zap CRM BR';
const SITE_DESCRIPTION =
  'Transforme o WhatsApp da sua empresa em uma máquina de vendas. Caixa de entrada compartilhada, funil de vendas visual, disparos em massa e automações — tudo pelo canal oficial do WhatsApp Business (Meta), sem risco de bloqueio do número.';

// generateMetadata (em vez de `export const metadata` estático) porque
// o layout é locale-aware via next-intl — isso permite refletir o
// locale atual no openGraph e no hreflang de `alternates.languages`.
export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const ogLocale = locale === 'en' ? 'en_US' : 'pt_BR'; // ajuste conforme os locales que seu app suporta

  return {
    metadataBase: new URL(SITE_URL),

    title: {
      default: `${SITE_NAME} — CRM para WhatsApp Business`,
      template: `%s — ${SITE_NAME}`,
    },
    description: SITE_DESCRIPTION,
    keywords: [
      'CRM para WhatsApp',
      'WhatsApp Business API',
      'funil de vendas WhatsApp',
      'disparo em massa WhatsApp',
      'automação WhatsApp',
      'caixa de entrada compartilhada WhatsApp',
      'CRM WhatsApp Brasil',
    ],
    authors: [{ name: SITE_NAME, url: SITE_URL }],
    creator: SITE_NAME,
    publisher: SITE_NAME,
    applicationName: SITE_NAME,
    category: 'technology',

    formatDetection: {
      email: false,
      address: false,
      telephone: false,
    },

    openGraph: {
      type: 'website',
      locale: ogLocale,
      title: `${SITE_NAME} — CRM para WhatsApp Business`,
      description:
        'Caixa de entrada compartilhada, funil de vendas visual, disparos em massa e automações para o WhatsApp da sua empresa.',
      url: SITE_URL,
      siteName: SITE_NAME,
      images: [
        {
          url: '/og-image.webp',
          width: 1200,
          height: 630,
          alt: `${SITE_NAME} — CRM para WhatsApp Business`,
        },
      ],
    },

    twitter: {
      card: 'summary_large_image',
      title: `${SITE_NAME} — CRM para WhatsApp Business`,
      description: 'CRM para WhatsApp feito para o mercado brasileiro.',
      images: ['/og-image.webp'],
    },

    // ⚠️ Ainda bloqueado para indexação (staging/dev).
    // Trocar para true/true quando o site for para produção.
    robots: {
      index: false,
      follow: false,
    },

    alternates: {
      canonical: SITE_URL,
      languages: {
        'pt-BR': SITE_URL,
      },
    },

    // manifest: '/site.webmanifest',
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  themeColor: '#fafbfc',
  colorScheme: 'light dark',
};


// Inline boot script — runs before React hydrates so the user's
// chosen accent (data-theme) AND mode (data-mode) are on the <html>
// element before first paint. Without this every page load flashes
// the server-rendered defaults for a frame before the React tree
// mounts and applies the picked values.
//
// Kept dependency-free (no imports, no JSX) — must be a string the
// browser can run as a single <script>. Knowledge of valid ids is
// sourced from the THEME_IDS / MODES constants so adding one doesn't
// silently break the boot path.
const THEME_BOOT_SCRIPT = `
(function(){
  var d = document.documentElement;
  try {
    var THEME_KEY = ${JSON.stringify(STORAGE_KEY)};
    var THEME_DEFAULT = ${JSON.stringify(DEFAULT_THEME)};
    var THEMES = ${JSON.stringify(THEME_IDS)};
    var savedTheme = localStorage.getItem(THEME_KEY);
    d.dataset.theme = THEMES.indexOf(savedTheme) !== -1 ? savedTheme : THEME_DEFAULT;

    var MODE_KEY = ${JSON.stringify(MODE_STORAGE_KEY)};
    var MODE_DEFAULT = ${JSON.stringify(DEFAULT_MODE)};
    var MODES = ${JSON.stringify(MODES)};
    var savedMode = localStorage.getItem(MODE_KEY);
    d.dataset.mode = MODES.indexOf(savedMode) !== -1 ? savedMode : MODE_DEFAULT;
  } catch (_e) {
    d.dataset.theme = ${JSON.stringify(DEFAULT_THEME)};
    d.dataset.mode = ${JSON.stringify(DEFAULT_MODE)};
  }
})();
`;

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html
      lang={locale}
      data-theme={DEFAULT_THEME}
      data-mode={DEFAULT_MODE}
      className={`${inter.variable} h-full antialiased`}
      // The `theme-boot` script below rewrites `data-theme` and
      // `data-mode` on <html> from localStorage before React hydrates,
      // so for any non-default choice the client DOM intentionally
      // differs from the server-rendered defaults. suppressHydration-
      // Warning silences the expected mismatch — it only applies to
      // this element's own attributes, so genuine mismatches in
      // children still surface.
      suppressHydrationWarning
    >
      <head>
        <Script
          id="theme-boot"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }}
        />
      </head>
      <body className="bg-background text-foreground min-h-full font-sans">
        <NextIntlClientProvider messages={messages} locale={locale}>
          <ThemeProvider>
            {children}
            <ThemedToaster />
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
