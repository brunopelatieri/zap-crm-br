'use client';

/**
 * Início do disparo do wizard (SPEC 044 §6.1).
 *
 * Este hook já foi o motor de envio inteiro: resolvia a audiência,
 * criava contatos importados, inseria destinatários e percorria os
 * lotes com `await fetch(...)` + `sleep(1000)` — tudo no navegador.
 * Fechar a aba matava a campanha no meio.
 *
 * Agora ele só INICIA. `POST /api/broadcasts/send` persiste tudo,
 * responde 202 e faz o fan-out em `after()`; o progresso real é
 * acompanhado pelo polling da lista e da tela de detalhe. Tudo o que
 * saiu daqui foi para módulos de servidor com o mesmo comportamento:
 *
 *   • resolução da audiência → `lib/audience/resolve.ts`
 *   • variáveis por contato  → `lib/whatsapp/broadcast-variables.ts`
 *   • planejamento + envio   → `lib/whatsapp/broadcast-dispatch.ts`
 *                              + `lib/whatsapp/broadcast-core.ts`
 *
 * A assinatura `createAndSendBroadcast(payload) => Promise<string>` não
 * mudou — é o compromisso 2 da §1.6, e é o que permitiu trocar o motor
 * sem tocar em `new/page.tsx`.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import type { MessageTemplate } from '@/types';
import type {
  AudienceConfig,
  CustomFieldFilter,
  CustomFieldOperator,
} from '@/lib/audience/estimate';
import type { VariableMapping } from '@/lib/whatsapp/broadcast-variables';

export type {
  AudienceConfig,
  CustomFieldFilter,
  CustomFieldOperator,
  VariableMapping,
};

interface BroadcastPayload {
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  /**
   * URL de mídia para header IMAGE/VIDEO/DOCUMENT. Obrigatória no envio
   * de templates com header de mídia — a Meta recusa sem ela. Vai como
   * override e o servidor cai na URL guardada no template se vier vazia.
   */
  headerMediaUrl?: string;
  /**
   * ISO do disparo agendado (SPEC 044 §6.3). Ausente = enviar agora.
   * Presente, a rota grava `status = 'scheduled'` e o cron retoma.
   */
  scheduledAt?: string;
  /**
   * Fuso IANA em que o horário foi escolhido. É nele que a janela de
   * horário permitido é avaliada — no servidor e depois no cron.
   */
  timeZone?: string;
  /** O usuário aceitou disparar fora da janela permitida. */
  windowOverride?: boolean;
  /**
   * Teste A/B (SPEC 044 §6.6). Presente, o servidor divide a audiência
   * entre os dois templates e cria duas campanhas ligadas. O mapeamento
   * de variáveis é o DESTE template — o outro tem os próprios
   * placeholders.
   */
  abTest?: {
    template: MessageTemplate;
    variables: Record<string, VariableMapping>;
    headerMediaUrl?: string;
    splitPercent: number;
  };
}

export interface BroadcastStartResult {
  broadcastId: string;
  status: 'sending' | 'scheduled';
  scheduledAt?: string;
}

interface UseBroadcastSendingReturn {
  createAndSendBroadcast: (
    payload: BroadcastPayload
  ) => Promise<BroadcastStartResult>;
  isProcessing: boolean;
  /**
   * 0–100 do HANDSHAKE, não do envio. A rota responde assim que as
   * linhas estão no banco; a partir daí quem mostra progresso real é a
   * tela de detalhe, que faz polling enquanto o status é `sending`.
   */
  progress: number;
}

/** Códigos de erro tipados da rota → chaves de i18n. */
const ERROR_CODES = new Set([
  'whatsapp_not_configured',
  // SPEC 049 §5.3 — distinct from the code above: the account HAS a
  // channel, just not one that can broadcast (QR-only).
  'channel_not_capable',
  'empty_audience',
  'quota_exceeded',
  'too_many_recipients',
  'template_malformed',
  'template_not_found',
  'draft_not_found',
  'bad_request',
  'internal',
  // Fase 7 (§6.3, §6.8)
  'all_opted_out',
  'outside_send_window',
  'schedule_in_past',
  'schedule_too_far',
  // §6.4 e §6.6
  'all_whatsapp_invalid',
  'ab_same_template',
  'ab_category_mismatch',
  'ab_audience_too_small',
]);

/**
 * Erro da rota com o CÓDIGO preservado.
 *
 * A mensagem já vem traduzida (é ela que o `toast` mostra), mas o passo 4
 * precisa distinguir `outside_send_window` de qualquer outra falha para
 * poder oferecer o override da §6.3 em vez de só reclamar — daí o código
 * e o horário sugerido virem junto.
 */
export class BroadcastRequestError extends Error {
  readonly code: string;
  readonly suggestedAt?: string;
  readonly window?: string;

  constructor(
    code: string,
    message: string,
    extra: { suggestedAt?: string; window?: string } = {}
  ) {
    super(message);
    this.name = 'BroadcastRequestError';
    this.code = code;
    this.suggestedAt = extra.suggestedAt;
    this.window = extra.window;
  }
}

export function useBroadcastSending(): UseBroadcastSendingReturn {
  const t = useTranslations('Broadcasts.audience.sendError');
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  async function createAndSendBroadcast(
    payload: BroadcastPayload
  ): Promise<BroadcastStartResult> {
    setIsProcessing(true);
    setProgress(10);

    try {
      const res = await fetch('/api/broadcasts/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: payload.name,
          templateName: payload.template.name,
          templateLanguage: payload.template.language ?? 'en_US',
          audience: payload.audience,
          variables: payload.variables,
          headerMediaUrl: payload.headerMediaUrl,
          scheduledAt: payload.scheduledAt,
          // O fuso vai sempre, agendado ou não: a janela de horário
          // (§6.3) é avaliada no fuso de quem dispara, e o servidor não
          // tem como adivinhá-lo.
          timeZone:
            payload.timeZone ??
            Intl.DateTimeFormat().resolvedOptions().timeZone,
          windowOverride: payload.windowOverride ?? false,
          abTest: payload.abTest
            ? {
                templateName: payload.abTest.template.name,
                templateLanguage: payload.abTest.template.language ?? 'en_US',
                variables: payload.abTest.variables,
                headerMediaUrl: payload.abTest.headerMediaUrl,
                splitPercent: payload.abTest.splitPercent,
              }
            : undefined,
        }),
      });

      setProgress(70);

      if (res.status === 429) {
        throw new BroadcastRequestError('rate_limited', t('rate_limited'));
      }

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        const code = typeof data?.code === 'string' ? data.code : 'internal';
        // A mensagem do servidor é a de log; a que o usuário lê é a
        // traduzida. Um código desconhecido cai no genérico em vez de
        // vazar texto interno para a tela.
        throw new BroadcastRequestError(
          code,
          ERROR_CODES.has(code) ? t(code) : t('internal'),
          {
            suggestedAt:
              typeof data?.suggestedAt === 'string'
                ? data.suggestedAt
                : undefined,
            window: typeof data?.window === 'string' ? data.window : undefined,
          }
        );
      }

      if (typeof data?.broadcastId !== 'string') {
        throw new Error(t('internal'));
      }

      setProgress(100);
      return {
        broadcastId: data.broadcastId,
        status: data.status === 'scheduled' ? 'scheduled' : 'sending',
        scheduledAt:
          typeof data.scheduledAt === 'string' ? data.scheduledAt : undefined,
      };
    } finally {
      setIsProcessing(false);
    }
  }

  return { createAndSendBroadcast, isProcessing, progress };
}
