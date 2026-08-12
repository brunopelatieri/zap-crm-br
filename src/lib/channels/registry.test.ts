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

  it('canal sem adaptador falha com motivo explícito, não undefined', () => {
    // O adaptador da Evolution chega na F4. Até lá, quem tentar usar
    // precisa saber POR QUE falhou — um `undefined` estouraria três
    // camadas acima, sem rastro.
    expect(hasAdapter('whatsapp_qr')).toBe(false);
    expect(() => getAdapter('whatsapp_qr')).toThrow(/F4/);
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
