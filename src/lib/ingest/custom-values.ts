// ============================================================
// Campos personalizados — escrita para o webhook de entrada (SPEC
// 055 achado C / D-8 / F3).
//
// Casamento por NOME, case-insensitive com trim, contra
// `custom_fields.field_name` da conta. Sem correspondência → o campo
// é pulado (nunca cria campo novo). `custom_fields` não tem índice
// único por `(account_id, field_name)` (SPEC 055 §2.2) — se o
// casamento for ambíguo (duas definições diferindo só em caixa), o
// campo também é pulado, nunca escrito ao acaso.
//
// A escrita é SEMPRE `upsert` por `(contact_id, custom_field_id)` —
// nunca o `DELETE`-then-`INSERT` de `contact-detail-view.tsx`
// (achado C), que apagaria os campos que este POST não conhece.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import type { IngestCustomFieldInput, IngestWarning } from './validate';

export class IngestCustomValuesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IngestCustomValuesError';
  }
}

export type CustomValueOutcome = {
  field: string;
  status: 'matched' | 'not_found' | 'ambiguous';
};

export interface ApplyCustomValuesResult {
  outcomes: CustomValueOutcome[];
  warnings: IngestWarning[];
}

export interface ApplyCustomValuesParams {
  accountId: string;
  contactId: string;
  entries: IngestCustomFieldInput[];
}

/**
 * Aplica `entries` (já normalizadas por `parseIngestPayload`) contra
 * os campos personalizados da conta. No-op quando `entries` está
 * vazio — nem a query de `custom_fields` roda.
 */
export async function applyCustomValues(
  db: SupabaseClient,
  { accountId, contactId, entries }: ApplyCustomValuesParams
): Promise<ApplyCustomValuesResult> {
  if (entries.length === 0) return { outcomes: [], warnings: [] };

  const { data: fields, error } = await db
    .from('custom_fields')
    .select('id, field_name')
    .eq('account_id', accountId);
  if (error) {
    throw new IngestCustomValuesError('Failed to load custom fields');
  }

  // Agrupado por chave case-insensitive/trim — o mesmo casamento que
  // `custom-fields-manager.tsx` já faz client-side. Mais de um id na
  // mesma chave é o caso ambíguo (§2.2: sem unique por conta+nome).
  const idsByKey = new Map<string, string[]>();
  for (const f of fields ?? []) {
    const key = String(f.field_name).trim().toLowerCase();
    const list = idsByKey.get(key) ?? [];
    list.push(f.id as string);
    idsByKey.set(key, list);
  }

  const outcomes: CustomValueOutcome[] = [];
  const warnings: IngestWarning[] = [];
  // Chaveado por custom_field_id: se o payload repetir o mesmo campo
  // duas vezes, o upsert não pode receber a mesma chave de conflito
  // duas vezes na mesma chamada — o Postgres rejeita isso. O último
  // valor do payload vence, mesma convenção usada para tags/nomes.
  const rowsByFieldId = new Map<
    string,
    { contact_id: string; custom_field_id: string; value: string }
  >();

  for (const entry of entries) {
    const key = entry.field.trim().toLowerCase();
    const ids = idsByKey.get(key) ?? [];

    if (ids.length === 0) {
      outcomes.push({ field: entry.field, status: 'not_found' });
      warnings.push({
        code: 'custom_field_not_found',
        message: `Custom field '${entry.field}' does not exist in this account`,
      });
      continue;
    }

    if (ids.length > 1) {
      outcomes.push({ field: entry.field, status: 'ambiguous' });
      warnings.push({
        code: 'custom_field_ambiguous',
        message: `Custom field '${entry.field}' matches more than one definition in this account (differing only by case) — skipped`,
      });
      continue;
    }

    outcomes.push({ field: entry.field, status: 'matched' });
    rowsByFieldId.set(ids[0], {
      contact_id: contactId,
      custom_field_id: ids[0],
      value: entry.value,
    });
  }

  const rows = [...rowsByFieldId.values()];
  if (rows.length > 0) {
    const { error: upsertError } = await db
      .from('contact_custom_values')
      .upsert(rows, { onConflict: 'contact_id,custom_field_id' });
    if (upsertError) {
      throw new IngestCustomValuesError('Failed to write custom field values');
    }
  }

  return { outcomes, warnings };
}
