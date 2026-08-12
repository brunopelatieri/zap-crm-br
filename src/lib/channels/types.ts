/**
 * Vocabulário da camada de canais (PRD 047 / SPEC 048 F1).
 *
 * Este arquivo não faz nada — declara o contrato que permite ao inbox,
 * às automações, aos flows e à IA falarem com QUALQUER canal sem saber
 * qual é. Um canal novo implementa `ChannelAdapter`, declara suas
 * capacidades, e o resto do sistema não muda.
 *
 * O que NÃO está aqui, de propósito
 *
 *   Nada específico da Meta e nada específico da Evolution. Se um tipo
 *   daqui menciona `phone_number_id` ou `instanceToken`, a abstração
 *   vazou — e o próximo canal (Instagram, e-mail) pagará por isso.
 */

import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive';

/**
 * Tipos de canal suportados. Adicionar um valor aqui obriga, por
 * exaustividade do TypeScript, a declarar suas capacidades em
 * `capabilities.ts` e a registrar um adaptador em `registry.ts`.
 */
export const CHANNEL_TYPES = ['whatsapp_cloud', 'whatsapp_qr'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export type ChannelStatus =
  'disconnected' | 'connecting' | 'connected' | 'error' | 'disabled';

/** Linha de `channels` (migração 055). */
export interface Channel {
  id: string;
  account_id: string;
  user_id: string;
  type: ChannelType;
  /** Rótulo do operador — aparece no filtro do inbox e nos avisos. */
  name: string;
  /** Telefone/handle conectado. NULL enquanto não pareado. */
  identifier: string | null;
  status: ChannelStatus;
  status_detail: string | null;
  is_default: boolean;
  connected_at: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * O que um canal sabe fazer. Matriz declarativa em `capabilities.ts` —
 * UI, validação de automações e runtime leem a MESMA fonte, para que
 * não exista botão que erra ao clicar.
 */
export interface ChannelCapabilities {
  text: boolean;
  media: { image: boolean; video: boolean; audio: boolean; document: boolean };
  /** Áudio "gravado na hora" (push-to-talk). */
  ptt: boolean;
  location: boolean;
  poll: boolean;
  interactiveButtons: boolean;
  interactiveList: boolean;
  templates: boolean;
  reactions: boolean;
  replyQuote: boolean;
  editMessage: boolean;
  deleteForEveryone: boolean;
  typingIndicator: boolean;
  markRead: boolean;
  deliveryReceipts: boolean;
  /** Disparo em massa — regra de produto, não só técnica. */
  broadcast: boolean;
  /** A janela de 24h da Meta se aplica? (PRD §7.1) */
  sessionWindow24h: boolean;
  /** O tier de limite de mensagens da Meta se aplica? */
  messagingLimit: boolean;
}

// ------------------------------------------------------------
// Envio
// ------------------------------------------------------------

/**
 * Credenciais já resolvidas e decriptadas por `resolve.ts` — o único
 * lugar da camada que toca `ENCRYPTION_KEY`. Um adaptador nunca
 * decripta nada por conta própria.
 */
export interface ChannelContext {
  accountId: string;
  channel: Channel;
  credentials: Record<string, string>;
}

export interface SendResult {
  /** Id da mensagem no provedor (wamid na Meta, ID no whatsmeow). */
  providerMessageId: string;
}

export interface SendTextParams {
  to: string;
  text: string;
  /** Id da mensagem citada, quando o canal suporta `replyQuote`. */
  quotedProviderMessageId?: string | null;
}

export interface SendMediaParams {
  to: string;
  kind: 'image' | 'video' | 'audio' | 'document';
  /** URL já assinada quando a mídia vem do bucket privado. */
  url: string;
  caption?: string | null;
  filename?: string | null;
}

export interface SendLocationParams {
  to: string;
  latitude: number;
  longitude: number;
  name?: string | null;
  address?: string | null;
}

export interface SendPollParams {
  to: string;
  question: string;
  options: string[];
  /** Quantas opções o destinatário pode marcar. */
  maxAnswers?: number;
}

export interface SendTemplateParams {
  to: string;
  templateName: string;
  language?: string | null;
  /** Estrutura já montada pelo builder de template do canal Cloud. */
  components?: unknown;
}

export interface SendInteractiveParams {
  to: string;
  payload: InteractiveMessagePayload;
}

// ------------------------------------------------------------
// Recebimento
// ------------------------------------------------------------

/**
 * Evento de entrada, já traduzido do formato do provedor. É o que
 * `ingest.ts` (F2) consome — o webhook de cada provedor vira um
 * tradutor fino que produz isto.
 */
export type NormalizedInbound =
  NormalizedMessage | NormalizedStatusUpdate | NormalizedConnectionUpdate;

export interface NormalizedMessage {
  kind: 'message';
  /** Quem escreveu. E.164 sem sufixo de dispositivo (SPEC 048 §1.2 R4). */
  fromPhone: string;
  /** Identificador alternativo do provedor (ex.: LID), quando houver. */
  fromExternalId?: string | null;
  /** Nome de exibição informado pelo provedor. */
  pushName?: string | null;
  providerMessageId: string;
  /**
   * `true` quando a mensagem saiu do aparelho do operador, não do CRM.
   * O canal QRCode entrega isso via `SEND_MESSAGE` — algo que o canal
   * oficial não oferece.
   */
  fromMe: boolean;
  contentType:
    | 'text'
    | 'image'
    | 'document'
    | 'audio'
    | 'video'
    | 'location'
    | 'interactive';
  text?: string | null;
  mediaUrl?: string | null;
  mediaId?: string | null;
  /** Id do botão/linha tocado, quando o canal suporta interativos. */
  interactiveReplyId?: string | null;
  /** Instante DO PROVEDOR — nunca do nosso servidor (SPEC 045 §5.2.1). */
  occurredAt: Date;
  /** Mensagem citada, quando houver. */
  replyToProviderMessageId?: string | null;
}

export interface NormalizedStatusUpdate {
  kind: 'status';
  providerMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  occurredAt: Date;
  error?: string | null;
}

export interface NormalizedConnectionUpdate {
  kind: 'connection';
  status: ChannelStatus;
  detail?: string | null;
  /** Telefone conectado, quando o evento o informa. */
  identifier?: string | null;
}

// ------------------------------------------------------------
// Adaptador
// ------------------------------------------------------------

/**
 * Um canal concreto. Os métodos opcionais correspondem a capacidades
 * opcionais: quem chama consulta `capabilities` ANTES, e nunca deve
 * descobrir a ausência por um `undefined` em runtime.
 */
export interface ChannelAdapter {
  readonly type: ChannelType;
  readonly capabilities: ChannelCapabilities;

  sendText(ctx: ChannelContext, p: SendTextParams): Promise<SendResult>;
  sendMedia(ctx: ChannelContext, p: SendMediaParams): Promise<SendResult>;

  sendLocation?(
    ctx: ChannelContext,
    p: SendLocationParams
  ): Promise<SendResult>;
  sendPoll?(ctx: ChannelContext, p: SendPollParams): Promise<SendResult>;
  sendTemplate?(
    ctx: ChannelContext,
    p: SendTemplateParams
  ): Promise<SendResult>;
  sendInteractive?(
    ctx: ChannelContext,
    p: SendInteractiveParams
  ): Promise<SendResult>;

  /** Traduz o payload cru do provedor em eventos normalizados. */
  normalizeInbound(raw: unknown): NormalizedInbound[];
}
