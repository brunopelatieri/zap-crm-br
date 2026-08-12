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
 */

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { readColdSendLimits } from '@/lib/channels/cold-send-limit';

export async function GET() {
  try {
    await requireRole('viewer');

    const limits = readColdSendLimits();

    return NextResponse.json({
      ...limits,
      /**
       * `false` quando o dono do sistema zerou os tetos de volume — o
       * recurso está desligado, e a interface deve dizer isso em vez de
       * mostrar "0 mensagens por dia" como se fosse uma cota.
       */
      enabled: limits.perDay > 0 && limits.perHour > 0,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
