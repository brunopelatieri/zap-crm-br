/**
 * CSV parsing for the contacts import modal. Shared + unit-tested so
 * tag-column handling stays aligned with phone/name/email/company.
 */

export interface ParsedContactRow {
  phone: string;
  name?: string;
  email?: string;
  company?: string;
  /** Tag names from the optional `tags` column (comma/semicolon separated). */
  tagNames: string[];
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

/**
 * Low-level CSV reader: header + data lines, nothing domain-specific.
 *
 * Extracted so the contacts import and the broadcast audience import
 * share one tokenizer — the part with the real edge cases (quoted
 * fields, CRLF, a leading BOM absorbed by `trim`). The two callers
 * disagree about what to do with a row that has no phone (the import
 * drops it, the audience importer reports it), so that decision stays
 * with them and not here.
 */
export function readCsvTable(text: string): CsvTable {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return { headers: [], rows: [] };

  const headers = lines[0]
    .split(',')
    .map((h) => h.trim().toLowerCase().replace(/["']/g, ''));

  const rows: CsvTableRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    rows.push({ values: parseCsvLine(line), lineNumber: i + 1 });
  }

  return { headers, rows };
}

/** Read a cell by column index, stripping stray quotes. Empty → undefined. */
export function csvCell(values: string[], index: number): string | undefined {
  if (index < 0) return undefined;
  return values[index]?.replace(/["']/g, '').trim() || undefined;
}

export function parseContactCsv(text: string): ParseContactCsvResult {
  const { headers, rows: tableRows } = readCsvTable(text);
  if (headers.length === 0) {
    return { rows: [], hasTagsColumn: false, hasCompanyColumn: false };
  }

  const phoneIdx = headers.indexOf('phone');
  if (phoneIdx === -1) {
    return { rows: [], hasTagsColumn: false, hasCompanyColumn: false };
  }

  const nameIdx = headers.indexOf('name');
  const emailIdx = headers.indexOf('email');
  const companyIdx = headers.indexOf('company');
  const tagsIdx = headers.indexOf('tags');

  const rows: ParsedContactRow[] = [];

  for (const { values } of tableRows) {
    const phone = values[phoneIdx]?.replace(/["']/g, '').trim();
    if (!phone) continue;

    rows.push({
      phone,
      name:
        nameIdx >= 0
          ? values[nameIdx]?.replace(/["']/g, '').trim() || undefined
          : undefined,
      email:
        emailIdx >= 0
          ? values[emailIdx]?.replace(/["']/g, '').trim() || undefined
          : undefined,
      company:
        companyIdx >= 0
          ? values[companyIdx]?.replace(/["']/g, '').trim() || undefined
          : undefined,
      tagNames:
        tagsIdx >= 0 ? parseTagCell(values[tagsIdx]?.replace(/["']/g, '')) : [],
    });
  }

  return {
    rows,
    hasTagsColumn: tagsIdx >= 0,
    hasCompanyColumn: companyIdx >= 0,
  };
}

/** Simple CSV line parse (handles quoted fields). */
function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}
