/**
 * Adaptador XLSX → `RawAudienceRow[]` (SPEC 044 §3.2.1).
 *
 * A leitura do arquivo em si fica com `read-excel-file`, importado
 * dinamicamente e só dentro do Worker — quem usa CSV ou Google Sheets
 * nunca baixa esse chunk. O que mora aqui é a parte que precisa de
 * teste: converter a matriz de células do Excel na mesma matriz de
 * strings que o CSV produz, para que a partir daí exista um único
 * caminho de código.
 *
 * O detalhe que quebra planilha de telefone
 *
 *   O Excel guarda "5511988887777" como NÚMERO se a célula não estiver
 *   formatada como texto. `read-excel-file` devolve um `number`, e um
 *   `${cell}` ingênuo funciona por acidente até o dia em que o valor
 *   passa de 1e21 e vira "5.5e+21". Pior: um número perde o zero à
 *   esquerda, então "011999998888" volta como 11999998888. O primeiro
 *   caso é tratado aqui (`formatNumericCell`); o segundo é irrecuperável
 *   no arquivo e fica por conta de `phoneVariants` no envio, que já
 *   testa a variante com e sem o 0 de tronco.
 */

import { rowsFromTable, mapAudienceColumns } from './parse-csv';
import type { AudienceColumnMap } from './parse-csv';
import type { RawAudienceRow } from '@/lib/audience/types';
import { SpreadsheetParseError, MAX_AUDIENCE_ROWS } from './types';

/** Uma célula como `read-excel-file` a entrega. */
export type XlsxCell = string | number | boolean | Date | null | undefined;

/** Uma aba: nome + matriz de células (primeira linha é o cabeçalho). */
export interface XlsxSheet {
  sheet: string;
  data: XlsxCell[][];
}

/**
 * Formata um número de planilha sem notação científica.
 *
 * Acima de 1e21 tanto `String()` quanto `toFixed(0)` devolvem "1e+21" —
 * e isso é pior do que parece: `sanitizePhoneForMeta` tiraria os
 * não-dígitos e produziria "121", um telefone curto, plausível e
 * errado, que passaria batido na triagem. `BigInt` imprime todos os
 * dígitos. A precisão além de 2^53 já se perdeu no próprio Excel; o que
 * este ramo garante é que o lixo continue parecendo lixo.
 */
function formatNumericCell(value: number): string {
  if (!Number.isFinite(value)) return '';
  if (!Number.isInteger(value)) return String(value);
  if (Math.abs(value) < 1e21) return String(value);
  try {
    return BigInt(value).toString();
  } catch {
    return '';
  }
}

/** Converte qualquer célula na string que o pipeline de CSV espera. */
export function cellToString(cell: XlsxCell): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'number') return formatNumericCell(cell);
  if (typeof cell === 'boolean') return String(cell);
  if (cell instanceof Date) return cell.toISOString().slice(0, 10);
  return String(cell).trim();
}

/** Uma linha é "vazia" quando nenhuma célula tem conteúdo. */
function isBlankRow(cells: string[]): boolean {
  return cells.every((c) => c === '');
}

/**
 * Converte uma aba em linhas de audiência.
 *
 * `sourceRow` é 1-based e conta o cabeçalho, igual ao CSV — assim a
 * mensagem "linha 47" bate com o que o usuário vê no Excel.
 */
export function sheetToAudienceRows(
  sheet: XlsxSheet,
  columns?: AudienceColumnMap
): RawAudienceRow[] {
  const [headerCells, ...dataCells] = sheet.data;

  if (!headerCells || headerCells.length === 0) {
    throw new SpreadsheetParseError(
      'empty_file',
      'A aba selecionada está vazia.'
    );
  }

  const headers = headerCells.map((c) => cellToString(c).toLowerCase());

  const rows = dataCells
    .map((cells, i) => ({
      values: cells.map(cellToString),
      lineNumber: i + 2, // +1 pelo cabeçalho, +1 para ficar 1-based
    }))
    .filter((r) => !isBlankRow(r.values));

  if (rows.length === 0) {
    throw new SpreadsheetParseError(
      'empty_file',
      'A aba selecionada não tem linhas de dados.'
    );
  }

  if (rows.length > MAX_AUDIENCE_ROWS) {
    throw new SpreadsheetParseError(
      'too_many_rows',
      `A planilha tem mais de ${MAX_AUDIENCE_ROWS} linhas.`,
      { max: MAX_AUDIENCE_ROWS, found: rows.length }
    );
  }

  return rowsFromTable(headers, rows, columns);
}

/**
 * Escolhe qual aba usar numa pasta de trabalho com várias.
 *
 * Prefere a primeira que tenha uma coluna de telefone reconhecível, em
 * vez de assumir a primeira do arquivo — planilhas reais costumam abrir
 * com uma aba de instruções ou de resumo, e falhar com "coluna de
 * telefone ausente" quando a aba certa está logo ao lado é um beco sem
 * saída para o usuário.
 */
export function pickBestSheet(sheets: XlsxSheet[]): XlsxSheet | null {
  if (sheets.length === 0) return null;

  for (const sheet of sheets) {
    const headerCells = sheet.data[0];
    if (!headerCells) continue;
    const headers = headerCells.map((c) => cellToString(c).toLowerCase());
    if (mapAudienceColumns(headers).phone !== -1) return sheet;
  }

  return sheets[0];
}

export interface XlsxParseResult {
  rows: RawAudienceRow[];
  /** Nome da aba efetivamente lida. */
  sheetName: string;
  /** Todas as abas da pasta, para o seletor da UI. */
  sheetNames: string[];
}

/**
 * Ponto de entrada: recebe as abas já lidas pela biblioteca e devolve
 * as linhas da aba escolhida. Mantido separado da chamada a
 * `read-excel-file` para que isto seja testável sem um .xlsx real.
 */
export function parseXlsxSheets(
  sheets: XlsxSheet[],
  options: { sheetName?: string; columns?: AudienceColumnMap } = {}
): XlsxParseResult {
  if (sheets.length === 0) {
    throw new SpreadsheetParseError('empty_file', 'A planilha não tem abas.');
  }

  const sheetNames = sheets.map((s) => s.sheet);
  const requested = options.sheetName
    ? sheets.find((s) => s.sheet === options.sheetName)
    : null;
  const target = requested ?? pickBestSheet(sheets);

  if (!target) {
    throw new SpreadsheetParseError('empty_file', 'A planilha não tem abas.');
  }

  return {
    rows: sheetToAudienceRows(target, options.columns),
    sheetName: target.sheet,
    sheetNames,
  };
}
