/**
 * Geração de arquivo da exportação de contatos (SPEC 051 §4).
 *
 * Só o CSV vive aqui: o XLSX depende de `write-excel-file/node`, uma
 * dependência Node-only que a rota importa dinamicamente para não
 * entrar no bundle do app (§4). O BOM do CSV também não entra aqui —
 * é acrescentado pela rota, para esta função ficar pura e comparável
 * em teste.
 */

/** Aspas duplicadas, RFC 4180 — toda célula é citada, sem exceção. */
function quoteCsvCell(cell: string): string {
  return `"${cell.replace(/"/g, '""')}"`;
}

/**
 * Monta o CSV a partir da matriz `[header, ...linhas]` de
 * `buildContactExportMatrix`. CRLF entre linhas (o que o Excel espera
 * ao abrir um `.csv` no Windows) e vírgula como delimitador — de
 * propósito: é o que `parse-contact-csv.ts` lê, então o arquivo
 * exportado volta a ser importável pelo próprio sistema.
 */
export function buildContactsCsv(matrix: string[][]): string {
  return matrix.map((row) => row.map(quoteCsvCell).join(',')).join('\r\n');
}

/**
 * `<prefixo>-YYYY-MM-DD.<formato>` — prefixo vem do i18n
 * (`contatos`/`contacts`), data em ISO curta.
 */
export function contactExportFilename(
  prefix: string,
  format: 'csv' | 'xlsx',
  now: Date
): string {
  const isoDate = now.toISOString().slice(0, 10);
  return `${prefix}-${isoDate}.${format}`;
}
