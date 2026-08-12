/**
 * Teto de segurança para ENVIO FRIO em instância não-oficial
 * (WhatsApp via QRCode — PRD 047 §10.3).
 *
 * O que é "envio frio", e por que só ele é contado
 *
 *   Responder alguém que está conversando com você tem risco zero: a
 *   pessoa iniciou, espera resposta e não vai denunciar. O que derruba
 *   número é o oposto — mensagem automatizada para quem NÃO está
 *   falando com você. É esse o padrão que o WhatsApp classifica como
 *   spam, e é ele, e só ele, que este módulo limita.
 *
 *   Concretamente: um envio é FRIO quando a última mensagem do contato
 *   é mais antiga que `silenceHours` (padrão 24 h), ou quando ele nunca
 *   escreveu. Uma automação respondendo dentro de uma conversa viva não
 *   consome cota nenhuma.
 *
 * Por que três tetos, e não só "por dia"
 *
 *   Um teto diário sozinho permite mandar as 60 mensagens do dia em
 *   cinco minutos — que é EXATAMENTE o disparo em rajada que o
 *   antispam do WhatsApp detecta. O limite por hora é o que impede a
 *   rajada; o intervalo mínimo é o que impede a metralhadora dentro da
 *   hora; o diário é o teto de volume. Os três juntos descrevem um
 *   comportamento humano; qualquer um sozinho, não.
 *
 * Janela deslizante, não dia do calendário
 *
 *   "Por dia" contado à meia-noite deixa mandar 2× o limite em torno da
 *   virada — 60 às 23h50 e 60 às 00h10. As últimas 24 h corridas não
 *   têm essa borda.
 *
 * Aquecimento
 *
 *   Instância nova mandando o volume máximo no primeiro dia é o retrato
 *   do número descartável, e o classificador do WhatsApp trata assim. A
 *   cota cresce linearmente até `warmupDays` — o operador não precisa
 *   fazer nada, e o teto que ele configurou continua sendo o teto.
 *
 * Módulo puro: parsing, cálculo e veredito, sem banco e sem rede. Quem
 * chama reúne o uso (as contagens) e executa a decisão.
 */

/** Piso da cota diária durante o aquecimento. */
const WARMUP_FLOOR = 5;

export interface ColdSendLimits {
  /** Silêncio a partir do qual um envio conta como frio. */
  silenceHours: number;
  perHour: number;
  perDay: number;
  minIntervalSeconds: number;
  /** Dias até a cota diária atingir `perDay`. 0 desliga o aquecimento. */
  warmupDays: number;
}

export const COLD_SEND_DEFAULTS: ColdSendLimits = {
  silenceHours: 24,
  perHour: 12,
  perDay: 60,
  minIntervalSeconds: 45,
  warmupDays: 14,
};

/**
 * Lê os tetos das variáveis de ambiente. Valor ausente, não numérico ou
 * negativo cai no padrão — um `.env` com erro de digitação não pode
 * virar "sem limite", que é o pior resultado possível aqui.
 *
 * `0` é aceito e significa **bloquear todo envio frio** nesse eixo; é a
 * forma de o dono do sistema desligar o recurso sem mexer em código.
 */
export function readColdSendLimits(
  env: Record<string, string | undefined> = process.env
): ColdSendLimits {
  return {
    silenceHours: positiveInt(
      env.EVOLUTION_COLD_SEND_SILENCE_HOURS,
      COLD_SEND_DEFAULTS.silenceHours,
      { allowZero: false }
    ),
    perHour: positiveInt(
      env.EVOLUTION_COLD_SEND_PER_HOUR,
      COLD_SEND_DEFAULTS.perHour
    ),
    perDay: positiveInt(
      env.EVOLUTION_COLD_SEND_PER_DAY,
      COLD_SEND_DEFAULTS.perDay
    ),
    minIntervalSeconds: positiveInt(
      env.EVOLUTION_COLD_SEND_MIN_INTERVAL_SECONDS,
      COLD_SEND_DEFAULTS.minIntervalSeconds
    ),
    warmupDays: positiveInt(
      env.EVOLUTION_COLD_SEND_WARMUP_DAYS,
      COLD_SEND_DEFAULTS.warmupDays
    ),
  };
}

function positiveInt(
  raw: string | undefined,
  fallback: number,
  { allowZero = true }: { allowZero?: boolean } = {}
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return fallback;
  if (n === 0 && !allowZero) return fallback;
  return n;
}

/**
 * Um envio é frio? `lastInboundAt` é a última mensagem DO CONTATO nesta
 * conversa; `null` = nunca escreveu, o caso mais frio de todos.
 */
export function isColdSend(
  lastInboundAt: Date | null,
  limits: ColdSendLimits,
  now: Date = new Date()
): boolean {
  if (!lastInboundAt) return true;
  return (
    now.getTime() - lastInboundAt.getTime() >= limits.silenceHours * 3_600_000
  );
}

/**
 * Cota diária efetiva de uma instância, já com o aquecimento aplicado.
 * Exportada porque a interface mostra este número — e não o `perDay`
 * cru — quando a instância ainda está aquecendo.
 */
export function effectiveDailyLimit(
  limits: ColdSendLimits,
  instanceCreatedAt: Date,
  now: Date = new Date()
): number {
  if (limits.warmupDays <= 0 || limits.perDay === 0) return limits.perDay;

  const ageDays = Math.floor(
    (now.getTime() - instanceCreatedAt.getTime()) / 86_400_000
  );
  if (ageDays >= limits.warmupDays) return limits.perDay;

  const ramped = Math.ceil((limits.perDay * (ageDays + 1)) / limits.warmupDays);
  // O piso nunca pode ultrapassar o teto configurado: com perDay=3 e
  // aquecimento ligado, o resultado tem de ser 3, não 5.
  return Math.min(
    limits.perDay,
    Math.max(ramped, Math.min(WARMUP_FLOOR, limits.perDay))
  );
}

export interface ColdSendUsage {
  /** Envios frios desta instância nas últimas 24 h corridas. */
  last24h: number;
  /** Envios frios desta instância na última hora corrida. */
  lastHour: number;
  /** Instante do último envio frio, para o intervalo mínimo. */
  lastColdSendAt: Date | null;
  /** Quando a instância foi criada — base do aquecimento. */
  instanceCreatedAt: Date;
}

export type ColdSendDenialReason =
  'daily_limit' | 'hourly_limit' | 'min_interval';

export interface ColdSendDecision {
  allowed: boolean;
  reason?: ColdSendDenialReason;
  /** Segundos até valer a pena tentar de novo. */
  retryAfterSeconds?: number;
  remainingToday: number;
  remainingThisHour: number;
  /** Teto diário em vigor agora (com aquecimento). */
  dailyLimit: number;
  hourlyLimit: number;
  /** A instância ainda está no período de aquecimento. */
  warmingUp: boolean;
}

/**
 * Este envio frio pode sair agora?
 *
 * A ordem das checagens é a ordem da severidade: estourar o dia é uma
 * espera de horas, a hora é uma espera de minutos, o intervalo é de
 * segundos. Reportar sempre a restrição MAIS longa evita que quem
 * chama fique tentando de 45 em 45 segundos contra um teto diário.
 */
export function evaluateColdSend(
  limits: ColdSendLimits,
  usage: ColdSendUsage,
  now: Date = new Date()
): ColdSendDecision {
  const dailyLimit = effectiveDailyLimit(limits, usage.instanceCreatedAt, now);
  const warmingUp = dailyLimit < limits.perDay;

  const remainingToday = Math.max(0, dailyLimit - usage.last24h);
  const remainingThisHour = Math.max(0, limits.perHour - usage.lastHour);

  const base = {
    remainingToday,
    remainingThisHour,
    dailyLimit,
    hourlyLimit: limits.perHour,
    warmingUp,
  };

  if (remainingToday === 0) {
    return {
      ...base,
      allowed: false,
      reason: 'daily_limit',
      retryAfterSeconds: 3600,
    };
  }

  if (remainingThisHour === 0) {
    return {
      ...base,
      allowed: false,
      reason: 'hourly_limit',
      retryAfterSeconds: 600,
    };
  }

  if (limits.minIntervalSeconds > 0 && usage.lastColdSendAt) {
    const elapsed = (now.getTime() - usage.lastColdSendAt.getTime()) / 1000;
    if (elapsed < limits.minIntervalSeconds) {
      return {
        ...base,
        allowed: false,
        reason: 'min_interval',
        retryAfterSeconds: Math.ceil(limits.minIntervalSeconds - elapsed),
      };
    }
  }

  return { ...base, allowed: true };
}

/** Motivo legível para `automation_logs` — nunca some sem rastro. */
export function describeDenial(decision: ColdSendDecision): string {
  switch (decision.reason) {
    case 'daily_limit':
      return `cold-send daily limit reached (${decision.dailyLimit}/24h${decision.warmingUp ? ', instance still warming up' : ''})`;
    case 'hourly_limit':
      return `cold-send hourly limit reached (${decision.hourlyLimit}/h)`;
    case 'min_interval':
      return `cold-send minimum interval not elapsed (retry in ${decision.retryAfterSeconds}s)`;
    default:
      return 'cold send allowed';
  }
}
