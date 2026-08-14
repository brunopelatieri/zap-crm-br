import { describe, it, expect } from 'vitest';

import { CHANNEL_TYPES } from './types';
import { capabilitiesFor } from './capabilities';
import { getAdapter, hasAdapter } from './registry';

describe('registry', () => {
  it('resolve o adaptador do canal oficial', () => {
    const adapter = getAdapter('whatsapp_cloud');
    expect(adapter.type).toBe('whatsapp_cloud');
  });

  it('o adaptador carrega EXATAMENTE as capacidades da matriz', () => {
    // Se o adaptador declarasse as suas por conta própria, a interface
    // e o runtime poderiam discordar — que é o bug que a matriz
    // declarativa existe para tornar impossível.
    expect(getAdapter('whatsapp_cloud').capabilities).toBe(
      capabilitiesFor('whatsapp_cloud')
    );
  });

  it('implementa os métodos das capacidades que declara', () => {
    const adapter = getAdapter('whatsapp_cloud');
    expect(typeof adapter.sendText).toBe('function');
    expect(typeof adapter.sendMedia).toBe('function');
    // Cloud declara templates e interativos — os métodos têm de existir.
    expect(adapter.capabilities.templates).toBe(true);
    expect(typeof adapter.sendTemplate).toBe('function');
    expect(adapter.capabilities.interactiveButtons).toBe(true);
    expect(typeof adapter.sendInteractive).toBe('function');
  });

  it('resolve o adaptador Evolution (F4)', () => {
    const adapter = getAdapter('whatsapp_qr');
    expect(adapter.type).toBe('whatsapp_qr');
    expect(hasAdapter('whatsapp_qr')).toBe(true);
  });

  it('o adaptador Evolution carrega EXATAMENTE as capacidades da matriz', () => {
    expect(getAdapter('whatsapp_qr').capabilities).toBe(
      capabilitiesFor('whatsapp_qr')
    );
  });

  it('Evolution implementa os métodos das capacidades que declara', () => {
    const adapter = getAdapter('whatsapp_qr');
    expect(typeof adapter.sendText).toBe('function');
    expect(typeof adapter.sendMedia).toBe('function');
    // QR declara enquete e localização — os métodos têm de existir.
    expect(adapter.capabilities.poll).toBe(true);
    expect(typeof adapter.sendPoll).toBe('function');
    expect(adapter.capabilities.location).toBe(true);
    expect(typeof adapter.sendLocation).toBe('function');
    // MEDIDO como false (SPEC 048 §1.1-bis) — sem sendTemplate/sendInteractive.
    expect(adapter.capabilities.templates).toBe(false);
    expect(adapter.sendTemplate).toBeUndefined();
  });

  it('todo tipo declarado ou resolve, ou explica a ausência', () => {
    for (const type of CHANNEL_TYPES) {
      if (hasAdapter(type)) {
        expect(getAdapter(type).type).toBe(type);
      } else {
        expect(() => getAdapter(type)).toThrow();
      }
    }
  });
});
