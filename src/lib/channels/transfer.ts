/**
 * Elegibilidade de canal como destino de transferência (SPEC 056 §4.3).
 *
 * Módulo puro pelo mesmo motivo de `window-fallback.ts`: a pergunta
 * "este canal serve de destino, e se não serve, por quê" é lida em DOIS
 * lugares — o menu que oferece a transferência e a rota que a executa —
 * e eles não podem discordar. Separar do banco é o que permite testar
 * as quatro combinações sem consulta nenhuma.
 *
 * Por que a janela de sessão entra como dado, não como consulta
 *
 *   Um canal com `sessionWindow24h` (hoje, só o Cloud) só é destino
 *   válido se a janela da thread DO CONTATO NAQUELE CANAL estiver
 *   aberta (SPEC 056 D-3) — senão o único envio possível seria um
 *   template pago, e a ação nem deveria estar habilitada. Quem chama já
 *   resolveu isso via `resolveSessionWindow` (é a mesma leitura que a
 *   faixa de janela expirada do composer usa); este módulo só decide em
 *   cima do resultado, sem saber que existe um banco.
 *
 *   `sessionWindow: null` — contato sem thread ainda naquele canal — é
 *   tratado como janela fechada: uma janela que nunca abriu não está
 *   aberta.
 */

import { can } from './capabilities';
import type { ChannelSessionWindow } from './session-window';
import type { ChannelStatus, ChannelType } from './types';

export interface TransferCandidateChannel {
  id: string;
  /** Rótulo do operador — é o que a UI mostra, nunca o tipo (§4.1 ponto 1). */
  name: string;
  type: ChannelType;
  status: ChannelStatus;
  /**
   * Estado da janela na thread deste contato NESTE canal — `null`
   * quando o contato ainda não tem conversa ali. Ignorado para canais
   * sem `sessionWindow24h`.
   */
  sessionWindow: ChannelSessionWindow | null;
}

export type TransferIneligibleReason =
  | 'same_channel'
  | 'not_connected'
  | 'no_text_capability'
  | 'session_window_closed';

export interface TransferChannelEvaluation {
  channel: TransferCandidateChannel;
  eligible: boolean;
  reason?: TransferIneligibleReason;
}

/**
 * Avalia um único canal como destino, a partir do canal onde a
 * conversa atual está. Nunca lança.
 */
export function evaluateTransferChannel(
  channel: TransferCandidateChannel,
  currentChannelId: string
): TransferChannelEvaluation {
  if (channel.id === currentChannelId) {
    return { channel, eligible: false, reason: 'same_channel' };
  }

  if (channel.status !== 'connected') {
    return { channel, eligible: false, reason: 'not_connected' };
  }

  if (!can(channel.type, 'text')) {
    return { channel, eligible: false, reason: 'no_text_capability' };
  }

  // D-3: um canal com janela só é destino válido se ELE estiver aberto
  // — a janela do canal atual não importa aqui, o que importa é se o
  // ENVIO PARA O DESTINO seria aceito pela Meta sem template.
  if (can(channel.type, 'sessionWindow24h')) {
    const windowOpen = channel.sessionWindow?.isOpen ?? false;
    if (!windowOpen) {
      return { channel, eligible: false, reason: 'session_window_closed' };
    }
  }

  return { channel, eligible: true };
}

/** Avalia uma lista de canais candidatos, na ordem recebida. */
export function evaluateTransferChannels(
  channels: readonly TransferCandidateChannel[],
  currentChannelId: string
): TransferChannelEvaluation[] {
  return channels.map((channel) =>
    evaluateTransferChannel(channel, currentChannelId)
  );
}

/**
 * Só os canais elegíveis, para quem não precisa do motivo de recusa
 * (a UI usa `evaluateTransferChannels` quando precisa mostrar o D-3
 * desabilitado-com-motivo; a rota de envio usa esta para validar).
 */
export function eligibleTransferChannels(
  channels: readonly TransferCandidateChannel[],
  currentChannelId: string
): TransferCandidateChannel[] {
  return evaluateTransferChannels(channels, currentChannelId)
    .filter((e) => e.eligible)
    .map((e) => e.channel);
}
