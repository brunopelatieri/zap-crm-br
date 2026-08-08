/**
 * GET /api/whatsapp/messaging-limit
 *
 * Tier de mensageria da conta na Meta + quanto da janela de 24 h já
 * foi consumido (SPEC 044 §4).
 *
 * Por que isto é uma rota de servidor e não um fetch do componente
 *
 *   `whatsapp_config.access_token` está cifrado em repouso e só é
 *   decifrado aqui. Um fetch à Graph API a partir do React exporia o
 *   token de sistema da conta a qualquer usuário com o DevTools
 *   aberto — inclusive um `viewer`. Não existe variante aceitável
 *   disso, e é por isso que o CSP do projeto nem lista
 *   graph.facebook.com em `connect-src`.
 *
 * Contrato de resposta
 *
 *   Segue o padrão de /api/whatsapp/config: 200 em todo caso que não
 *   seja de autenticação, com `configured: false` + `reason` quando
 *   não dá para responder. A tela de disparo precisa renderizar um
 *   estado útil, não um 500.
 */

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { serializeQuota } from '@/lib/whatsapp/messaging-limit';
import { loadAccountQuota } from '@/lib/whatsapp/messaging-limit-server';
import {
  RATE_LIMITS,
  checkRateLimit,
  rateLimitResponse,
} from '@/lib/rate-limit';

export async function GET() {
  try {
    // `viewer` também abre a tela de disparo (em leitura), então o
    // piso aqui é a associação à conta, não o papel de agente.
    const { supabase, userId, accountId } = await requireRole('viewer');

    const limit = checkRateLimit(
      `messaging-limit:${userId}`,
      RATE_LIMITS.messagingLimit
    );
    if (!limit.success) return rateLimitResponse(limit);

    // Toda a lógica de tier + cache + fallback mora em
    // `messaging-limit-server`, porque a rota de envio precisa
    // exatamente da mesma leitura para impor o teto (§4.5, item 4).
    const quota = await loadAccountQuota(supabase, accountId);

    if (!quota.configured) {
      return NextResponse.json(
        {
          configured: false,
          reason: quota.reason,
          message: 'WhatsApp não configurado.',
        },
        { status: 200 }
      );
    }

    return NextResponse.json(
      { configured: true, ...serializeQuota(quota.snapshot) },
      { status: 200 }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
