/**
 * Serializer puro da exportação de contatos (SPEC 051 §3).
 *
 * Recebe linhas já coletadas (`export-fetch.ts`, F4) e devolve a matriz
 * do arquivo. Zero I/O, zero `next-intl` — os rótulos chegam prontos em
 * `ContactExportLabels`, o que torna esta função testável sem stub de
 * Supabase e sem locale.
 *
 * A ordem das colunas segue `CONTACT_EXPORT_FIELDS` (a ordem canônica do
 * catálogo), nunca a ordem de `fields` recebida — é isso que garante que
 * o arquivo saia igual não importa em que ordem o usuário marcou os
 * checkboxes no modal.
 */

import type { Contact } from '@/types';
import {
  CONTACT_EXPORT_FIELDS,
  type ContactExportFieldId,
} from './export-fields';

export interface ContactExportRow {
  /** Linha crua de `contacts`. */
  contact: Contact;
  /** Ordenadas por nome. */
  tagNames: string[];
  /** Distintas, ordenadas por nome. */
  channelNames: string[];
  /** `custom_field_id` → valor. */
  customValues: Record<string, string>;
  /** Mais recente primeiro. */
  notes: { created_at: string; note_text: string }[];
  lastMessageAt: string | null;
  /** `null` = canal sem janela de 24h (QR) — nunca vira "fechada". */
  sessionWindowOpen: boolean | null;
}

export interface ContactExportLabels {
  columns: {
    name: string;
    phone: string;
    email: string;
    company: string;
    created_at: string;
    notes: string;
    phone_e164: string;
    whatsapp_status: string;
    whatsapp_status_reason: string;
    consent_status: string;
    consent_source: string;
    consent_date: string;
    last_interaction: string;
    session_window: string;
  };
  tagColumn: (n: number) => string;
  channelColumn: (n: number) => string;
  values: {
    optedIn: string;
    optedOut: string;
    unknown: string;
    valid: string;
    invalid: string;
    windowOpen: string;
    windowClosed: string;
    windowNA: string;
    consentSource: Record<string, string>;
    whatsappReason: Record<string, string>;
  };
  /** Formata um ISO string como `dd/MM/yyyy HH:mm` (locale do rótulo). */
  formatDate: (iso: string) => string;
}

/** Definição de campo personalizado, na ordem em que vira coluna. */
export interface ContactExportCustomFieldDef {
  id: string;
  field_name: string;
}

interface ExportColumn {
  header: string;
  getValue: (row: ContactExportRow) => string;
}

function orEmpty(value: string | null | undefined): string {
  return value ?? '';
}

/**
 * Prefixo de data de uma nota: `formatDate` devolve `dd/MM/yyyy HH:mm`
 * (ou o equivalente no locale ativo); a nota só quer a parte da data,
 * então toma tudo antes do primeiro espaço — vale para qualquer locale
 * em que data e hora sejam separadas por espaço.
 */
function noteDatePrefix(
  iso: string,
  formatDate: ContactExportLabels['formatDate']
): string {
  return formatDate(iso).split(' ')[0];
}

function buildDynamicColumns(
  rows: ContactExportRow[],
  pick: (row: ContactExportRow) => string[],
  columnLabel: (n: number) => string
): ExportColumn[] {
  const width = rows.reduce((max, row) => Math.max(max, pick(row).length), 0);
  return Array.from({ length: width }, (_, i) => ({
    header: columnLabel(i + 1),
    getValue: (row: ContactExportRow) => orEmpty(pick(row)[i]),
  }));
}

function buildColumnsForField(
  fieldId: ContactExportFieldId,
  rows: ContactExportRow[],
  customFieldDefs: ContactExportCustomFieldDef[],
  labels: ContactExportLabels
): ExportColumn[] {
  const { columns, values, formatDate } = labels;

  switch (fieldId) {
    case 'name':
      return [
        { header: columns.name, getValue: (r) => orEmpty(r.contact.name) },
      ];
    case 'phone':
      return [
        { header: columns.phone, getValue: (r) => orEmpty(r.contact.phone) },
      ];
    case 'email':
      return [
        { header: columns.email, getValue: (r) => orEmpty(r.contact.email) },
      ];
    case 'tags':
      return buildDynamicColumns(rows, (r) => r.tagNames, labels.tagColumn);
    case 'company':
      return [
        {
          header: columns.company,
          getValue: (r) => orEmpty(r.contact.company),
        },
      ];
    case 'created_at':
      return [
        {
          header: columns.created_at,
          getValue: (r) => formatDate(r.contact.created_at),
        },
      ];
    case 'channels':
      return buildDynamicColumns(
        rows,
        (r) => r.channelNames,
        labels.channelColumn
      );
    case 'custom_fields':
      return customFieldDefs.map((def) => ({
        header: def.field_name,
        getValue: (r) => orEmpty(r.customValues[def.id]),
      }));
    case 'notes':
      return [
        {
          header: columns.notes,
          getValue: (r) =>
            r.notes
              .map(
                (note) =>
                  `[${noteDatePrefix(note.created_at, formatDate)}] ${note.note_text}`
              )
              .join('\n'),
        },
      ];
    case 'phone_e164':
      return [
        {
          header: columns.phone_e164,
          getValue: (r) => orEmpty(r.contact.phone_normalized),
        },
      ];
    case 'whatsapp_status':
      return [
        {
          header: columns.whatsapp_status,
          getValue: (r) => {
            const status = r.contact.whatsapp_status;
            if (status === 'valid') return values.valid;
            if (status === 'invalid') return values.invalid;
            return '';
          },
        },
        {
          header: columns.whatsapp_status_reason,
          getValue: (r) => {
            const reason = r.contact.whatsapp_status_reason;
            return reason ? orEmpty(values.whatsappReason[reason]) : '';
          },
        },
      ];
    case 'consent':
      return [
        {
          header: columns.consent_status,
          getValue: (r) => {
            const status = r.contact.opt_in_status;
            if (status === 'opted_in') return values.optedIn;
            if (status === 'opted_out') return values.optedOut;
            return values.unknown;
          },
        },
        {
          header: columns.consent_source,
          getValue: (r) => {
            const source = r.contact.opt_in_source;
            return source ? orEmpty(values.consentSource[source]) : '';
          },
        },
        {
          header: columns.consent_date,
          getValue: (r) =>
            r.contact.opt_in_updated_at
              ? formatDate(r.contact.opt_in_updated_at)
              : '',
        },
      ];
    case 'last_interaction':
      return [
        {
          header: columns.last_interaction,
          getValue: (r) => (r.lastMessageAt ? formatDate(r.lastMessageAt) : ''),
        },
        {
          header: columns.session_window,
          getValue: (r) => {
            if (r.sessionWindowOpen === null) return values.windowNA;
            return r.sessionWindowOpen
              ? values.windowOpen
              : values.windowClosed;
          },
        },
      ];
    default:
      return [];
  }
}

/**
 * Monta a matriz `[header, ...linhas]` do arquivo exportado.
 *
 * A largura das colunas dinâmicas (`tags`, `channels`) é o máximo entre
 * as linhas exportadas — se ninguém tiver etiqueta, nenhuma coluna
 * `etiqueta_*` é emitida (nunca uma `etiqueta_1` vazia para todo mundo).
 */
export function buildContactExportMatrix(
  rows: ContactExportRow[],
  fields: ContactExportFieldId[],
  customFieldDefs: ContactExportCustomFieldDef[],
  labels: ContactExportLabels
): string[][] {
  const requested = new Set(fields);
  const columns = CONTACT_EXPORT_FIELDS.filter((field) =>
    requested.has(field.id)
  ).flatMap((field) =>
    buildColumnsForField(field.id, rows, customFieldDefs, labels)
  );

  const header = columns.map((column) => column.header);
  const body = rows.map((row) => columns.map((column) => column.getValue(row)));
  return [header, ...body];
}
