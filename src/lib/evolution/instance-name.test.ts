import { describe, it, expect } from 'vitest';

import { slugifyLabel, buildInstanceName } from './instance-name';

describe('slugifyLabel', () => {
  it('minúsculas, sem acento, espaço vira hífen', () => {
    expect(slugifyLabel('Vendas São Paulo')).toBe('vendas-sao-paulo');
  });

  it('remove pontuação e caracteres não alfanuméricos', () => {
    // 'ª' decompõe (NFKD) para uma forma compatível de 'a' antes do
    // filtro de diacríticos rodar — não é removida, vira 'a' mesmo,
    // que é a leitura ASCII razoável de "2ª linha".
    expect(slugifyLabel('Suporte (2ª linha)!')).toBe('suporte-2a-linha');
  });

  it('colapsa hífens duplicados e corta hífen nas pontas', () => {
    expect(slugifyLabel('  --Vendas--  ')).toBe('vendas');
  });

  it('trunca rótulos longos', () => {
    const long = 'a'.repeat(50);
    expect(slugifyLabel(long).length).toBeLessThanOrEqual(24);
  });

  it('rótulo sem caractere utilizável cai em "instancia"', () => {
    expect(slugifyLabel('🎉🎉🎉')).toBe('instancia');
    expect(slugifyLabel('')).toBe('instancia');
  });
});

describe('buildInstanceName', () => {
  it('monta prefix_accountHex_slug_suffix', () => {
    const name = buildInstanceName(
      'zapcrm',
      'a3f91b2c-1111-2222-3333-444455556666',
      'Vendas'
    );
    expect(name).toMatch(/^zapcrm_a3f91b2c_vendas_[0-9a-f]{4}$/);
  });

  it('dois chamados com o mesmo rótulo produzem nomes diferentes (sufixo aleatório)', () => {
    const accountId = 'a3f91b2c-1111-2222-3333-444455556666';
    const first = buildInstanceName('zapcrm', accountId, 'Vendas');
    const second = buildInstanceName('zapcrm', accountId, 'Vendas');
    expect(first).not.toBe(second);
  });

  it('account_id sem hífens ainda funciona (usa os 8 primeiros chars)', () => {
    const name = buildInstanceName(
      'zapcrm',
      'a3f91b2c111122223333444455556666',
      'Vendas'
    );
    expect(name.startsWith('zapcrm_a3f91b2c_vendas_')).toBe(true);
  });
});
