/**
 * CSV parsing for the contacts import modal. Shared + unit-tested so
 * tag-column handling stays aligned with phone/name/email/company.
 */

export interface ContactColumnSpec {
  key: 'phone' | 'name' | 'email' | 'company' | 'tags';
  /**
   * Cabeçalhos aceitos, em ordem de preferência. O primeiro é o
   * canônico (o que a exportação em inglês escreve); os demais cobrem
   * variações em pt-BR — sem eles, um CSV exportado com cabeçalhos
   * traduzidos (`telefone`, `nome`...) não reconhece NENHUMA linha ao
   * ser reimportado (SPEC 051 §4/§9.8: o CSV exportado precisa voltar
   * a ser importável pelo próprio sistema).
   *
   * Fonte única também para `spreadsheet/parse-csv.ts`
   * (`SPREADSHEET_COLUMNS` deriva daqui) — duas listas de aliases
   * seriam duas chances de divergir.
   */
  aliases: string[];
}

export const CONTACT_COLUMNS: ContactColumnSpec[] = [
  {
    key: 'phone',
    aliases: ['phone', 'telefone', 'celular', 'whatsapp', 'numero'],
  },
  { key: 'name', aliases: ['name', 'nome'] },
  { key: 'email', aliases: ['email', 'e-mail'] },
  { key: 'company', aliases: ['company', 'empresa'] },
  { key: 'tags', aliases: ['tags', 'etiquetas'] },
];

/** Primeiro índice cujo cabeçalho casa com um dos apelidos. */
export function findColumn(headers: string[], aliases: string[]): number {
  for (const alias of aliases) {
    const idx = headers.indexOf(alias);
    if (idx !== -1) return idx;
  }
  return -1;
}

function columnAliases(key: ContactColumnSpec['key']): string[] {
  return CONTACT_COLUMNS.find((c) => c.key === key)!.aliases;
}

export interface ParsedContactRow {
  phone: string;
  name?: string;
  email?: string;
  company?: string;
  /** Tag names from the optional `tags` column (comma/semicolon separated). */
  tagNames: string[];
  /** 1-based line number in the original file (SPEC 050 F3 — lets the
   *  import summary say "line 47", not just "one row was skipped"). */
  sourceRow: number;
}

/** Split a CSV cell into unique tag names (case-insensitive de-dupe). */
export function parseTagCell(value: string | undefined): string[] {
  if (!value?.trim()) return [];

  const seen = new Set<string>();
  const names: string[] = [];

  for (const part of value.split(/[,;]/)) {
    const name = part.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }

  return names;
}

export interface ParseContactCsvResult {
  rows: ParsedContactRow[];
  /** True when the CSV header includes a `tags` column. */
  hasTagsColumn: boolean;
  /** True when the CSV header includes a `company` column. */
  hasCompanyColumn: boolean;
}

/** One data line, with the 1-based line number it came from. */
export interface CsvTableRow {
  values: string[];
  /**
   * 1-based line number in the original file, counting the header.
   * The contacts import ignores this; the broadcast audience importer
   * uses it to say "line 47 has an invalid phone" instead of the
   * useless "one line was skipped".
   */
  lineNumber: number;
}

export interface CsvTable {
  /** Lower-cased, unquoted header cells. */
  headers: string[];
  rows: CsvTableRow[];
}

/** Delimitadores candidatos, na ordem que desempata (SPEC 052 D-4). */
const DELIMITER_CANDIDATES = [',', ';', '\t'];

/**
 * Conta ocorrências de `char` na linha, ignorando as que estão dentro
 * de um campo entre aspas duplas (respeitando `""` escapado, RFC 4180).
 *
 * Sem isto, um cabeçalho como `telefone;"empresa,filial"` conta uma
 * vírgula a mais (a de dentro da aspas) e o desempate cai errado em
 * `,` — exatamente o CSV `;` que o D-4 existe para reconhecer.
 */
function countUnquoted(line: string, char: string): number {
  let count = 0;
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i++; // par escapado — não fecha a aspa
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === char && !inQuotes) {
      count++;
    }
  }

  return count;
}

/**
 * Fareja o delimitador na linha de cabeçalho (só nela): vence o que
 * aparecer mais vezes fora de um campo entre aspas; empate ou zero
 * ocorrências caem em `,`.
 *
 * Só o cabeçalho é o que o autor da planilha controla e a única linha
 * em que o delimitador aparece por definição — farejar no corpo
 * trocaria o delimitador por causa de uma vírgula dentro de um nome de
 * empresa (SPEC 052 §4 D-4).
 */
function sniffDelimiter(headerLine: string): string {
  let best = DELIMITER_CANDIDATES[0];
  let bestCount = 0;

  for (const candidate of DELIMITER_CANDIDATES) {
    const count = countUnquoted(headerLine, candidate);
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }

  return best;
}

/**
 * Remove só um par de aspas SIMPLES que envolve a célula inteira — o
 * único caso que `parseCsvLine` não trata, porque aspas simples nunca
 * fizeram parte da sintaxe de delimitação do CSV.
 *
 * Nunca aspas DUPLAS: `parseCsvLine` já resolveu toda a sintaxe RFC
 * 4180 de um campo `"…"` (abre, fecha, desescapa `""` → `"`) antes de
 * este valor chegar aqui. Repetir a remoção corrompia um valor cujo
 * conteúdo LEGÍTIMO começa e termina com `"` — ex.: a célula
 * `"""Bibi"""` (RFC 4180 para o valor literal `"Bibi"`) virava `Bibi`,
 * perdendo as aspas que eram o dado.
 */
function stripEnclosingSingleQuote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    trimmed[0] === "'" &&
    trimmed[trimmed.length - 1] === "'"
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Low-level CSV reader: header + data lines, nothing domain-specific.
 *
 * Extracted so the contacts import and the broadcast audience import
 * share one tokenizer — the part with the real edge cases (quoted
 * fields, CRLF, a leading BOM absorbed by `trim`, delimiter sniffing).
 * The two callers disagree about what to do with a row that has no
 * phone (the import drops it, the audience importer reports it), so
 * that decision stays with them and not here.
 */
export function readCsvTable(text: string): CsvTable {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return { headers: [], rows: [] };

  const delimiter = sniffDelimiter(lines[0]);

  // O cabeçalho passa pelo MESMO tokenizador ciente de aspas que as
  // linhas de dados — um `.split(delimiter)` ingênuo aqui divide um
  // cabeçalho como `"phone","nome, completo","email"` em 4 pedaços em
  // vez de 3 (a vírgula dentro da aspas conta), desalinhando os
  // índices de coluna contra as linhas de dados, que `parseCsvLine`
  // sempre leu certo.
  const headers = parseCsvLine(lines[0], delimiter).map((h) =>
    stripEnclosingSingleQuote(h).toLowerCase()
  );

  const rows: CsvTableRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    rows.push({ values: parseCsvLine(line, delimiter), lineNumber: i + 1 });
  }

  return { headers, rows };
}

/** Read a cell by column index, stripping only an enclosing single quote. Empty → undefined. */
export function csvCell(values: string[], index: number): string | undefined {
  if (index < 0) return undefined;
  const raw = values[index];
  if (raw === undefined) return undefined;
  return stripEnclosingSingleQuote(raw) || undefined;
}

export function parseContactCsv(text: string): ParseContactCsvResult {
  const { headers, rows: tableRows } = readCsvTable(text);
  if (headers.length === 0) {
    return { rows: [], hasTagsColumn: false, hasCompanyColumn: false };
  }

  const phoneIdx = findColumn(headers, columnAliases('phone'));
  if (phoneIdx === -1) {
    return { rows: [], hasTagsColumn: false, hasCompanyColumn: false };
  }

  const nameIdx = findColumn(headers, columnAliases('name'));
  const emailIdx = findColumn(headers, columnAliases('email'));
  const companyIdx = findColumn(headers, columnAliases('company'));
  const tagsIdx = findColumn(headers, columnAliases('tags'));

  const rows: ParsedContactRow[] = [];

  for (const { values, lineNumber } of tableRows) {
    const phone = csvCell(values, phoneIdx);
    if (!phone) continue;

    rows.push({
      phone,
      name: csvCell(values, nameIdx),
      email: csvCell(values, emailIdx),
      company: csvCell(values, companyIdx),
      tagNames: tagsIdx >= 0 ? parseTagCell(csvCell(values, tagsIdx)) : [],
      sourceRow: lineNumber,
    });
  }

  return {
    rows,
    hasTagsColumn: tagsIdx >= 0,
    hasCompanyColumn: companyIdx >= 0,
  };
}

/**
 * Simple CSV line parse (handles quoted fields with the given
 * delimiter, and unescapes RFC 4180 `""` inside a quoted field).
 */
function parseCsvLine(line: string, delimiter: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}
