import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Sobrescreve os ignores padrão do eslint-config-next.
  globalIgnores([
    // Ignores padrão do eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // Worker do encoder opus-recorder, minificado e vendorizado (servido estaticamente).
    'public/opus/**',
  ]),
]);

export default eslintConfig;
