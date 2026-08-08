/**
 * POST /api/broadcasts/send — dispara uma campanha do painel.
 *
 * Rota INTERNA do wizard (corpo em camelCase, não é a API pública
 * `/api/v1/broadcasts`). SPEC 044 §6.1.
 *
 * O que ela resolve
 *
 *   O disparo do wizard rodava no navegador. Fechar a aba no meio
 *   matava a campanha e deixava destinatários em `pending` para sempre.
 *   Agora o cliente só INICIA: a rota persiste tudo, responde 202 e faz
 *   o fan-out em `after()`. A aba pode fechar — o envio continua.
 *
 * Três decisões que valem ser lidas antes de mexer
 *
 *   1. **A audiência é resolvida aqui, não no cliente.** O corpo carrega
 *      o FILTRO (etiquetas, campo personalizado, linhas importadas), não
 *      a lista final de contatos. Aceitar a lista pronta do navegador
 *      seria deixar o cliente escolher para quem o servidor envia.
 *   2. **A cota é reconferida aqui.** Os avisos do wizard são UX; este
 *      é o controle (§4.5, item 4).
 *   3. **O fan-out usa o cliente de service-role, não o SSR.** O cliente
 *      SSR carrega o access token daquele request e não o renova; um
 *      disparo de milhares roda por minutos depois da resposta e
 *      passaria a falhar calado quando o token vencesse. Ver
 *      `lib/supabase/admin.ts`.
 *
 * Dois caminhos desde a fase 7 (§6.3)
 *
 *   Com `scheduledAt` no corpo, a rota **agenda**: grava a intenção com
 *   `status = 'scheduled'` e não resolve nada — quem retoma é
 *   `GET /api/broadcasts/cron`. Sem ele, o comportamento é o de sempre.
 *
 *   Os dois passam pela janela de horário permitido (§6.3): um disparo
 *   às 23h queima reputação, e reputação é o que governa o tier da Meta
 *   (§4). Bloqueado por padrão, liberado por `windowOverride` explícito —
 *   e o override fica na trilha (`broadcast_audit_log`, §6.8).
 *
 * Teste A/B (§6.6)
 *
 *   Com `abTest` no corpo, os dois caminhos acima ganham um segundo
 *   braço: uma audiência, dois templates, duas linhas em `broadcasts`
 *   ligadas por `parent_broadcast_id`. O fan-out roda os braços em
 *   SEQUÊNCIA no mesmo `after()` — em paralelo, os dois competiriam pelo
 *   mesmo limite de taxa por número da Meta e o pacing de
 *   `SEND_BATCH_SIZE` deixaria de significar o que diz.
 */

import { NextResponse, after } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  RATE_LIMITS,
  checkRateLimit,
  rateLimitResponse,
} from '@/lib/rate-limit';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { logBroadcastAudit } from '@/lib/broadcasts/audit';
import {
  isRecord,
  parseAbTest,
  parseAudienceConfig,
  parseVariableMap,
} from '@/lib/broadcasts/parse-input';
import {
  describeSendWindow,
  isWithinSendWindow,
  nextWindowOpening,
  resolveTimeZone,
} from '@/lib/broadcasts/send-window';
import {
  BroadcastError,
  deliverBroadcast,
} from '@/lib/whatsapp/broadcast-core';
import {
  SEND_BATCH_DELAY_MS,
  SEND_BATCH_SIZE,
  planAbTestBroadcast,
  planDashboardBroadcast,
  scheduleDashboardBroadcast,
} from '@/lib/whatsapp/broadcast-dispatch';
import { loadAccountQuota } from '@/lib/whatsapp/messaging-limit-server';

/**
 * Teto de tempo do `after()`. Em self-host (o alvo deste projeto) o
 * processo é longevo e o valor não morde; em plataformas serverless ele
 * é o limite real do fan-out, e uma audiência grande pode ser cortada no
 * meio — os destinatários restantes ficam `pending`. A saída completa é
 * uma fila durável / cron de drenagem, registrada como próximo passo na
 * SPEC.
 */
export const maxDuration = 300;

function badRequest(message: string) {
  return NextResponse.json(
    { error: message, code: 'bad_request' },
    { status: 400 }
  );
}

/**
 * Teto de quão longe no futuro um agendamento pode ir.
 *
 * 90 dias não é uma regra da Meta — é o horizonte em que a intenção
 * ainda descreve a realidade. Um agendamento para dentro de dois anos
 * dispararia com uma audiência, um template e uma equipe que já não são
 * os de hoje.
 */
const MAX_SCHEDULE_AHEAD_MS = 90 * 24 * 60 * 60 * 1000;

/** Menor antecedência aceita — abaixo disso é "enviar agora". */
const MIN_SCHEDULE_AHEAD_MS = 60 * 1000;

interface ScheduleRequest {
  at: Date;
  timeZone: string;
  override: boolean;
}

/**
 * Lê e valida a parte de agendamento do corpo.
 *
 * Devolve `null` quando não há agendamento (disparo imediato) e lança
 * {@link BroadcastError} quando há, mas está errado — um `scheduledAt`
 * inválido nunca deve virar um envio imediato por omissão.
 */
function parseSchedule(body: Record<string, unknown>): ScheduleRequest | null {
  const timeZone = resolveTimeZone(body.timeZone);
  const override = body.windowOverride === true;

  const raw = body.scheduledAt;
  if (raw === undefined || raw === null || raw === '') return null;

  if (typeof raw !== 'string') {
    throw new BroadcastError(
      'bad_request',
      "'scheduledAt' must be an ISO date string",
      400
    );
  }

  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) {
    throw new BroadcastError('bad_request', "'scheduledAt' is not a date", 400);
  }

  const delta = at.getTime() - Date.now();
  if (delta < MIN_SCHEDULE_AHEAD_MS) {
    throw new BroadcastError(
      'schedule_in_past',
      "'scheduledAt' must be at least a minute in the future",
      400
    );
  }
  if (delta > MAX_SCHEDULE_AHEAD_MS) {
    throw new BroadcastError(
      'schedule_too_far',
      "'scheduledAt' is further ahead than 90 days",
      400
    );
  }

  return { at, timeZone, override };
}

export async function POST(request: Request) {
  try {
    // Disparar é a mesma ação que enviar mensagem — piso `agent`.
    const { supabase, userId, accountId } = await requireRole('agent');

    // Mesmo balde da rota de disparo antiga: limita quantas campanhas
    // um usuário INICIA por minuto, não quantas mensagens saem em uma.
    const limit = checkRateLimit(`broadcast:${userId}`, RATE_LIMITS.broadcast);
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as unknown;
    if (!isRecord(body))
      return badRequest('Request body must be a JSON object');

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return badRequest("'name' is required");

    const templateName =
      typeof body.templateName === 'string' ? body.templateName : '';
    if (!templateName) return badRequest("'templateName' is required");

    const audience = parseAudienceConfig(body.audience);
    if (!audience) return badRequest("'audience' is missing or malformed");

    const variables = parseVariableMap(body.variables);
    if (!variables) return badRequest("'variables' is malformed");

    const schedule = parseSchedule(body);
    const abTest = parseAbTest(body.abTest);
    const input = {
      name,
      templateName,
      templateLanguage:
        typeof body.templateLanguage === 'string'
          ? body.templateLanguage
          : 'en_US',
      audience,
      variables,
      headerMediaUrl:
        typeof body.headerMediaUrl === 'string'
          ? body.headerMediaUrl
          : undefined,
    };

    // ── Janela de horário permitido (§6.3) ─────────────────────────
    // Vale para o instante em que a mensagem VAI SAIR: agora, no disparo
    // imediato; o horário escolhido, no agendado. O override é do
    // usuário e fica registrado — a janela protege contra o descuido,
    // não contra a decisão consciente.
    const windowInstant = schedule?.at ?? new Date();
    const windowTimeZone = schedule?.timeZone ?? resolveTimeZone(body.timeZone);
    const windowOverride = schedule?.override ?? body.windowOverride === true;

    if (!windowOverride && !isWithinSendWindow(windowInstant, windowTimeZone)) {
      await logBroadcastAudit(supabase, {
        accountId,
        event: 'blocked_window',
        broadcastName: name,
        actorUserId: userId,
        templateName,
        scheduledAt: schedule ? schedule.at.toISOString() : null,
        details: {
          time_zone: windowTimeZone,
          window: describeSendWindow(),
          suggested_at: nextWindowOpening(
            windowInstant,
            windowTimeZone
          ).toISOString(),
        },
      });

      return NextResponse.json(
        {
          error: `Outside the allowed send window (${describeSendWindow()}).`,
          code: 'outside_send_window',
          window: describeSendWindow(),
          timeZone: windowTimeZone,
          suggestedAt: nextWindowOpening(
            windowInstant,
            windowTimeZone
          ).toISOString(),
        },
        { status: 409 }
      );
    }

    // ── Caminho agendado: grava a intenção e para aqui ─────────────
    if (schedule) {
      const scheduled = await scheduleDashboardBroadcast(supabase, {
        accountId,
        userId,
        input,
        scheduledAt: schedule.at,
        timeZone: schedule.timeZone,
        windowOverride: schedule.override,
        variant: abTest?.variant,
        splitPercent: abTest?.splitPercent,
      });

      await logBroadcastAudit(supabase, {
        accountId,
        event: 'scheduled',
        broadcastId: scheduled.broadcastId,
        broadcastName: name,
        actorUserId: userId,
        templateName,
        scheduledAt: scheduled.scheduledAt,
        details: {
          time_zone: schedule.timeZone,
          window_override: schedule.override,
          audience_type: audience.type,
          ...(abTest
            ? {
                ab_test: true,
                ab_variant_broadcast_id: scheduled.variantBroadcastId,
                ab_variant_template: abTest.variant.templateName,
                ab_split_percent: abTest.splitPercent,
              }
            : {}),
        },
      });

      return NextResponse.json(
        {
          broadcastId: scheduled.broadcastId,
          status: 'scheduled',
          scheduledAt: scheduled.scheduledAt,
          ...(scheduled.variantBroadcastId
            ? {
                abTest: {
                  variantBroadcastId: scheduled.variantBroadcastId,
                  splitPercent: abTest?.splitPercent,
                },
              }
            : {}),
        },
        { status: 202 }
      );
    }

    // Cota autoritativa. Sem WhatsApp configurado não há o que impor —
    // e nem o que enviar; o planner devolve o erro tipado logo abaixo.
    const quota = await loadAccountQuota(supabase, accountId);
    const quotaRemaining = quota.configured
      ? quota.snapshot.remaining
      : Number.POSITIVE_INFINITY;

    // ── Teste A/B (§6.6): dois braços, uma audiência ───────────────
    if (abTest) {
      const ab = await planAbTestBroadcast(supabase, {
        accountId,
        userId,
        quotaRemaining,
        input,
        variant: abTest.variant,
        splitPercent: abTest.splitPercent,
      });

      await logBroadcastAudit(supabase, {
        accountId,
        event: 'dispatched',
        broadcastId: ab.variantA.broadcastId,
        broadcastName: name,
        actorUserId: userId,
        templateName,
        totalRecipients: ab.totalRecipients,
        excludedOptedOut: ab.excludedOptedOut,
        details: {
          audience_type: audience.type,
          window_override: windowOverride,
          time_zone: windowTimeZone,
          excluded_invalid_whatsapp: ab.excludedInvalidWhatsapp,
          ab_test: true,
          ab_split_percent: ab.splitPercent,
          ab_variant_broadcast_id: ab.variantB.broadcastId,
          ab_variant_template: abTest.variant.templateName,
          ab_accepted_a: ab.variantA.planned.length,
          ab_accepted_b: ab.variantB.planned.length,
          rejected: ab.variantA.rejected + ab.variantB.rejected,
        },
      });

      // Em SEQUÊNCIA, não em paralelo: os dois braços saem pelo mesmo
      // número, e disparar juntos dobraria a taxa instantânea que o
      // pacing de `SEND_BATCH_SIZE` existe para conter.
      after(async () => {
        const admin = supabaseAdmin();
        await deliverBroadcast(admin, ab.variantA, {
          batchSize: SEND_BATCH_SIZE,
          delayMs: SEND_BATCH_DELAY_MS,
        });
        await deliverBroadcast(admin, ab.variantB, {
          batchSize: SEND_BATCH_SIZE,
          delayMs: SEND_BATCH_DELAY_MS,
        });
      });

      return NextResponse.json(
        {
          broadcastId: ab.variantA.broadcastId,
          status: 'sending',
          totalRecipients: ab.totalRecipients,
          accepted: ab.variantA.planned.length + ab.variantB.planned.length,
          rejected: ab.variantA.rejected + ab.variantB.rejected,
          excludedOptedOut: ab.excludedOptedOut,
          excludedInvalidWhatsapp: ab.excludedInvalidWhatsapp,
          abTest: {
            splitPercent: ab.splitPercent,
            variantA: {
              broadcastId: ab.variantA.broadcastId,
              totalRecipients: ab.variantA.totalRecipients,
            },
            variantB: {
              broadcastId: ab.variantB.broadcastId,
              totalRecipients: ab.variantB.totalRecipients,
            },
          },
        },
        { status: 202 }
      );
    }

    const plan = await planDashboardBroadcast(supabase, {
      accountId,
      userId,
      quotaRemaining,
      input,
    });

    // Trilha antes do fan-out: se o processo morrer no meio do envio, o
    // registro de que a campanha foi disparada (e por quem) já existe.
    await logBroadcastAudit(supabase, {
      accountId,
      event: 'dispatched',
      broadcastId: plan.broadcastId,
      broadcastName: name,
      actorUserId: userId,
      templateName,
      totalRecipients: plan.totalRecipients,
      excludedOptedOut: plan.excludedOptedOut,
      details: {
        audience_type: audience.type,
        accepted: plan.planned.length,
        rejected: plan.rejected,
        window_override: windowOverride,
        time_zone: windowTimeZone,
        excluded_invalid_whatsapp: plan.excludedInvalidWhatsapp,
      },
    });

    // Fan-out depois da resposta. O cliente de service-role é
    // deliberado — ver a nota 3 no cabeçalho.
    after(() =>
      deliverBroadcast(supabaseAdmin(), plan, {
        batchSize: SEND_BATCH_SIZE,
        delayMs: SEND_BATCH_DELAY_MS,
      })
    );

    return NextResponse.json(
      {
        broadcastId: plan.broadcastId,
        status: 'sending',
        totalRecipients: plan.totalRecipients,
        accepted: plan.planned.length,
        rejected: plan.rejected,
        excludedOptedOut: plan.excludedOptedOut,
        excludedInvalidWhatsapp: plan.excludedInvalidWhatsapp,
      },
      { status: 202 }
    );
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
