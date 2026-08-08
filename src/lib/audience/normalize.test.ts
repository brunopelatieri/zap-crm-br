import { describe, expect, it } from 'vitest';
import { normalizeAudience, toCsvContacts } from './normalize';
import type { RawAudienceRow } from './types';

function row(
  sourceRow: number,
  phone: string,
  extra: Partial<RawAudienceRow> = {}
): RawAudienceRow {
  return { phone, tagNames: [], sourceRow, ...extra };
}

describe('normalizeAudience', () => {
  it('sanitiza telefone formatado para dígitos apenas', () => {
    const result = normalizeAudience([row(2, '+55 (11) 98888-7777')]);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].phone).toBe('5511988887777');
    expect(result.stats.valid).toBe(1);
  });

  it('trata número formatado e número cru como a mesma pessoa', () => {
    const result = normalizeAudience([
      row(2, '+55 (11) 98888-7777'),
      row(3, '5511988887777'),
    ]);

    expect(result.rows).toHaveLength(1);
    expect(result.stats.duplicates).toBe(1);
    expect(result.invalid[0]).toMatchObject({
      sourceRow: 3,
      reason: 'duplicate_in_file',
    });
  });

  it('preserva sourceRow no telefone inválido para a mensagem ser acionável', () => {
    const result = normalizeAudience([
      row(2, '5511988887777'),
      row(3, '123'),
      row(4, '5511977776666'),
    ]);

    expect(result.rows).toHaveLength(2);
    expect(result.invalid).toEqual([
      {
        sourceRow: 3,
        rawPhone: '123',
        name: undefined,
        reason: 'invalid_phone',
      },
    ]);
  });

  it('distingue telefone ausente de telefone malformado', () => {
    const result = normalizeAudience([row(2, '   '), row(3, 'abc')]);

    expect(result.invalid.map((i) => i.reason)).toEqual([
      'missing_phone',
      'invalid_phone',
    ]);
  });

  it('reporta número inválido repetido como inválido, não como duplicata', () => {
    // A ordem do pipeline (validar antes de deduplicar) existe para
    // isto: o usuário precisa ver o problema real, não o sintoma.
    const result = normalizeAudience([row(2, '123'), row(3, '123')]);

    expect(result.stats.duplicates).toBe(0);
    expect(result.stats.invalid).toBe(2);
    expect(result.invalid.every((i) => i.reason === 'invalid_phone')).toBe(
      true
    );
  });

  it('mantém os contadores somando o total lido', () => {
    const result = normalizeAudience([
      row(2, '5511988887777'),
      row(3, '5511988887777'),
      row(4, 'xx'),
      row(5, '5511977776666'),
    ]);

    const { read, valid, duplicates, invalid } = result.stats;
    expect(read).toBe(4);
    expect(valid + duplicates + invalid).toBe(read);
  });

  it('conserva nome, email, empresa e etiquetas da linha aprovada', () => {
    const result = normalizeAudience([
      row(2, '5511988887777', {
        name: 'Maria',
        email: 'maria@exemplo.com.br',
        company: 'Acme',
        tagNames: ['vip', 'sp'],
      }),
    ]);

    expect(result.rows[0]).toMatchObject({
      name: 'Maria',
      email: 'maria@exemplo.com.br',
      company: 'Acme',
      tagNames: ['vip', 'sp'],
    });
  });

  it('mantém a primeira ocorrência de uma duplicata, não a última', () => {
    const result = normalizeAudience([
      row(2, '5511988887777', { name: 'Primeiro' }),
      row(3, '5511988887777', { name: 'Segundo' }),
    ]);

    expect(result.rows[0].name).toBe('Primeiro');
  });

  it('devolve estrutura vazia para entrada vazia', () => {
    const result = normalizeAudience([]);

    expect(result.rows).toEqual([]);
    expect(result.stats).toEqual({
      read: 0,
      valid: 0,
      duplicates: 0,
      invalid: 0,
    });
  });
});

describe('toCsvContacts', () => {
  it('reduz à forma que o hook de envio já consome', () => {
    const audience = normalizeAudience([
      row(2, '+5511988887777', { name: 'Maria', company: 'Acme' }),
      row(3, '5511977776666'),
    ]);

    expect(toCsvContacts(audience)).toEqual([
      { phone: '5511988887777', name: 'Maria' },
      { phone: '5511977776666', name: undefined },
    ]);
  });
});
