import { describe, expect, it } from 'vitest';
import {
  cellToString,
  parseXlsxSheets,
  pickBestSheet,
  sheetToAudienceRows,
} from './parse-xlsx';
import type { XlsxSheet } from './parse-xlsx';

const sheet = (name: string, data: unknown[][]): XlsxSheet =>
  ({ sheet: name, data }) as XlsxSheet;

describe('cellToString', () => {
  it('mantém telefone guardado como número sem notação científica', () => {
    // O Excel guarda "5511988887777" como number se a célula não
    // estiver formatada como texto.
    expect(cellToString(5511988887777)).toBe('5511988887777');
  });

  it('não usa notação científica em número muito grande', () => {
    expect(cellToString(1e21)).toBe('1000000000000000000000');
    expect(cellToString(1e21)).not.toContain('e');
  });

  it('trata nulo e indefinido como célula vazia', () => {
    expect(cellToString(null)).toBe('');
    expect(cellToString(undefined)).toBe('');
  });

  it('recorta espaços de string', () => {
    expect(cellToString('  Maria  ')).toBe('Maria');
  });

  it('formata data como ISO curta', () => {
    expect(cellToString(new Date('2026-08-07T12:00:00Z'))).toBe('2026-08-07');
  });

  it('preserva decimal', () => {
    expect(cellToString(1.5)).toBe('1.5');
  });
});

describe('sheetToAudienceRows', () => {
  it('numera sourceRow batendo com a linha visível no Excel', () => {
    const rows = sheetToAudienceRows(
      sheet('Contatos', [
        ['phone', 'name'],
        [5511988887777, 'Maria'],
        [5511977776666, 'João'],
      ])
    );

    expect(rows.map((r) => r.sourceRow)).toEqual([2, 3]);
    expect(rows[0].phone).toBe('5511988887777');
  });

  it('pula linhas totalmente vazias mas preserva a numeração', () => {
    const rows = sheetToAudienceRows(
      sheet('S', [['phone'], ['5511988887777'], [null], ['5511977776666']])
    );

    expect(rows.map((r) => r.sourceRow)).toEqual([2, 4]);
  });

  it('aceita cabeçalho em português', () => {
    const rows = sheetToAudienceRows(
      sheet('S', [
        ['Nome', 'Telefone'],
        ['Maria', '5511988887777'],
      ])
    );

    expect(rows[0]).toMatchObject({ name: 'Maria', phone: '5511988887777' });
  });

  it('rejeita aba sem coluna de telefone', () => {
    expect(() =>
      sheetToAudienceRows(sheet('S', [['nome'], ['Maria']]))
    ).toThrowError(expect.objectContaining({ code: 'missing_phone_column' }));
  });

  it('rejeita aba só com cabeçalho', () => {
    expect(() => sheetToAudienceRows(sheet('S', [['phone']]))).toThrowError(
      expect.objectContaining({ code: 'empty_file' })
    );
  });
});

describe('pickBestSheet', () => {
  it('escolhe a primeira aba que tem coluna de telefone, não a primeira do arquivo', () => {
    // Planilhas reais abrem com aba de instruções; falhar ali quando a
    // aba certa está ao lado é um beco sem saída.
    const picked = pickBestSheet([
      sheet('Instruções', [['Leia antes de usar']]),
      sheet('Contatos', [
        ['phone', 'name'],
        ['5511988887777', 'Maria'],
      ]),
    ]);

    expect(picked?.sheet).toBe('Contatos');
  });

  it('cai na primeira aba quando nenhuma tem telefone', () => {
    const picked = pickBestSheet([sheet('A', [['x']]), sheet('B', [['y']])]);

    expect(picked?.sheet).toBe('A');
  });

  it('devolve null para pasta sem abas', () => {
    expect(pickBestSheet([])).toBeNull();
  });
});

describe('parseXlsxSheets', () => {
  const workbook = [
    sheet('Resumo', [['total'], [42]]),
    sheet('Contatos', [
      ['phone', 'name'],
      ['5511988887777', 'Maria'],
    ]),
    sheet('Antigos', [['phone'], ['5511911112222']]),
  ];

  it('seleciona automaticamente a aba com telefone e lista todas', () => {
    const result = parseXlsxSheets(workbook);

    expect(result.sheetName).toBe('Contatos');
    expect(result.sheetNames).toEqual(['Resumo', 'Contatos', 'Antigos']);
    expect(result.rows).toHaveLength(1);
  });

  it('respeita a aba pedida explicitamente', () => {
    const result = parseXlsxSheets(workbook, { sheetName: 'Antigos' });

    expect(result.sheetName).toBe('Antigos');
    expect(result.rows[0].phone).toBe('5511911112222');
  });

  it('cai na seleção automática se a aba pedida não existir', () => {
    const result = parseXlsxSheets(workbook, { sheetName: 'Inexistente' });

    expect(result.sheetName).toBe('Contatos');
  });

  it('rejeita pasta de trabalho vazia', () => {
    expect(() => parseXlsxSheets([])).toThrowError(
      expect.objectContaining({ code: 'empty_file' })
    );
  });
});
