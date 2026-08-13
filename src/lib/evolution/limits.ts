/**
 * Limite de instâncias Evolution (D-1, PRD 047 §4 / SPEC 048 §7.2).
 *
 * Regra efetiva:
 *
 *   limite = COALESCE(accounts.evolution_instance_limit, EVOLUTION_MAX_INSTANCES_PER_ACCOUNT)
 *
 * e a criação também falha se o total do DEPLOYMENT já atingiu
 * `EVOLUTION_MAX_INSTANCES_TOTAL` — o env por conta não protege a VPS
 * (10 contas x 3 instâncias = 30 sessões whatsmeow); só o teto global
 * faz isso.
 *
 * Módulo puro: recebe as contagens já lidas do banco, decide.
 */

export interface InstanceLimitCheck {
  accountCount: number;
  totalCount: number;
  /** `accounts.evolution_instance_limit` — `null` = usa o padrão do `.env`. */
  accountOverride: number | null;
  defaultPerAccount: number;
  maxTotal: number;
}

export type InstanceLimitDenialReason = 'account_limit' | 'deployment_limit';

export interface InstanceLimitDecision {
  allowed: boolean;
  reason?: InstanceLimitDenialReason;
  /** Teto efetivo desta conta (override ou padrão). */
  accountLimit: number;
  accountCount: number;
  maxTotal: number;
  totalCount: number;
}

export function checkInstanceLimit(
  input: InstanceLimitCheck
): InstanceLimitDecision {
  const accountLimit = input.accountOverride ?? input.defaultPerAccount;

  const base = {
    accountLimit,
    accountCount: input.accountCount,
    maxTotal: input.maxTotal,
    totalCount: input.totalCount,
  };

  // O teto global protege o recurso compartilhado (a VPS); checa
  // primeiro porque nenhuma exceção por conta pode contorná-lo.
  if (input.totalCount >= input.maxTotal) {
    return { ...base, allowed: false, reason: 'deployment_limit' };
  }

  if (input.accountCount >= accountLimit) {
    return { ...base, allowed: false, reason: 'account_limit' };
  }

  return { ...base, allowed: true };
}

export function describeLimitDenial(decision: InstanceLimitDecision): string {
  switch (decision.reason) {
    case 'account_limit':
      return `account instance limit reached (${decision.accountCount}/${decision.accountLimit})`;
    case 'deployment_limit':
      return `deployment instance limit reached (${decision.totalCount}/${decision.maxTotal})`;
    default:
      return 'instance creation allowed';
  }
}
