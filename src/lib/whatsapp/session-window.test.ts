import { describe, expect, it } from 'vitest';

import { SESSION_WINDOW_MS, computeSessionWindow } from './session-window';

const NOW = new Date('2026-08-09T12:00:00Z');

describe('computeSessionWindow', () => {
  it('contato nunca escreveu (null) → fechada', () => {
    const state = computeSessionWindow(null, NOW);
    expect(state.isOpen).toBe(false);
    expect(state.lastCustomerMessageAt).toBeNull();
  });

  it('exatamente 24h → fechada (fechamento exclusivo)', () => {
    const lastMsg = new Date(NOW.getTime() - SESSION_WINDOW_MS);
    const state = computeSessionWindow(lastMsg, NOW);
    expect(state.isOpen).toBe(false);
    expect(state.minutesRemaining).toBe(0);
  });

  it('23h59min → aberta com minutesRemaining = 1', () => {
    const lastMsg = new Date(NOW.getTime() - SESSION_WINDOW_MS + 60_000);
    const state = computeSessionWindow(lastMsg, NOW);
    expect(state.isOpen).toBe(true);
    expect(state.minutesRemaining).toBe(1);
  });

  it('janela já vencida há muito → minutesRemaining negativo', () => {
    const lastMsg = new Date(NOW.getTime() - SESSION_WINDOW_MS - 3_600_000);
    const state = computeSessionWindow(lastMsg, NOW);
    expect(state.isOpen).toBe(false);
    expect(state.minutesRemaining).toBe(-60);
  });

  it('travessia de horário de verão — a duração é por instante, não por calendário local', () => {
    // 2026-10-18T02:00 em São Paulo não tem mais DST (extinto em 2019),
    // mas a função não deve depender de fuso nenhum: 24h em milissegundos
    // é 24h em milissegundos, qualquer que seja o fuso do leitor.
    const lastMsg = new Date('2026-10-17T12:00:00Z');
    const now = new Date('2026-10-18T11:59:00Z');
    expect(computeSessionWindow(lastMsg, now).isOpen).toBe(true);
    const nowClosed = new Date('2026-10-18T12:00:00Z');
    expect(computeSessionWindow(lastMsg, nowClosed).isOpen).toBe(false);
  });

  it('usa o `now` injetado, nunca o relógio real', () => {
    const lastMsg = new Date('2000-01-01T00:00:00Z');
    const now = new Date('2000-01-01T01:00:00Z');
    const state = computeSessionWindow(lastMsg, now);
    expect(state.isOpen).toBe(true);
    expect(state.minutesRemaining).toBe(23 * 60);
  });
});
