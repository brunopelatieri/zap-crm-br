/**
 * Modelo de agendamento do gatilho `time_based` (SPEC 046 §4).
 *
 * Módulo deliberadamente PURO — sem cliente de banco, sem React. Mesmo
 * motivo de `window-trigger.ts`: é importado por três lados que não
 * podem se importar entre si — o construtor visual no navegador
 * (`visual-cron-builder.tsx`), a validação de ativação (`validate.ts`)
 * e a varredura server-side (`schedule-scan.ts`).
 *
 * O formato ARMAZENADO não muda: `trigger_config.schedule` continua
 * sendo uma string cron de 5 campos. Os cinco `ScheduleMode` abaixo são
 * projeções de conveniência sobre esse formato, não um formato novo —
 * é o que mantém compatibilidade com toda automação já salva.
 *
 * Piso de 15 minutos: o cron do agendador (`supabase/setup/cron-jobs.sql`)
 * pinga a cada 5 minutos. Um agendamento com menos de 15 minutos de
 * intervalo — 3 ticks — dispara "às vezes" sem o autor descobrir por
 * quê, o mesmo raciocínio (e o mesmo número) do piso de `margin_minutes`
 * em `window-trigger.ts`.
 */

import {
  isWithinSendWindow,
  zonedParts,
  zonedWallTimeToUtc,
  type Weekday,
} from '@/lib/broadcasts/send-window';

// ------------------------------------------------------------
// Estado visual
// ------------------------------------------------------------

export type ScheduleMode =
  'interval' | 'daily' | 'weekly' | 'monthly' | 'advanced';

export type ScheduleState =
  | { mode: 'interval'; unit: 'minute' | 'hour'; every: number }
  | { mode: 'daily'; hour: number; minute: number }
  | { mode: 'weekly'; hour: number; minute: number; weekdays: Weekday[] }
  | { mode: 'monthly'; hour: number; minute: number; monthDays: number[] }
  | { mode: 'advanced'; raw: string };

/** Só os intervalos que sobrevivem ao piso de 15 min (§3.3). */
export const INTERVAL_MINUTE_OPTIONS = [15, 30] as const;
export const INTERVAL_HOUR_OPTIONS = [1, 2, 3, 4, 6, 8, 12] as const;

export const INTERVAL_OPTIONS: {
  unit: 'minute' | 'hour';
  every: number;
  i18nKey: string;
}[] = [
  ...INTERVAL_MINUTE_OPTIONS.map((every) => ({
    unit: 'minute' as const,
    every,
    i18nKey: `min${every}`,
  })),
  ...INTERVAL_HOUR_OPTIONS.map((every) => ({
    unit: 'hour' as const,
    every,
    i18nKey: `hour${every}`,
  })),
];

/** Piso prático: 3 ticks do cron de 5 min tolera duas execuções perdidas. */
export const MIN_INTERVAL_MINUTES = 15;

// ------------------------------------------------------------
// Serialização (ScheduleState → cron)
// ------------------------------------------------------------

export function scheduleToCron(state: ScheduleState): string {
  switch (state.mode) {
    case 'interval':
      return state.unit === 'minute'
        ? `*/${state.every} * * * *`
        : `0 */${state.every} * * *`;
    case 'daily':
      return `${state.minute} ${state.hour} * * *`;
    case 'weekly': {
      const days = [...new Set(state.weekdays)].sort((a, b) => a - b);
      const dowField = days.length > 0 ? days.join(',') : '*';
      return `${state.minute} ${state.hour} * * ${dowField}`;
    }
    case 'monthly': {
      const days = [...new Set(state.monthDays)].sort((a, b) => a - b);
      const domField = days.length > 0 ? days.join(',') : '*';
      return `${state.minute} ${state.hour} ${domField} * *`;
    }
    case 'advanced':
      return state.raw;
  }
}

// ------------------------------------------------------------
// Interpretação (cron → ScheduleState) — nunca lança
// ------------------------------------------------------------

/** Legado: o placeholder atual promete "Expressão cron ou HH:mm". */
const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/**
 * Interpreta uma string cron (ou HH:mm legado) no melhor preset
 * possível. O que não couber num dos quatro presets volta como
 * `{ mode: 'advanced', raw }` — **preservado byte a byte**, nunca
 * reescrito. Esse é o invariante que impede o pior desfecho desta
 * SPEC: uma automação configurada por alguém que sabia o que estava
 * fazendo sendo silenciosamente normalizada por um dropdown.
 */
export function parseSchedule(rawInput: string): ScheduleState {
  const raw = (rawInput ?? '').trim();
  if (raw === '') return { mode: 'daily', hour: 9, minute: 0 };

  const hhmm = HHMM_RE.exec(raw);
  if (hhmm) {
    return { mode: 'daily', hour: Number(hhmm[1]), minute: Number(hhmm[2]) };
  }

  const fields = raw.split(/\s+/);
  if (fields.length !== 5) return { mode: 'advanced', raw };
  const [minF, hourF, domF, monF, dowF] = fields;

  // interval — passo em minutos: */15, */30 (hora e resto irrestritos)
  const minuteStep = /^\*\/(\d+)$/.exec(minF);
  if (
    minuteStep &&
    hourF === '*' &&
    domF === '*' &&
    monF === '*' &&
    dowF === '*' &&
    (INTERVAL_MINUTE_OPTIONS as readonly number[]).includes(
      Number(minuteStep[1])
    )
  ) {
    return { mode: 'interval', unit: 'minute', every: Number(minuteStep[1]) };
  }

  // interval — passo em horas: minuto fixo em 0, resto irrestrito
  const hourStep = /^\*\/(\d+)$/.exec(hourF);
  if (
    minF === '0' &&
    hourStep &&
    domF === '*' &&
    monF === '*' &&
    dowF === '*' &&
    (INTERVAL_HOUR_OPTIONS as readonly number[]).includes(Number(hourStep[1]))
  ) {
    return { mode: 'interval', unit: 'hour', every: Number(hourStep[1]) };
  }

  const plainMinute = /^(\d{1,2})$/.exec(minF);
  const plainHour = /^(\d{1,2})$/.exec(hourF);
  const minuteOk = !!plainMinute && Number(plainMinute[1]) <= 59;
  const hourOk = !!plainHour && Number(plainHour[1]) <= 23;

  // daily / weekly — minuto e hora fixos, dia-do-mês e mês irrestritos
  if (minuteOk && hourOk && domF === '*' && monF === '*') {
    const minute = Number(plainMinute![1]);
    const hour = Number(plainHour![1]);

    if (dowF === '*') {
      return { mode: 'daily', hour, minute };
    }

    // Só dígitos separados por vírgula — uma faixa ("1-5") ou qualquer
    // outra sintaxe cai fora daqui de propósito, para não absorver (e
    // reescrever) um cron como `0 9 * * 1-5` num preset semanal.
    if (/^\d(,\d)*$/.test(dowF)) {
      const weekdays = normalizeWeekdays(dowF.split(',').map(Number));
      if (weekdays && weekdays.length > 0) {
        return { mode: 'weekly', hour, minute, weekdays };
      }
    }
  }

  // monthly — minuto e hora fixos, mês e dia-da-semana irrestritos
  if (minuteOk && hourOk && monF === '*' && dowF === '*') {
    if (/^([12]?\d|3[01])(,([12]?\d|3[01]))*$/.test(domF)) {
      const days = domF.split(',').map(Number);
      if (days.every((d) => d >= 1 && d <= 31)) {
        return {
          mode: 'monthly',
          hour: Number(plainHour![1]),
          minute: Number(plainMinute![1]),
          monthDays: [...new Set(days)].sort((a, b) => a - b),
        };
      }
    }
  }

  return { mode: 'advanced', raw };
}

function normalizeWeekdays(values: number[]): Weekday[] | null {
  const set = new Set<Weekday>();
  for (const v of values) {
    if (v === 7) set.add(0);
    else if (v >= 0 && v <= 6) set.add(v as Weekday);
    else return null;
  }
  return [...set].sort((a, b) => a - b);
}

// ------------------------------------------------------------
// Validação — a mesma porta para a UI e para validate.ts
// ------------------------------------------------------------

/**
 * `null` quando o cron é sintaticamente suportado e respeita o piso de
 * 15 minutos; senão uma mensagem de diagnóstico (inglês, no padrão das
 * demais mensagens de `validate.ts`).
 */
export function validateSchedule(cron: string): string | null {
  const raw = (cron ?? '').trim();
  if (!raw) return 'schedule is required';

  const fields = raw.split(/\s+/);
  if (fields.length !== 5) {
    return 'cron expression must have exactly 5 space-separated fields (minute hour day-of-month month day-of-week)';
  }
  const [minF, hourF, domF, monF, dowF] = fields;

  const minute = parseField(minF, 0, 59);
  if (!minute) return `unsupported syntax in the minute field: "${minF}"`;
  const hour = parseField(hourF, 0, 23);
  if (!hour) return `unsupported syntax in the hour field: "${hourF}"`;
  const dom = parseField(domF, 1, 31);
  if (!dom) return `unsupported syntax in the day-of-month field: "${domF}"`;
  const mon = parseField(monF, 1, 12);
  if (!mon) return `unsupported syntax in the month field: "${monF}"`;
  const dow = parseWeekdayField(dowF);
  if (!dow) return `unsupported syntax in the day-of-week field: "${dowF}"`;

  if (minGapMinutes(minute) < MIN_INTERVAL_MINUTES) {
    return `schedule interval below ${MIN_INTERVAL_MINUTES} minutes is not supported — the automation cron tick runs every 5 minutes and cannot reliably hit a shorter interval`;
  }
  return null;
}

/** Menor intervalo, em minutos, entre disparos consecutivos dentro de
 *  uma hora — incluindo o "salto" da virada (ex.: `\*\/14` volta a
 *  disparar 4 min depois da hora seguinte começar, não 14). */
function minGapMinutes(minuteField: FieldMatcher): number {
  if (!minuteField.restricted) return 1; // '*' — todo minuto
  const matched: number[] = [];
  for (let m = 0; m < 60; m++) {
    if (minuteField.test(m)) matched.push(m);
  }
  if (matched.length <= 1) return Infinity;
  let gap = matched[0] + 60 - matched[matched.length - 1];
  for (let i = 1; i < matched.length; i++) {
    gap = Math.min(gap, matched[i] - matched[i - 1]);
  }
  return gap;
}

// ------------------------------------------------------------
// Avaliador — usado pelo runtime E pela pré-visualização
// ------------------------------------------------------------

interface FieldMatcher {
  test: (n: number) => boolean;
  /** `false` só para `*` — é o que decide a regra OU entre dia-do-mês
   *  e dia-da-semana quando os dois são restritos. */
  restricted: boolean;
}

function parseField(
  raw: string,
  min: number,
  max: number
): FieldMatcher | null {
  const trimmed = raw.trim();
  if (trimmed === '*') return { test: () => true, restricted: false };

  const step = /^\*\/(\d+)$/.exec(trimmed);
  if (step) {
    const n = Number(step[1]);
    if (!Number.isInteger(n) || n <= 0) return null;
    return { test: (v) => (v - min) % n === 0, restricted: true };
  }

  const parts = trimmed.split(',');
  if (parts.length === 0 || parts.some((p) => p === '')) return null;

  const values = new Set<number>();
  for (const part of parts) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (a > b || a < min || b > max) return null;
      for (let v = a; v <= b; v++) values.add(v);
      continue;
    }
    const single = /^(\d+)$/.exec(part);
    if (!single) return null; // nomes (MON/JAN), L/W/#/? — não suportados
    const v = Number(single[1]);
    if (v < min || v > max) return null;
    values.add(v);
  }
  if (values.size === 0) return null;
  return { test: (v) => values.has(v), restricted: true };
}

/** Dia-da-semana: cron aceita 0 e 7 como domingo; `zonedParts` só conhece 0-6. */
function parseWeekdayField(raw: string): FieldMatcher | null {
  const parsed = parseField(raw, 0, 7);
  if (!parsed) return null;
  return {
    restricted: parsed.restricted,
    test: (n: number) => parsed.test(n) || (n === 0 && parsed.test(7)),
  };
}

function compileCronFields(cron: string): {
  minute: FieldMatcher;
  hour: FieldMatcher;
  dom: FieldMatcher;
  mon: FieldMatcher;
  dow: FieldMatcher;
} | null {
  const fields = (cron ?? '').trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minF, hourF, domF, monF, dowF] = fields;
  const minute = parseField(minF, 0, 59);
  const hour = parseField(hourF, 0, 23);
  const dom = parseField(domF, 1, 31);
  const mon = parseField(monF, 1, 12);
  const dow = parseWeekdayField(dowF);
  if (!minute || !hour || !dom || !mon || !dow) return null;
  return { minute, hour, dom, mon, dow };
}

/**
 * `true` se `date` (avaliado no fuso `timeZone`) é um instante que este
 * cron dispara. Regra clássica de cron para dia-do-mês × dia-da-semana:
 * quando os dois são restritos, casa quem satisfizer QUALQUER um dos
 * dois (OU, não E) — o modelo restrito de `parseSchedule` nunca produz
 * esse caso, mas um cron do modo avançado pode.
 */
export function cronMatches(
  cron: string,
  date: Date,
  timeZone: string
): boolean {
  const compiled = compileCronFields(cron);
  if (!compiled) return false;
  const { minute, hour, dom, mon, dow } = compiled;

  const p = zonedParts(date, timeZone);
  if (!minute.test(p.minute)) return false;
  if (!hour.test(p.hour)) return false;
  if (!mon.test(p.month)) return false;

  if (dom.restricted && dow.restricted)
    return dom.test(p.day) || dow.test(p.weekday);
  if (dom.restricted) return dom.test(p.day);
  if (dow.restricted) return dow.test(p.weekday);
  return true;
}

/** Teto de busca da pré-visualização: um cron raríssimo mas válido
 *  (29/fev) precisa de quase um ano; um impossível (30/fev) precisa do
 *  teto para não rodar para sempre — ver `describeSchedule` no
 *  componente para o que a UI mostra quando o retorno vem vazio. */
const MAX_LOOKAHEAD_DAYS = 366;

export interface NextOccurrencesOptions {
  /**
   * Só ocorrências que a janela de horário permitido (`isWithinSendWindow`)
   * deixa passar — ou seja, o que a varredura REALMENTE dispara.
   *
   * Existe porque sem isto a pré-visualização do construtor mentia: um
   * agendamento de sábado às 10h listava "próximo disparo: sáb 10:00" e
   * nunca disparava, já que `SEND_WINDOW` cobre só dias úteis das 09h às
   * 20h. Uma tela que promete o que o runtime recusa é o modo de falha
   * que esta SPEC existe para eliminar.
   */
  deliverableOnly?: boolean;
}

/**
 * Próximas `count` ocorrências deste cron, a partir de `from`
 * (inclusive), no fuso `timeZone`. Devolve menos de `count` — inclusive
 * zero — quando o cron não tem tantas ocorrências dentro do teto de
 * busca; nunca lança.
 */
export function nextOccurrences(
  cron: string,
  timeZone: string,
  count: number,
  from: Date = new Date(),
  options: NextOccurrencesOptions = {}
): Date[] {
  const compiled = compileCronFields(cron);
  if (!compiled || count <= 0) return [];
  const { minute, hour, dom, mon, dow } = compiled;

  // Combinações hora×minuto que casam, computadas uma vez (1440 checagens
  // sem nenhuma chamada a Intl) — é isso que evita varrer minuto a minuto
  // pelos até 366 dias do teto.
  const timeCandidates: { hour: number; minute: number }[] = [];
  for (let h = 0; h < 24; h++) {
    if (!hour.test(h)) continue;
    for (let m = 0; m < 60; m++) {
      if (minute.test(m)) timeCandidates.push({ hour: h, minute: m });
    }
  }
  if (timeCandidates.length === 0) return [];

  const results: Date[] = [];
  const start = zonedParts(from, timeZone);

  for (
    let offset = 0;
    offset <= MAX_LOOKAHEAD_DAYS && results.length < count;
    offset++
  ) {
    // Avança pelo CALENDÁRIO local (mesma técnica de `nextWindowOpening`
    // em send-window.ts), não em milissegundos — evita depender de Intl
    // para os dias que nem sequer batem mês/dia.
    const cursor = new Date(
      Date.UTC(start.year, start.month - 1, start.day + offset)
    );
    const month = cursor.getUTCMonth() + 1;
    const day = cursor.getUTCDate();
    const weekday = cursor.getUTCDay() as Weekday;

    if (!mon.test(month)) continue;

    const dayEligible =
      dom.restricted && dow.restricted
        ? dom.test(day) || dow.test(weekday)
        : dom.restricted
          ? dom.test(day)
          : dow.restricted
            ? dow.test(weekday)
            : true;
    if (!dayEligible) continue;

    for (const c of timeCandidates) {
      const instant = zonedWallTimeToUtc(
        {
          year: cursor.getUTCFullYear(),
          month,
          day,
          hour: c.hour,
          minute: c.minute,
        },
        timeZone
      );
      if (instant.getTime() < from.getTime()) continue;
      if (options.deliverableOnly && !isWithinSendWindow(instant, timeZone)) {
        continue;
      }
      results.push(instant);
      if (results.length >= count) break;
    }
  }

  return results;
}

// ------------------------------------------------------------
// Cobertura: o que este agendamento REALMENTE dispara
// ------------------------------------------------------------

/**
 * Quantas ocorrências cruas amostrar para decidir se a janela de
 * horário barra alguma.
 *
 * 64 é escolhido para que a amostra atravesse pelo menos um ciclo
 * completo de cada modo: 64 dias num agendamento diário (pega fins de
 * semana), 16 horas num de 15 em 15 minutos (pega a virada das 20h),
 * 64 sábados num semanal de sábado. Contar ocorrências, e não dias,
 * é o que faz o mesmo número servir aos quatro modos.
 */
const COVERAGE_SAMPLE = 64;

export interface ScheduleCoverage {
  /** Próximos disparos REAIS, já filtrados pela janela de horário. */
  deliverable: Date[];
  /** Alguma ocorrência da amostra é barrada pela janela de horário. */
  someBlocked: boolean;
  /** Nenhuma ocorrência dispara dentro do teto de busca. */
  neverFires: boolean;
}

/**
 * O que o construtor precisa mostrar sem mentir: os próximos disparos
 * de verdade, se a janela de horário engole alguns, e se engole todos.
 *
 * `neverFires` é o caso que `validate.ts` recusa na ativação — um
 * agendamento 100% fora da janela (sábado às 10h, ou qualquer dia às
 * 22h) salva, ativa e nunca roda, que é exatamente o que esta SPEC
 * existe para impedir.
 */
export function scheduleCoverage(
  cron: string,
  timeZone: string,
  count: number,
  from: Date = new Date()
): ScheduleCoverage {
  const raw = nextOccurrences(cron, timeZone, COVERAGE_SAMPLE, from);
  const deliverable = nextOccurrences(cron, timeZone, count, from, {
    deliverableOnly: true,
  });
  return {
    deliverable,
    someBlocked: raw.some((d) => !isWithinSendWindow(d, timeZone)),
    neverFires: deliverable.length === 0,
  };
}

/**
 * `true` quando este agendamento dispara ao menos uma vez dentro do
 * teto de busca. Versão barata de `scheduleCoverage` para quem só
 * precisa da decisão de ativar ou não (`validate.ts`).
 */
export function firesAtLeastOnce(
  cron: string,
  timeZone: string,
  from: Date = new Date()
): boolean {
  return (
    nextOccurrences(cron, timeZone, 1, from, { deliverableOnly: true }).length >
    0
  );
}

// ------------------------------------------------------------
// Resumo em linguagem natural
// ------------------------------------------------------------

/** Mesmo padrão de `RelativeTranslate` em `trigger-meta.ts`: um tipo
 *  inline, sem importar `next-intl`, para o módulo continuar puro. */
export type ScheduleTranslate = (
  key: string,
  values?: Record<string, string | number | Date>
) => string;

function formatTime(hour: number, minute: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(hour)}:${pad(minute)}`;
}

function joinList(items: string[], and: string): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} ${and} ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} ${and} ${items[items.length - 1]}`;
}

/** Frase em linguagem natural para o resumo do construtor (SPEC 046 §5.3). */
export function describeSchedule(
  state: ScheduleState,
  t: ScheduleTranslate
): string {
  switch (state.mode) {
    case 'interval': {
      const opt = INTERVAL_OPTIONS.find(
        (o) => o.unit === state.unit && o.every === state.every
      );
      return opt
        ? t(`scheduleBuilder.intervalOptions.${opt.i18nKey}`)
        : t('scheduleBuilder.summary.custom', { cron: scheduleToCron(state) });
    }
    case 'daily':
      return t('scheduleBuilder.summary.daily', {
        time: formatTime(state.hour, state.minute),
      });
    case 'weekly': {
      const time = formatTime(state.hour, state.minute);
      const days = new Set(state.weekdays);
      const isAll = ([0, 1, 2, 3, 4, 5, 6] as Weekday[]).every((d) =>
        days.has(d)
      );
      const isWeekday =
        days.size === 5 &&
        ([1, 2, 3, 4, 5] as Weekday[]).every((d) => days.has(d));
      const isWeekend = days.size === 2 && days.has(0) && days.has(6);

      if (isAll) return t('scheduleBuilder.summary.allDays', { time });
      if (isWeekday) return t('scheduleBuilder.summary.weekday', { time });
      if (isWeekend) return t('scheduleBuilder.summary.weekend', { time });

      const names = [...days]
        .sort((a, b) => a - b)
        .map((d) => t(`scheduleBuilder.weekdayFull.${d}`));
      const list = joinList(names, t('scheduleBuilder.and'));
      return t('scheduleBuilder.summary.weekly', { days: list, time });
    }
    case 'monthly': {
      const time = formatTime(state.hour, state.minute);
      const day = state.monthDays[0];
      if (day === undefined) {
        return t('scheduleBuilder.summary.custom', {
          cron: scheduleToCron(state),
        });
      }
      return day === 1
        ? t('scheduleBuilder.summary.monthlyFirst', { time })
        : t('scheduleBuilder.summary.monthly', { day, time });
    }
    case 'advanced': {
      // Um cron do modo avançado pode, por acaso, casar com um preset —
      // nesse caso descreve o preset em vez de "personalizado".
      const parsed = parseSchedule(state.raw);
      if (parsed.mode !== 'advanced') return describeSchedule(parsed, t);
      if (validateSchedule(state.raw)) {
        return t('scheduleBuilder.summary.customInvalid', { cron: state.raw });
      }
      return t('scheduleBuilder.summary.custom', { cron: state.raw });
    }
  }
}
