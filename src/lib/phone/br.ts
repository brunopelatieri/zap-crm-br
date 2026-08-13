/**
 * Validação e normalização de telefone brasileiro (SPEC 050).
 *
 * `sanitizePhoneForMeta` / `isValidE164` (`@/lib/whatsapp/phone-utils`)
 * continuam sendo o formato canônico gravado em todo o sistema —
 * dígitos-only, com DDI, sem `+`. Este módulo não reimplementa isso:
 * importa dali e acrescenta, por cima, a camada de validação regional
 * (DDD contra a lista da Anatel, celular × fixo × celular legado) que
 * só entra quando o deployment é brasileiro (`isBrDeployment`).
 *
 * Fica em `lib/phone/`, não dentro de `lib/whatsapp/phone-utils.ts`,
 * de propósito: aquele arquivo hoje é importado por contatos,
 * audiência, API pública e inbox — não é "de WhatsApp" há tempo, mas
 * movê-lo é um refactor de dezenas de imports que não pertence a esta
 * SPEC (ver SPEC 050 §5.2).
 */

import { isBrDeployment } from '@/lib/i18n/deployment-locale';
import { isValidE164, sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';

export const BR_COUNTRY_CODE = '55';

/**
 * 67 DDDs ativos no Brasil (Anatel). Fonte:
 * docs/references/mobile_number_brasil_guide.md.
 */
export const BR_AREA_CODES: ReadonlySet<number> = new Set([
  // Sudeste
  11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28, 31, 32, 33, 34, 35,
  37, 38,
  // Sul
  41, 42, 43, 44, 45, 46, 47, 48, 49, 51, 53, 54, 55,
  // Centro-Oeste
  61, 62, 63, 64, 65, 66, 67, 68, 69,
  // Nordeste
  71, 73, 74, 75, 77, 79, 81, 82, 83, 84, 85, 86, 87, 88, 89,
  // Norte
  91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

/**
 * `mobile_legacy` = 8 dígitos locais, pré-nono dígito (D-6, aceito de
 * propósito — WhatsApp mantém contatos antigos nesse formato).
 * Informativo: nenhuma regra do produto depende deste campo.
 */
export type BrPhoneKind = 'mobile' | 'mobile_legacy' | 'landline';

export type PhoneRejectReason =
  | 'empty'
  | 'invalid_length'
  | 'invalid_ddd'
  | 'mobile_invalid_ninth_digit' // 11 díg.: o local de 9 díg. não começa com 9
  | 'invalid_local_prefix' // 10 díg.: local começa com 0 ou 1
  | 'missing_country_code'; // só em deploy não-BR

export type PhoneNormalizeResult =
  | {
      ok: true;
      /** Dígitos-only, com DDI, sem `+` — o formato canônico do sistema. */
      phone: string;
      kind: BrPhoneKind | 'foreign';
      ddd: number | null;
      /** true em `mobile_legacy` — dispara o aviso não-bloqueante do formulário (D-6). */
      legacy: boolean;
    }
  | { ok: false; reason: PhoneRejectReason };

function ok(
  phone: string,
  kind: BrPhoneKind | 'foreign',
  ddd: number | null,
  legacy = false
): PhoneNormalizeResult {
  return { ok: true, phone, kind, ddd, legacy };
}

function fail(reason: PhoneRejectReason): PhoneNormalizeResult {
  return { ok: false, reason };
}

/**
 * Valida a parte nacional (DDD + local) de um número doméstico já sem
 * DDI. `national` sempre tem 10 ou 11 dígitos — garantido pelos dois
 * únicos pontos de chamada em `normalizeContactPhone`.
 */
function validateDomestic(national: string): PhoneNormalizeResult {
  const ddd = parseInt(national.slice(0, 2), 10);
  if (!BR_AREA_CODES.has(ddd)) return fail('invalid_ddd');

  const local = national.slice(2);
  const phone = BR_COUNTRY_CODE + national;

  if (local.length === 9) {
    // Celular atual: nono dígito obrigatoriamente '9'.
    if (local[0] !== '9') return fail('mobile_invalid_ninth_digit');
    return ok(phone, 'mobile', ddd);
  }

  // local.length === 8 — fixo ou celular legado (D-6).
  const first = local[0];
  if (first === '0' || first === '1') return fail('invalid_local_prefix');
  if (first === '9') return ok(phone, 'mobile_legacy', ddd, true);
  return ok(phone, 'landline', ddd); // first ∈ 2–8
}

/**
 * Pipeline completo (SPEC 050 §5.2) — a ordem é o comportamento.
 * `opts.brMode` só existe para teste; em produção sempre vem de
 * `isBrDeployment()`.
 */
export function normalizeContactPhone(
  raw: string,
  opts?: { brMode?: boolean }
): PhoneNormalizeResult {
  const brMode = opts?.brMode ?? isBrDeployment();

  let digits = sanitizePhoneForMeta(raw);
  if (!digits) return fail('empty');

  // Remove UM zero de tronco à esquerda (discagem nacional: 011… → 11…).
  // Um número com DDI nunca começa com 0 (nenhum DDI começa em 0), então
  // isto só afeta o caso doméstico que motivou a regra.
  if (digits.startsWith('0')) digits = digits.slice(1);

  // DDI 55 + doméstico: 12 dígitos (DDD + fixo de 8) ou 13 (DDD + celular
  // de 9). Testado ANTES do bloco doméstico-sem-DDI: um DDD 55 (Santa
  // Maria/RS) sem DDI tem 10/11 dígitos, nunca 12/13 — não há colisão
  // (ver SPEC 050 §4 D-2). Não "consertar" esta ordem.
  if (
    (digits.length === 12 || digits.length === 13) &&
    digits.startsWith(BR_COUNTRY_CODE)
  ) {
    return validateDomestic(digits.slice(2));
  }

  // Doméstico sem DDI.
  if (digits.length === 10 || digits.length === 11) {
    if (!brMode) return fail('missing_country_code');
    return validateDomestic(digits);
  }

  // Estrangeiro (ou lixo). 12–15 dígitos que não começam com 55 já
  // passaram pelo bloco acima; o que sobra aqui é validado pela regra
  // genérica E.164 — não rejeitamos número de fora do Brasil (D-2).
  if (digits.length >= 12 && digits.length <= 15) {
    return isValidE164(digits)
      ? ok(digits, 'foreign', null)
      : fail('invalid_length');
  }

  return fail('invalid_length');
}

/**
 * Exibição: `5519992496598` → `"+55 (19) 99924-9658"`. Nunca lança —
 * dígitos que não casam com um formato BR conhecido voltam com um `+`
 * na frente e mais nada (fallback seguro para número estrangeiro).
 */
export function formatPhoneForDisplay(digits: string): string {
  const clean = sanitizePhoneForMeta(digits);
  if (!clean) return '';

  if (
    clean.startsWith(BR_COUNTRY_CODE) &&
    clean.length >= 12 &&
    clean.length <= 13
  ) {
    const national = clean.slice(2);
    const ddd = national.slice(0, 2);
    const local = national.slice(2);
    const localFormatted =
      local.length === 9
        ? `${local.slice(0, 5)}-${local.slice(5)}`
        : `${local.slice(0, 4)}-${local.slice(4)}`;
    return `+55 (${ddd}) ${localFormatted}`;
  }

  return `+${clean}`;
}
