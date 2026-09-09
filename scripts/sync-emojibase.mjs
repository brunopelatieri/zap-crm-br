// Copia os dados da Emojibase para public/emojibase/, de onde o Frimousse
// os busca em runtime (prop `emojibaseUrl`). Rode depois de atualizar a
// dependência `emojibase-data`:
//
//   npm run emoji:sync
//
// Os arquivos resultantes SÃO commitados de propósito — self-host evita
// depender do jsDelivr em runtime (CSP, redes corporativas restritas,
// deploy on-premise). Ver docs/spec-066-emoji-picker-inbox.md
// § Configuração — Fonte dos dados.

import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'emojibase-data');
const dest = join(root, 'public', 'emojibase');

// Um locale da Emojibase por locale do app (ver src/lib/emoji/locale.ts,
// REQUIRED_EMOJIBASE_LOCALES). Adicionar um idioma ao app = adicionar o
// locale Emojibase equivalente aqui, senão o picker cai no inglês em
// silêncio para esse idioma.
const LOCALES = ['en', 'pt'];

// Só o que o Frimousse busca em runtime — confirmado no bundle publicado:
// `${emojibaseUrl}/${locale}/data.json` e `${emojibaseUrl}/${locale}/messages.json`.
// Nada de compact.json/shortcodes/*.d.ts — a pasta completa passaria de 10 MB.
const FILES = ['data.json', 'messages.json'];

for (const locale of LOCALES) {
  mkdirSync(join(dest, locale), { recursive: true });
  for (const file of FILES) {
    copyFileSync(join(src, locale, file), join(dest, locale, file));
  }
}

// A MIT exige preservar o aviso de copyright ao redistribuir os dados.
copyFileSync(join(src, 'LICENSE'), join(dest, 'LICENSE'));

console.log(
  `emojibase: ${LOCALES.length} locale(s) sincronizado(s) em ${dest}`
);
