// ============================================================
// Validação pura do corpo de POST /api/v1/ingest/contact (SPEC 055).
//
// Sem I/O — nada aqui consulta o banco. `custom_fields` só é
// normalizado NA FORMA (par field/value); o casamento contra
// `custom_fields.field_name` da conta é responsabilidade de
// `applyCustomValues` (src/lib/ingest/custom-values.ts), que precisa
// de uma query. Da mesma forma, `template_id` só é passado adiante —
// a existência e o status `APPROVED` são checados por
// `src/lib/whatsapp/template-approval.ts`.
// ============================================================

import { normalizeContactPhone } from '@/lib/phone/br';

export type IngestErrorCode =
  | 'bad_request'
  | 'invalid_webhook_id'
  | 'invalid_webhook_name'
  | 'invalid_phone';

export interface IngestWarning {
  code: string;
  message: string;
}

export interface IngestCustomFieldInput {
  field: string;
  value: string;
}

export interface IngestPayload {
  webhookId: string;
  webhookName: string;
  /** Dígitos-only, com DDI, sem `+` — já validado pela SPEC 050. */
  phone: string;
  name: string | null;
  email: string | null;
  company: string | null;
  tags: string[];
  notes: string[];
  customFields: IngestCustomFieldInput[];
  templateId: string | null;
  templateParams: string[];
}

export type ParseIngestPayloadResult =
  | { ok: true; value: IngestPayload; warnings: IngestWarning[] }
  | { ok: false; code: IngestErrorCode; message: string };

/** `webhook_id`: só dígitos, mínimo 16 (SPEC 055 §5.1). */
const WEBHOOK_ID_RE = /^\d{16,}$/;

/** `webhook_name`: rótulo de exibição do funil — não vale a pena
 *  derrubar um POST por causa de um label comprido demais, então o
 *  excesso é truncado (não rejeitado). O corpo do rejeito real é
 *  "vazio", não "longo". */
const WEBHOOK_NAME_MAX = 120;

/**
 * Coage um campo string-ou-número em string, sem quebrar o chamador
 * que manda um valor numérico sem aspas no JSON (comum em ferramentas
 * no-code/planilha→JSON). Usado por todo campo que é logicamente
 * texto mas pode chegar como `number` — `webhook_id` e `phone`
 * precisam do MESMO tratamento aqui; deixar um coagir e o outro não
 * faz o mesmo erro de chamador ser aceito num campo e rejeitado no
 * outro (achado de code-review, SPEC 055).
 */
function coerceToString(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return '';
}

function normalizeWebhookId(raw: unknown): string | null {
  const str = coerceToString(raw);
  return WEBHOOK_ID_RE.test(str) ? str : null;
}

function normalizeWebhookName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.length > WEBHOOK_NAME_MAX
    ? trimmed.slice(0, WEBHOOK_NAME_MAX)
    : trimmed;
}

/** `tags`: CSV string ou array de strings — ambos tratados igual (D-6). */
function normalizeTags(raw: unknown): string[] {
  const list: unknown[] =
    typeof raw === 'string' ? raw.split(',') : Array.isArray(raw) ? raw : [];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

interface NotesResult {
  notes: string[];
  warnings: IngestWarning[];
}

/**
 * `notes`: objeto indexado (`{"nota_1": "…", "nota_2": "…"}`) ou array
 * de strings (D-7). O objeto é ordenado pelo SUFIXO NUMÉRICO da chave,
 * não lexicograficamente — senão `nota_10` entraria antes de `nota_2`.
 * Chaves sem sufixo numérico vão para o fim, em ordem alfabética.
 */
function normalizeNotes(raw: unknown): NotesResult {
  const warnings: IngestWarning[] = [];
  if (raw == null) return { notes: [], warnings };

  let ordered: unknown[];
  if (Array.isArray(raw)) {
    ordered = raw;
  } else if (typeof raw === 'object') {
    const withSuffix: { key: string; num: number; value: unknown }[] = [];
    const withoutSuffix: { key: string; value: unknown }[] = [];
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const m = /(\d+)$/.exec(key);
      if (m) {
        withSuffix.push({ key, num: parseInt(m[1], 10), value });
      } else {
        withoutSuffix.push({ key, value });
      }
    }
    withSuffix.sort((a, b) => a.num - b.num);
    withoutSuffix.sort((a, b) => a.key.localeCompare(b.key));
    ordered = [
      ...withSuffix.map((e) => e.value),
      ...withoutSuffix.map((e) => e.value),
    ];
  } else {
    return { notes: [], warnings };
  }

  const notes: string[] = [];
  for (const value of ordered) {
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (!text) {
      warnings.push({
        code: 'note_empty',
        message: 'A note entry was empty and was skipped',
      });
      continue;
    }
    notes.push(text);
  }
  return { notes, warnings };
}

interface CustomFieldsResult {
  entries: IngestCustomFieldInput[];
  warnings: IngestWarning[];
}

/**
 * `custom_fields`: array de `{ field, value }`. Uma forma errada (ex.:
 * objeto em vez de array) NÃO derruba a requisição — vira aviso e o
 * campo é tratado como ausente (D-8). O casamento contra
 * `custom_fields.field_name` da conta acontece em `custom-values.ts`.
 */
function normalizeCustomFields(raw: unknown): CustomFieldsResult {
  const warnings: IngestWarning[] = [];
  if (raw == null) return { entries: [], warnings };

  if (!Array.isArray(raw)) {
    warnings.push({
      code: 'custom_fields_malformed',
      message: "'custom_fields' must be an array of { field, value } — ignored",
    });
    return { entries: [], warnings };
  }

  const entries: IngestCustomFieldInput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rawField = (item as Record<string, unknown>).field;
    const rawValue = (item as Record<string, unknown>).value;
    const field = typeof rawField === 'string' ? rawField.trim() : '';
    if (!field) continue;
    const value =
      typeof rawValue === 'string'
        ? rawValue
        : rawValue == null
          ? ''
          : String(rawValue);
    entries.push({ field, value });
  }
  return { entries, warnings };
}

/**
 * Valida e normaliza o corpo de `POST /api/v1/ingest/contact`.
 *
 * Falhas em `webhook_id` / `webhook_name` / `phone` derrubam a
 * requisição inteira (400, nada é criado — D-14). Tudo o mais é
 * best-effort: forma inválida em `tags` / `notes` / `custom_fields`
 * vira lista vazia (silenciosamente, quando a própria forma já é
 * frouxa) ou aviso (`warnings`, quando há algo a reportar).
 */
export function parseIngestPayload(body: unknown): ParseIngestPayloadResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      code: 'bad_request',
      message: 'Request body must be a JSON object',
    };
  }
  const raw = body as Record<string, unknown>;

  const webhookId = normalizeWebhookId(raw.webhook_id);
  if (!webhookId) {
    return {
      ok: false,
      code: 'invalid_webhook_id',
      message: "'webhook_id' must be a numeric string with at least 16 digits",
    };
  }

  const webhookName = normalizeWebhookName(raw.webhook_name);
  if (!webhookName) {
    return {
      ok: false,
      code: 'invalid_webhook_name',
      message: "'webhook_name' is required and must not be empty",
    };
  }

  const rawPhone = coerceToString(raw.phone);
  const phoneResult = normalizeContactPhone(rawPhone);
  if (!phoneResult.ok) {
    return {
      ok: false,
      code: 'invalid_phone',
      message: `Phone number failed Brazilian validation: ${phoneResult.reason}`,
    };
  }

  const warnings: IngestWarning[] = [];

  const { notes, warnings: noteWarnings } = normalizeNotes(raw.notes);
  warnings.push(...noteWarnings);

  const { entries: customFields, warnings: cfWarnings } = normalizeCustomFields(
    raw.custom_fields
  );
  warnings.push(...cfWarnings);

  const templateId =
    typeof raw.template_id === 'string' && raw.template_id.trim()
      ? raw.template_id.trim()
      : null;
  // Coage cada entrada em vez de filtrar as não-string: são parâmetros
  // POSICIONAIS ({{1}}, {{2}}...) — dropar uma entrada deslocaria todas
  // as seguintes para o placeholder errado, silenciosamente. `null`/
  // `undefined` viram string vazia (preserva a posição, perde só o
  // valor); número/boolean são coagidos, igual a `custom_fields.value`
  // já faz mais abaixo neste arquivo.
  const templateParams = Array.isArray(raw.template_params)
    ? raw.template_params.map((p) =>
        typeof p === 'string' ? p : p == null ? '' : String(p)
      )
    : [];

  return {
    ok: true,
    warnings,
    value: {
      webhookId,
      webhookName,
      phone: phoneResult.phone,
      name:
        typeof raw.name === 'string' && raw.name.trim()
          ? raw.name.trim()
          : null,
      email:
        typeof raw.email === 'string' && raw.email.trim()
          ? raw.email.trim()
          : null,
      company:
        typeof raw.company === 'string' && raw.company.trim()
          ? raw.company.trim()
          : null,
      tags: normalizeTags(raw.tags),
      notes,
      customFields,
      templateId,
      templateParams,
    },
  };
}
