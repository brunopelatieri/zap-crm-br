/**
 * A janela de 24h, agora ciente de canal (PRD 047 §7.1.1).
 *
 * O problema que isto resolve
 *
 *   `computeSessionWindow` (lib/whatsapp/session-window.ts) trata
 *   "sem âncora" como janela FECHADA — o padrão seguro correto quando
 *   o canal É a Cloud API e a Meta rejeitaria o envio.
 *
 *   Numa conversa de canal QRCode a âncora é NULL para sempre, porque
 *   `last_customer_message_at` só é escrito onde a janela existe. Sem
 *   esta função, os quatro consumidores da SPEC 045 leriam "fechada" e:
 *
 *     - `checkWindowGuard` reprovaria TODO envio de automação no canal
 *       QRCode (o default de leitura é 'fail') — o canal nasceria inútil;
 *     - a condição `session_window` responderia sempre "fechada", e
 *       automações/flows tomariam o ramo errado em silêncio;
 *     - a thread do inbox exibiria "janela fechada" — alarme falso
 *       sobre uma regra que não existe ali;
 *     - a varredura de reengajamento tentaria reengajar com template.
 *
 * Por que NÃO é "falha fechada"
 *
 *   O projeto trata "não sei" como fechado, e está certo. Aqui o caso é
 *   outro: não é desconhecimento do estado da janela, é a AUSÊNCIA da
 *   regra. A janela de 24h é uma restrição da Meta; num canal que não
 *   fala com a Meta, "fechada" não é conservador — é uma afirmação falsa
 *   que bloquearia 100% dos envios legítimos.
 *
 *   Por isso o retorno carrega `applicable: false` explicitamente, em
 *   vez de fingir uma janela aberta: cada consumidor decide o que fazer
 *   com a informação, e nenhum precisa adivinhar.
 *
 * Um relógio só
 *
 *   `computeSessionWindow` já existia para ser "o relógio da verdade
 *   único" em vez de cada consumidor recalcular do seu jeito. Esta
 *   função estende o mesmo argumento para canais: os quatro consumidores
 *   NÃO ganham um `if` de canal cada um — leem daqui.
 */

import {
  computeSessionWindow,
  type SessionWindowState,
} from '@/lib/whatsapp/session-window';
import { can } from './capabilities';
import type { ChannelType } from './types';

export interface ChannelSessionWindow extends SessionWindowState {
  /**
   * `false` quando o canal não tem regra de janela. Distingue "não há
   * restrição" de "a janela está aberta" — parecem iguais no `isOpen`,
   * mas significam coisas diferentes para a interface (uma faixa de
   * contagem regressiva só faz sentido no primeiro caso).
   */
  applicable: boolean;
}

/**
 * Estado da janela para uma conversa, considerando o canal dela.
 *
 * @param channelType tipo do canal da conversa
 * @param lastCustomerMessageAt âncora (`conversations.last_customer_message_at`)
 */
export function resolveSessionWindow(
  channelType: ChannelType,
  lastCustomerMessageAt: Date | null,
  now: Date = new Date()
): ChannelSessionWindow {
  if (!can(channelType, 'sessionWindow24h')) {
    return {
      applicable: false,
      isOpen: true,
      minutesRemaining: Number.POSITIVE_INFINITY,
      lastCustomerMessageAt: null,
    };
  }

  return {
    applicable: true,
    ...computeSessionWindow(lastCustomerMessageAt, now),
  };
}

/**
 * A âncora de janela deve ser gravada para este canal?
 *
 * Usado por `ingest.ts` (F2): escrever `last_customer_message_at` num
 * canal sem janela colocaria conversas QRCode no alcance da varredura
 * de reengajamento, que tentaria reengajá-las com um template
 * inexistente. Manter NULL é o que as mantém fora, por construção.
 */
export function shouldTrackSessionWindow(channelType: ChannelType): boolean {
  return can(channelType, 'sessionWindow24h');
}
