// Compares the key trees of messages/en.json (source of truth) and
// every other messages/*.json dictionary. Exits non-zero if any
// locale is missing keys or has extras, so it can run in CI.
//
// Usage: node scripts/check-i18n-parity.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const messagesDir = join(rootDir, 'messages');

function keyPaths(obj, prefix = '') {
  const paths = [];
  for (const key of Object.keys(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (obj[key] !== null && typeof obj[key] === 'object') {
      paths.push(...keyPaths(obj[key], path));
    } else {
      paths.push(path);
    }
  }
  return paths;
}

const enKeys = new Set(
  keyPaths(JSON.parse(readFileSync(join(messagesDir, 'en.json'), 'utf8')))
);

let failed = false;

for (const file of readdirSync(messagesDir)) {
  if (!file.endsWith('.json') || file === 'en.json') continue;

  const localeKeys = new Set(
    keyPaths(JSON.parse(readFileSync(join(messagesDir, file), 'utf8')))
  );

  const missing = [...enKeys].filter((k) => !localeKeys.has(k));
  const extra = [...localeKeys].filter((k) => !enKeys.has(k));

  if (missing.length || extra.length) {
    failed = true;
    console.error(
      `✗ ${file}: ${missing.length} missing, ${extra.length} extra`
    );
    for (const k of missing) console.error(`  missing: ${k}`);
    for (const k of extra) console.error(`  extra:   ${k}`);
  } else {
    console.log(`✓ ${file}: ${localeKeys.size} keys, in parity with en.json`);
  }
}

// --- Auth error-code → i18n key consistency check -------------------------
//
// `src/lib/auth/error-messages.ts` exports CODE_TO_MESSAGE_KEY, a map of
// Supabase Auth error codes to translation KEY NAMES (not values).
// `getAuthErrorMessageKey()` returns one of those key names, and every
// caller looks it up inside its OWN next-intl namespace via
// `t(getAuthErrorMessageKey(error))`. That means every namespace that
// calls the helper must carry every key the map can produce, plus
// `errorGeneric` (the fallback for unmapped codes).
//
// Neither `tsc` nor the JSON-parity check above catches a missing one:
// both en.json and pt-BR.json can be equally missing a key, and the key
// name itself is just a string as far as TypeScript is concerned. It
// only breaks at runtime as a next-intl MISSING_MESSAGE — which is
// exactly what shipped once in the `AuthConfirmPage` namespace (SPEC 053
// §2.1.3) before this check existed.
const errorMessagesSrc = readFileSync(
  join(rootDir, 'src/lib/auth/error-messages.ts'),
  'utf8'
);

const codeMapMatch = errorMessagesSrc.match(
  /CODE_TO_MESSAGE_KEY[^{]*\{([\s\S]*?)\n\};/
);
if (!codeMapMatch) {
  failed = true;
  console.error(
    '✗ auth error-key check: could not find CODE_TO_MESSAGE_KEY in src/lib/auth/error-messages.ts — update the parser in scripts/check-i18n-parity.mjs if that file moved or was restructured'
  );
} else {
  const requiredErrorKeys = new Set(
    [...codeMapMatch[1].matchAll(/:\s*'([^']+)'/g)].map((m) => m[1])
  );
  requiredErrorKeys.add('errorGeneric'); // always-present fallback

  // Namespace → set of files that call getAuthErrorMessageKey() while
  // using that namespace, so a failure below points at real file paths.
  const namespaceFiles = new Map();

  function walkTsx(dir) {
    const files = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...walkTsx(full));
      else if (entry.name.endsWith('.tsx')) files.push(full);
    }
    return files;
  }

  for (const file of walkTsx(join(rootDir, 'src'))) {
    const content = readFileSync(file, 'utf8');
    if (!content.includes('getAuthErrorMessageKey')) continue;

    const namespaces = [
      ...content.matchAll(/useTranslations\(\s*'([^']+)'\s*\)/g),
    ].map((m) => m[1]);

    if (namespaces.length === 0) {
      failed = true;
      console.error(
        `✗ auth error-key check: ${file.slice(rootDir.length + 1)} calls getAuthErrorMessageKey() but no useTranslations('Namespace') call was found — can't verify its i18n keys`
      );
      continue;
    }

    for (const ns of namespaces) {
      if (!namespaceFiles.has(ns)) namespaceFiles.set(ns, []);
      namespaceFiles.get(ns).push(file.slice(rootDir.length + 1));
    }
  }

  const enMessages = JSON.parse(
    readFileSync(join(messagesDir, 'en.json'), 'utf8')
  );

  for (const [ns, files] of namespaceFiles) {
    const nsKeys = new Set(Object.keys(enMessages[ns] ?? {}));
    const missing = [...requiredErrorKeys].filter((k) => !nsKeys.has(k));

    if (missing.length) {
      failed = true;
      console.error(
        `✗ en.json "${ns}" (used by ${files.join(', ')}) is missing auth error keys reachable via getAuthErrorMessageKey: ${missing.join(', ')}`
      );
    } else {
      console.log(
        `✓ en.json "${ns}": has all ${requiredErrorKeys.size} auth error keys`
      );
    }
  }
}

process.exit(failed ? 1 : 0);
