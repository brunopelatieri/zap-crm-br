import { NextResponse } from 'next/server';
import { format as formatDate } from 'date-fns';
import { getLocale, getTranslations } from 'next-intl/server';
import type { SheetData } from 'write-excel-file/node';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  isContactExportFieldId,
  sortContactExportFields,
  type ContactExportFieldId,
} from '@/lib/contacts/export-fields';
import {
  CONTACT_EXPORT_MAX_ROWS,
  fetchContactsForExport,
  type ContactExportScope,
} from '@/lib/contacts/export-fetch';
import {
  buildContactExportMatrix,
  type ContactExportCustomFieldDef,
  type ContactExportLabels,
} from '@/lib/contacts/export-serialize';
import {
  buildContactsCsv,
  contactExportFilename,
} from '@/lib/contacts/export-file';

// Uma exportação grande passa dos 10s padrão do host (SPEC 051 §6).
export const maxDuration = 60;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ParsedExportRequest {
  format: 'csv' | 'xlsx';
  fields: ContactExportFieldId[];
  customFieldIds?: string[];
  scope: ContactExportScope;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((v) => typeof v === 'string') ? (value as string[]) : null;
}

/**
 * Validação do payload (SPEC 051 §6 ponto 2): formato conhecido,
 * `fields` só com ids do catálogo, `scope.ids` ≤ o teto e todos UUID.
 * `phone` é forçado na lista via `sortContactExportFields` mesmo que o
 * cliente não mande — é a identidade do contato.
 */
function parseRequestBody(
  body: unknown
): ParsedExportRequest | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Invalid JSON body' };
  const b = body as Record<string, unknown>;

  if (b.format !== 'csv' && b.format !== 'xlsx') {
    return { error: 'format must be "csv" or "xlsx"' };
  }

  const rawFields = stringArray(b.fields);
  if (!rawFields) return { error: 'fields must be an array of strings' };
  if (rawFields.some((f) => !isContactExportFieldId(f))) {
    return { error: 'fields contains an unknown field id' };
  }
  const fields = sortContactExportFields(rawFields as ContactExportFieldId[]);

  let customFieldIds: string[] | undefined;
  if (b.customFieldIds !== undefined) {
    const ids = stringArray(b.customFieldIds);
    if (!ids) return { error: 'customFieldIds must be an array of strings' };
    customFieldIds = ids;
  }

  const rawScope = b.scope;
  if (!rawScope || typeof rawScope !== 'object') {
    return { error: 'scope is required' };
  }
  const s = rawScope as Record<string, unknown>;

  let scope: ContactExportScope;
  if (s.mode === 'filter') {
    scope = {
      mode: 'filter',
      search: typeof s.search === 'string' ? s.search : '',
      tagIds: stringArray(s.tagIds) ?? [],
      channelIds: stringArray(s.channelIds) ?? [],
    };
  } else if (s.mode === 'selection') {
    const ids = stringArray(s.ids);
    if (!ids) return { error: 'scope.ids must be an array of strings' };
    if (ids.length > CONTACT_EXPORT_MAX_ROWS) {
      return { error: `scope.ids exceeds ${CONTACT_EXPORT_MAX_ROWS}` };
    }
    if (ids.some((id) => !UUID_RE.test(id))) {
      return { error: 'scope.ids must all be UUIDs' };
    }
    scope = { mode: 'selection', ids };
  } else {
    return { error: 'scope.mode must be "filter" or "selection"' };
  }

  return { format: b.format, fields, customFieldIds, scope };
}

export async function POST(request: Request) {
  let ctx;
  try {
    ctx = await requireRole('admin');
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  const parsed = parseRequestBody(body);
  if ('error' in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { format: fileFormat, fields, customFieldIds, scope } = parsed;

  const { rows, truncated, total } = await fetchContactsForExport(
    ctx.supabase,
    scope,
    fields
  );
  if (truncated) {
    return NextResponse.json(
      { error: 'export_too_large', total },
      { status: 413 }
    );
  }

  let customFieldDefs: ContactExportCustomFieldDef[] = [];
  if (fields.includes('custom_fields')) {
    const { data, error } = await ctx.supabase
      .from('custom_fields')
      .select('id, field_name')
      .order('field_name', { ascending: true });
    if (error) {
      console.error('[contacts/export] custom_fields fetch failed:', error);
    } else {
      const defs = (data ?? []) as ContactExportCustomFieldDef[];
      customFieldDefs = customFieldIds
        ? defs.filter((d) => customFieldIds.includes(d.id))
        : defs;
    }
  }

  const locale = await getLocale();
  const tColumns = await getTranslations('Contacts.exportColumns');
  const tValues = await getTranslations('Contacts.exportValues');
  const tModal = await getTranslations('Contacts.exportModal');

  // Datas já formatadas no locale, texto puro — o XLSX bate com o que a
  // tela mostra (§4) e o CSV não precisa reabrir a discussão de fuso.
  const datePattern =
    locale === 'pt-BR' ? 'dd/MM/yyyy HH:mm' : 'MM/dd/yyyy HH:mm';

  const labels: ContactExportLabels = {
    columns: {
      name: tColumns('name'),
      phone: tColumns('phone'),
      email: tColumns('email'),
      company: tColumns('company'),
      created_at: tColumns('created_at'),
      notes: tColumns('notes'),
      phone_e164: tColumns('phone_e164'),
      whatsapp_status: tColumns('whatsapp_status'),
      whatsapp_status_reason: tColumns('whatsapp_status_reason'),
      consent_status: tColumns('consent_status'),
      consent_source: tColumns('consent_source'),
      consent_date: tColumns('consent_date'),
      last_interaction: tColumns('last_interaction'),
      session_window: tColumns('session_window'),
    },
    tagColumn: (n) => tColumns('tagColumn', { n }),
    channelColumn: (n) => tColumns('channelColumn', { n }),
    values: {
      optedIn: tValues('optedIn'),
      optedOut: tValues('optedOut'),
      unknown: tValues('unknown'),
      valid: tValues('valid'),
      invalid: tValues('invalid'),
      windowOpen: tValues('windowOpen'),
      windowClosed: tValues('windowClosed'),
      windowNA: tValues('windowNA'),
      consentSource: {
        inbound_keyword: tValues('consentSource.inbound_keyword'),
        manual: tValues('consentSource.manual'),
        import: tValues('consentSource.import'),
        api: tValues('consentSource.api'),
        automation: tValues('consentSource.automation'),
      },
      whatsappReason: {
        consecutive_failures: tValues('whatsappReason.consecutive_failures'),
        meta_error: tValues('whatsappReason.meta_error'),
        manual: tValues('whatsappReason.manual'),
      },
    },
    formatDate: (iso) => formatDate(new Date(iso), datePattern),
  };

  const matrix = buildContactExportMatrix(
    rows,
    fields,
    customFieldDefs,
    labels
  );
  const filename = contactExportFilename(
    tModal('filenamePrefix'),
    fileFormat,
    new Date()
  );

  let fileBody: BodyInit;
  let contentType: string;

  if (fileFormat === 'csv') {
    // BOM aqui, não em `buildContactsCsv` — mantém a função pura e
    // comparável em teste (§4).
    fileBody = '﻿' + buildContactsCsv(matrix);
    contentType = 'text/csv; charset=utf-8';
  } else {
    // Import dinâmico: `write-excel-file/node` é Node-only e não deve
    // entrar no bundle do app (§4).
    const { default: writeXlsxFile } = await import('write-excel-file/node');
    // Toda célula é `type: String` — sem isso o Excel lê um telefone
    // longo como notação científica e come os zeros à esquerda (§4).
    const sheetData: SheetData = matrix.map((row) =>
      row.map((cell) => ({ value: cell, type: String }))
    );
    const workbook = writeXlsxFile(sheetData);
    const buffer = await workbook.toBuffer();
    fileBody = new Uint8Array(buffer);
    contentType =
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }

  // Trilha de auditoria — `supabaseAdmin()` só aqui, depois do role já
  // checado. Best-effort: uma falha não derruba o download, o arquivo
  // já está montado (§6).
  try {
    await supabaseAdmin()
      .from('contact_exports')
      .insert({
        account_id: ctx.accountId,
        user_id: ctx.userId,
        format: fileFormat,
        scope: scope.mode,
        row_count: rows.length,
        fields,
        filter:
          scope.mode === 'filter'
            ? {
                search: scope.search,
                tag_ids: scope.tagIds,
                channel_ids: scope.channelIds,
              }
            : { selected: scope.ids.length },
      });
  } catch (err) {
    console.error('[contacts/export] audit insert failed:', err);
  }

  return new NextResponse(fileBody, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'X-Export-Row-Count': String(rows.length),
      'X-Export-Total': String(total),
    },
  });
}
