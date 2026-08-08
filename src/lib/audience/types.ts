/**
 * Tipos compartilhados da ingestão de audiência (SPEC 044 §3.2).
 *
 * O ponto de projeto que mantém as três fontes (CSV, XLSX, Google
 * Sheets) simples: todas convergem para `RawAudienceRow[]` ANTES de
 * qualquer normalização, validação ou persistência. Nada abaixo desta
 * camada sabe de onde a linha veio.
 *
 * `RawAudienceRow` é deliberadamente o `ParsedContactRow` do import de
 * contatos (`@/lib/contacts/parse-contact-csv`) mais `sourceRow` — o
 * que permite reusar aquele parser sem fork e mantém o import de
 * contatos e o de audiência falando a mesma língua.
 */

import type { ParsedContactRow } from '@/lib/contacts/parse-contact-csv';

/** Uma linha lida de qualquer fonte, ainda sem validação de telefone. */
export interface RawAudienceRow extends ParsedContactRow {
  /**
   * Índice 1-based da linha na planilha original, contando o cabeçalho.
   * Existe só para a mensagem de erro: "linha 47: telefone inválido" é
   * acionável, "uma linha era inválida" não é.
   */
  sourceRow: number;
}

/** Por que uma linha foi rejeitada. Vira chave i18n `Broadcasts.audience.invalid.*`. */
export type InvalidReason =
  'missing_phone' | 'invalid_phone' | 'duplicate_in_file';

/** Linha descartada, preservada para exibição — nunca sumimos em silêncio. */
export interface InvalidRow {
  sourceRow: number;
  /** Valor bruto como veio do arquivo, para o usuário reconhecer a linha. */
  rawPhone: string;
  name?: string;
  reason: InvalidReason;
}

/** Linha aprovada, com telefone já sanitizado para o formato da Meta. */
export interface NormalizedAudienceRow {
  /** Dígitos apenas, pronto para a Graph API (`sanitizePhoneForMeta`). */
  phone: string;
  name?: string;
  email?: string;
  company?: string;
  tagNames: string[];
  sourceRow: number;
}

/**
 * Resultado do pipeline de normalização. Os contadores existem para o
 * resumo pós-parse — "1 240 lidas · 1 198 válidas · 31 duplicadas ·
 * 11 inválidas" — e cada um é derivável das listas, mas materializá-los
 * evita recontar em três componentes diferentes.
 */
export interface NormalizedAudience {
  rows: NormalizedAudienceRow[];
  invalid: InvalidRow[];
  stats: {
    /** Linhas de dados lidas do arquivo (exclui o cabeçalho). */
    read: number;
    valid: number;
    duplicates: number;
    invalid: number;
  };
}

/** Fontes de audiência suportadas pelo passo 2. */
export type AudienceSourceKind =
  'all' | 'tags' | 'custom_field' | 'csv' | 'xlsx' | 'google_sheets';

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
 * Abaixo deste número de linhas o parsing roda na main thread: o custo
 * de subir um Worker (spawn + transferência) supera o ganho, e a UI
 * não chega a piscar.
 */
export const WORKER_THRESHOLD_ROWS = 2_000;

/** Códigos de erro de parsing. Mapeiam para `Broadcasts.audience.parseError.*`. */
export type ParseErrorCode =
  | 'file_too_large'
  | 'too_many_rows'
  | 'missing_phone_column'
  | 'empty_file'
  | 'unreadable'
  | 'unsupported_format';

/** Erro de parsing com código estável — a UI traduz, não exibe `message`. */
export class AudienceParseError extends Error {
  readonly code: ParseErrorCode;
  /** Contexto opcional para interpolação na mensagem traduzida. */
  readonly meta?: Record<string, string | number>;

  constructor(
    code: ParseErrorCode,
    message: string,
    meta?: Record<string, string | number>
  ) {
    super(message);
    this.name = 'AudienceParseError';
    this.code = code;
    this.meta = meta;
  }
}
