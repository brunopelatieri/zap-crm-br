/**
 * /api/channels/evolution/instances/[id] (SPEC 048 §7)
 *
 *   PATCH  — rótulo local e/ou flags avançadas (admin+).
 *   DELETE — exclui a instância na VPS e no banco; o CANAL fica
 *            `disabled`, preservando as conversas (admin+, exige o
 *            mesmo padrão de confirmação por digitação do resto do
 *            projeto — aplicado no CLIENTE; o servidor não repete a
 *            checagem porque não tem o rótulo "esperado" para comparar
 *            além do que já está no banco).
 */

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import {
  deleteEvolutionInstance,
  patchInstance,
  type AdvancedSettingsInput,
} from '@/lib/evolution/instances';
import { toEvolutionErrorResponse } from '@/lib/evolution/respond';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

type Params = { params: Promise<{ id: string }> };

const MAX_LABEL_LENGTH = 60;
const ADVANCED_SETTINGS_KEYS: (keyof AdvancedSettingsInput)[] = [
  'alwaysOnline',
  'rejectCall',
  'msgRejectCall',
  'readMessages',
  'ignoreGroups',
  'ignoreStatus',
];

function parseAdvancedSettings(
  raw: unknown
): AdvancedSettingsInput | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object') {
    throw new Error("'advancedSettings' must be an object");
  }
  const input = raw as Record<string, unknown>;
  const out: AdvancedSettingsInput = {};
  for (const key of ADVANCED_SETTINGS_KEYS) {
    const value = input[key];
    if (value === undefined) continue;
    if (key === 'msgRejectCall') {
      if (typeof value !== 'string') {
        throw new Error("'advancedSettings.msgRejectCall' must be a string");
      }
      out.msgRejectCall = value;
    } else {
      if (typeof value !== 'boolean') {
        throw new Error(`'advancedSettings.${key}' must be a boolean`);
      }
      out[key] = value;
    }
  }
  return out;
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const { accountId, userId } = await requireRole('admin');
    const { id } = await params;

    const limit = checkRateLimit(
      `evolution:instanceAction:${userId}`,
      RATE_LIMITS.evolutionInstanceAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      label?: unknown;
      advancedSettings?: unknown;
    } | null;

    const label =
      typeof body?.label === 'string' ? body.label.trim() : undefined;
    if (label !== undefined) {
      if (!label) {
        return NextResponse.json(
          { error: 'label cannot be empty' },
          { status: 400 }
        );
      }
      if (label.length > MAX_LABEL_LENGTH) {
        return NextResponse.json(
          { error: `label must be ${MAX_LABEL_LENGTH} characters or fewer` },
          { status: 400 }
        );
      }
    }

    let advancedSettings: AdvancedSettingsInput | undefined;
    try {
      advancedSettings = parseAdvancedSettings(body?.advancedSettings);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 400 }
      );
    }

    if (label === undefined && advancedSettings === undefined) {
      return NextResponse.json({ error: 'nothing to update' }, { status: 400 });
    }

    await patchInstance(accountId, id, { label, advancedSettings });

    return NextResponse.json({ success: true });
  } catch (err) {
    return toEvolutionErrorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { accountId, userId } = await requireRole('admin');
    const { id } = await params;

    const limit = checkRateLimit(
      `evolution:instanceAction:${userId}`,
      RATE_LIMITS.evolutionInstanceAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    await deleteEvolutionInstance(accountId, id);

    return NextResponse.json({ success: true });
  } catch (err) {
    return toEvolutionErrorResponse(err);
  }
}
