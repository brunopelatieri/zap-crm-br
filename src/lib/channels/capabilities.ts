/**
 * O que cada canal sabe fazer (PRD 047 §6.2 / SPEC 048 §1.1-bis).
 *
 * Capacidade é DADO, não `if`
 *
 *   A interface, a validação de automações e o runtime leem esta mesma
 *   matriz. É o que garante que o composer não ofereça template num
 *   canal sem template, que o editor de automação avise antes de salvar,
 *   e que o motor recuse com motivo legível em vez de estourar um erro
 *   opaco do provedor. Um canal novo declara suas capacidades aqui e a
 *   interface se adapta sozinha.
 *
 * Os valores do canal QRCode foram MEDIDOS, não deduzidos
 *
 *   Em 12/08/2026, contra uma instância Evolution Go real e um número
 *   real: `/send/text` e `/send/poll` entregaram; `/send/button` e
 *   `/send/list` foram recusados pelo WhatsApp com
 *   `500 {"error":"server returned error 405"}` — duas vezes, com
 *   payloads diferentes. O endpoint existe na API; a Meta é que não
 *   aceita numa conexão não-oficial. Confirmado no aparelho: o que
 *   deu 200 chegou, o que deu 405 não chegou.
 *
 *   Por isso `interactiveButtons` e `interactiveList` são `false` aqui —
 *   e não por precaução.
 */

import type { ChannelCapabilities, ChannelType } from './types';

const CLOUD: ChannelCapabilities = {
  text: true,
  media: { image: true, video: true, audio: true, document: true },
  ptt: true,
  location: true,
  // A Cloud API não tem enquete nativa.
  poll: false,
  interactiveButtons: true,
  interactiveList: true,
  templates: true,
  reactions: true,
  replyQuote: true,
  // Editar/apagar para todos não existe na Cloud API.
  editMessage: false,
  deleteForEveryone: false,
  typingIndicator: false,
  markRead: true,
  deliveryReceipts: true,
  broadcast: true,
  sessionWindow24h: true,
  messagingLimit: true,
};

const QR: ChannelCapabilities = {
  text: true,
  media: { image: true, video: true, audio: true, document: true },
  // Sem endpoint dedicado de PTT: `/send/media` com `type: audio` envia,
  // mas se sai como "gravado agora" ou como arquivo ainda não foi
  // verificado no aparelho. Conservador até lá.
  ptt: false,
  location: true,
  // Único mecanismo interativo que a Meta aceita neste canal.
  poll: true,
  // MEDIDO: WhatsApp devolve 405. Ver cabeçalho.
  interactiveButtons: false,
  interactiveList: false,
  // Template é conceito da Meta — não existe fora da Cloud API.
  templates: false,
  reactions: true,
  replyQuote: true,
  editMessage: true,
  deleteForEveryone: true,
  typingIndicator: true,
  markRead: true,
  deliveryReceipts: true,
  // REGRA DE PRODUTO, não limitação técnica: disparo em massa por
  // instância não-oficial é o caminho mais rápido para o banimento.
  broadcast: false,
  // Não fala com a Meta, logo não há janela de sessão nem tier.
  sessionWindow24h: false,
  messagingLimit: false,
};

/**
 * Matriz completa. `Record<ChannelType, …>` é o que faz o TypeScript
 * exigir uma entrada nova sempre que `ChannelType` ganha um valor —
 * um canal não pode nascer sem capacidades declaradas.
 */
export const CHANNEL_CAPABILITIES: Record<ChannelType, ChannelCapabilities> = {
  whatsapp_cloud: CLOUD,
  whatsapp_qr: QR,
};

export function capabilitiesFor(type: ChannelType): ChannelCapabilities {
  return CHANNEL_CAPABILITIES[type];
}

/** Capacidades booleanas de primeiro nível (exclui o objeto `media`). */
export type ChannelCapabilityKey = {
  [K in keyof ChannelCapabilities]: ChannelCapabilities[K] extends boolean
    ? K
    : never;
}[keyof ChannelCapabilities];

/**
 * O canal suporta esta capacidade?
 *
 * ```ts
 * if (!can(channel.type, 'templates')) { … }
 * ```
 */
export function can(
  type: ChannelType,
  capability: ChannelCapabilityKey
): boolean {
  return CHANNEL_CAPABILITIES[type][capability];
}

/** O canal envia este tipo de mídia? */
export function canSendMedia(
  type: ChannelType,
  kind: keyof ChannelCapabilities['media']
): boolean {
  return CHANNEL_CAPABILITIES[type].media[kind];
}

/**
 * Quantos dos tipos de canal de uma conta suportam uma capacidade.
 *
 * `'none'`: nenhum canal possível suporta — o recurso NUNCA funcionaria
 * (armadilha "ativa e falha em silêncio" do AGENTS.md). `'some'`: parte
 * suporta, parte não — vale aviso, não bloqueio, porque bloquear
 * impediria um uso legítimo no canal que suporta. `'all'`: sem ressalva.
 *
 * Usado tanto pela validação de automações (SPEC 049 §5.1.2/§5.1.3)
 * quanto pela guarda de disparo em massa (§5.3) — a mesma pergunta
 * ("este recurso é alcançável pelos canais desta conta?") em dois
 * lugares diferentes.
 */
export function accountCapabilityCoverage(
  accountChannelTypes: ChannelType[],
  capability: ChannelCapabilityKey
): 'none' | 'some' | 'all' {
  const supported = accountChannelTypes.filter((t) => can(t, capability));
  if (supported.length === 0) return 'none';
  if (supported.length === accountChannelTypes.length) return 'all';
  return 'some';
}
