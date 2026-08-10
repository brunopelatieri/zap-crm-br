/**
 * Adaptador CSV → `RawAudienceRow[]` (SPEC 044 §3.2).
 *
 * Reusa `readCsvTable` — o mesmo tokenizador do import de contatos —
 * e diverge dele num único ponto deliberado: uma linha **sem telefone
 * não é descartada aqui**. Ela sai com `phone: ''` para que
 * `normalizeAudience` a reporte como `missing_phone` com o número da
 * linha. O import de contatos pode se dar ao luxo de ignorar em
 * silêncio; um disparo, não — o usuário precisa saber que a linha 47
 * da planilha dele não vai receber nada.
 */

import {
  csvCell,
  parseTagCell,
  readCsvTable,
} from '@/lib/contacts/parse-contact-csv';
import { AudienceParseError, MAX_AUDIENCE_ROWS } from './types';
import type { RawAudienceRow } from './types';

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
 * Fonte única: o mapeamento do parser, o modelo oferecido na UI
 * (`buildAudienceTemplateCsv`) e a lista de colunas exibida no passo 2
 * leem daqui. Duas listas seriam duas chances de o modelo sugerir um
 * cabeçalho que o parser não reconhece.
 */
export const AUDIENCE_COLUMNS: AudienceColumnSpec[] = [
  {
    key: 'phone',
    required: true,
    aliases: ['phone', 'telefone', 'celular', 'whatsapp', 'numero'],
  },
  { key: 'name', required: false, aliases: ['name', 'nome'] },
  { key: 'email', required: false, aliases: ['email', 'e-mail'] },
  { key: 'company', required: false, aliases: ['company', 'empresa'] },
  { key: 'tags', required: false, aliases: ['tags', 'etiquetas'] },
];

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
  for (const column of AUDIENCE_COLUMNS) {
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
 */
export function rowsFromTable(
  headers: string[],
  rows: { values: string[]; lineNumber: number }[],
  columns?: AudienceColumnMap
): RawAudienceRow[] {
  const cols = columns ?? mapAudienceColumns(headers);

  if (cols.phone === -1) {
    throw new AudienceParseError(
      'missing_phone_column',
      'A planilha precisa de uma coluna de telefone.'
    );
  }

  if (rows.length > MAX_AUDIENCE_ROWS) {
    throw new AudienceParseError(
      'too_many_rows',
      `A planilha tem mais de ${MAX_AUDIENCE_ROWS} linhas.`,
      { max: MAX_AUDIENCE_ROWS, found: rows.length }
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
  columns?: AudienceColumnMap
): RawAudienceRow[] {
  const { headers, rows } = readCsvTable(text);

  if (headers.length === 0) {
    throw new AudienceParseError(
      'empty_file',
      'O arquivo está vazio ou só tem cabeçalho.'
    );
  }

  return rowsFromTable(headers, rows, columns);
}
