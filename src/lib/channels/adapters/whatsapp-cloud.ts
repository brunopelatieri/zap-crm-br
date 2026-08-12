/**
 * Adaptador do canal oficial (WhatsApp Cloud API).
 *
 * Este arquivo NÃO reimplementa nada: embrulha o `lib/whatsapp/meta-api`
 * que já existe e está testado, expondo-o pela interface `ChannelAdapter`.
 * É o que permite ao `send.ts` (F2) tratar Meta e Evolution pela mesma
 * porta, sem que o canal oficial mude uma linha de comportamento.
 *
 * `normalizeInbound` fica vazio de propósito
 *
 *   O webhook da Meta ainda faz a tradução inline, dentro da própria
 *   rota. Movê-la para cá é trabalho da F2 (`ingest.ts`), que é um PR
 *   isolado com testes de paridade — é o caminho crítico de recebimento
 *   de mensagem e não pode viajar junto com a fundação. Até lá, lançar
 *   é mais honesto que devolver `[]`: um array vazio silenciaria
 *   mensagens se alguém plugasse este adaptador cedo demais.
 */

import {
  sendTextMessage,
  sendMediaMessage,
  sendTemplateMessage,
  sendInteractiveButtons,
  sendInteractiveList,
} from '@/lib/whatsapp/meta-api';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';
import { capabilitiesFor } from '../capabilities';
import type {
  ChannelAdapter,
  ChannelContext,
  NormalizedInbound,
  SendInteractiveParams,
  SendMediaParams,
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
      // `components` é `unknown` na interface de propósito: template é
      // conceito da Meta, e tipá-lo em `types.ts` arrastaria
      // `SendTimeParams` para dentro da abstração de canais — o
      // vazamento que o cabeçalho de types.ts proíbe. O cast é seguro
      // porque este adaptador é o ÚNICO consumidor do campo, e só o
      // caminho de envio Cloud o produz.
      messageParams: p.components as SendTimeParams | undefined,
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
    });
    return { providerMessageId: r.messageId };
  },

  normalizeInbound(): NormalizedInbound[] {
    throw new Error(
      'whatsapp-cloud normalizeInbound lands in F2 (ingest.ts) — the Meta webhook still translates inline'
    );
  },
};
