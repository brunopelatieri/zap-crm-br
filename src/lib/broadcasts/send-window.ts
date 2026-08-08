/**
 * Janela de horário permitido para disparo (SPEC 044 §6.3).
 *
 * Por que isto existe
 *
 *   Um disparo em massa às 23h queima reputação: a taxa de bloqueio
 *   sobe, e no WhatsApp reputação é o que governa o tier da Meta (§4) —
 *   ou seja, mandar na hora errada custa cota permanente, não só uma
 *   noite de irritação. A §6.3 pede o comportamento explícito:
 *   **bloquear por padrão, com override consciente**.
 *
 * Onde a janela mora
 *
 *   Nas constantes abaixo, não em tabela. Este projeto é auto-hospedado
 *   e a janela é política do operador, não preferência por usuário —
 *   uma tabela de configuração exigiria uma tela de configuração para
 *   não ficar imutável na prática, e nada na §6.3 pede isso. Quem
 *   precisa de outra janela muda `SEND_WINDOW` aqui, num lugar só.
 *
 *   O que É por disparo: o `windowOverride`. Quem aceita mandar às 23h
 *   aceita naquele disparo (`broadcasts.window_override`), nunca para
 *   sempre.
 *
 * Sobre o fuso
 *
 *   "20h" não significa nada sem fuso. O fuso vem do cliente que
 *   agendou (`Intl.DateTimeFormat().resolvedOptions().timeZone`, o mesmo
 *   padrão do gráfico da §5.2) e fica gravado em
 *   `broadcasts.scheduled_timezone` — é isso que faz o cron avaliar a
 *   janela no fuso de quem agendou, e não no do servidor.
 *
 *   Um fuso vindo da rede é validado (`isValidTimeZone`) e cai no
 *   padrão quando não presta. Ele NÃO é uma fronteira de segurança:
 *   quem quiser burlar a janela tem o override à mão, que é legítimo e
 *   fica registrado na trilha. A janela é uma proteção contra o erro
 *   distraído, não contra o usuário mal-intencionado.
 */

/** Dia da semana no formato de `Date#getUTCDay()`: 0 = domingo. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface SendWindow {
  /** Primeira hora permitida (inclusiva). 9 = 09:00 já pode. */
  startHour: number;
  /** Hora de fechamento (exclusiva). 20 = 19:59 pode, 20:00 não. */
  endHour: number;
  /** Dias em que o disparo é permitido. */
  weekdays: readonly Weekday[];
}

/**
 * Janela padrão: dias úteis, 09:00–20:00, conforme o exemplo da §6.3.
 *
 * Sábado fica de fora deliberadamente — não porque disparar sábado seja
 * proibido, mas porque o padrão precisa ser o conservador e o override
 * existe justamente para a campanha de fim de semana planejada.
 */
export const SEND_WINDOW: SendWindow = {
  startHour: 9,
  endHour: 20,
  weekdays: [1, 2, 3, 4, 5],
};

/** Fuso assumido quando o cliente não informou um válido. */
export const DEFAULT_TIME_ZONE = 'America/Sao_Paulo';

/** Até quantos dias à frente procurar a próxima abertura da janela. */
const MAX_LOOKAHEAD_DAYS = 8;

/** `true` se o nome é um fuso IANA que este runtime conhece. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Fuso utilizável a partir de uma entrada de rede não confiável. */
export function resolveTimeZone(tz: unknown): string {
  return isValidTimeZone(tz) ? tz : DEFAULT_TIME_ZONE;
}

export interface ZonedParts {
  year: number;
  /** 1–12, como se lê num calendário (não o 0–11 do `Date`). */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: Weekday;
}

const PART_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = PART_FORMATTERS.get(timeZone);
  if (cached) return cached;
  // `hourCycle: 'h23'` evita o "24" que `hour12: false` produz à
  // meia-noite em alguns runtimes — um 24 viraria hora 24 no cálculo.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  PART_FORMATTERS.set(timeZone, fmt);
  return fmt;
}

/** Quebra um instante nos componentes de calendário daquele fuso. */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');

  const year = get('year');
  const month = get('month');
  const day = get('day');

  return {
    year,
    month,
    day,
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
    // O dia da semana sai da DATA local, não do instante UTC: às 22h de
    // São Paulo o UTC já virou o dia seguinte, e usar `getUTCDay()` do
    // instante faria uma sexta à noite contar como sábado.
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() as Weekday,
  };
}

/**
 * Instante UTC correspondente a uma hora de parede naquele fuso.
 *
 * Duas passadas: a primeira usa o deslocamento do palpite, a segunda o
 * do resultado. É o que acerta as bordas de horário de verão — o Brasil
 * não tem mais DST, mas o fuso aqui vem do navegador e pode ser
 * qualquer um.
 */
export function zonedWallTimeToUtc(
  wall: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute?: number;
  },
  timeZone: string
): Date {
  const naive = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute ?? 0,
    0
  );

  const offsetAt = (ts: number) => {
    const p = zonedParts(new Date(ts), timeZone);
    return (
      Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ts
    );
  };

  let ts = naive - offsetAt(naive);
  ts = naive - offsetAt(ts);
  return new Date(ts);
}

/** `true` se este instante cai dentro da janela permitida naquele fuso. */
export function isWithinSendWindow(
  date: Date,
  timeZone: string,
  window: SendWindow = SEND_WINDOW
): boolean {
  const p = zonedParts(date, timeZone);
  if (!window.weekdays.includes(p.weekday)) return false;
  return p.hour >= window.startHour && p.hour < window.endHour;
}

/**
 * Próxima abertura da janela a partir de `date` (inclusive).
 *
 * Devolve `date` quando já está dentro. É o que o cron usa para ADIAR
 * um agendamento vencido fora de hora, em vez de disparar às 23h ou de
 * marcar a campanha como falha — adiar preserva a intenção do usuário;
 * as outras duas saídas destroem alguma coisa.
 */
export function nextWindowOpening(
  date: Date,
  timeZone: string,
  window: SendWindow = SEND_WINDOW
): Date {
  if (isWithinSendWindow(date, timeZone, window)) return date;

  const p = zonedParts(date, timeZone);

  for (let offset = 0; offset <= MAX_LOOKAHEAD_DAYS; offset++) {
    // Avança pelo CALENDÁRIO local, não somando 24 h em milissegundos:
    // num fuso com DST o dia seguinte pode ter 23 ou 25 horas.
    const cursor = new Date(Date.UTC(p.year, p.month - 1, p.day + offset));
    const weekday = cursor.getUTCDay() as Weekday;
    if (!window.weekdays.includes(weekday)) continue;

    // No dia de hoje, só serve se a abertura ainda está à frente (o caso
    // "chegou às 7h da manhã de uma terça").
    if (offset === 0 && p.hour >= window.startHour) continue;

    return zonedWallTimeToUtc(
      {
        year: cursor.getUTCFullYear(),
        month: cursor.getUTCMonth() + 1,
        day: cursor.getUTCDate(),
        hour: window.startHour,
      },
      timeZone
    );
  }

  // Inalcançável com `weekdays` não vazio — uma semana inteira sempre
  // contém todos os dias. Se `weekdays` ficar vazio por edição errada
  // das constantes, é melhor devolver a data original do que um loop.
  return date;
}

/** Descrição legível da janela, para a UI e para a trilha de auditoria. */
export function describeSendWindow(window: SendWindow = SEND_WINDOW): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(window.startHour)}:00–${pad(window.endHour)}:00`;
}
