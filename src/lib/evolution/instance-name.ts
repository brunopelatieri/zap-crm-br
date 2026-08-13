/**
 * Nome namespaced da instância (SPEC 048 §7.1 / PRD §8.3).
 *
 * `remote_instance_name` é GLOBAL na VPS Evolution — compartilhada
 * entre todas as contas do deployment. Um rótulo escolhido pelo
 * usuário ("Vendas") nunca vai cru: o namespace impede colisão entre
 * contas e entre deployments que compartilhem a mesma VPS, e o prefixo
 * permite auditar o que é nosso.
 *
 *   <prefix>_<8 hex do account_id>_<slug do rótulo>_<4 hex aleatórios>
 *   ex.: zapcrm_a3f91b2c_vendas_7d1e
 */

import { randomBytes } from 'crypto';

const MAX_SLUG_LENGTH = 24;

/**
 * Reduz um rótulo livre a `[a-z0-9-]+`, sem acento, sem espaço
 * duplicado virando hífen duplo. Cai em `"instancia"` quando o rótulo
 * não sobra nada utilizável (ex.: só emoji) — o namespace continua
 * único pelos hex ao redor.
 */
export function slugifyLabel(label: string): string {
  const slug = label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // remove diacritics after NFKD split
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
  return slug || 'instancia';
}

export function buildInstanceName(
  prefix: string,
  accountId: string,
  label: string
): string {
  const accountHex = accountId.replace(/-/g, '').slice(0, 8);
  const slug = slugifyLabel(label);
  const suffix = randomBytes(2).toString('hex');
  return `${prefix}_${accountHex}_${slug}_${suffix}`;
}
