/**
 * Leituras do dashboard de engajamento (SPEC 044 §5.2).
 *
 * Três RPCs, dois formatos de escopo:
 *
 *   - `broadcast_account_stats` / `broadcast_engagement_series` (migração
 *     047) são `SECURITY DEFINER` e exigem `accountId` explícito — não há
 *     RLS por linha para se apoiar aqui (a agregação é sobre TODA a conta),
 *     então a guarda `is_account_member` mora dentro da função.
 *   - `audience_engagement_summary` (046) é `SECURITY INVOKER`: a RLS de
 *     `broadcast_audience_staging` (045) já escopa por `draftId`, sem
 *     parâmetro de conta.
 *
 * Os tipos abaixo espelham as colunas das RPCs 1:1 (snake_case), mesma
 * convenção de `triage.ts` — os componentes que consomem já leem
 * `campaigns_received` etc. da tabela de triagem sem tradução, então manter
 * o mesmo formato aqui evita um mapeamento a mais só para trocar de estilo.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { TriageFilter } from './triage';

/** Uma linha de `broadcast_account_stats` (047). */
export interface AccountEngagementStats {
  campaigns_total: number;
  campaigns_sent: number;
  messages_sent: number;
  messages_delivered: number;
  messages_read: number;
  messages_replied: number;
  messages_failed: number;
  contacts_reached: number;
}

const ZERO_STATS: AccountEngagementStats = {
  campaigns_total: 0,
  campaigns_sent: 0,
  messages_sent: 0,
  messages_delivered: 0,
  messages_read: 0,
  messages_replied: 0,
  messages_failed: 0,
  contacts_reached: 0,
};

/** Uma linha de `broadcast_engagement_series` (047). */
export interface EngagementSeriesPoint {
  day: string;
  campaigns: number;
  messages_sent: number;
  messages_delivered: number;
  messages_read: number;
  messages_replied: number;
  messages_failed: number;
  contacts_reached: number;
}

/** Uma linha de `audience_engagement_summary` (046, ampliada na 048). */
export interface AudienceEngagementSummary {
  total_rows: number;
  selected_rows: number;
  valid_rows: number;
  invalid_rows: number;
  new_contacts: number;
  existing_contacts: number;
  ever_contacted: number;
  ever_read: number;
  ever_replied: number;
  never_delivered: number;
  problematic: number;
  in_cooldown: number;
  /** Linhas cujo contato pediu para sair de marketing (§6.8). */
  opted_out_rows: number;
  /** Selecionadas e válidas, INCLUINDO quem está em opt-out. */
  selected_valid_rows: number;
  /**
   * O alcance efetivo de um template de MARKETING: selecionadas, válidas
   * e fora do opt-out. É este número que `estimateAudience` usa para uma
   * audiência `staged` — ver o cabeçalho de `estimate.ts`.
   */
  sendable_rows: number;
}

const ZERO_SUMMARY: AudienceEngagementSummary = {
  total_rows: 0,
  selected_rows: 0,
  valid_rows: 0,
  invalid_rows: 0,
  new_contacts: 0,
  existing_contacts: 0,
  ever_contacted: 0,
  ever_read: 0,
  ever_replied: 0,
  never_delivered: 0,
  problematic: 0,
  in_cooldown: 0,
  opted_out_rows: 0,
  selected_valid_rows: 0,
  sendable_rows: 0,
};

/**
 * Cards agregados da conta (§5.2a). `sinceIso` omitido = desde sempre; a
 * tela passa o início da mesma janela da série, para o card e o gráfico
 * descreverem o MESMO período — ver o cabeçalho da 047.
 */
export async function loadAccountEngagementStats(
  db: SupabaseClient,
  accountId: string,
  sinceIso?: string | null
): Promise<AccountEngagementStats> {
  const { data, error } = await db.rpc('broadcast_account_stats', {
    p_account_id: accountId,
    p_since: sinceIso ?? null,
  });
  if (error) throw error;
  // `RETURNS TABLE` chega como array de uma linha.
  const row = (data as AccountEngagementStats[] | null)?.[0];
  return row ?? ZERO_STATS;
}

/**
 * Série diária para o gráfico (§5.2). `timeZone` é o fuso da CONTA, não
 * assumido pelo servidor — a tela passa
 * `Intl.DateTimeFormat().resolvedOptions().timeZone`. Dias sem atividade já
 * vêm zerados do banco (LEFT JOIN em `generate_series`), então não há
 * lacuna para preencher aqui.
 */
export async function loadEngagementSeries(
  db: SupabaseClient,
  accountId: string,
  days: number,
  timeZone: string
): Promise<EngagementSeriesPoint[]> {
  const { data, error } = await db.rpc('broadcast_engagement_series', {
    p_account_id: accountId,
    p_days: days,
    p_time_zone: timeZone,
  });
  if (error) throw error;
  return (data ?? []) as EngagementSeriesPoint[];
}

/**
 * Recorte da audiência atual (§5.2b) — o número que decide a triagem, não
 * o histórico da conta inteira. Aceita o mesmo filtro+busca da tabela
 * (046) para o resumo acompanhar o que está na tela.
 */
export async function loadAudienceEngagementSummary(
  db: SupabaseClient,
  draftId: string,
  search: string,
  filter: TriageFilter
): Promise<AudienceEngagementSummary> {
  const { data, error } = await db.rpc('audience_engagement_summary', {
    p_draft_id: draftId,
    p_search: search.trim() || null,
    p_filter: filter,
  });
  if (error) throw error;
  const row = (data as AudienceEngagementSummary[] | null)?.[0];
  return row ?? ZERO_SUMMARY;
}
