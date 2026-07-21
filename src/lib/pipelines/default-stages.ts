/**
 * Default pipeline stages seeded on first visit / new funnel creation.
 *
 * Titles live in `messages/*.json` under `Pipelines.page.defaultStages.*`
 * so the seed persists names in the user's current locale (pt-BR or en).
 * Colors and positions stay here as the product-spec constants.
 */

export const DEFAULT_STAGE_KEYS = [
  'newLead',
  'qualified',
  'proposalSent',
  'negotiation',
  'won',
] as const;

export type DefaultStageKey = (typeof DEFAULT_STAGE_KEYS)[number];

export interface DefaultStageDef {
  key: DefaultStageKey;
  color: string;
  position: number;
}

export const DEFAULT_STAGE_DEFS: ReadonlyArray<DefaultStageDef> = [
  { key: 'newLead', color: '#3b82f6', position: 0 },
  { key: 'qualified', color: '#eab308', position: 1 },
  { key: 'proposalSent', color: '#f97316', position: 2 },
  { key: 'negotiation', color: '#8b5cf6', position: 3 },
  { key: 'won', color: '#22c55e', position: 4 },
];

/**
 * Historical / locale variants of the stock seed titles. Used to detect
 * an untouched default funnel so we can rewrite names into the active
 * locale without clobbering user-renamed stages.
 */
export const DEFAULT_STAGE_NAME_ALIASES: Record<DefaultStageKey, string[]> = {
  newLead: ['New Lead', 'Novo Lead'],
  qualified: ['Qualified', 'Qualificado'],
  proposalSent: ['Proposal Sent', 'Proposta Enviada'],
  negotiation: ['Negotiation', 'Negociação'],
  won: ['Won', 'Ganho', 'Ganhos'],
};

export const DEFAULT_PIPELINE_NAME_ALIASES = [
  'Sales Pipeline',
  'Funil de Vendas',
] as const;

export function isDefaultStageName(
  key: DefaultStageKey,
  name: string
): boolean {
  return DEFAULT_STAGE_NAME_ALIASES[key].includes(name);
}

export function isStockDefaultPipeline(
  pipelineName: string,
  stages: ReadonlyArray<{ name: string; position: number }>
): boolean {
  if (
    !DEFAULT_PIPELINE_NAME_ALIASES.includes(
      pipelineName as (typeof DEFAULT_PIPELINE_NAME_ALIASES)[number]
    )
  ) {
    return false;
  }
  if (stages.length !== DEFAULT_STAGE_DEFS.length) return false;
  const byPos = [...stages].sort((a, b) => a.position - b.position);
  return DEFAULT_STAGE_DEFS.every((def, i) => {
    const stage = byPos[i];
    return (
      stage?.position === def.position &&
      isDefaultStageName(def.key, stage.name)
    );
  });
}
