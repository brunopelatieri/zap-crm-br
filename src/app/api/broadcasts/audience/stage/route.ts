/**
 * POST /api/broadcasts/audience/stage — SPEC 044 §3.3.
 *
 * Cria o rascunho da triagem: um `broadcasts` com `status = 'draft'` e a
 * audiência inteira gravada em `broadcast_audience_staging` (045). É o
 * que dá à triagem um identificador roteável
 * (`/broadcasts/new/[draftId]/triage`) que sobrevive a um F5.
 *
 * O corpo carrega a mesma `AudienceConfig` do passo 2 — filtro para
 * `all`/`tags`/`custom_field`, linhas já parseadas para `csv` — nunca
 * uma lista de contatos prontos. Quem resolve o filtro em linhas é o
 * servidor (`stageAudience`), pelo mesmo motivo do `/api/broadcasts/send`
 * (SPEC 044 §6.1, decisão 1): aceitar a lista final do cliente seria
 * deixar o navegador decidir o que entra na triagem de outra pessoa.
 */

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  RATE_LIMITS,
  checkRateLimit,
  rateLimitResponse,
} from '@/lib/rate-limit';
import { BroadcastError } from '@/lib/whatsapp/broadcast-core';
import { stageAudience, type StageAudienceInput } from '@/lib/audience/stage';
import { MAX_AUDIENCE_ROWS } from '@/lib/audience/types';
import type { CustomFieldOperator } from '@/lib/audience/estimate';

const CUSTOM_FIELD_OPERATORS: CustomFieldOperator[] = [
  'is',
  'is_not',
  'contains',
];

const INVALID_REASONS = new Set([
  'missing_phone',
  'invalid_phone',
  'duplicate_in_file',
]);

const STATUS_BY_CODE: Record<string, number> = {
  template_not_found: 404,
  too_many_rows: 400,
  empty_audience: 400,
  bad_request: 400,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === 'string');
  return out.length > 0 ? out : undefined;
}

function badRequest(message: string) {
  return NextResponse.json(
    { error: message, code: 'bad_request' },
    { status: 400 }
  );
}

/** Espelha `parseAudience` de `send/route.ts`, mas para o formato de stage. */
function parseAudience(raw: unknown): StageAudienceInput | null {
  if (!isRecord(raw)) return null;
  const type = raw.type;
  const excludeTagIds = stringArray(raw.excludeTagIds);

  if (type === 'all') {
    return { type: 'all', excludeTagIds };
  }

  if (type === 'tags') {
    const tagIds = stringArray(raw.tagIds);
    if (!tagIds) return null;
    return { type: 'tags', tagIds, excludeTagIds };
  }

  if (type === 'custom_field') {
    const cf = raw.customField;
    if (!isRecord(cf)) return null;
    if (
      typeof cf.fieldId !== 'string' ||
      typeof cf.value !== 'string' ||
      typeof cf.operator !== 'string' ||
      !CUSTOM_FIELD_OPERATORS.includes(cf.operator as CustomFieldOperator)
    ) {
      return null;
    }
    return {
      type: 'custom_field',
      customField: {
        fieldId: cf.fieldId,
        operator: cf.operator as CustomFieldOperator,
        value: cf.value,
      },
      excludeTagIds,
    };
  }

  if (type === 'csv') {
    if (!Array.isArray(raw.rows) || !Array.isArray(raw.invalidRows)) {
      return null;
    }
    if (raw.rows.length + raw.invalidRows.length > MAX_AUDIENCE_ROWS) {
      return null;
    }

    const parsedRows: {
      phone: string;
      name?: string;
      email?: string;
      company?: string;
      tagNames?: string[];
      sourceRow?: number;
    }[] = [];
    for (const row of raw.rows) {
      if (!isRecord(row) || typeof row.phone !== 'string') continue;
      parsedRows.push({
        phone: row.phone,
        name: typeof row.name === 'string' ? row.name : undefined,
        email: typeof row.email === 'string' ? row.email : undefined,
        company: typeof row.company === 'string' ? row.company : undefined,
        tagNames: stringArray(row.tagNames),
        sourceRow:
          typeof row.sourceRow === 'number' ? row.sourceRow : undefined,
      });
    }
    const invalidRows: {
      sourceRow: number;
      rawPhone: string;
      name?: string;
      reason: 'missing_phone' | 'invalid_phone' | 'duplicate_in_file';
    }[] = [];
    for (const row of raw.invalidRows) {
      if (
        !isRecord(row) ||
        typeof row.sourceRow !== 'number' ||
        typeof row.rawPhone !== 'string' ||
        typeof row.reason !== 'string' ||
        !INVALID_REASONS.has(row.reason)
      ) {
        continue;
      }
      invalidRows.push({
        sourceRow: row.sourceRow,
        rawPhone: row.rawPhone,
        name: typeof row.name === 'string' ? row.name : undefined,
        reason: row.reason as
          | 'missing_phone'
          | 'invalid_phone'
          | 'duplicate_in_file',
      });
    }

    return { type: 'csv', rows: parsedRows, invalidRows };
  }

  return null;
}

export async function POST(request: Request) {
  try {
    // Mesmo piso de papel do envio — a triagem faz parte de criar disparo.
    const { supabase, userId, accountId } = await requireRole('agent');

    const limit = checkRateLimit(
      `audience-stage:${userId}`,
      RATE_LIMITS.audienceStage
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as unknown;
    if (!isRecord(body)) {
      return badRequest('Request body must be a JSON object');
    }

    const templateName =
      typeof body.templateName === 'string' ? body.templateName : '';
    if (!templateName) return badRequest("'templateName' is required");

    const templateLanguage =
      typeof body.templateLanguage === 'string'
        ? body.templateLanguage
        : 'en_US';

    const audience = parseAudience(body.audience);
    if (!audience) return badRequest("'audience' is missing or malformed");

    const result = await stageAudience(supabase, {
      accountId,
      userId,
      templateName,
      templateLanguage,
      audience,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof BroadcastError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: STATUS_BY_CODE[err.code] ?? err.status }
      );
    }
    return toErrorResponse(err);
  }
}
