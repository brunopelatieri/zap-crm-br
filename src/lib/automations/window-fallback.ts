/**
 * Roteamento de um envio de sessão quando a janela de 24h já fechou
 * (SPEC 045 §5.3, estendida pelo PRD 047 §10.2).
 *
 * O que mudou e por quê
 *
 *   Até aqui, uma automação que precisasse falar com o contato depois
 *   da janela tinha três saídas: pular, falhar, ou mandar um TEMPLATE —
 *   que é cobrado pela Meta. Com a chegada dos canais não-oficiais
 *   (instâncias WhatsApp via QRCode), existe uma quarta: mandar a mesma
 *   mensagem por OUTRO CANAL, que não tem janela nenhuma porque não
 *   fala com a Meta.
 *
 *   É o caso de uso que motivou o PRD 047: o contato começou a conversa
 *   no número oficial, ficou 24h em silêncio, e reengajá-lo custaria um
 *   template pago. Pelo canal QR o mesmo texto sai livre.
 *
 * Por que isto é um módulo puro
 *
 *   A decisão depende de seis fatos (ação configurada, janela aplicável,
 *   janela aberta, canal escolhido, canais disponíveis, consentimento) e
 *   de nenhuma consulta. Separá-la do motor é o que permite testar as
 *   doze combinações sem banco, sem rede e sem Meta — a convenção do
 *   repositório para regra de negócio. O motor (`engine.ts`) fica com o
 *   trabalho de reunir os fatos e executar a rota escolhida.
 *
 * ⚠️ Nota de produto, deliberadamente codificada aqui
 *
 *   Uma mensagem entregue por este caminho chega ao contato a partir de
 *   um NÚMERO DIFERENTE daquele para o qual ele escreveu. Do lado de lá
 *   isso lê como abordagem de desconhecido, e disparo frio a partir de
 *   instância não-oficial é o padrão que mais leva número a banimento.
 *   Daí dois guardrails que não existem no fallback por template:
 *   `contactOptedOut` bloqueia (§`fallback_channel` item 2) e um canal
 *   que também tenha janela é recusado em vez de aceito em silêncio.
 */

import type { OnWindowClosedAction, SendTemplateStepConfig } from '@/types';

/**
 * Fatia de um canal que a decisão precisa conhecer.
 *
 * Declarada estruturalmente, e não importada de `@/lib/channels`, de
 * propósito: este módulo precisa compilar e ser testado ANTES da camada
 * de canais existir (PRD 047 F1). Quando ela chegar, a linha de
 * `channels` a satisfaz sem cast — é o mesmo formato.
 */
export interface FallbackChannel {
  id: string;
  /** Rótulo do usuário, usado nas mensagens de diagnóstico. */
  name: string;
  status: 'connected' | 'connecting' | 'disconnected' | 'error' | 'disabled';
  /**
   * O canal pode mandar texto livre sem restrição de janela?
   *
   * Verdadeiro para instâncias QRCode; FALSO para qualquer canal Cloud
   * API, que carrega a mesma janela de 24h da Meta. Vem de
   * `!capabilities.sessionWindow24h` na camada de canais.
   */
  freeformOutsideWindow: boolean;
}

export type WindowRoute =
  /** Janela aberta (ou inexistente): segue o envio normal. */
  | { kind: 'send' }
  | { kind: 'skip'; detail: string }
  /** O motor lança — a mensagem vira `failed` com este motivo. */
  | { kind: 'fail'; reason: string }
  | { kind: 'fallback_template'; template: SendTemplateStepConfig }
  | { kind: 'fallback_channel'; channelId: string; channelName: string };

export interface ResolveWindowRouteInput {
  /**
   * `on_window_closed` do step. Ausente = `'fail'` — o default de
   * LEITURA da SPEC 045 §5.3.2, que preserva o comportamento de um
   * step_config gravado antes do campo existir. Não confundir com o
   * default de ESCRITA (`'skip'`) do construtor.
   */
  action: OnWindowClosedAction | undefined;
  /**
   * O canal desta conversa tem regra de janela? (PRD 047 §7.1.1)
   * `false` num canal QRCode — ausência de restrição, não restrição
   * violada.
   */
  windowApplicable: boolean;
  windowOpen: boolean;
  fallbackTemplate?: SendTemplateStepConfig;
  fallbackChannelId?: string;
  /** Canais que a conta pode usar como fallback, já resolvidos. */
  availableChannels: readonly FallbackChannel[];
  /** O contato pediu para não receber contato automatizado. */
  contactOptedOut: boolean;
}

/**
 * Decide o que fazer com um envio de sessão. Nunca lança: toda condição
 * de erro vira `{ kind: 'fail', reason }`, para que o motor registre o
 * motivo em `automation_logs` em vez de estourar sem rastro.
 */
export function resolveWindowRoute(
  input: ResolveWindowRouteInput
): WindowRoute {
  // 1) Canal sem regra de janela — PRD 047 §7.1.1. A janela é uma
  //    restrição da META; num canal que não fala com a Meta, "fechada"
  //    não é o padrão conservador, é uma afirmação falsa que bloquearia
  //    100% dos envios legítimos.
  if (!input.windowApplicable) return { kind: 'send' };

  // 2) Janela aberta: nada a decidir.
  if (input.windowOpen) return { kind: 'send' };

  const action = input.action ?? 'fail';

  if (action === 'skip') {
    return { kind: 'skip', detail: 'session window closed — skipped' };
  }

  if (action === 'fallback_template') {
    if (!input.fallbackTemplate?.template_name?.trim()) {
      return { kind: 'fail', reason: 'fallback_template needs template_name' };
    }
    return { kind: 'fallback_template', template: input.fallbackTemplate };
  }

  if (action === 'fallback_channel') {
    return resolveChannelFallback(input);
  }

  // action === 'fail' — a mensagem original da SPEC 045, preservada
  // literalmente porque ela já aparece em logs e em testes existentes.
  return {
    kind: 'fail',
    reason: '24h session window closed — Meta would reject a free-form message',
  };
}

function resolveChannelFallback(input: ResolveWindowRouteInput): WindowRoute {
  const channelId = input.fallbackChannelId?.trim();

  // Erro de configuração. Mesma postura do fallback por template: falhar
  // com motivo legível é melhor que pular em silêncio, porque o operador
  // configurou explicitamente um desvio que não aconteceu.
  if (!channelId) {
    return {
      kind: 'fail',
      reason:
        'fallback_channel needs fallback_channel_id — no channel selected',
    };
  }

  // Consentimento. Este é o guardrail que o fallback por template NÃO
  // tem, e a assimetria é proposital: um template de utilidade tem
  // categoria aprovada pela Meta e alcança um opted-out por regra
  // conhecida (ver `fallbackTemplateAllowed` no engine). Uma mensagem
  // livre saindo de um número não-oficial não tem categoria nenhuma —
  // ela é, por definição, contato automatizado não solicitado, vindo de
  // um remetente que o contato não reconhece. Suprimir é o único
  // resultado defensável.
  //
  // `skip`, e não `fail`: o contato pediu para não ser contatado, o que
  // não é defeito da automação. O resto dos passos segue.
  if (input.contactOptedOut) {
    return {
      kind: 'skip',
      detail: 'opted out — channel fallback suppressed',
    };
  }

  const channel = input.availableChannels.find((c) => c.id === channelId);

  if (!channel) {
    return {
      kind: 'fail',
      reason: `fallback channel ${channelId} not found or not available to this account`,
    };
  }

  // A armadilha que este ramo existe para fechar: selecionar um SEGUNDO
  // número Cloud API como fallback não escapa da janela — ele carrega
  // exatamente a mesma restrição de 24h da Meta. Sem esta checagem, o
  // operador configuraria o desvio, veria a automação "funcionar" e
  // colheria rejeição da Meta no envio.
  if (!channel.freeformOutsideWindow) {
    return {
      kind: 'fail',
      reason: `fallback channel "${channel.name}" is also subject to the 24h window — pick a QR code instance`,
    };
  }

  if (channel.status !== 'connected') {
    return {
      kind: 'fail',
      reason: `fallback channel "${channel.name}" is ${channel.status} — cannot deliver`,
    };
  }

  return {
    kind: 'fallback_channel',
    channelId: channel.id,
    channelName: channel.name,
  };
}

/**
 * Canais que podem ser OFERECIDOS como fallback na interface.
 *
 * Só canais conectados e sem janela — oferecer um canal Cloud aqui
 * seria oferecer um desvio que a `resolveWindowRoute` recusaria depois,
 * e a hora de dizer "isto não resolve seu problema" é na configuração,
 * não no runtime.
 */
export function eligibleFallbackChannels(
  channels: readonly FallbackChannel[]
): FallbackChannel[] {
  return channels.filter(
    (c) => c.freeformOutsideWindow && c.status === 'connected'
  );
}
