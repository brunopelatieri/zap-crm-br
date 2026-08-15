/**
 * Tipos de DOMÍNIO da audiência de disparo (SPEC 044 §3.2, SPEC 052 D-1).
 *
 * Os tipos de FORMATO (leitura de planilha, sem domínio) moraram aqui
 * e foram para `@/lib/spreadsheet/types` — este arquivo ficou só com o
 * que é regra de disparo: uma linha crua, por que ela foi rejeitada, e
 * o resultado normalizado.
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
import type { PhoneRejectReason } from '@/lib/phone/br';

/** Uma linha lida de qualquer fonte, ainda sem validação de telefone. */
export interface RawAudienceRow extends ParsedContactRow {
  /**
   * Índice 1-based da linha na planilha original, contando o cabeçalho.
   * Existe só para a mensagem de erro: "linha 47: telefone inválido" é
   * acionável, "uma linha era inválida" não é.
   */
  sourceRow: number;
}

/**
 * Por que uma linha foi rejeitada. Vira chave i18n `Import.reason.*`
 * (SPEC 052 D-2/F2) — o mesmo vocabulário do import de contatos
 * (`PhoneRejectReason`, SPEC 050) mais `duplicate_in_file`, que só faz
 * sentido para uma planilha inteira, não para um único telefone.
 */
export type InvalidReason = PhoneRejectReason | 'duplicate_in_file';

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
