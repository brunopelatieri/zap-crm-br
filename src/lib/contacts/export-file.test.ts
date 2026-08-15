import { describe, expect, it } from 'vitest';
import { buildContactsCsv, contactExportFilename } from './export-file';
import { parseContactCsv } from './parse-contact-csv';

describe('buildContactsCsv', () => {
  it('separa linhas com CRLF', () => {
    const csv = buildContactsCsv([
      ['phone', 'name'],
      ['5511900000001', 'Maria'],
      ['5511900000002', 'João'],
    ]);
    expect(csv.split('\r\n')).toEqual([
      '"phone","name"',
      '"5511900000001","Maria"',
      '"5511900000002","João"',
    ]);
  });

  it('cita toda célula, mesmo sem caractere especial', () => {
    const csv = buildContactsCsv([['phone'], ['5511900000001']]);
    expect(csv).toBe('"phone"\r\n"5511900000001"');
  });

  it('duplica aspas internas (RFC 4180)', () => {
    const csv = buildContactsCsv([['name'], ['A "boa" loja']]);
    expect(csv).toBe('"name"\r\n"A ""boa"" loja"');
  });

  it('preserva quebra de linha dentro da célula (notas concatenadas)', () => {
    const csv = buildContactsCsv([
      ['notas'],
      ['[10/08/2026] a\n[01/08/2026] b'],
    ]);
    expect(csv).toBe('"notas"\r\n"[10/08/2026] a\n[01/08/2026] b"');
  });

  it('matriz vazia gera string vazia', () => {
    expect(buildContactsCsv([])).toBe('');
  });

  it('round-trip via parseContactCsv: vírgula dentro de uma célula não vira coluna extra', () => {
    const matrix = [
      ['phone', 'name', 'email', 'company'],
      [
        '5511900000001',
        'Maria, a Rainha, Souza',
        'maria@exemplo.com',
        'Loja da Maria',
      ],
    ];
    const csv = buildContactsCsv(matrix);
    const { rows } = parseContactCsv(csv);

    expect(rows).toHaveLength(1);
    expect(rows[0].phone).toBe('5511900000001');
    expect(rows[0].name).toBe('Maria, a Rainha, Souza');
    expect(rows[0].email).toBe('maria@exemplo.com');
    expect(rows[0].company).toBe('Loja da Maria');
  });
});

describe('contactExportFilename', () => {
  it('monta <prefixo>-<data ISO curta>.<formato>', () => {
    const now = new Date('2026-08-15T23:59:00.000Z');
    expect(contactExportFilename('contatos', 'xlsx', now)).toBe(
      'contatos-2026-08-15.xlsx'
    );
    expect(contactExportFilename('contacts', 'csv', now)).toBe(
      'contacts-2026-08-15.csv'
    );
  });
});
