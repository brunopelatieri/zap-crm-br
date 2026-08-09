/**
 * Tier de mensageria da Meta e limite de contatos por disparo
 * (SPEC 044 §4).
 *
 * Lógica pura, sem I/O — a chamada HTTP mora em `meta-api.ts` e a
 * orquestração na rota. Isto aqui é o que precisa de teste: como um
 * tier vira um número, e o que esse número significa.
 *
 * O que o tier é — e o que ele NÃO é
 *
 *   `whatsapp_business_manager_messaging_limit` é o TETO DE CONTATOS
 *   QUE PODEM RECEBER UM DISPARO EM LOTE. Um TIER_2K permite montar
 *   uma audiência de até 2 000 contatos; é um limite por campanha, não
 *   um saldo que se esgota ao longo do dia.
 *
 *   Uma versão anterior desta implementação tratava o valor como uma
 *   cota de janela deslizante de 24 h e subtraía do teto os contatos já
 *   alcançados no período. Isso encolhia o limite artificialmente: uma
 *   conta TIER_2K que tivesse disparado para 1 800 contatos pela manhã
 *   aparecia com 200 de folga, quando na verdade continuava podendo
 *   montar uma audiência de 2 000.
 *
 *   `usedLast24h` continua sendo lido e exibido — é informação útil de
 *   volume —, mas NÃO entra no cálculo do limite.
 */

/**
 * Tiers conhecidos da Meta e o número máximo de contatos por disparo
 * de cada um.
 *
 * `TIER_2K` não é hipotético: é o valor que a conta de produção
 * devolve hoje. Sem ele na tabela, `parseTier` derrubava para o
 * fallback restritivo e o CRM limitava um disparo a 250 contatos numa
 * conta que aguenta 2 000.
 */
export const TIER_CAPS: Record<string, number> = {
  TIER_50: 50,
  TIER_250: 250,
  TIER_1K: 1_000,
  TIER_2K: 2_000,
  TIER_10K: 10_000,
  TIER_100K: 100_000,
  TIER_UNLIMITED: Number.POSITIVE_INFINITY,
};

/**
 * Tier assumido quando não sabemos qual é o real.
 *
 * Falhar fechado é a única postura defensável: se a Meta devolver um
 * valor que não conhecemos, ou nada, tratar como "ilimitado" faria o
 * CRM autorizar exatamente o disparo que vai ser rejeitado no meio.
 * O mais restritivo apenas pede que o usuário divida a campanha.
 */
export const FALLBACK_TIER = 'TIER_250';

/**
 * Campos pedidos à Graph API.
 *
 * Dois, de propósito. `messaging_limit_tier` é o campo do nó de número
 * de telefone; `whatsapp_business_manager_messaging_limit` aparece
 * associado ao nó de Business Manager.
 *
 * Verificado contra a conta de produção (`v21.0` e `v25.0`, mesmo
 * resultado): a Graph devolve apenas
 * `whatsapp_business_manager_messaging_limit` e ignora em silêncio o
 * outro campo, sem erro. Pedir os dois continua valendo — contas
 * provisionadas de outra forma podem responder o primeiro —, e
 * `tierFromResponse` escolhe o que vier preenchido.
 */
export const MESSAGING_LIMIT_FIELDS = [
  'messaging_limit_tier',
  'whatsapp_business_manager_messaging_limit',
] as const;

/** Resposta crua da Graph API, com os dois campos possíveis. */
export interface MessagingLimitResponse {
  id?: string;
  messaging_limit_tier?: string;
  whatsapp_business_manager_messaging_limit?: string;
}

/**
 * Normaliza qualquer forma de tier num identificador conhecido.
 *
 * Aceita variações reais: minúsculas, `TIER_1000` em vez de `TIER_1K`,
 * e o valor sem o prefixo. Qualquer coisa irreconhecível cai no
 * fallback restritivo.
 */
export function parseTier(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return FALLBACK_TIER;

  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  const withPrefix = normalized.startsWith('TIER_')
    ? normalized
    : `TIER_${normalized}`;

  if (withPrefix in TIER_CAPS) return withPrefix;

  // A Meta já documentou os mesmos degraus escritos por extenso.
  const aliases: Record<string, string> = {
    TIER_1000: 'TIER_1K',
    TIER_2000: 'TIER_2K',
    TIER_10000: 'TIER_10K',
    TIER_100000: 'TIER_100K',
    TIER_UNLIMITED_MESSAGING: 'TIER_UNLIMITED',
    TIER_NOT_APPLICABLE: FALLBACK_TIER,
  };
  if (withPrefix in aliases) return aliases[withPrefix];

  return FALLBACK_TIER;
}

/** Extrai o tier da resposta, seja qual for o campo que veio preenchido. */
export function tierFromResponse(response: MessagingLimitResponse): string {
  return parseTier(
    response.messaging_limit_tier ??
      response.whatsapp_business_manager_messaging_limit
  );
}

/**
 * Máximo de contatos por disparo de um tier. Desconhecido → fallback
 * restritivo.
 */
export function tierCap(tier: string): number {
  return TIER_CAPS[tier] ?? TIER_CAPS[FALLBACK_TIER];
}

/** De onde veio o valor exibido — a UI sinaliza quando não é fresco. */
export type QuotaSource = 'meta' | 'cache' | 'fallback';

export interface QuotaSnapshot {
  tier: string;
  /**
   * Máximo de contatos que cabem em um disparo em lote.
   * `Infinity` para TIER_UNLIMITED. É contra este número que a UI e o
   * servidor validam a audiência.
   */
  batchLimit: number;
  /**
   * Contatos distintos alcançados por disparo nas últimas 24 h.
   *
   * Puramente informativo desde que o tier passou a ser lido como
   * teto por disparo: NÃO é subtraído de `batchLimit`.
   */
  usedLast24h: number;
  source: QuotaSource;
  /** True quando estamos exibindo o último valor conhecido. */
  stale: boolean;
  checkedAt: string;
}

export interface ComputeQuotaInput {
  tier: string;
  usedLast24h: number;
  source: QuotaSource;
  checkedAt?: Date;
}

/**
 * Monta o retrato de limite que a UI e as validações consomem.
 *
 * Sem aritmética sobre o teto: o número que a Meta devolve é o número
 * que vale. A margem de segurança de 5 % que existia aqui compensava o
 * erro da NOSSA contagem de 24 h contra a contabilidade da Meta — sem
 * essa subtração, não há erro a compensar, e reservar 5 % só recusaria
 * disparos que a Meta aceitaria.
 */
export function computeQuota(input: ComputeQuotaInput): QuotaSnapshot {
  const { tier, usedLast24h, source } = input;

  return {
    tier,
    batchLimit: tierCap(tier),
    usedLast24h: Math.max(0, Math.trunc(usedLast24h) || 0),
    source,
    stale: source !== 'meta',
    checkedAt: (input.checkedAt ?? new Date()).toISOString(),
  };
}

/** TTL do cache do tier em `whatsapp_config` (SPEC 044 §4.4). */
export const TIER_CACHE_TTL_MS = 15 * 60 * 1000;

/** True quando o tier em cache ainda vale e a Meta pode ser poupada. */
export function isCacheFresh(
  checkedAt: string | null | undefined,
  now: Date = new Date()
): boolean {
  if (!checkedAt) return false;
  const ts = Date.parse(checkedAt);
  if (Number.isNaN(ts)) return false;
  const age = now.getTime() - ts;
  // Um `checked_at` no futuro (relógio torto entre app e banco) não
  // pode valer como cache eterno.
  if (age < 0) return false;
  return age < TIER_CACHE_TTL_MS;
}

/**
 * Serializa para a resposta JSON da rota. `Infinity` não sobrevive ao
 * JSON (vira `null`), então o ilimitado viaja como `null` e é
 * reconstituído no cliente.
 */
export function serializeQuota(snapshot: QuotaSnapshot) {
  const finite = (n: number) => (Number.isFinite(n) ? n : null);
  return {
    tier: snapshot.tier,
    batchLimit: finite(snapshot.batchLimit),
    usedLast24h: snapshot.usedLast24h,
    source: snapshot.source,
    stale: snapshot.stale,
    checkedAt: snapshot.checkedAt,
  };
}

export type SerializedQuota = ReturnType<typeof serializeQuota>;
