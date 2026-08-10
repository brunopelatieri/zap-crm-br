import { describe, expect, it } from 'vitest';

import {
  INTERVAL_HOUR_OPTIONS,
  INTERVAL_MINUTE_OPTIONS,
  MIN_INTERVAL_MINUTES,
  type ScheduleState,
  cronMatches,
  describeSchedule,
  firesAtLeastOnce,
  nextOccurrences,
  parseSchedule,
  scheduleCoverage,
  scheduleToCron,
  validateSchedule,
} from './schedule';

// ------------------------------------------------------------
// Invariante 1 — round-trip sobre os modos restritos (§4.3)
// ------------------------------------------------------------

describe('round-trip (parseSchedule ∘ scheduleToCron)', () => {
  it('interval — todos os intervalos permitidos', () => {
    for (const every of INTERVAL_MINUTE_OPTIONS) {
      const s: ScheduleState = { mode: 'interval', unit: 'minute', every };
      expect(parseSchedule(scheduleToCron(s))).toEqual(s);
    }
    for (const every of INTERVAL_HOUR_OPTIONS) {
      const s: ScheduleState = { mode: 'interval', unit: 'hour', every };
      expect(parseSchedule(scheduleToCron(s))).toEqual(s);
    }
  });

  it('daily — bordas de horário', () => {
    for (const [hour, minute] of [
      [0, 0],
      [9, 30],
      [23, 59],
    ] as const) {
      const s: ScheduleState = { mode: 'daily', hour, minute };
      expect(parseSchedule(scheduleToCron(s))).toEqual(s);
    }
  });

  it('weekly — um dia, vários dias, todos os dias', () => {
    const cases: ScheduleState[] = [
      { mode: 'weekly', hour: 9, minute: 0, weekdays: [1] },
      { mode: 'weekly', hour: 9, minute: 30, weekdays: [1, 3] },
      { mode: 'weekly', hour: 9, minute: 0, weekdays: [0, 1, 2, 3, 4, 5, 6] },
    ];
    for (const s of cases) {
      expect(parseSchedule(scheduleToCron(s))).toEqual(s);
    }
  });

  it('monthly — dia 1, dia do meio, dia 31', () => {
    for (const day of [1, 15, 31]) {
      const s: ScheduleState = {
        mode: 'monthly',
        hour: 9,
        minute: 0,
        monthDays: [day],
      };
      expect(parseSchedule(scheduleToCron(s))).toEqual(s);
    }
  });
});

// ------------------------------------------------------------
// Invariante 2 — preservação byte a byte do que não cabe num preset
// ------------------------------------------------------------

describe('preservação (crons fora do modelo restrito)', () => {
  const cases = ['0 9 * * 1-5', '15,45 * * * *', '0 0 1 1,7 *', '0 8 * * 1#2'];

  it.each(cases)(
    'parseSchedule(%s) → advanced, scheduleToCron devolve idêntico',
    (cron) => {
      const parsed = parseSchedule(cron);
      expect(parsed).toEqual({ mode: 'advanced', raw: cron });
      expect(scheduleToCron(parsed)).toBe(cron);
    }
  );

  it('gramática não suportada fica inválida, mas o valor não é apagado', () => {
    const parsed = parseSchedule('0 8 * * 1#2');
    expect(parsed.mode).toBe('advanced');
    expect(validateSchedule((parsed as { raw: string }).raw)).not.toBeNull();
    expect(scheduleToCron(parsed)).toBe('0 8 * * 1#2');
  });
});

// ------------------------------------------------------------
// Invariante 3 — totalidade de parseSchedule
// ------------------------------------------------------------

describe('parseSchedule nunca lança', () => {
  const inputs = [
    '',
    'abc',
    '* * *',
    '   ',
    'x'.repeat(10_000),
    '0 9 * * *  extra',
  ];

  it.each(inputs)('não lança para %j', (input) => {
    expect(() => parseSchedule(input)).not.toThrow();
  });

  it('trata undefined/null coagido como string vazia', () => {
    expect(() => parseSchedule(null as unknown as string)).not.toThrow();
    expect(() => parseSchedule(undefined as unknown as string)).not.toThrow();
  });
});

// ------------------------------------------------------------
// Invariante 4 — fuso horário
// ------------------------------------------------------------

describe('cronMatches respeita o fuso', () => {
  it('09:00 em São Paulo (UTC-3) é 12:00 UTC', () => {
    const noon = new Date('2026-08-10T12:00:00Z');
    const nineUtc = new Date('2026-08-10T09:00:00Z');
    expect(cronMatches('0 9 * * *', noon, 'America/Sao_Paulo')).toBe(true);
    expect(cronMatches('0 9 * * *', nineUtc, 'America/Sao_Paulo')).toBe(false);
  });

  it('atravessa a virada de DST em America/New_York', () => {
    // 2026-03-08: relógios avançam 1h às 02:00 → 03:00 (spring forward).
    // 07:00 local antes da virada = 12:00 UTC; depois da virada, 07:00
    // local = 11:00 UTC (o deslocamento mudou de -5 para -4).
    const beforeDst = new Date('2026-03-07T12:00:00Z');
    const afterDst = new Date('2026-03-09T11:00:00Z');
    expect(cronMatches('0 7 * * *', beforeDst, 'America/New_York')).toBe(true);
    expect(cronMatches('0 7 * * *', afterDst, 'America/New_York')).toBe(true);
  });
});

// ------------------------------------------------------------
// Invariante 5 — piso de 15 minutos
// ------------------------------------------------------------

describe('validateSchedule — piso de granularidade', () => {
  it.each(['* * * * *', '*/1 * * * *', '*/5 * * * *', '*/14 * * * *'])(
    'rejeita %s',
    (cron) => {
      expect(validateSchedule(cron)).not.toBeNull();
    }
  );

  it(`aceita */${MIN_INTERVAL_MINUTES} * * * *`, () => {
    expect(validateSchedule(`*/${MIN_INTERVAL_MINUTES} * * * *`)).toBeNull();
  });

  it('um disparo por hora não viola o piso, mesmo com hora irrestrita', () => {
    expect(validateSchedule('0 * * * *')).toBeNull();
  });
});

describe('validateSchedule — sintaxe', () => {
  it('exige 5 campos', () => {
    expect(validateSchedule('* * *')).not.toBeNull();
  });

  it('rejeita campo com sintaxe não suportada', () => {
    expect(validateSchedule('0 8 * * 1#2')).not.toBeNull();
    expect(validateSchedule('0 8 * MON *')).not.toBeNull();
  });

  it('aceita listas e faixas dentro dos limites de cada campo', () => {
    expect(validateSchedule('0 9 * * 1-5')).toBeNull();
    expect(validateSchedule('15,45 9 * * *')).toBeNull();
  });
});

// ------------------------------------------------------------
// cronMatches — regra OU entre dia-do-mês e dia-da-semana
// ------------------------------------------------------------

describe('cronMatches — dia-do-mês × dia-da-semana restritos', () => {
  it('casa quando QUALQUER um dos dois bate (OU, não E)', () => {
    // "0 9 1 * 1": dia 1 do mês OU segunda-feira, às 9h.
    // 2026-08-10 é segunda-feira, mas não é dia 1 — deve casar pelo OU.
    const monday10th = new Date('2026-08-10T12:00:00Z'); // 09:00 em UTC-3
    expect(cronMatches('0 9 1 * 1', monday10th, 'America/Sao_Paulo')).toBe(
      true
    );
    // 2026-08-05 é dia 1... não, ajuste: usar um dia que não é nem dia 1
    // nem segunda para confirmar que o OU também exclui corretamente.
    const tuesday4th = new Date('2026-08-04T12:00:00Z');
    expect(cronMatches('0 9 1 * 1', tuesday4th, 'America/Sao_Paulo')).toBe(
      false
    );
  });
});

// ------------------------------------------------------------
// nextOccurrences
// ------------------------------------------------------------

describe('nextOccurrences', () => {
  it('acha 29 de fevereiro dentro do teto de busca (ano bissexto próximo)', () => {
    const from = new Date('2028-01-01T00:00:00Z'); // 2028 é bissexto
    const occ = nextOccurrences('0 0 29 2 *', 'UTC', 1, from);
    expect(occ).toHaveLength(1);
    expect(occ[0].getUTCMonth()).toBe(1); // fevereiro (0-indexado)
    expect(occ[0].getUTCDate()).toBe(29);
  });

  it('30 de fevereiro nunca existe — devolve vazio, não trava', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const occ = nextOccurrences('0 0 30 2 *', 'UTC', 3, from);
    expect(occ).toEqual([]);
  });

  it('devolve occurrences em ordem cronológica ascendente', () => {
    const from = new Date('2026-08-10T00:00:00Z');
    const occ = nextOccurrences('0 9 * * *', 'America/Sao_Paulo', 3, from);
    expect(occ).toHaveLength(3);
    expect(occ[0].getTime()).toBeLessThan(occ[1].getTime());
    expect(occ[1].getTime()).toBeLessThan(occ[2].getTime());
  });

  it('cron inválido devolve lista vazia sem lançar', () => {
    expect(nextOccurrences('not a cron', 'UTC', 3)).toEqual([]);
  });
});

// ------------------------------------------------------------
// describeSchedule
// ------------------------------------------------------------

function fakeT(
  key: string,
  values?: Record<string, string | number | Date>
): string {
  return values ? `${key}(${JSON.stringify(values)})` : key;
}

describe('describeSchedule', () => {
  it('reconhece dias úteis, fim de semana e todos os dias como casos especiais', () => {
    const weekday: ScheduleState = {
      mode: 'weekly',
      hour: 9,
      minute: 0,
      weekdays: [1, 2, 3, 4, 5],
    };
    const weekend: ScheduleState = {
      mode: 'weekly',
      hour: 9,
      minute: 0,
      weekdays: [0, 6],
    };
    const allDays: ScheduleState = {
      mode: 'weekly',
      hour: 9,
      minute: 0,
      weekdays: [0, 1, 2, 3, 4, 5, 6],
    };
    expect(describeSchedule(weekday, fakeT)).toContain(
      'scheduleBuilder.summary.weekday'
    );
    expect(describeSchedule(weekend, fakeT)).toContain(
      'scheduleBuilder.summary.weekend'
    );
    expect(describeSchedule(allDays, fakeT)).toContain(
      'scheduleBuilder.summary.allDays'
    );
  });

  it('modo avançado que casa com um preset descreve o preset', () => {
    const advanced: ScheduleState = { mode: 'advanced', raw: '0 9 * * *' };
    expect(describeSchedule(advanced, fakeT)).toContain(
      'scheduleBuilder.summary.daily'
    );
  });

  it('modo avançado com gramática inválida usa a variante de erro', () => {
    const advanced: ScheduleState = { mode: 'advanced', raw: '0 8 * * 1#2' };
    expect(describeSchedule(advanced, fakeT)).toContain(
      'scheduleBuilder.summary.customInvalid'
    );
  });
});

// ------------------------------------------------------------
// Janela de horário permitido (revisão da SPEC 046, achado nº 1)
//
// SEND_WINDOW é dias úteis, 09:00–20:00. Antes desta revisão a
// pré-visualização ignorava isso: um agendamento de sábado listava a
// próxima data concreta na tela e nunca disparava.
// ------------------------------------------------------------

describe('nextOccurrences com deliverableOnly', () => {
  // Segunda-feira, 00:00 UTC.
  const MONDAY = new Date('2026-08-10T00:00:00Z');

  it('pula fins de semana num agendamento diário', () => {
    const occ = nextOccurrences('0 12 * * *', 'UTC', 7, MONDAY, {
      deliverableOnly: true,
    });
    // Nenhum sábado (6) nem domingo (0) na lista.
    const weekdays = occ.map((d) => d.getUTCDay());
    expect(weekdays).not.toContain(0);
    expect(weekdays).not.toContain(6);
  });

  it('devolve vazio para um agendamento inteiramente fora da janela', () => {
    // Todo sábado às 10h — dia bloqueado.
    expect(
      nextOccurrences('0 10 * * 6', 'UTC', 3, MONDAY, { deliverableOnly: true })
    ).toEqual([]);
    // Todo dia às 22h — hora bloqueada.
    expect(
      nextOccurrences('0 22 * * *', 'UTC', 3, MONDAY, { deliverableOnly: true })
    ).toEqual([]);
  });

  it('sem a opção, as mesmas ocorrências aparecem (comportamento cru)', () => {
    expect(nextOccurrences('0 10 * * 6', 'UTC', 3, MONDAY)).toHaveLength(3);
  });
});

describe('scheduleCoverage', () => {
  const MONDAY = new Date('2026-08-10T00:00:00Z');

  it('marca neverFires quando a janela engole todas as ocorrências', () => {
    const saturday = scheduleCoverage('0 10 * * 6', 'UTC', 2, MONDAY);
    expect(saturday.neverFires).toBe(true);
    expect(saturday.deliverable).toEqual([]);

    const lateNight = scheduleCoverage('0 22 * * *', 'UTC', 2, MONDAY);
    expect(lateNight.neverFires).toBe(true);
  });

  it('marca someBlocked num diário (fins de semana caem)', () => {
    const daily = scheduleCoverage('0 12 * * *', 'UTC', 2, MONDAY);
    expect(daily.neverFires).toBe(false);
    expect(daily.someBlocked).toBe(true);
    expect(daily.deliverable).toHaveLength(2);
  });

  it('não marca nada num agendamento inteiramente dentro da janela', () => {
    const weekdaysOnly = scheduleCoverage('0 12 * * 1-5', 'UTC', 2, MONDAY);
    expect(weekdaysOnly.neverFires).toBe(false);
    expect(weekdaysOnly.someBlocked).toBe(false);
  });

  it('marca someBlocked num intervalo curto (a noite cai)', () => {
    // A amostra de 64 ocorrências a cada 15 min cobre 16h — cruza as 20h.
    const quarterly = scheduleCoverage('*/15 * * * *', 'UTC', 2, MONDAY);
    expect(quarterly.someBlocked).toBe(true);
    expect(quarterly.neverFires).toBe(false);
  });
});

describe('firesAtLeastOnce', () => {
  const MONDAY = new Date('2026-08-10T00:00:00Z');

  it('false para agendamento inerte, true para agendamento útil', () => {
    expect(firesAtLeastOnce('0 10 * * 6', 'UTC', MONDAY)).toBe(false);
    expect(firesAtLeastOnce('0 22 * * *', 'UTC', MONDAY)).toBe(false);
    expect(firesAtLeastOnce('0 12 * * 1-5', 'UTC', MONDAY)).toBe(true);
  });
});
