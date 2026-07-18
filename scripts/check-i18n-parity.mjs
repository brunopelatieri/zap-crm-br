// Compares the key trees of messages/en.json (source of truth) and
// every other messages/*.json dictionary. Exits non-zero if any
// locale is missing keys or has extras, so it can run in CI.
//
// Usage: node scripts/check-i18n-parity.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const messagesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'messages'
);

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

process.exit(failed ? 1 : 0);
