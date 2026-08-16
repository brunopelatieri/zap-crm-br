/**
 * Tipos de FORMATO da camada de planilha (SPEC 052 D-1) — sem domínio.
 *
 * Movido de `lib/audience/types.ts`: nada aqui sabe o que é um contato
 * ou uma audiência de disparo, só como ler `.csv`/`.xlsx`/Google
 * Sheets. Os tipos de domínio (`RawAudienceRow`, `NormalizedAudience`,
 * etc.) continuam em `lib/audience/types.ts` — são regra de disparo.
 */

/** Formatos de arquivo aceitos pelo dropzone. */
export const ACCEPTED_SPREADSHEET_EXTENSIONS = ['.csv', '.xlsx'] as const;

/**
 * Teto de tamanho de arquivo (SPEC 044 §3.4). Validado ANTES de ler o
 * conteúdo — um `.xlsx` de 10 MB já passa de 100 k linhas, e ler para
 * só então rejeitar desperdiça a memória que estamos tentando proteger.
 */
export const MAX_SPREADSHEET_BYTES = 10 * 1024 * 1024;

/** Teto de linhas processadas (SPEC 044 §3.4) — limite de memória do Worker. */
export const MAX_AUDIENCE_ROWS = 50_000;

/**
 * Teto de linhas para a importação de CONTATOS (SPEC 052 D-7/F6) — bem
 * mais baixo que `MAX_AUDIENCE_ROWS`. A audiência só LÊ a planilha; o
 * import de contatos ESCREVE — insere pelo navegador, sujeito a RLS, em
 * lotes de 50. 50 000 linhas seriam 1 000 requisições sequenciais; 10 000
 * ficam em 200, ainda incômodo mas tolerável — acima disso a mensagem
 * pede para dividir o arquivo em vez de deixar a aba travada por minutos.
 */
export const MAX_CONTACTS_ROWS = 10_000;

/**
 * Abaixo deste número de linhas o parsing roda na main thread: o custo
 * de subir um Worker (spawn + transferência) supera o ganho, e a UI
 * não chega a piscar.
 */
export const WORKER_THRESHOLD_ROWS = 2_000;

/**
 * Códigos de erro de parsing. Mapeiam para `Import.parseError.*`
 * (SPEC 052 F7) — consumido tanto pelo passo 2 do disparo quanto pelo
 * importador de contatos.
 */
export type ParseErrorCode =
  | 'file_too_large'
  | 'too_many_rows'
  | 'missing_phone_column'
  | 'empty_file'
  | 'unreadable'
  | 'unsupported_format';

/** Erro de parsing com código estável — a UI traduz, não exibe `message`. */
export class SpreadsheetParseError extends Error {
  readonly code: ParseErrorCode;
  /** Contexto opcional para interpolação na mensagem traduzida. */
  readonly meta?: Record<string, string | number>;
  /**
   * Abas já conhecidas quando o erro ocorreu (só XLSX). Sem isto, uma
   * pasta com uma aba de 15 mil linhas e outra de 800 rejeita a
   * primeira por `too_many_rows` e o seletor de aba some junto — o
   * usuário fica sem como trocar para a aba que serviria (SPEC 052 F6,
   * achado de revisão).
   */
  readonly sheetNames?: string[];

  constructor(
    code: ParseErrorCode,
    message: string,
    meta?: Record<string, string | number>,
    sheetNames?: string[]
  ) {
    super(message);
    this.name = 'SpreadsheetParseError';
    this.code = code;
    this.meta = meta;
    this.sheetNames = sheetNames;
  }
}
