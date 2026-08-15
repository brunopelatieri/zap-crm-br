import { describe, expect, it } from 'vitest';
import {
  createRowNormalizer,
  normalizeAudience,
  toCsvContacts,
} from './normalize';
import type { RawAudienceRow } from './types';
import type { PhoneNormalizeResult } from '@/lib/phone/br';

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
        reason: 'invalid_length',
      },
    ]);
  });

  it('distingue telefone ausente de telefone malformado', () => {
    // 'abc' sanitiza para string vazia — mesmo motivo que um campo em
    // branco (`empty`); '123' tem dígitos, mas comprimento errado
    // (`invalid_length`) — são motivos diferentes.
    const result = normalizeAudience([row(2, '   '), row(3, '123')]);

    expect(result.invalid.map((i) => i.reason)).toEqual([
      'empty',
      'invalid_length',
    ]);
  });

  it('reporta número inválido repetido como inválido, não como duplicata', () => {
    // A ordem do pipeline (validar antes de deduplicar) existe para
    // isto: o usuário precisa ver o problema real, não o sintoma.
    const result = normalizeAudience([row(2, '123'), row(3, '123')]);

    expect(result.stats.duplicates).toBe(0);
    expect(result.stats.invalid).toBe(2);
    expect(result.invalid.every((i) => i.reason === 'invalid_length')).toBe(
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

  // SPEC 052 D-2: o padrão dos dois consumidores (contatos e
  // audiência) passa a ser `normalizeContactPhone` (SPEC 050) — não
  // mais o `isValidE164` genérico. Casos verificados diretamente
  // contra `normalizeContactPhone` (não apenas copiados da SPEC).
  describe('validação SPEC 050 por padrão (D-2)', () => {
    it('acrescenta o DDI 55 a um número doméstico sem DDI, em vez de o confundir com DDI 19', () => {
      // Achado J (SPEC 052 §2.2): antes do D-2 este número virava
      // "19992496598" — um telefone com DDI 19, que não existe.
      const result = normalizeAudience([row(2, '19992496598')]);

      expect(result.rows[0].phone).toBe('5519992496598');
    });

    it('rejeita DDD que não existe na lista da Anatel', () => {
      const result = normalizeAudience([row(2, '5510987654321')]);

      expect(result.rows).toHaveLength(0);
      expect(result.invalid[0]).toMatchObject({ reason: 'invalid_ddd' });
    });

    it('preserva número estrangeiro (SPEC 050 D-2)', () => {
      const result = normalizeAudience([row(2, '+351912345678')]);

      expect(result.rows[0].phone).toBe('351912345678');
    });

    it('preserva celular legado de 8 dígitos (SPEC 050 D-6)', () => {
      const result = normalizeAudience([row(2, '551198765432')]);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].phone).toBe('551198765432');
    });
  });

  describe('createRowNormalizer com validador customizado', () => {
    it('usa o validador passado em vez do padrão', () => {
      const alwaysInvalid = (): PhoneNormalizeResult => ({
        ok: false,
        reason: 'invalid_length',
      });

      const normalizer = createRowNormalizer({ validate: alwaysInvalid });
      normalizer.push(row(2, '5511988887777')); // válido pelo padrão, não pelo customizado
      const result = normalizer.finish();

      expect(result.rows).toHaveLength(0);
      expect(result.invalid[0]).toMatchObject({ reason: 'invalid_length' });
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
