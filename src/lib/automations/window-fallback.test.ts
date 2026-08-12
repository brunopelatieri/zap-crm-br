import { describe, it, expect } from 'vitest';

import {
  resolveWindowRoute,
  eligibleFallbackChannels,
  type FallbackChannel,
  type ResolveWindowRouteInput,
} from './window-fallback';

const qrChannel: FallbackChannel = {
  id: 'qr-1',
  name: 'Vendas (QRCode)',
  status: 'connected',
  freeformOutsideWindow: true,
};

const cloudChannel: FallbackChannel = {
  id: 'cloud-2',
  name: 'Suporte Oficial',
  status: 'connected',
  freeformOutsideWindow: false,
};

/** Janela fechada num canal que TEM janela — o cenário do fallback. */
function input(
  over: Partial<ResolveWindowRouteInput> = {}
): ResolveWindowRouteInput {
  return {
    action: 'fallback_channel',
    windowApplicable: true,
    windowOpen: false,
    availableChannels: [qrChannel],
    contactOptedOut: false,
    fallbackChannelId: qrChannel.id,
    ...over,
  };
}

describe('resolveWindowRoute — precedência', () => {
  it('envia direto quando o canal não tem regra de janela (PRD 047 §7.1.1)', () => {
    // O caso que quebraria o canal QRCode inteiro: âncora nula levaria
    // windowOpen=false e reprovaria todo envio.
    expect(
      resolveWindowRoute(
        input({ windowApplicable: false, windowOpen: false, action: 'fail' })
      )
    ).toEqual({ kind: 'send' });
  });

  it('envia direto com a janela aberta, qualquer que seja a ação', () => {
    expect(resolveWindowRoute(input({ windowOpen: true }))).toEqual({
      kind: 'send',
    });
  });
});

describe('resolveWindowRoute — comportamento herdado da SPEC 045', () => {
  it('sem ação configurada, falha (default de LEITURA §5.3.2)', () => {
    const route = resolveWindowRoute(input({ action: undefined }));
    expect(route.kind).toBe('fail');
    expect(route).toMatchObject({
      reason:
        '24h session window closed — Meta would reject a free-form message',
    });
  });

  it('skip continua pulando', () => {
    expect(resolveWindowRoute(input({ action: 'skip' }))).toEqual({
      kind: 'skip',
      detail: 'session window closed — skipped',
    });
  });

  it('fallback_template sem nome de template falha', () => {
    const route = resolveWindowRoute(
      input({ action: 'fallback_template', fallbackTemplate: undefined })
    );
    expect(route).toEqual({
      kind: 'fail',
      reason: 'fallback_template needs template_name',
    });
  });

  it('fallback_template válido roteia para o template', () => {
    const template = { template_name: 'reengajamento', language: 'pt_BR' };
    expect(
      resolveWindowRoute(
        input({ action: 'fallback_template', fallbackTemplate: template })
      )
    ).toEqual({ kind: 'fallback_template', template });
  });

  it('nome de template só com espaços não conta como preenchido', () => {
    const route = resolveWindowRoute(
      input({
        action: 'fallback_template',
        fallbackTemplate: { template_name: '   ' },
      })
    );
    expect(route.kind).toBe('fail');
  });
});

describe('resolveWindowRoute — fallback por canal (PRD 047 §10.2)', () => {
  it('roteia para a instância QRCode conectada', () => {
    expect(resolveWindowRoute(input())).toEqual({
      kind: 'fallback_channel',
      channelId: 'qr-1',
      channelName: 'Vendas (QRCode)',
    });
  });

  it('sem canal selecionado, falha como erro de configuração', () => {
    const route = resolveWindowRoute(input({ fallbackChannelId: undefined }));
    expect(route.kind).toBe('fail');
    expect((route as { reason: string }).reason).toContain(
      'no channel selected'
    );
  });

  it('id só com espaços é tratado como ausente', () => {
    const route = resolveWindowRoute(input({ fallbackChannelId: '   ' }));
    expect(route.kind).toBe('fail');
  });

  it('contato opted-out suprime o envio — guardrail que o template não tem', () => {
    expect(resolveWindowRoute(input({ contactOptedOut: true }))).toEqual({
      kind: 'skip',
      detail: 'opted out — channel fallback suppressed',
    });
  });

  it('opt-out é avaliado ANTES de o canal existir — sem vazar diagnóstico', () => {
    // Mesmo com um canal inválido, quem pediu para não ser contatado
    // não vira uma falha ruidosa: a resposta é pular.
    const route = resolveWindowRoute(
      input({ contactOptedOut: true, fallbackChannelId: 'sumiu' })
    );
    expect(route.kind).toBe('skip');
  });

  it('canal inexistente (ou de outra conta) falha com motivo legível', () => {
    const route = resolveWindowRoute(
      input({ fallbackChannelId: 'de-outra-conta' })
    );
    expect(route.kind).toBe('fail');
    expect((route as { reason: string }).reason).toContain('not found');
  });

  it('recusa um segundo canal Cloud — ele tem a MESMA janela de 24h', () => {
    const route = resolveWindowRoute(
      input({
        availableChannels: [qrChannel, cloudChannel],
        fallbackChannelId: cloudChannel.id,
      })
    );
    expect(route.kind).toBe('fail');
    expect((route as { reason: string }).reason).toContain(
      'also subject to the 24h window'
    );
  });

  it.each(['disconnected', 'connecting', 'error', 'disabled'] as const)(
    'recusa instância com status "%s"',
    (status) => {
      const route = resolveWindowRoute(
        input({ availableChannels: [{ ...qrChannel, status }] })
      );
      expect(route.kind).toBe('fail');
      expect((route as { reason: string }).reason).toContain(status);
    }
  );
});

describe('eligibleFallbackChannels', () => {
  it('oferece só instância conectada e sem janela', () => {
    expect(
      eligibleFallbackChannels([
        qrChannel,
        cloudChannel,
        { ...qrChannel, id: 'qr-2', status: 'disconnected' },
      ])
    ).toEqual([qrChannel]);
  });

  it('lista vazia enquanto a camada de canais não existir', () => {
    expect(eligibleFallbackChannels([])).toEqual([]);
  });
});
