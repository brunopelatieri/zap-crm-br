/**
 * Trilha de disparo (SPEC 044 §6.8, terceiro item).
 *
 * "Quem disparou, para quantos, com qual template" — mais o que NÃO
 * aconteceu: um agendamento adiado por estar fora da janela (§6.3), um
 * disparo recusado pela cota, uma campanha cancelada.
 *
 * Por que não basta ler `broadcasts`
 *
 *   A linha de `broadcasts` é mutável por desenho: os contadores mudam a
 *   cada webhook de status, e o rascunho staged é reaproveitado como a
 *   campanha enviada (§6.1, decisão sobre `draftId`). Ela responde "como
 *   está agora", nunca "o que foi decidido, por quem, quando". E não
 *   registra bloqueio nenhum — um disparo barrado pela janela não deixa
 *   linha alguma lá.
 *
 * Best-effort, sempre
 *
 *   Nenhuma escrita aqui pode derrubar um disparo. Uma trilha que
 *   impede a operação de acontecer é pior do que uma trilha com um
 *   registro faltando: o operador contornaria justamente o caminho
 *   auditado. Falha vira `console.error` e a vida segue.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type BroadcastAuditEvent =
  /** Disparo iniciado (imediato ou retomado pelo cron). */
  | 'dispatched'
  /** Agendado para uma data futura. */
  | 'scheduled'
  /** Horário do agendamento alterado por quem agendou. */
  | 'rescheduled'
  /** Venceu fora da janela permitida e foi empurrado para a próxima. */
  | 'postponed_window'
  /** Recusado na hora do envio por estar fora da janela. */
  | 'blocked_window'
  /** Recusado por não caber na cota de 24 h. */
  | 'blocked_quota'
  | 'canceled'
  | 'failed';

export interface BroadcastAuditEntry {
  accountId: string;
  event: BroadcastAuditEvent;
  broadcastId?: string | null;
  broadcastName?: string | null;
  /** `null` = sistema (o cron). Um humano deixa o id. */
  actorUserId?: string | null;
  templateName?: string | null;
  totalRecipients?: number | null;
  /** Contatos removidos da audiência por estarem em opt-out (§6.8). */
  excludedOptedOut?: number;
  scheduledAt?: string | null;
  details?: Record<string, unknown>;
}

/**
 * Registra uma entrada na trilha. Nunca lança.
 *
 * O cliente pode ser o SSR do usuário (a política `bal_insert` da 048
 * exige `agent`) ou o de service-role (cron). Nos dois casos o
 * `accountId` é explícito — a trilha nunca infere a conta.
 */
export async function logBroadcastAudit(
  db: SupabaseClient,
  entry: BroadcastAuditEntry
): Promise<void> {
  try {
    const { error } = await db.from('broadcast_audit_log').insert({
      account_id: entry.accountId,
      broadcast_id: entry.broadcastId ?? null,
      broadcast_name: entry.broadcastName ?? null,
      event: entry.event,
      actor_user_id: entry.actorUserId ?? null,
      template_name: entry.templateName ?? null,
      total_recipients: entry.totalRecipients ?? null,
      excluded_opted_out: entry.excludedOptedOut ?? 0,
      scheduled_at: entry.scheduledAt ?? null,
      details: entry.details ?? {},
    });
    if (error) {
      console.error('[broadcast-audit] insert failed:', error.message);
    }
  } catch (err) {
    console.error('[broadcast-audit] insert threw:', err);
  }
}
