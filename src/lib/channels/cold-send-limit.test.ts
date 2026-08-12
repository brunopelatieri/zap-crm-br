import { describe, it, expect } from 'vitest';

import {
  COLD_SEND_DEFAULTS,
  readColdSendLimits,
  isColdSend,
  effectiveDailyLimit,
  evaluateColdSend,
  describeDenial,
  type ColdSendLimits,
  type ColdSendUsage,
} from './cold-send-limit';

const NOW = new Date('2026-08-12T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

const limits: ColdSendLimits = {
  silenceHours: 24,
  perHour: 12,
  perDay: 60,
  minIntervalSeconds: 45,
  warmupDays: 0, // desligado por padrão nos testes de cota
};

function usage(over: Partial<ColdSendUsage> = {}): ColdSendUsage {
  return {
    last24h: 0,
    lastHour: 0,
    lastColdSendAt: null,
    instanceCreatedAt: daysAgo(90),
    ...over,
  };
}

describe('readColdSendLimits', () => {
  it('sem env, usa os padrões conservadores', () => {
    expect(readColdSendLimits({})).toEqual(COLD_SEND_DEFAULTS);
  });

  it('lê valores válidos do ambiente', () => {
    expect(
      readColdSendLimits({
        EVOLUTION_COLD_SEND_PER_DAY: '30',
        EVOLUTION_COLD_SEND_PER_HOUR: '5',
        EVOLUTION_COLD_SEND_MIN_INTERVAL_SECONDS: '90',
        EVOLUTION_COLD_SEND_SILENCE_HOURS: '48',
        EVOLUTION_COLD_SEND_WARMUP_DAYS: '7',
      })
    ).toEqual({
      perDay: 30,
      perHour: 5,
      minIntervalSeconds: 90,
      silenceHours: 48,
      warmupDays: 7,
    });
  });

  it.each(['abc', '-1', '3.5', ''])(
    'valor inválido (%s) cai no padrão em vez de virar "sem limite"',
    (raw) => {
      expect(
        readColdSendLimits({ EVOLUTION_COLD_SEND_PER_DAY: raw }).perDay
      ).toBe(COLD_SEND_DEFAULTS.perDay);
    }
  );

  it('zero é aceito e significa bloquear todo envio frio', () => {
    expect(
      readColdSendLimits({ EVOLUTION_COLD_SEND_PER_DAY: '0' }).perDay
    ).toBe(0);
  });

  it('silenceHours nunca aceita zero — tudo viraria envio frio', () => {
    expect(
      readColdSendLimits({ EVOLUTION_COLD_SEND_SILENCE_HOURS: '0' })
        .silenceHours
    ).toBe(COLD_SEND_DEFAULTS.silenceHours);
  });
});

describe('isColdSend', () => {
  it('contato que nunca escreveu é o caso mais frio', () => {
    expect(isColdSend(null, limits, NOW)).toBe(true);
  });

  it('conversa viva não consome cota', () => {
    expect(isColdSend(hoursAgo(3), limits, NOW)).toBe(false);
  });

  it('silêncio além do limiar conta como frio', () => {
    expect(isColdSend(hoursAgo(25), limits, NOW)).toBe(true);
  });

  it('exatamente no limiar já é frio (fechamento inclusivo)', () => {
    expect(isColdSend(hoursAgo(24), limits, NOW)).toBe(true);
  });
});

describe('effectiveDailyLimit — aquecimento', () => {
  it('sem aquecimento configurado, vale o teto cheio', () => {
    expect(effectiveDailyLimit(limits, daysAgo(0), NOW)).toBe(60);
  });

  it('instância nova começa baixo e cresce', () => {
    const l = { ...limits, warmupDays: 10 };
    expect(effectiveDailyLimit(l, daysAgo(0), NOW)).toBe(6);
    expect(effectiveDailyLimit(l, daysAgo(4), NOW)).toBe(30);
    expect(effectiveDailyLimit(l, daysAgo(9), NOW)).toBe(60);
  });

  it('depois do aquecimento, teto cheio', () => {
    expect(
      effectiveDailyLimit({ ...limits, warmupDays: 10 }, daysAgo(30), NOW)
    ).toBe(60);
  });

  it('o piso do aquecimento nunca ultrapassa o teto configurado', () => {
    const l = { ...limits, perDay: 3, warmupDays: 14 };
    expect(effectiveDailyLimit(l, daysAgo(0), NOW)).toBe(3);
  });

  it('teto zero continua zero durante o aquecimento', () => {
    expect(
      effectiveDailyLimit(
        { ...limits, perDay: 0, warmupDays: 14 },
        daysAgo(0),
        NOW
      )
    ).toBe(0);
  });
});

describe('evaluateColdSend', () => {
  it('libera quando há folga nos três eixos', () => {
    const d = evaluateColdSend(limits, usage(), NOW);
    expect(d.allowed).toBe(true);
    expect(d.remainingToday).toBe(60);
    expect(d.remainingThisHour).toBe(12);
    expect(d.warmingUp).toBe(false);
  });

  it('bloqueia no teto diário', () => {
    const d = evaluateColdSend(limits, usage({ last24h: 60 }), NOW);
    expect(d).toMatchObject({ allowed: false, reason: 'daily_limit' });
    expect(d.remainingToday).toBe(0);
  });

  it('bloqueia a rajada mesmo com o dia sobrando', () => {
    // O cenário que o teto diário sozinho não pega: 12 mensagens em
    // poucos minutos, com 48 de cota diária ainda livre.
    const d = evaluateColdSend(
      limits,
      usage({ last24h: 12, lastHour: 12 }),
      NOW
    );
    expect(d).toMatchObject({ allowed: false, reason: 'hourly_limit' });
    expect(d.remainingToday).toBe(48);
  });

  it('bloqueia envios colados, com retryAfter em segundos', () => {
    const d = evaluateColdSend(
      limits,
      usage({ lastColdSendAt: new Date(NOW.getTime() - 10_000) }),
      NOW
    );
    expect(d).toMatchObject({ allowed: false, reason: 'min_interval' });
    expect(d.retryAfterSeconds).toBe(35);
  });

  it('libera assim que o intervalo mínimo passa', () => {
    const d = evaluateColdSend(
      limits,
      usage({ lastColdSendAt: new Date(NOW.getTime() - 45_000) }),
      NOW
    );
    expect(d.allowed).toBe(true);
  });

  it('reporta a restrição MAIS longa primeiro', () => {
    // Os três estourados de uma vez: quem chama precisa saber que a
    // espera é de horas, não de 45 segundos.
    const d = evaluateColdSend(
      limits,
      usage({
        last24h: 60,
        lastHour: 12,
        lastColdSendAt: new Date(NOW.getTime() - 1000),
      }),
      NOW
    );
    expect(d.reason).toBe('daily_limit');
    expect(d.retryAfterSeconds).toBe(3600);
  });

  it('teto zero bloqueia todo envio frio', () => {
    const d = evaluateColdSend({ ...limits, perDay: 0 }, usage(), NOW);
    expect(d).toMatchObject({ allowed: false, reason: 'daily_limit' });
  });

  it('instância em aquecimento reporta o teto reduzido, não o configurado', () => {
    const d = evaluateColdSend(
      { ...limits, warmupDays: 10 },
      usage({ instanceCreatedAt: daysAgo(0) }),
      NOW
    );
    expect(d.dailyLimit).toBe(6);
    expect(d.warmingUp).toBe(true);
  });
});

describe('describeDenial', () => {
  it('menciona o aquecimento quando ele é a causa do teto baixo', () => {
    const d = evaluateColdSend(
      { ...limits, warmupDays: 10 },
      usage({ instanceCreatedAt: daysAgo(0), last24h: 6 }),
      NOW
    );
    expect(describeDenial(d)).toContain('warming up');
  });

  it('descreve o intervalo mínimo com o tempo de espera', () => {
    const d = evaluateColdSend(
      limits,
      usage({ lastColdSendAt: new Date(NOW.getTime() - 10_000) }),
      NOW
    );
    expect(describeDenial(d)).toContain('35s');
  });
});
