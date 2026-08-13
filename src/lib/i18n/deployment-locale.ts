/**
 * Locale DA INSTALAÇÃO — não o da sessão. Ver SPEC 050 §4 (D-1).
 *
 * `src/i18n/request.ts` resolve o idioma da UI por cookie (por
 * dispositivo) → env → default. Regras de integridade de dado (como a
 * validação brasileira de telefone) não podem seguir essa mesma cadeia:
 * um operador que trocou a própria UI para inglês não pode gravar
 * contatos com uma regra diferente do colega ao lado, na mesma conta.
 * Por isso este módulo lê SÓ a env var, ignorando o cookie de sessão —
 * de propósito, não por descuido. Não troque para `useLocale()`.
 */

import { DEFAULT_LOCALE, isAppLocale, type AppLocale } from './locales';

/**
 * Locale de deployment: `NEXT_PUBLIC_APP_LOCALE` (acesso literal —
 * necessário para o Next.js inlinar a variável no bundle do browser)
 * ou `DEFAULT_LOCALE` quando ausente/inválida.
 */
export function getDeploymentLocale(): AppLocale {
  const envLocale = process.env.NEXT_PUBLIC_APP_LOCALE;
  return isAppLocale(envLocale) ? envLocale : DEFAULT_LOCALE;
}

/** True quando o deployment é brasileiro (`pt-BR`). */
export function isBrDeployment(): boolean {
  return getDeploymentLocale() === 'pt-BR';
}
