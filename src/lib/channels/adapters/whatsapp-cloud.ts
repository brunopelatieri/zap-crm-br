/**
 * Adaptador do canal oficial (WhatsApp Cloud API).
 *
 * Este arquivo NÃO reimplementa nada: embrulha o `lib/whatsapp/meta-api`
 * que já existe e está testado, expondo-o pela interface `ChannelAdapter`.
 * É o que permite ao `send.ts` (F2) tratar Meta e Evolution pela mesma
 * porta, sem que o canal oficial mude uma linha de comportamento.
 *
 * `normalizeInbound` continua lançando, e isso é deliberado
 *
 *   A F2 moveu a INGESTÃO (o que acontece depois de a mensagem entrar)
 *   para `lib/channels/ingest.ts`, mas a tradução do payload da Meta
 *   ficou na rota do webhook dela. O motivo é a assinatura: normalizar
 *   uma mensagem da Cloud API exige verificar cada mídia contra a Graph
 *   API — uma chamada de rede assíncrona, com o token da conta —, e
 *   `normalizeInbound(raw): NormalizedInbound[]` é síncrona e sem
 *   credencial. Forçar a tradução aqui pediria mudar o contrato de todos
 *   os canais por causa de um.
 *
 *   Lançar continua sendo mais honesto que devolver `[]`: um array vazio
 *   silenciaria mensagens se alguém plugasse este adaptador na entrada.
 */

import {
  sendTextMessage,
  sendMediaMessage,
  sendTemplateMessage,
  sendInteractiveButtons,
  sendInteractiveList,
  sendReactionMessage,
} from '@/lib/whatsapp/meta-api';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';
import type { MessageTemplate } from '@/types';
import { capabilitiesFor } from '../capabilities';
import type {
  ChannelAdapter,
  ChannelContext,
  NormalizedInbound,
  SendInteractiveParams,
  SendMediaParams,
  SendReactionParams,
  SendResult,
  SendTemplateParams,
  SendTextParams,
} from '../types';

/**
 * Credenciais que `resolve.ts` entrega para este canal. Vêm de
 * `whatsapp_config`, com o token já decriptado.
 */
function credentials(ctx: ChannelContext): {
  phoneNumberId: string;
  accessToken: string;
} {
  const phoneNumberId = ctx.credentials.phoneNumberId;
  const accessToken = ctx.credentials.accessToken;

  if (!phoneNumberId || !accessToken) {
    throw new Error(
      `channel ${ctx.channel.id} is missing Cloud API credentials`
    );
  }
  return { phoneNumberId, accessToken };
}

export const whatsappCloudAdapter: ChannelAdapter = {
  type: 'whatsapp_cloud',
  capabilities: capabilitiesFor('whatsapp_cloud'),

  async sendText(ctx, p: SendTextParams): Promise<SendResult> {
    const { phoneNumberId, accessToken } = credentials(ctx);
    const r = await sendTextMessage({
      phoneNumberId,
      accessToken,
      to: p.to,
      text: p.text,
      contextMessageId: p.quotedProviderMessageId ?? undefined,
    });
    return { providerMessageId: r.messageId };
  },

  async sendMedia(ctx, p: SendMediaParams): Promise<SendResult> {
    const { phoneNumberId, accessToken } = credentials(ctx);
    const r = await sendMediaMessage({
      phoneNumberId,
      accessToken,
      to: p.to,
      kind: p.kind,
      link: p.url,
      caption: p.caption ?? undefined,
      filename: p.filename ?? undefined,
      contextMessageId: p.quotedProviderMessageId ?? undefined,
    });
    return { providerMessageId: r.messageId };
  },

  async sendTemplate(ctx, p: SendTemplateParams): Promise<SendResult> {
    const { phoneNumberId, accessToken } = credentials(ctx);
    const r = await sendTemplateMessage({
      phoneNumberId,
      accessToken,
      to: p.to,
      templateName: p.templateName,
      language: p.language ?? undefined,
      // `components` / `definition` são `unknown` na interface de
      // propósito: template é conceito da Meta, e tipá-los em `types.ts`
      // arrastaria `SendTimeParams` e `MessageTemplate` para dentro da
      // abstração de canais — o vazamento que o cabeçalho de types.ts
      // proíbe. Os casts são seguros porque este adaptador é o ÚNICO
      // consumidor dos campos, e só o caminho de envio Cloud os produz.
      messageParams: p.components as SendTimeParams | undefined,
      // Sem a linha do template a Meta rejeita header de mídia e não
      // monta botão de URL com variável — ver `SendTemplateParams`.
      template: (p.definition as MessageTemplate | undefined) ?? undefined,
      params: p.positionalParams,
      contextMessageId: p.quotedProviderMessageId ?? undefined,
    });
    return { providerMessageId: r.messageId };
  },

  async sendInteractive(ctx, p: SendInteractiveParams): Promise<SendResult> {
    const { phoneNumberId, accessToken } = credentials(ctx);
    const payload = p.payload;

    if (payload.kind === 'buttons') {
      const r = await sendInteractiveButtons({
        phoneNumberId,
        accessToken,
        to: p.to,
        bodyText: payload.body,
        buttons: payload.buttons,
        headerText: payload.header,
        footerText: payload.footer,
        contextMessageId: p.quotedProviderMessageId ?? undefined,
      });
      return { providerMessageId: r.messageId };
    }

    const r = await sendInteractiveList({
      phoneNumberId,
      accessToken,
      to: p.to,
      bodyText: payload.body,
      buttonLabel: payload.button_label,
      sections: payload.sections,
      headerText: payload.header,
      footerText: payload.footer,
      contextMessageId: p.quotedProviderMessageId ?? undefined,
    });
    return { providerMessageId: r.messageId };
  },

  async sendReaction(ctx, p: SendReactionParams): Promise<SendResult> {
    const { phoneNumberId, accessToken } = credentials(ctx);
    const r = await sendReactionMessage({
      phoneNumberId,
      accessToken,
      to: p.to,
      targetMessageId: p.targetProviderMessageId,
      // Emoji vazio remove a reação (spec da Cloud API).
      emoji: p.emoji,
    });
    return { providerMessageId: r.messageId };
  },

  normalizeInbound(): NormalizedInbound[] {
    throw new Error(
      'whatsapp-cloud normalizeInbound is not used — the Meta webhook route translates its own payload (media verification needs the account token); ingestion itself lives in lib/channels/ingest.ts'
    );
  },
};
