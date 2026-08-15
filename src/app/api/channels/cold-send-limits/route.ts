/**
 * GET /api/channels/cold-send-limits
 *
 * Tetos de segurança para envio frio em instância não-oficial
 * (PRD 047 §10.3). Quem configura é o dono do sistema, pelo `.env` do
 * deployment; quem PRECISA ver é o cliente, que está montando a
 * automação e tem de saber com que volume pode contar.
 *
 * Por que uma rota, e não uma constante no bundle
 *
 *   `process.env` não existe no browser, e prefixar estas variáveis com
 *   NEXT_PUBLIC_ as congelaria no build — trocar um teto exigiria
 *   rebuild. Uma rota lê o valor vigente a cada chamada.
 *
 * Não há segredo aqui: a resposta são cinco números que descrevem uma
 * política de uso. O piso é a associação à conta (`viewer`), o mesmo de
 * /api/whatsapp/messaging-limit, porque a informação é de leitura e
 * aparece em telas que o viewer abre.
 *
 * `instances` — consumo por instância (SPEC 049 §6.2, F6.1)
 *
 *   Os cinco números acima descrevem a POLÍTICA; `instances` descreve o
 *   CONSUMO — o que a aba WhatsApp QRCode (F3) precisa para desenhar a
 *   barra e o selo de aquecimento. Só canais `whatsapp_qr`: é o único
 *   tipo onde o teto se aplica (a Meta já regula o resto).
 */

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  readColdSendLimits,
  evaluateColdSend,
} from '@/lib/channels/cold-send-limit';
import { loadColdSendUsage } from '@/lib/channels/cold-send-usage';

export async function GET() {
  try {
    const ctx = await requireRole('viewer');

    const limits = readColdSendLimits();

    const { data: channels } = await ctx.supabase
      .from('channels')
      .select('id, name, status')
      .eq('account_id', ctx.accountId)
      .eq('type', 'whatsapp_qr');

    const instances = await Promise.all(
      ((channels ?? []) as { id: string; name: string; status: string }[]).map(
        async (channel) => {
          const usage = await loadColdSendUsage(ctx.supabase, channel.id);
          const decision = evaluateColdSend(limits, usage);
          return {
            channelId: channel.id,
            name: channel.name,
            status: channel.status,
            last24h: usage.last24h,
            lastHour: usage.lastHour,
            dailyLimit: decision.dailyLimit,
            hourlyLimit: decision.hourlyLimit,
            remainingToday: decision.remainingToday,
            remainingThisHour: decision.remainingThisHour,
            warmingUp: decision.warmingUp,
          };
        }
      )
    );

    return NextResponse.json({
      ...limits,
      /**
       * `false` quando o dono do sistema zerou os tetos de volume — o
       * recurso está desligado, e a interface deve dizer isso em vez de
       * mostrar "0 mensagens por dia" como se fosse uma cota.
       */
      enabled: limits.perDay > 0 && limits.perHour > 0,
      instances,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
