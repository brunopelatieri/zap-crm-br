/**
 * Métricas de reengajamento de janela (SPEC 045 §7).
 *
 * Lê a RPC `automation_window_stats` (migração 053) e transforma as
 * cinco contagens cruas nas taxas que a §7 pede. As taxas moram AQUI,
 * e não na RPC, por um motivo: divisão por zero é uma decisão de
 * apresentação, não de banco — uma automação que nunca disparou não tem
 * "taxa de reabertura de 0%", ela não tem taxa nenhuma, e é o `null`
 * que faz a UI escrever "—" em vez de um zero que parece fracasso.
 *
 * Recorte: os últimos 30 dias, por construção — a varredura purga
 * claims mais antigos (§5.5.2). Não há parâmetro de janela porque não
 * há histórico além disso.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface WindowStatsRow {
  claims_total: number;
  sent: number;
  failed: number;
  reopened: number;
  opted_out_after: number;
}

export interface WindowStats extends WindowStatsRow {
  /** Reabriram / enviados. `null` quando nada foi enviado ainda. */
  reopenRate: number | null;
  /** Descadastros / enviados. `null` quando nada foi enviado ainda. */
  optOutRate: number | null;
}

/** `a / b` como fração 0–1, ou `null` quando não há denominador. */
export function rate(numerator: number, denominator: number): number | null {
  if (!denominator) return null;
  return numerator / denominator;
}

export function deriveWindowStats(row: WindowStatsRow): WindowStats {
  return {
    ...row,
    // Denominador é `sent`, não `claims_total`: um claim que falhou no
    // despacho nunca teve chance de reabrir a janela, e contá-lo no
    // denominador transformaria uma indisponibilidade da Meta em uma
    // "queda na taxa de reengajamento" — atribuindo ao CONTEÚDO da
    // mensagem um problema que foi de infraestrutura.
    reopenRate: rate(row.reopened, row.sent),
    optOutRate: rate(row.opted_out_after, row.sent),
  };
}

/**
 * Busca as métricas de uma automação de reengajamento.
 *
 * Devolve `null` quando a RPC não existe (deploy sem a migração 053) ou
 * quando o chamador não é membro da conta — os dois casos significam a
 * mesma coisa para a UI: não há painel a mostrar. Um erro aqui nunca
 * deve derrubar a página de logs, que é útil por si só.
 */
export async function loadWindowStats(
  db: SupabaseClient,
  automationId: string
): Promise<WindowStats | null> {
  const { data, error } = await db.rpc('automation_window_stats', {
    p_automation_id: automationId,
  });

  if (error) {
    console.warn('[window-stats] unavailable:', error.message);
    return null;
  }

  // `RETURNS TABLE` chega como array de uma linha.
  const row = (data as WindowStatsRow[] | null)?.[0];
  if (!row) return null;

  return deriveWindowStats({
    claims_total: Number(row.claims_total ?? 0),
    sent: Number(row.sent ?? 0),
    failed: Number(row.failed ?? 0),
    reopened: Number(row.reopened ?? 0),
    opted_out_after: Number(row.opted_out_after ?? 0),
  });
}
