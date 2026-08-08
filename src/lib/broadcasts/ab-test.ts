/**
 * Teste A/B de template — divisão da audiência e leitura do resultado
 * (SPEC 044 §6.6).
 *
 * Módulo puro de propósito: o sorteio e a estatística não tocam banco,
 * rede nem relógio. Quem persiste é `broadcast-dispatch.ts`; quem
 * desenha é `variant-comparison.tsx`. Aqui mora só a parte que precisa
 * estar CERTA, e que por isso é a única do §6.6 com teste unitário
 * direto.
 *
 * Duas regras governam tudo abaixo
 *
 *   1. **O sorteio é exato, não binomial.** Sortear cada contato com
 *      `Math.random() < 0.5` daria braços de tamanhos diferentes a cada
 *      disparo (com 1 000 pessoas, um desvio de ±30 é rotineiro). Braços
 *      desiguais não invalidam o teste, mas gastam poder estatístico à
 *      toa e fazem o usuário desconfiar da tela. Embaralhamos e
 *      fatiamos: 50 % de 1 000 é 500 e 500, sempre.
 *   2. **Abaixo de {@link AB_MIN_ARM_FOR_SIGNIFICANCE} destinatários por
 *      braço, nada é declarado vencedor.** É a exigência explícita da
 *      §6.6, e é a que impede o dano real do recurso: com 40 pessoas por
 *      braço, "12 % contra 8 %" é ruído puro, e mostrar esse número sem
 *      ressalva induz a trocar um template que estava bom.
 */

/** Percentual da audiência sorteado para a variante A. */
export const AB_DEFAULT_SPLIT_PERCENT = 50;

/**
 * Piso de destinatários POR BRAÇO para reportar significância (§6.6).
 *
 * Não é um número mágico: com ~300 por braço, um teste de duas
 * proporções detecta diferenças da ordem de 10 pontos percentuais em
 * taxas médias (por exemplo 45 % → 55 %) com poder razoável. Diferenças
 * menores do que isso exigem audiências que a maioria das contas não
 * tem — e prometer detectá-las seria mentir com a cara de estatística.
 */
export const AB_MIN_ARM_FOR_SIGNIFICANCE = 300;

/** Nível de significância. Bilateral: não sabemos de antemão quem ganha. */
export const AB_SIGNIFICANCE_LEVEL = 0.05;

/**
 * Métrica que decide o vencedor.
 *
 * Entrega é quase sempre ~100 % nos dois braços (depende do número, não
 * do texto) e resposta é rara demais para mover em n = 300. A taxa de
 * LEITURA é a que o texto do template de fato influencia e a única com
 * eventos suficientes para o piso acima significar alguma coisa. As três
 * aparecem na tela; só esta nomeia um vencedor.
 */
export const AB_PRIMARY_METRIC: AbMetric = 'read';

export type AbMetric = 'delivered' | 'read' | 'replied';

export const AB_METRICS: readonly AbMetric[] = ['delivered', 'read', 'replied'];

/**
 * Os números de um braço, como vêm de `broadcasts`.
 *
 * O denominador é `sent`, não `total_recipients`: um destinatário com
 * telefone inválido nunca recebeu mensagem nenhuma, e contá-lo no
 * denominador puniria o braço que por acaso herdou mais números ruins
 * do sorteio — um efeito da lista, não do template.
 */
export interface VariantStats {
  sent: number;
  delivered: number;
  read: number;
  replied: number;
}

export interface MetricComparison {
  metric: AbMetric;
  /** Eventos e taxa (0–1) de cada braço. */
  countA: number;
  countB: number;
  rateA: number;
  rateB: number;
  /** Diferença B − A em pontos percentuais. */
  diffPoints: number;
  /** Variação relativa de B sobre A (0.2 = +20 %). `null` se A é zero. */
  lift: number | null;
  /** Estatística z do teste de duas proporções. `null` sem dados. */
  z: number | null;
  /** p bilateral. `null` sem dados. */
  pValue: number | null;
  /** p < 0.05 **e** os dois braços acima do piso. */
  significant: boolean;
}

export interface AbTestSummary {
  /** Uma comparação por métrica, na ordem do funil. */
  metrics: MetricComparison[];
  /**
   * Braço vencedor pela métrica primária. `null` quando não há
   * significância — o que inclui todo teste pequeno demais.
   */
  winner: 'A' | 'B' | null;
  /** Um dos braços não alcançou o piso: nenhum veredito é reportável. */
  smallSample: boolean;
  /** Menor dos dois braços, para a UI dizer quanto falta. */
  smallestArm: number;
}

/**
 * Divide `items` em dois braços com tamanhos exatos.
 *
 * `percentA` é a fatia de A (1–99). O resto vai para B. A ordem é
 * embaralhada antes do corte — sem isso, "os 50 % primeiros" seria a
 * ordem de leitura da planilha, e planilhas chegam ordenadas por coisas
 * que importam (data de cadastro, cidade, valor gasto). Um braço
 * sistematicamente diferente do outro é um teste que mede a ordenação.
 *
 * `rng` existe para o teste unitário poder fixar o sorteio; em produção
 * é sempre `Math.random`.
 */
export function splitInTwo<T>(
  items: readonly T[],
  percentA: number = AB_DEFAULT_SPLIT_PERCENT,
  rng: () => number = Math.random
): { a: T[]; b: T[] } {
  const shuffled = shuffle(items, rng);
  const total = shuffled.length;
  if (total === 0) return { a: [], b: [] };

  let countA = Math.round((total * clampSplitPercent(percentA)) / 100);

  // Com dois ou mais itens, nenhum braço pode ficar vazio: um "teste"
  // com um braço sem ninguém é uma campanha comum com nome pomposo.
  // Com um item só, B fica vazio — e quem chama recusa antes disso.
  if (total > 1) countA = Math.min(Math.max(countA, 1), total - 1);

  return { a: shuffled.slice(0, countA), b: shuffled.slice(countA) };
}

/** Fisher–Yates. Não muta a entrada. */
function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Mantém o percentual em 1–99; fora disso um braço nasceria vazio. */
export function clampSplitPercent(percent: number): number {
  if (!Number.isFinite(percent)) return AB_DEFAULT_SPLIT_PERCENT;
  return Math.min(99, Math.max(1, Math.round(percent)));
}

/**
 * Teste z de duas proporções, agrupado (pooled), bilateral.
 *
 * Devolve `null` quando não há o que testar — braço vazio, ou variância
 * zero (as duas taxas idênticas em 0 % ou 100 %). Um `null` explícito
 * força a UI a dizer "sem dados" em vez de renderizar `NaN`.
 */
export function twoProportionZTest(
  successA: number,
  nA: number,
  successB: number,
  nB: number
): { z: number; pValue: number } | null {
  if (nA <= 0 || nB <= 0) return null;

  const pA = successA / nA;
  const pB = successB / nB;
  const pooled = (successA + successB) / (nA + nB);
  const variance = pooled * (1 - pooled) * (1 / nA + 1 / nB);
  if (variance <= 0) return null;

  const z = (pB - pA) / Math.sqrt(variance);
  return { z, pValue: 2 * (1 - normalCdf(Math.abs(z))) };
}

/**
 * Φ(x) — CDF da normal padrão, via a aproximação de Abramowitz &
 * Stegun 7.1.26 (erro < 1,5e-7). Trazer uma biblioteca de estatística
 * para uma única função seria pagar caro por seis linhas.
 */
export function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;

  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-z * z);

  return 0.5 * (1 + sign * y);
}

function eventsFor(stats: VariantStats, metric: AbMetric): number {
  switch (metric) {
    case 'delivered':
      return stats.delivered;
    case 'read':
      return stats.read;
    case 'replied':
      return stats.replied;
  }
}

/** Compara uma métrica entre os dois braços. */
export function compareMetric(
  a: VariantStats,
  b: VariantStats,
  metric: AbMetric
): MetricComparison {
  const countA = eventsFor(a, metric);
  const countB = eventsFor(b, metric);
  const rateA = a.sent > 0 ? countA / a.sent : 0;
  const rateB = b.sent > 0 ? countB / b.sent : 0;

  const test = twoProportionZTest(countA, a.sent, countB, b.sent);
  const bigEnough = Math.min(a.sent, b.sent) >= AB_MIN_ARM_FOR_SIGNIFICANCE;

  return {
    metric,
    countA,
    countB,
    rateA,
    rateB,
    diffPoints: (rateB - rateA) * 100,
    lift: rateA > 0 ? (rateB - rateA) / rateA : null,
    z: test?.z ?? null,
    pValue: test?.pValue ?? null,
    significant:
      bigEnough && test !== null && test.pValue < AB_SIGNIFICANCE_LEVEL,
  };
}

/**
 * Leitura completa do teste: as três métricas + o veredito.
 *
 * O veredito sai só da métrica primária e só com significância — e
 * significância, aqui, já embute o piso de amostra. Quem chama não
 * precisa lembrar de checar `smallSample` antes de mostrar o vencedor;
 * ele simplesmente não existe nesse caso.
 */
export function summarizeAbTest(
  a: VariantStats,
  b: VariantStats
): AbTestSummary {
  const metrics = AB_METRICS.map((metric) => compareMetric(a, b, metric));
  const primary = metrics.find((m) => m.metric === AB_PRIMARY_METRIC)!;

  return {
    metrics,
    winner: primary.significant
      ? primary.rateB > primary.rateA
        ? 'B'
        : 'A'
      : null,
    smallSample: Math.min(a.sent, b.sent) < AB_MIN_ARM_FOR_SIGNIFICANCE,
    smallestArm: Math.min(a.sent, b.sent),
  };
}
