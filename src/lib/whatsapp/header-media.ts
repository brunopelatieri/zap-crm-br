// ============================================================
// Header de mídia de template — resolução para envio.
//
// Um template com header `image`/`video`/`document` exige que a Meta
// consiga BUSCAR o arquivo por URL no momento do envio. Depois da
// migração 040 o bucket `chat-media` é privado, então a URL guardada em
// `message_templates.header_media_url` não é mais buscável por
// terceiros — precisa ser assinada na hora.
//
// Três chamadores precisam exatamente disso, e por isso a lógica vive
// aqui e não duplicada em cada um:
//   • `lib/whatsapp/send-message.ts`      (inbox + API pública)
//   • `lib/automations/meta-send.ts`      (motor de automações)
//   • `lib/flows/meta-send.ts`            (motor de flows, via template)
//
// ⚠️ `header_media_url` NEM SEMPRE É NOSSO. O campo aceita URL externa
//    colada pelo usuário (step3-personalize.tsx, template-manager.tsx).
//    `resolveMediaUrlForServer` devolve a URL intocada nesse caso — é o
//    comportamento correto, e é o motivo de a assinatura não poder ser
//    feita cegamente com `createSignedUrl`.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageTemplate } from '@/types';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';
import { resolveMediaUrlForServer } from '@/lib/storage/sign-media';
import { SIGNED_URL_TTL_SECONDS } from '@/lib/storage/media-url';

const MEDIA_HEADER_TYPES = ['image', 'video', 'document'] as const;

export function isMediaHeaderTemplate(
  template: Pick<MessageTemplate, 'header_type'> | null | undefined
): boolean {
  return (
    !!template?.header_type &&
    (MEDIA_HEADER_TYPES as readonly string[]).includes(template.header_type)
  );
}

/**
 * Devolve os `SendTimeParams` a passar para `sendTemplateMessage`, com
 * `headerMediaUrl` já assinado quando o header aponta para um objeto
 * nosso.
 *
 * Entra como OVERRIDE em `messageParams.headerMediaUrl`, que o
 * `template-send-builder` já prefere sobre `template.header_media_url`
 * — assim o builder continua puro e sem noção de que buckets existem.
 *
 * Devolve `existing` inalterado quando não há nada a assinar: header de
 * texto, template sem header, ou envio por `headerMediaId` (id real de
 * /media na Meta, que tem precedência e não é URL).
 *
 * Lança quando o objeto deveria ser nosso mas não pôde ser resolvido —
 * falhar aqui é melhor do que mandar à Meta um link que ela não abre e
 * receber um erro genérico de template.
 */
export async function withSignedHeaderMedia(
  supabase: SupabaseClient,
  template: MessageTemplate | null | undefined,
  existing?: SendTimeParams
): Promise<SendTimeParams | undefined> {
  if (!template || !isMediaHeaderTemplate(template)) return existing;
  if (existing?.headerMediaId) return existing;

  const storedUrl = existing?.headerMediaUrl ?? template.header_media_url;
  if (!storedUrl) return existing;

  const resolved = await resolveMediaUrlForServer(supabase, storedUrl);
  if (!resolved) {
    throw new Error(
      'Could not resolve the template header media for sending — the file may have been removed from storage.'
    );
  }

  return { ...(existing ?? {}), headerMediaUrl: resolved };
}

/**
 * Reassina antes de expirar. Para DISPAROS EM MASSA.
 *
 * ⚠️ Por que uma assinatura só não serve aqui.
 *
 *   `withSignedHeaderMedia` produz uma URL válida por
 *   `SIGNED_URL_TTL_SECONDS` (10 min). Isso basta para um envio avulso,
 *   mas um broadcast percorre milhares de destinatários em sequência: a
 *   URL assinada no primeiro deles já teria expirado no milésimo, e a
 *   Meta passaria a recusar o header no meio da campanha — metade dos
 *   contatos recebe a imagem, metade recebe erro. Falha parcial e
 *   silenciosa, das piores de diagnosticar.
 *
 *   Este resolvedor devolve uma função a ser chamada POR DESTINATÁRIO,
 *   com os `SendTimeParams` daquele destinatário (que variam: cada
 *   linha do disparo tem suas próprias variáveis de corpo). Ela
 *   reaproveita a assinatura do header enquanto houver folga e minta
 *   uma nova quando o prazo aperta, então o custo é uma assinatura a
 *   cada poucos minutos, não uma por destinatário.
 *
 * Para template sem header de mídia, devolve os params recebidos sem
 * tocar em nada — o chamador não precisa ramificar.
 */
export function createHeaderMediaResolver(
  supabase: SupabaseClient,
  template: MessageTemplate | null | undefined
): (existing?: SendTimeParams) => Promise<SendTimeParams | undefined> {
  if (!template || !isMediaHeaderTemplate(template)) {
    return async (existing) => existing;
  }

  // Margem: reassina um minuto antes do vencimento real, para nenhuma
  // URL chegar à Meta já expirada por causa da latência do request.
  const refreshAfterMs = (SIGNED_URL_TTL_SECONDS - 60) * 1000;

  let cachedUrl: string | null = null;
  let signedAt = 0;

  return async (existing) => {
    // Override por destinatário (`headerMediaId` ou uma URL própria) não
    // entra no cache: é do destinatário, não do template.
    if (existing?.headerMediaId || existing?.headerMediaUrl) {
      return withSignedHeaderMedia(supabase, template, existing);
    }

    if (!cachedUrl || Date.now() - signedAt >= refreshAfterMs) {
      const signed = await withSignedHeaderMedia(supabase, template);
      cachedUrl = signed?.headerMediaUrl ?? null;
      signedAt = Date.now();
    }

    if (!cachedUrl) return existing;
    return { ...(existing ?? {}), headerMediaUrl: cachedUrl };
  };
}
