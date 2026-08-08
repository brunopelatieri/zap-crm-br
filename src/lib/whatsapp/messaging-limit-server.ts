/**
 * Leitura da cota de 24 h no servidor (SPEC 044 §4).
 *
 * Extraído da rota `GET /api/whatsapp/messaging-limit` quando o envio
 * migrou para o servidor (§6.1). O motivo é o §4.5, item 4: os pontos
 * 1–3 de imposição do teto (pós-parse, triagem, passo 4) são UX; o
 * controle de verdade é o servidor revalidando na hora de enviar. Se
 * essa revalidação usasse uma segunda implementação, o número exibido e
 * o número aplicado poderiam divergir — e a divergência só apareceria
 * como "o botão liberou e o disparo foi recusado".
 *
 * O token cifrado nunca sai daqui: `decrypt` só roda no servidor.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';
import { fetchMessagingLimit } from '@/lib/whatsapp/meta-api';
import {
  FALLBACK_TIER,
  computeQuota,
  isCacheFresh,
  tierFromResponse,
  type QuotaSnapshot,
  type QuotaSource,
} from '@/lib/whatsapp/messaging-limit';

export type QuotaLoadResult =
  | { configured: false; reason: 'no_config' }
  | { configured: true; snapshot: QuotaSnapshot };

/**
 * Resolve o retrato de cota da conta: tier (da Meta, do cache ou do
 * fallback restritivo) + quanto da janela de 24 h já foi consumido.
 *
 * Nunca lança por causa da Meta. Se a Graph API estiver fora, devolve o
 * último tier conhecido — ou `TIER_250` se nunca houve leitura — com
 * `source: 'fallback'`. Nunca "sem limite".
 */
export async function loadAccountQuota(
  db: SupabaseClient,
  accountId: string
): Promise<QuotaLoadResult> {
  const { data: config } = await db
    .from('whatsapp_config')
    .select(
      'phone_number_id, access_token, messaging_limit_tier, messaging_limit_checked_at'
    )
    .eq('account_id', accountId)
    .maybeSingle();

  if (!config) return { configured: false, reason: 'no_config' };

  // O consumo da janela sempre vem do banco — é barato e muda a cada
  // disparo, então nunca é cacheado junto com o tier.
  const { data: usedRaw, error: usageError } = await db.rpc(
    'broadcast_quota_usage',
    { p_account_id: accountId }
  );
  if (usageError) {
    console.error('[messaging-limit] quota usage error:', usageError);
  }
  const usedLast24h = Number(usedRaw ?? 0);

  // ── Cache quente: pula a Meta ──────────────────────────────────
  if (
    config.messaging_limit_tier &&
    isCacheFresh(config.messaging_limit_checked_at)
  ) {
    return {
      configured: true,
      snapshot: computeQuota({
        tier: config.messaging_limit_tier,
        usedLast24h,
        source: 'cache',
        checkedAt: new Date(config.messaging_limit_checked_at),
      }),
    };
  }

  // ── Cache frio: consulta a Meta ────────────────────────────────
  // Começa pessimista: último tier salvo, ou o restritivo se nunca
  // houve leitura. Só vira 'meta' se a chamada abaixo der certo.
  let tier = config.messaging_limit_tier ?? FALLBACK_TIER;
  let source: QuotaSource = 'fallback';
  let checkedAt = config.messaging_limit_checked_at
    ? new Date(config.messaging_limit_checked_at)
    : new Date();

  try {
    const accessToken = decrypt(config.access_token);
    const response = await fetchMessagingLimit({
      phoneNumberId: config.phone_number_id,
      accessToken,
    });
    tier = tierFromResponse(response);
    source = 'meta';
    checkedAt = new Date();

    // Persistir o tier é o que faz o medidor sobreviver a um restart e o
    // que dá um valor de fallback quando a Meta cai. Uma falha de
    // escrita não invalida a leitura — logamos e seguimos.
    const { error: cacheError } = await db
      .from('whatsapp_config')
      .update({
        messaging_limit_tier: tier,
        messaging_limit_checked_at: checkedAt.toISOString(),
      })
      .eq('account_id', accountId);
    if (cacheError) {
      console.error('[messaging-limit] tier cache write failed:', cacheError);
    }
  } catch (err) {
    // Meta fora do ar, token inválido, timeout. Não é erro fatal: a
    // tela mostra o último tier conhecido com selo de desatualizado, e
    // o servidor continua aplicando um teto.
    console.error('[messaging-limit] Meta lookup failed:', err);
  }

  return {
    configured: true,
    snapshot: computeQuota({ tier, usedLast24h, source, checkedAt }),
  };
}
