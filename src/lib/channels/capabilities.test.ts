import { describe, it, expect } from 'vitest';

import { CHANNEL_TYPES, type ChannelCapabilities } from './types';
import {
  CHANNEL_CAPABILITIES,
  capabilitiesFor,
  can,
  canSendMedia,
} from './capabilities';

describe('matriz de capacidades — completude', () => {
  it('todo ChannelType tem entrada declarada', () => {
    for (const type of CHANNEL_TYPES) {
      expect(CHANNEL_CAPABILITIES[type]).toBeDefined();
    }
    expect(Object.keys(CHANNEL_CAPABILITIES).sort()).toEqual(
      [...CHANNEL_TYPES].sort()
    );
  });

  it('nenhuma capacidade fica indefinida em nenhum canal', () => {
    // Um `undefined` aqui vira `false` silencioso no runtime e um
    // recurso que some da interface sem ninguém entender por quê.
    const keys: (keyof ChannelCapabilities)[] = [
      'text',
      'media',
      'ptt',
      'location',
      'poll',
      'interactiveButtons',
      'interactiveList',
      'templates',
      'reactions',
      'replyQuote',
      'editMessage',
      'deleteForEveryone',
      'typingIndicator',
      'markRead',
      'deliveryReceipts',
      'broadcast',
      'sessionWindow24h',
      'messagingLimit',
    ];

    for (const type of CHANNEL_TYPES) {
      const caps = capabilitiesFor(type);
      for (const key of keys) {
        expect(caps[key], `${type}.${key}`).toBeDefined();
      }
      for (const kind of ['image', 'video', 'audio', 'document'] as const) {
        expect(caps.media[kind], `${type}.media.${kind}`).toBeDefined();
      }
    }
  });
});

describe('canal QRCode — valores MEDIDOS contra servidor real', () => {
  // Estes quatro não são opinião: foram testados em 12/08/2026 contra
  // uma instância Evolution Go e um número real. Mudar qualquer um sem
  // novo teste no aparelho é regressão.
  it('botões e listas são FALSE — o WhatsApp devolve 405', () => {
    expect(can('whatsapp_qr', 'interactiveButtons')).toBe(false);
    expect(can('whatsapp_qr', 'interactiveList')).toBe(false);
  });

  it('enquete é TRUE — único interativo que a Meta aceita neste canal', () => {
    expect(can('whatsapp_qr', 'poll')).toBe(true);
  });

  it('texto entrega', () => {
    expect(can('whatsapp_qr', 'text')).toBe(true);
  });
});

describe('canal QRCode — regras de produto e da Meta', () => {
  it('não tem templates (conceito exclusivo da Cloud API)', () => {
    expect(can('whatsapp_qr', 'templates')).toBe(false);
  });

  it('não faz disparo em massa (regra de produto)', () => {
    expect(can('whatsapp_qr', 'broadcast')).toBe(false);
  });

  it('não tem janela de 24h nem tier de mensagens', () => {
    expect(can('whatsapp_qr', 'sessionWindow24h')).toBe(false);
    expect(can('whatsapp_qr', 'messagingLimit')).toBe(false);
  });

  it('edita e apaga para todos — o que a Cloud API não faz', () => {
    expect(can('whatsapp_qr', 'editMessage')).toBe(true);
    expect(can('whatsapp_cloud', 'editMessage')).toBe(false);
    expect(can('whatsapp_qr', 'deleteForEveryone')).toBe(true);
    expect(can('whatsapp_cloud', 'deleteForEveryone')).toBe(false);
  });
});

describe('canal Cloud', () => {
  it('mantém template, interativos, disparo, janela e tier', () => {
    for (const key of [
      'templates',
      'interactiveButtons',
      'interactiveList',
      'broadcast',
      'sessionWindow24h',
      'messagingLimit',
    ] as const) {
      expect(can('whatsapp_cloud', key), key).toBe(true);
    }
  });

  it('não tem enquete nativa', () => {
    expect(can('whatsapp_cloud', 'poll')).toBe(false);
  });
});

describe('canSendMedia', () => {
  it('ambos os canais enviam os quatro tipos de mídia', () => {
    for (const type of CHANNEL_TYPES) {
      for (const kind of ['image', 'video', 'audio', 'document'] as const) {
        expect(canSendMedia(type, kind), `${type}/${kind}`).toBe(true);
      }
    }
  });
});

describe('invariantes entre canais', () => {
  it('nenhum canal tem janela de 24h sem ter templates', () => {
    // A janela existe porque a Meta exige template para falar fora
    // dela. Um canal com janela e sem template seria uma prisão: nada
    // poderia ser enviado depois de 24h de silêncio.
    for (const type of CHANNEL_TYPES) {
      const caps = capabilitiesFor(type);
      if (caps.sessionWindow24h) {
        expect(caps.templates, `${type}`).toBe(true);
      }
    }
  });

  it('disparo em massa nunca é oferecido sem template', () => {
    for (const type of CHANNEL_TYPES) {
      const caps = capabilitiesFor(type);
      if (caps.broadcast) {
        expect(caps.templates, `${type}`).toBe(true);
      }
    }
  });
});
