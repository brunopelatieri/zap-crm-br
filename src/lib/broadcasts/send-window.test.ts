import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TIME_ZONE,
  SEND_WINDOW,
  describeSendWindow,
  isValidTimeZone,
  isWithinSendWindow,
  nextWindowOpening,
  resolveTimeZone,
  zonedParts,
  zonedWallTimeToUtc,
} from './send-window';

const SP = 'America/Sao_Paulo';

/** Instante UTC de uma hora de parede em São Paulo (UTC-3, sem DST). */
function spWallTime(iso: string): Date {
  return zonedWallTimeToUtc(
    {
      year: Number(iso.slice(0, 4)),
      month: Number(iso.slice(5, 7)),
      day: Number(iso.slice(8, 10)),
      hour: Number(iso.slice(11, 13)),
      minute: Number(iso.slice(14, 16)),
    },
    SP
  );
}

describe('isValidTimeZone / resolveTimeZone', () => {
  it('aceita um nome IANA conhecido', () => {
    expect(isValidTimeZone(SP)).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
  });

  it('recusa lixo vindo da rede', () => {
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });

  it('cai no padrão em vez de propagar um fuso inválido', () => {
    expect(resolveTimeZone('Mars/Olympus')).toBe(DEFAULT_TIME_ZONE);
    expect(resolveTimeZone(undefined)).toBe(DEFAULT_TIME_ZONE);
    expect(resolveTimeZone(SP)).toBe(SP);
  });
});

describe('zonedParts', () => {
  it('lê a hora de parede do fuso, não a do servidor', () => {
    // 2026-08-07T12:00Z = 09:00 em São Paulo (UTC-3).
    const p = zonedParts(new Date('2026-08-07T12:00:00Z'), SP);
    expect(p.year).toBe(2026);
    expect(p.month).toBe(8);
    expect(p.day).toBe(7);
    expect(p.hour).toBe(9);
    expect(p.weekday).toBe(5); // sexta
  });

  it('usa a DATA local para o dia da semana', () => {
    // Sábado 00:30 UTC ainda é sexta 21:30 em São Paulo. Usar o dia da
    // semana do instante UTC faria uma sexta à noite contar como sábado.
    const p = zonedParts(new Date('2026-08-08T00:30:00Z'), SP);
    expect(p.day).toBe(7);
    expect(p.hour).toBe(21);
    expect(p.weekday).toBe(5);
  });

  it('não devolve hora 24 à meia-noite', () => {
    const p = zonedParts(new Date('2026-08-07T03:00:00Z'), SP);
    expect(p.hour).toBe(0);
  });
});

describe('zonedWallTimeToUtc', () => {
  it('resolve a hora de parede para o instante certo', () => {
    const utc = zonedWallTimeToUtc(
      { year: 2026, month: 8, day: 7, hour: 9 },
      SP
    );
    expect(utc.toISOString()).toBe('2026-08-07T12:00:00.000Z');
  });

  it('sobrevive a um fuso com horário de verão', () => {
    // 2026-07-15 em Nova York é EDT (UTC-4).
    const utc = zonedWallTimeToUtc(
      { year: 2026, month: 7, day: 15, hour: 9 },
      'America/New_York'
    );
    expect(utc.toISOString()).toBe('2026-07-15T13:00:00.000Z');

    // Já em janeiro é EST (UTC-5) — a mesma hora de parede, outro
    // instante. É este caso que a segunda passada de deslocamento cobre.
    const winter = zonedWallTimeToUtc(
      { year: 2026, month: 1, day: 15, hour: 9 },
      'America/New_York'
    );
    expect(winter.toISOString()).toBe('2026-01-15T14:00:00.000Z');
  });
});

describe('isWithinSendWindow', () => {
  it('aceita a abertura e recusa o fechamento', () => {
    // A janela é [startHour, endHour): 09:00 pode, 20:00 não.
    expect(isWithinSendWindow(spWallTime('2026-08-07T09:00'), SP)).toBe(true);
    expect(isWithinSendWindow(spWallTime('2026-08-07T19:59'), SP)).toBe(true);
    expect(isWithinSendWindow(spWallTime('2026-08-07T20:00'), SP)).toBe(false);
    expect(isWithinSendWindow(spWallTime('2026-08-07T08:59'), SP)).toBe(false);
  });

  it('recusa o fim de semana inteiro', () => {
    // 2026-08-08 é sábado, 2026-08-09 domingo.
    expect(isWithinSendWindow(spWallTime('2026-08-08T10:00'), SP)).toBe(false);
    expect(isWithinSendWindow(spWallTime('2026-08-09T10:00'), SP)).toBe(false);
  });

  it('julga no fuso informado, não no do servidor', () => {
    // 2026-08-07T23:00Z é 20:00 em São Paulo (fora) e 16:00 em Los
    // Angeles (dentro). O mesmo instante, duas respostas — é exatamente
    // por isso que o fuso é gravado junto com o agendamento.
    const instant = new Date('2026-08-07T23:00:00Z');
    expect(isWithinSendWindow(instant, SP)).toBe(false);
    expect(isWithinSendWindow(instant, 'America/Los_Angeles')).toBe(true);
  });
});

describe('nextWindowOpening', () => {
  it('devolve o próprio instante quando já está dentro', () => {
    const inside = spWallTime('2026-08-07T10:00');
    expect(nextWindowOpening(inside, SP)).toBe(inside);
  });

  it('de madrugada, abre no mesmo dia', () => {
    const dawn = spWallTime('2026-08-07T03:00'); // sexta
    const next = nextWindowOpening(dawn, SP);
    const p = zonedParts(next, SP);
    expect(p.day).toBe(7);
    expect(p.hour).toBe(SEND_WINDOW.startHour);
  });

  it('depois do fechamento, pula para o próximo dia útil', () => {
    const night = spWallTime('2026-08-07T23:00'); // sexta à noite
    const next = nextWindowOpening(night, SP);
    const p = zonedParts(next, SP);
    // Sábado e domingo estão fora — a próxima abertura é segunda dia 10.
    expect(p.day).toBe(10);
    expect(p.weekday).toBe(1);
    expect(p.hour).toBe(SEND_WINDOW.startHour);
  });

  it('no sábado de manhã, espera segunda', () => {
    const saturday = spWallTime('2026-08-08T10:00');
    const p = zonedParts(nextWindowOpening(saturday, SP), SP);
    expect(p.day).toBe(10);
    expect(p.hour).toBe(SEND_WINDOW.startHour);
  });

  it('o resultado devolvido está sempre dentro da janela', () => {
    for (const iso of [
      '2026-08-07T03:00',
      '2026-08-07T23:30',
      '2026-08-08T12:00',
      '2026-08-09T21:00',
      '2026-08-10T08:00',
    ]) {
      const next = nextWindowOpening(spWallTime(iso), SP);
      expect(isWithinSendWindow(next, SP)).toBe(true);
    }
  });
});

describe('describeSendWindow', () => {
  it('formata com dois dígitos', () => {
    expect(
      describeSendWindow({ ...SEND_WINDOW, startHour: 9, endHour: 20 })
    ).toBe('09:00–20:00');
  });
});
