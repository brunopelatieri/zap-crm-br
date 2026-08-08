/**
 * Tier de mensageria da Meta e cálculo de cota (SPEC 044 §4).
 *
 * Lógica pura, sem I/O — a chamada HTTP mora em `meta-api.ts` e a
 * orquestração na rota. Isto aqui é o que precisa de teste: como um
 * tier vira um número, e como esse número vira "quantos ainda posso
 * enviar agora".
 *
 * O invariante que define o desenho
 *
 *   O tier NÃO é um teto por disparo. É uma janela deslizante de 24 h
 *   sobre clientes únicos iniciados pelo negócio. Três disparos de 400
 *   contatos no mesmo dia estouram um TIER_1K mesmo cada um estando
 *   individualmente "dentro do limite". Por isso o número que a UI
 *   mostra é `remaining = cap − usados nas últimas 24 h`, e não `cap`.
 */

/** Tiers conhecidos da Meta e o teto de conversas de cada um. */
export const TIER_CAPS: Record<string, number> = {
  TIER_50: 50,
  TIER_250: 250,
  TIER_1K: 1_000,
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
 * Margem de segurança sobre a cota (SPEC 044 §4.2).
 *
 * `usedLast24h` é a NOSSA contagem de destinatários enviados; a Meta
 * conta conversas pela contabilidade dela, que não é idêntica. Reservar
 * 5 % faz o CRM bloquear um pouco antes do teto real, em vez de
 * descobrir a diferença por rejeição no meio de um disparo.
 */
export const QUOTA_SAFETY_MARGIN = 0.05;

/**
 * Campos pedidos à Graph API.
 *
 * Dois, de propósito. `messaging_limit_tier` é o campo do nó de número
 * de telefone; `whatsapp_business_manager_messaging_limit` aparece
 * associado ao nó de Business Manager. Qual deles a conta responde
 * depende da versão da API e da forma como o número foi provisionado —
 * pedir os dois e normalizar o que voltar tira essa dúvida do caminho
 * crítico, em vez de fazer a feature depender de acertar o palpite.
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

/** Teto numérico de um tier. Desconhecido → fallback restritivo. */
export function tierCap(tier: string): number {
  return TIER_CAPS[tier] ?? TIER_CAPS[FALLBACK_TIER];
}

/** De onde veio o valor exibido — a UI sinaliza quando não é fresco. */
export type QuotaSource = 'meta' | 'cache' | 'fallback';

export interface QuotaSnapshot {
  tier: string;
  /** Teto bruto do tier. `Infinity` para TIER_UNLIMITED. */
  tierCap: number;
  /** Teto após a margem de segurança — é contra este que validamos. */
  effectiveCap: number;
  usedLast24h: number;
  /** Quanto ainda cabe. Nunca negativo. */
  remaining: number;
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
  /** Sobrescreve a margem padrão. Usado nos testes. */
  safetyMargin?: number;
}

/**
 * Monta o retrato de cota que a UI e as validações consomem.
 *
 * `remaining` é limitado em zero de propósito: uma conta que já passou
 * do teto (porque a contagem da Meta divergiu, ou porque um envio veio
 * de fora do CRM) precisa ver "0 disponíveis", não um número negativo
 * que ninguém sabe interpretar.
 */
export function computeQuota(input: ComputeQuotaInput): QuotaSnapshot {
  const { tier, usedLast24h, source } = input;
  const margin = input.safetyMargin ?? QUOTA_SAFETY_MARGIN;
  const cap = tierCap(tier);

  // Sem teto não há margem a aplicar — e `Infinity * 0.95` seria
  // Infinity de qualquer forma, mas o ramo explícito evita que um
  // `Math.floor(Infinity)` apareça em algum cálculo derivado.
  const effectiveCap = Number.isFinite(cap)
    ? Math.floor(cap * (1 - margin))
    : Number.POSITIVE_INFINITY;

  const used = Math.max(0, Math.trunc(usedLast24h) || 0);

  const remaining = Number.isFinite(effectiveCap)
    ? Math.max(0, effectiveCap - used)
    : Number.POSITIVE_INFINITY;

  return {
    tier,
    tierCap: cap,
    effectiveCap,
    usedLast24h: used,
    remaining,
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
    tierCap: finite(snapshot.tierCap),
    effectiveCap: finite(snapshot.effectiveCap),
    usedLast24h: snapshot.usedLast24h,
    remaining: finite(snapshot.remaining),
    source: snapshot.source,
    stale: snapshot.stale,
    checkedAt: snapshot.checkedAt,
  };
}

export type SerializedQuota = ReturnType<typeof serializeQuota>;
