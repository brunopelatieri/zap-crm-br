/**
 * Adaptador CSV → `RawAudienceRow[]` (SPEC 044 §3.2).
 *
 * Reusa `readCsvTable` — o mesmo tokenizador do import de contatos —
 * e diverge dele num único ponto deliberado: uma linha **sem telefone
 * não é descartada aqui**. Ela sai com `phone: ''` para que
 * `normalizeAudience` a reporte como `empty` (SPEC 052 D-2) com o
 * número da linha. O import de contatos pode se dar ao luxo de ignorar
 * em silêncio; um disparo, não — o usuário precisa saber que a linha
 * 47 da planilha dele não vai receber nada.
 */

import {
  CONTACT_COLUMNS,
  csvCell,
  parseTagCell,
  readCsvTable,
} from '@/lib/contacts/parse-contact-csv';
import type { RawAudienceRow } from '@/lib/audience/types';
import { SpreadsheetParseError, MAX_AUDIENCE_ROWS } from './types';

export interface AudienceColumnMap {
  phone: number;
  name: number;
  email: number;
  company: number;
  tags: number;
}

export interface AudienceColumnSpec {
  key: keyof AudienceColumnMap;
  /** Só o telefone é obrigatório — o resto enriquece a personalização. */
  required: boolean;
  /**
   * Cabeçalhos aceitos, em ordem de preferência. O primeiro é o
   * canônico: é o que o modelo de planilha escreve e o único que o
   * import de contatos (`parseContactCsv`) também entende, então um
   * arquivo montado a partir do modelo serve aos dois caminhos.
   */
  aliases: string[];
}

/**
 * As colunas conhecidas, na ordem em que saem no modelo de planilha.
 *
 * Aceita cabeçalhos em português além dos originais em inglês — uma
 * planilha exportada de qualquer ferramenta brasileira traz
 * "telefone", e obrigar o usuário a renomear a coluna para "phone" é
 * atrito sem propósito.
 *
 * Fonte única: os apelidos vêm de `CONTACT_COLUMNS`
 * (`parse-contact-csv.ts`) — o mesmo mapeamento que o import de
 * contatos usa. Duas listas de apelidos seriam duas chances de
 * divergir (e de o modelo sugerir um cabeçalho que um dos dois
 * parsers não reconhece).
 */
export const SPREADSHEET_COLUMNS: AudienceColumnSpec[] = CONTACT_COLUMNS.map(
  (column) => ({
    key: column.key,
    required: column.key === 'phone',
    aliases: column.aliases,
  })
);

/** Primeiro índice cujo cabeçalho casa com um dos apelidos. */
function findColumn(headers: string[], aliases: string[]): number {
  for (const alias of aliases) {
    const idx = headers.indexOf(alias);
    if (idx !== -1) return idx;
  }
  return -1;
}

/** Localiza as colunas conhecidas no cabeçalho lido. */
export function mapAudienceColumns(headers: string[]): AudienceColumnMap {
  const map: AudienceColumnMap = {
    phone: -1,
    name: -1,
    email: -1,
    company: -1,
    tags: -1,
  };
  for (const column of SPREADSHEET_COLUMNS) {
    map[column.key] = findColumn(headers, column.aliases);
  }
  return map;
}

/**
 * Converte a matriz genérica (cabeçalhos + linhas) em `RawAudienceRow[]`.
 * Compartilhado entre o CSV e o XLSX — o leitor de planilha binária
 * produz exatamente a mesma matriz, então a partir daqui o caminho é um só.
 *
 * @param columns mapeamento explícito; quando omitido é inferido do cabeçalho
 * @param maxRows teto de linhas — cada consumidor tem o seu (SPEC 052
 *   D-7/F6: audiência lê, contatos escreve, então o teto é bem menor)
 */
export function rowsFromTable(
  headers: string[],
  rows: { values: string[]; lineNumber: number }[],
  columns?: AudienceColumnMap,
  maxRows: number = MAX_AUDIENCE_ROWS
): RawAudienceRow[] {
  const cols = columns ?? mapAudienceColumns(headers);

  if (cols.phone === -1) {
    throw new SpreadsheetParseError(
      'missing_phone_column',
      'A planilha precisa de uma coluna de telefone.'
    );
  }

  if (rows.length > maxRows) {
    throw new SpreadsheetParseError(
      'too_many_rows',
      `A planilha tem mais de ${maxRows} linhas.`,
      { max: maxRows, found: rows.length }
    );
  }

  return rows.map(({ values, lineNumber }) => ({
    // `?? ''` em vez de descartar: ver o comentário no topo do arquivo.
    phone: csvCell(values, cols.phone) ?? '',
    name: csvCell(values, cols.name),
    email: csvCell(values, cols.email),
    company: csvCell(values, cols.company),
    tagNames:
      cols.tags >= 0 ? parseTagCell(csvCell(values, cols.tags) ?? '') : [],
    sourceRow: lineNumber,
  }));
}

/** Lê um CSV completo em linhas de audiência. */
export function parseAudienceCsv(
  text: string,
  columns?: AudienceColumnMap,
  maxRows?: number
): RawAudienceRow[] {
  const { headers, rows } = readCsvTable(text);

  if (headers.length === 0) {
    throw new SpreadsheetParseError(
      'empty_file',
      'O arquivo está vazio ou só tem cabeçalho.'
    );
  }

  return rowsFromTable(headers, rows, columns, maxRows);
}
