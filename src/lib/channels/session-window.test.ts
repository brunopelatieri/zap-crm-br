import { describe, it, expect } from 'vitest';

import { computeSessionWindow } from '@/lib/whatsapp/session-window';
import {
  resolveSessionWindow,
  shouldTrackSessionWindow,
} from './session-window';

const NOW = new Date('2026-08-12T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe('resolveSessionWindow — canal Cloud (paridade com a SPEC 045)', () => {
  it.each([
    ['janela aberta', hoursAgo(3)],
    ['quase fechando', hoursAgo(23)],
    ['já fechada', hoursAgo(30)],
    ['sem âncora', null],
  ])('%s: resultado idêntico a computeSessionWindow', (_label, anchor) => {
    const base = computeSessionWindow(anchor, NOW);
    const resolved = resolveSessionWindow('whatsapp_cloud', anchor, NOW);

    // A paridade é o critério de aceite da F1: migrar os consumidores
    // para esta função não pode mudar UMA decisão do canal oficial.
    expect(resolved.isOpen).toBe(base.isOpen);
    expect(resolved.minutesRemaining).toBe(base.minutesRemaining);
    expect(resolved.lastCustomerMessageAt).toEqual(base.lastCustomerMessageAt);
    expect(resolved.applicable).toBe(true);
  });

  it('sem âncora, continua FECHADA — o padrão seguro da SPEC 045', () => {
    const w = resolveSessionWindow('whatsapp_cloud', null, NOW);
    expect(w.isOpen).toBe(false);
    expect(w.applicable).toBe(true);
  });

  it('fechamento é exclusivo: exatamente 24h já está fechada', () => {
    expect(
      resolveSessionWindow('whatsapp_cloud', hoursAgo(24), NOW).isOpen
    ).toBe(false);
  });
});

describe('resolveSessionWindow — canal QRCode (sem regra de janela)', () => {
  it('sem âncora, o envio é LIVRE — o caso que quebraria o canal inteiro', () => {
    // Se isto voltasse `isOpen: false`, checkWindowGuard reprovaria
    // todo envio de automação no canal QRCode (default de leitura
    // 'fail'), e o canal nasceria inútil.
    const w = resolveSessionWindow('whatsapp_qr', null, NOW);
    expect(w.applicable).toBe(false);
    expect(w.isOpen).toBe(true);
    expect(w.minutesRemaining).toBe(Number.POSITIVE_INFINITY);
  });

  it('âncora antiga não fecha nada — a restrição simplesmente não existe', () => {
    const w = resolveSessionWindow('whatsapp_qr', hoursAgo(720), NOW);
    expect(w.applicable).toBe(false);
    expect(w.isOpen).toBe(true);
  });

  it('não expõe âncora: a interface não deve renderizar contagem regressiva', () => {
    expect(
      resolveSessionWindow('whatsapp_qr', hoursAgo(2), NOW)
        .lastCustomerMessageAt
    ).toBeNull();
  });

  it('applicable distingue "sem restrição" de "janela aberta"', () => {
    const qr = resolveSessionWindow('whatsapp_qr', null, NOW);
    const cloud = resolveSessionWindow('whatsapp_cloud', hoursAgo(1), NOW);
    expect(qr.isOpen).toBe(cloud.isOpen); // ambos true…
    expect(qr.applicable).not.toBe(cloud.applicable); // …mas por razões diferentes
  });
});

describe('shouldTrackSessionWindow', () => {
  it('só o canal Cloud grava a âncora', () => {
    expect(shouldTrackSessionWindow('whatsapp_cloud')).toBe(true);
    expect(shouldTrackSessionWindow('whatsapp_qr')).toBe(false);
  });

  it('é o que mantém conversas QRCode fora da varredura de reengajamento', () => {
    // A varredura filtra por `last_customer_message_at` num range seek.
    // NULL nunca casa — desde que ninguém escreva a âncora.
    expect(shouldTrackSessionWindow('whatsapp_qr')).toBe(false);
  });
});
