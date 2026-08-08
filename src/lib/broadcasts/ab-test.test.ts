import { describe, expect, it } from 'vitest';

import {
  AB_MIN_ARM_FOR_SIGNIFICANCE,
  clampSplitPercent,
  compareMetric,
  normalCdf,
  splitInTwo,
  summarizeAbTest,
  twoProportionZTest,
  type VariantStats,
} from './ab-test';

/** RNG determinístico — sorteio previsível, teste sem flake. */
function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // xorshift32: qualquer gerador serve, desde que seja o mesmo sempre.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 100000) / 100000;
  };
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('splitInTwo', () => {
  it('divide em tamanhos EXATOS, não binomiais', () => {
    // A razão de existir do embaralhar-e-fatiar: sortear cada item com
    // `random() < 0.5` daria 487/513 num disparo e 511/489 no seguinte.
    const { a, b } = splitInTwo(range(1000), 50, seededRng(7));
    expect(a).toHaveLength(500);
    expect(b).toHaveLength(500);
  });

  it('respeita um percentual configurado', () => {
    const { a, b } = splitInTwo(range(100), 20, seededRng(11));
    expect(a).toHaveLength(20);
    expect(b).toHaveLength(80);
  });

  it('não perde nem duplica ninguém', () => {
    const { a, b } = splitInTwo(range(37), 50, seededRng(3));
    expect(new Set([...a, ...b]).size).toBe(37);
    expect(a.length + b.length).toBe(37);
  });

  it('embaralha antes de cortar', () => {
    // Sem isto, "os 50 % primeiros" seria a ordem da planilha — e
    // planilhas chegam ordenadas por data de cadastro, cidade, valor.
    const { a } = splitInTwo(range(100), 50, seededRng(5));
    expect(a).not.toEqual(range(50));
  });

  it('nunca deixa um braço vazio quando há pelo menos dois itens', () => {
    // 1 % de 10 arredonda para 0; o piso corrige para 1.
    const { a, b } = splitInTwo(range(10), 1, seededRng(2));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(9);

    const extremo = splitInTwo(range(2), 99, seededRng(2));
    expect(extremo.a).toHaveLength(1);
    expect(extremo.b).toHaveLength(1);
  });

  it('devolve dois braços vazios para uma lista vazia', () => {
    expect(splitInTwo([], 50, seededRng(1))).toEqual({ a: [], b: [] });
  });
});

describe('clampSplitPercent', () => {
  it('mantém a faixa 1–99 e arredonda', () => {
    expect(clampSplitPercent(50)).toBe(50);
    expect(clampSplitPercent(0)).toBe(1);
    expect(clampSplitPercent(100)).toBe(99);
    expect(clampSplitPercent(33.4)).toBe(33);
  });

  it('cai no padrão diante de lixo numérico', () => {
    expect(clampSplitPercent(Number.NaN)).toBe(50);
    expect(clampSplitPercent(Number.POSITIVE_INFINITY)).toBe(50);
  });
});

describe('normalCdf', () => {
  it('bate com os valores tabelados', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 4);
    expect(normalCdf(2.576)).toBeCloseTo(0.995, 4);
  });
});

describe('twoProportionZTest', () => {
  it('reconhece uma diferença grande em amostra grande', () => {
    // 40 % contra 50 % em 1 000 por braço: p bem abaixo de 0,05.
    const test = twoProportionZTest(400, 1000, 500, 1000)!;
    expect(test.pValue).toBeLessThan(0.001);
    expect(test.z).toBeGreaterThan(0);
  });

  it('não vê diferença onde ela é ruído', () => {
    // A MESMA diferença de 10 pontos, com 20 por braço, é indistinguível
    // de acaso — é exatamente o caso que o piso da §6.6 protege.
    const test = twoProportionZTest(8, 20, 10, 20)!;
    expect(test.pValue).toBeGreaterThan(0.05);
  });

  it('devolve null sem dados ou sem variância', () => {
    expect(twoProportionZTest(0, 0, 0, 0)).toBeNull();
    // Os dois braços em 0 %: variância agrupada zero, nada a testar.
    expect(twoProportionZTest(0, 100, 0, 100)).toBeNull();
  });
});

function stats(
  sent: number,
  delivered: number,
  read: number,
  replied: number
): VariantStats {
  return { sent, delivered, read, replied };
}

describe('compareMetric', () => {
  it('usa `sent` como denominador, não o total de destinatários', () => {
    // Um número inválido nunca recebeu mensagem: contá-lo puniria o
    // braço que herdou mais números ruins do sorteio.
    const c = compareMetric(
      stats(100, 90, 50, 5),
      stats(100, 90, 60, 5),
      'read'
    );
    expect(c.rateA).toBeCloseTo(0.5);
    expect(c.rateB).toBeCloseTo(0.6);
    expect(c.diffPoints).toBeCloseTo(10);
    expect(c.lift).toBeCloseTo(0.2);
  });

  it('não declara significância abaixo do piso, por maior que seja a diferença', () => {
    const arm = AB_MIN_ARM_FOR_SIGNIFICANCE - 1;
    const c = compareMetric(
      stats(arm, arm, Math.round(arm * 0.2), 0),
      stats(arm, arm, Math.round(arm * 0.6), 0),
      'read'
    );
    expect(c.pValue).toBeLessThan(0.001);
    expect(c.significant).toBe(false);
  });

  it('declara significância acima do piso', () => {
    const arm = AB_MIN_ARM_FOR_SIGNIFICANCE;
    const c = compareMetric(
      stats(arm, arm, Math.round(arm * 0.3), 0),
      stats(arm, arm, Math.round(arm * 0.5), 0),
      'read'
    );
    expect(c.significant).toBe(true);
  });

  it('devolve lift nulo quando a taxa de A é zero', () => {
    const c = compareMetric(
      stats(100, 0, 0, 0),
      stats(100, 10, 0, 0),
      'delivered'
    );
    expect(c.lift).toBeNull();
    expect(c.diffPoints).toBeCloseTo(10);
  });
});

describe('summarizeAbTest', () => {
  it('não nomeia vencedor em amostra pequena', () => {
    const summary = summarizeAbTest(stats(40, 40, 5, 1), stats(40, 40, 12, 3));
    expect(summary.smallSample).toBe(true);
    expect(summary.winner).toBeNull();
    expect(summary.smallestArm).toBe(40);
  });

  it('nomeia o braço vencedor pela taxa de leitura', () => {
    const summary = summarizeAbTest(
      stats(1000, 980, 300, 40),
      stats(1000, 975, 450, 45)
    );
    expect(summary.winner).toBe('B');
    expect(summary.smallSample).toBe(false);
  });

  it('não nomeia vencedor quando a diferença não é significativa', () => {
    const summary = summarizeAbTest(
      stats(400, 395, 200, 20),
      stats(400, 396, 205, 21)
    );
    expect(summary.smallSample).toBe(false);
    expect(summary.winner).toBeNull();
  });

  it('reporta as três métricas do funil, na ordem', () => {
    const summary = summarizeAbTest(stats(10, 9, 5, 1), stats(10, 8, 4, 2));
    expect(summary.metrics.map((m) => m.metric)).toEqual([
      'delivered',
      'read',
      'replied',
    ]);
  });
});
