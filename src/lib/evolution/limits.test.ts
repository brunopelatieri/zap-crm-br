import { describe, it, expect } from 'vitest';

import { checkInstanceLimit, describeLimitDenial } from './limits';

describe('checkInstanceLimit', () => {
  it('permite quando conta e deployment têm folga', () => {
    const decision = checkInstanceLimit({
      accountCount: 1,
      totalCount: 5,
      accountOverride: null,
      defaultPerAccount: 3,
      maxTotal: 20,
    });
    expect(decision).toMatchObject({ allowed: true, accountLimit: 3 });
  });

  it('bloqueia por account_limit quando a conta atinge o padrão do .env', () => {
    const decision = checkInstanceLimit({
      accountCount: 3,
      totalCount: 5,
      accountOverride: null,
      defaultPerAccount: 3,
      maxTotal: 20,
    });
    expect(decision).toMatchObject({
      allowed: false,
      reason: 'account_limit',
      accountLimit: 3,
    });
  });

  it('override da conta (accounts.evolution_instance_limit) tem precedência sobre o padrão do .env', () => {
    const allowedByOverride = checkInstanceLimit({
      accountCount: 3,
      totalCount: 5,
      accountOverride: 10,
      defaultPerAccount: 3,
      maxTotal: 20,
    });
    expect(allowedByOverride.allowed).toBe(true);
    expect(allowedByOverride.accountLimit).toBe(10);

    const blockedByOverride = checkInstanceLimit({
      accountCount: 1,
      totalCount: 5,
      accountOverride: 1,
      defaultPerAccount: 3,
      maxTotal: 20,
    });
    expect(blockedByOverride).toMatchObject({
      allowed: false,
      reason: 'account_limit',
      accountLimit: 1,
    });
  });

  it('override 0 bloqueia mesmo com accountCount 0 (desliga o recurso pra conta)', () => {
    const decision = checkInstanceLimit({
      accountCount: 0,
      totalCount: 0,
      accountOverride: 0,
      defaultPerAccount: 3,
      maxTotal: 20,
    });
    expect(decision).toMatchObject({ allowed: false, reason: 'account_limit' });
  });

  it('teto do deployment é checado ANTES do teto da conta — protege a VPS mesmo com override generoso', () => {
    const decision = checkInstanceLimit({
      accountCount: 1,
      totalCount: 20,
      accountOverride: 50,
      defaultPerAccount: 3,
      maxTotal: 20,
    });
    expect(decision).toMatchObject({
      allowed: false,
      reason: 'deployment_limit',
    });
  });

  it('describeLimitDenial produz um motivo legível para cada razão', () => {
    const accountDenied = checkInstanceLimit({
      accountCount: 3,
      totalCount: 5,
      accountOverride: null,
      defaultPerAccount: 3,
      maxTotal: 20,
    });
    expect(describeLimitDenial(accountDenied)).toMatch(
      /account instance limit/
    );

    const deploymentDenied = checkInstanceLimit({
      accountCount: 1,
      totalCount: 20,
      accountOverride: null,
      defaultPerAccount: 3,
      maxTotal: 20,
    });
    expect(describeLimitDenial(deploymentDenied)).toMatch(
      /deployment instance limit/
    );

    const allowed = checkInstanceLimit({
      accountCount: 0,
      totalCount: 0,
      accountOverride: null,
      defaultPerAccount: 3,
      maxTotal: 20,
    });
    expect(describeLimitDenial(allowed)).toBe('instance creation allowed');
  });
});
