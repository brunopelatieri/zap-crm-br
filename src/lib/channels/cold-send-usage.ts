/**
 * Reúne o USO que `evaluateColdSend` (cold-send-limit.ts) precisa para
 * decidir — SPEC 049 §6.2 (F6.1).
 *
 * `cold-send-limit.ts` é módulo puro de propósito: parsing, cálculo e
 * veredito, sem banco. Este arquivo é "quem chama reúne o uso" — a
 * metade que faltava.
 *
 * `instanceCreatedAt` vem de `channels.created_at`, NÃO de
 * `evolution_instances.created_at`
 *
 *   As duas linhas nascem juntas hoje, mas quem reconecta uma instância
 *   existente (logout + novo pareamento) não reinicia o aquecimento — e
 *   é `channels` que representa "este número no CRM", não a linha da
 *   instância na VPS. Ler a tabela errada faria uma reconexão de rotina
 *   reiniciar o aquecimento e travar um número já estabelecido no piso
 *   de 5 mensagens/dia.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { ColdSendUsage } from './cold-send-limit';

export async function loadColdSendUsage(
  db: SupabaseClient,
  channelId: string,
  now: Date = new Date()
): Promise<ColdSendUsage> {
  const since24h = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const sinceHour = new Date(now.getTime() - 3_600_000).toISOString();

  const [last24hRes, lastHourRes, lastSentRes, channelRes] = await Promise.all([
    db
      .from('channel_cold_sends')
      .select('id', { count: 'exact', head: true })
      .eq('channel_id', channelId)
      .gte('sent_at', since24h),
    db
      .from('channel_cold_sends')
      .select('id', { count: 'exact', head: true })
      .eq('channel_id', channelId)
      .gte('sent_at', sinceHour),
    db
      .from('channel_cold_sends')
      .select('sent_at')
      .eq('channel_id', channelId)
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    db.from('channels').select('created_at').eq('id', channelId).maybeSingle(),
  ]);

  return {
    last24h: last24hRes.count ?? 0,
    lastHour: lastHourRes.count ?? 0,
    lastColdSendAt: lastSentRes.data?.sent_at
      ? new Date(lastSentRes.data.sent_at)
      : null,
    // Canal apagado fora do fluxo normal: cai no piso de aquecimento
    // (a leitura mais conservadora) em vez de assumir uma instância
    // veterana que nunca existiu.
    instanceCreatedAt: channelRes.data?.created_at
      ? new Date(channelRes.data.created_at)
      : now,
  };
}
