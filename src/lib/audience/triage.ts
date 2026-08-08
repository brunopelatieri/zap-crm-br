/**
 * Tipos e constantes da triagem de audiência (SPEC 044 §5.1, §5.3, §8.3).
 *
 * `TriageFilter` espelha, valor a valor, a lista fechada de
 * `triage_assert_filter` (migração 046) — um nome fora desta lista faz
 * a RPC abortar com `22023` em vez de silenciosamente virar "todos".
 * Mudar um lado sem o outro quebra a triagem em produção, não em build.
 */

export type TriageFilter =
  | 'all'
  | 'selected'
  | 'unselected'
  | 'valid'
  | 'invalid'
  | 'new'
  | 'existing'
  | 'engaged'
  | 'reads_no_reply'
  | 'dormant'
  | 'never_contacted'
  | 'problematic'
  | 'cooldown'
  // Consentimento (§6.8, migração 048)
  | 'opted_out'
  | 'optable';

/** Mesma ordem em que a UI agrupa o dropdown de filtro. */
export const TRIAGE_STATE_FILTERS: readonly TriageFilter[] = [
  'all',
  'selected',
  'unselected',
  'valid',
  'invalid',
  'new',
  'existing',
];

export const TRIAGE_ENGAGEMENT_FILTERS: readonly TriageFilter[] = [
  'engaged',
  'reads_no_reply',
  'dormant',
  'never_contacted',
  'problematic',
  'cooldown',
];

/**
 * Consentimento (§6.8). Grupo próprio no dropdown, e não junto dos
 * presets de engajamento: "quem pediu para sair" não é um recorte de
 * comportamento que se possa mirar — é uma restrição legal, e misturar os
 * dois convidaria a tratá-la como uma preferência de segmentação.
 */
export const TRIAGE_CONSENT_FILTERS: readonly TriageFilter[] = [
  'optable',
  'opted_out',
];

/** Linha devolvida por `triage_audience_page` (RPC, migração 046). */
export interface TriageRow {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  company: string | null;
  selected: boolean;
  invalid_reason: string | null;
  source_row: number | null;
  is_new: boolean;
  existing_contact_id: string | null;
  campaigns_received: number;
  last_delivered_at: string | null;
  last_sent_at: string | null;
  has_read: boolean;
  has_replied: boolean;
  failure_count: number;
  tag_names: string[];
  /** Consentimento do contato (§6.8). Linha nova = 'unknown'. */
  opt_in_status: 'opted_in' | 'opted_out' | 'unknown';
  is_opted_out: boolean;
  total_count: number;
}

/** Página lida via RPC, com `total_count` já extraído da primeira linha. */
export interface TriagePage {
  rows: TriageRow[];
  totalCount: number;
}
