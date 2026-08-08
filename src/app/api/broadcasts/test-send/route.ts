/**
 * POST /api/broadcasts/test-send — simulação a seco (SPEC 044 §6.7).
 *
 * "Enviar teste" no passo 3 do wizard: dispara o template para até 5
 * contatos escolhidos, com a mesma resolução de variáveis que o
 * disparo real usaria. Nenhuma linha de `broadcasts` ou
 * `broadcast_recipients` é criada — ver o cabeçalho de
 * `broadcast-test-send.ts` para o porquê.
 *
 * Responde sempre 200 com o resultado POR CONTATO (`sent` / `failed` /
 * `invalid_phone` / `opted_out` / `not_found`): um teste em que 3 de 5
 * números falham não é um erro de rota, é exatamente a informação que
 * o botão existe para revelar.
 */

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  RATE_LIMITS,
  checkRateLimit,
  rateLimitResponse,
} from '@/lib/rate-limit';
import { isRecord, parseVariableMap } from '@/lib/broadcasts/parse-input';
import { BroadcastError } from '@/lib/whatsapp/broadcast-core';
import {
  MAX_TEST_SEND_RECIPIENTS,
  sendBroadcastTest,
} from '@/lib/whatsapp/broadcast-test-send';

function badRequest(message: string) {
  return NextResponse.json(
    { error: message, code: 'bad_request' },
    { status: 400 }
  );
}

export async function POST(request: Request) {
  try {
    // Mesmo piso que disparar de verdade — é uma mensagem de marketing
    // de verdade para uma pessoa de verdade.
    const { supabase, userId, accountId } = await requireRole('agent');

    const limit = checkRateLimit(
      `broadcast-test-send:${userId}`,
      RATE_LIMITS.broadcastTestSend
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as unknown;
    if (!isRecord(body))
      return badRequest('Request body must be a JSON object');

    const templateName =
      typeof body.templateName === 'string' ? body.templateName : '';
    if (!templateName) return badRequest("'templateName' is required");

    const variables = parseVariableMap(body.variables);
    if (!variables) return badRequest("'variables' is malformed");

    const contactIds = Array.isArray(body.contactIds)
      ? body.contactIds.filter((v): v is string => typeof v === 'string')
      : [];
    if (contactIds.length === 0) {
      return badRequest("'contactIds' must be a non-empty array of strings");
    }
    if (contactIds.length > MAX_TEST_SEND_RECIPIENTS) {
      return badRequest(
        `'contactIds' is capped at ${MAX_TEST_SEND_RECIPIENTS} entries`
      );
    }

    const results = await sendBroadcastTest(supabase, {
      accountId,
      input: {
        templateName,
        templateLanguage:
          typeof body.templateLanguage === 'string'
            ? body.templateLanguage
            : 'en_US',
        variables,
        headerMediaUrl:
          typeof body.headerMediaUrl === 'string'
            ? body.headerMediaUrl
            : undefined,
        contactIds,
      },
    });

    return NextResponse.json({ results });
  } catch (err) {
    if (err instanceof BroadcastError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status }
      );
    }
    return toErrorResponse(err);
  }
}
