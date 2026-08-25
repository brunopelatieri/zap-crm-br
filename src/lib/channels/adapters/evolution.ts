/**
 * Adaptador de mensageria do canal WhatsApp QRCode — Evolution Go
 * (SPEC 048 F4).
 *
 * Reaproveita o cliente HTTP da F3 (`lib/evolution/client.ts`): mesmo
 * `evolutionRequest`, mesmo `unwrap`, mesmo mapeamento de erro real
 * medido contra o servidor (SPEC 048 §1/§6.1). Este arquivo só
 * acrescenta os endpoints de ENVIO, que a F3 (gerenciamento de
 * instância) não usa.
 *
 * `normalizeInbound` continua lançando, pelo mesmo motivo do adaptador
 * Cloud (`whatsapp-cloud.ts`): a tradução do payload de entrada mora na
 * rota do webhook (`app/api/channels/evolution/webhook/[secret]/route.ts`),
 * porque ela precisa resolver LID→contato (`contact_identities`) e
 * baixar mídia do bucket — trabalho assíncrono que o contrato síncrono
 * de `normalizeInbound(raw): NormalizedInbound[]` não cobre.
 *
 * O corpo de RESPOSTA de sucesso de `/send/*` foi MEDIDO no teste manual
 * do §8.3 (par real, envio nos dois sentidos):
 *
 *   {Info:{Chat,Sender,IsFromMe,ID,Type,Timestamp,…},
 *    Message:{extendedTextMessage|audioMessage|imageMessage:{…}},
 *    MessageContextInfo:{…}}
 *
 * O id vive em `Info.ID` — ver `extractProviderMessageId`, que documenta
 * por que ler o nível errado é um defeito silencioso.
 */

import { after } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import {
  EvolutionApiError,
  evolutionRequest,
  unwrap,
} from '@/lib/evolution/client';
import {
  readEvolutionConfig,
  type EvolutionConfig,
} from '@/lib/evolution/config';
import { evolutionDebugLog } from '@/lib/evolution/debug';
import { ensureContactIdentity } from '@/lib/evolution/contact-identity';
import { pickRecord, pickString } from '@/lib/evolution/payload';
import { capabilitiesFor } from '../capabilities';
import type {
  ChannelAdapter,
  ChannelContext,
  NormalizedInbound,
  SendLocationParams,
  SendMediaParams,
  SendPollParams,
  SendReactionParams,
  SendResult,
  SendTextParams,
} from '../types';

function requireConfig(): EvolutionConfig {
  const config = readEvolutionConfig();
  if (!config) {
    throw new Error(
      'EVOLUTION_API_URL / EVOLUTION_GLOBAL_API_KEY not set — the WhatsApp QRCode channel is disabled'
    );
  }
  return config;
}

/** Credenciais que `resolve.ts`/`send.ts` entregam: o token da
 *  instância, já decriptado (SPEC 048 §1.3 R8 — nasce do nosso lado). */
function credentials(ctx: ChannelContext): { instanceToken: string } {
  const instanceToken = ctx.credentials.instanceToken;
  if (!instanceToken) {
    throw new Error(
      `channel ${ctx.channel.id} is missing the Evolution instance token`
    );
  }
  return { instanceToken };
}

/** A Evolution quer dígitos-only sem `+` — mesma convenção da Meta. O
 *  núcleo (`resolveOutboundContact`) já entrega o telefone sanitizado;
 *  isto é defesa contra um `to` que chegue não-sanitizado por um
 *  caminho novo. */
function toEvolutionNumber(to: string): string {
  return sanitizePhoneForMeta(to);
}

/**
 * Lê o id da mensagem devolvida por `/send/*`.
 *
 * A grafia real é `Info.ID` — maiúscula E ANINHADA. A resposta medida
 * contra o servidor é `{Info:{Chat,Sender,ID,Timestamp,…}, Message:{…},
 * MessageContextInfo:{…}}`: o mesmo `MessageInfo` do whatsmeow que chega
 * no webhook, não um envelope plano. `SendResponse` é struct Go sem tags
 * de json, então `encoding/json` publica os nomes como declarados (`ID`,
 * `ServerID`, `Timestamp`).
 *
 * Procurar só na raiz custou caro duas vezes seguidas: primeiro `id`/`Id`
 * (caixa errada), depois `ID` na raiz (nível errado). Nos dois casos TODA
 * mensagem enviada foi gravada com `message_id` vazio, e o estrago é
 * silencioso — o recibo nunca casa (a mensagem fica em "enviada" para
 * sempre) e o eco `SendMessage` não reconhece o que o próprio CRM mandou,
 * duplicando cada resposta no inbox. Foi exatamente o que o teste com
 * número real mostrou: a bolha original em ✓ e a duplicata em ✓✓, porque
 * só a duplicata tinha o id que o recibo procurava.
 *
 * `pickString` é case-insensitive porque a mesma divergência de caixa
 * aparece em todo o payload da Evolution (ver `lib/evolution/payload.ts`);
 * a ordem abaixo vai do nível medido para os alternativos.
 *
 * NUNCA LANÇA, e essa continua sendo a decisão que importa. Esta função
 * roda DEPOIS de a Evolution ter devolvido 200 — a mensagem já saiu para
 * o cliente. Lançar transformaria uma entrega bem-sucedida em "falha de
 * envio": `sendAndPersistOutbound` não gravaria a linha, a UI mostraria
 * erro, e o operador reenviaria — fazendo o cliente receber duas vezes,
 * em loop. Devolver string vazia e logar alto mantém o modo de falha no
 * barato.
 */
function extractProviderMessageId(data: Record<string, unknown>): string {
  const fromInfo = pickString(pickRecord(data, 'Info'), 'ID', 'id');
  if (fromInfo) return fromInfo;

  const fromKey = pickString(pickRecord(data, 'key'), 'ID', 'id');
  if (fromKey) return fromKey;

  const direct = pickString(data, 'ID', 'messageId', 'id');
  if (direct) return direct;

  console.error(
    '[evolution] /send returned 200 but no recognizable message id — the message WAS delivered. Keys seen:',
    Object.keys(data).join(', ') || '(empty)'
  );
  return '';
}

/**
 * 401/403 num envio quase sempre significa token rotacionado ou
 * instância deslogada direto na VPS, fora do nosso controle (SPEC 048
 * §6.1). Marcar o canal como erro é o que tira a instância "morta" da
 * lista de canais utilizáveis, em vez de o operador só descobrir
 * quando uma mensagem falhar em silêncio. Best-effort: uma falha ao
 * gravar o status não pode mascarar o erro original do envio.
 */
async function flagAuthFailureIfNeeded(
  ctx: ChannelContext,
  err: unknown
): Promise<void> {
  if (err instanceof EvolutionApiError && err.kind === 'channel_auth_failed') {
    try {
      await supabaseAdmin()
        .from('channels')
        .update({ status: 'error', status_detail: err.message })
        .eq('id', ctx.channel.id);
    } catch (flagErr) {
      console.error(
        '[evolution] failed to flag channel auth failure:',
        flagErr
      );
    }
  }
}

async function send(
  ctx: ChannelContext,
  path: string,
  body: Record<string, unknown>,
  timeoutMs?: number
): Promise<SendResult> {
  const config = requireConfig();
  const { instanceToken } = credentials(ctx);
  try {
    const data = unwrap(
      await evolutionRequest(config, path, {
        method: 'POST',
        key: instanceToken,
        body,
        timeoutMs,
      })
    );
    evolutionDebugLog(`${path} → resposta`, data);

    // Fecha a lacuna do backfill puramente reativo do webhook (SPEC 048
    // §6.4): muitos contatos nunca mandam um inbound identificado por
    // telefone — chegam SEMPRE por LID, por causa do rollout de
    // privacidade do WhatsApp — então esperar um inbound phone-identified
    // pra aprender o vínculo telefone→LID é esperar pra sempre nesses
    // casos. Aqui o telefone já é conhecido (é `body.number`, pra ONDE
    // acabamos de mandar), então o vínculo pode nascer ANTES de o
    // contato precisar responder.
    //
    // Vive AQUI, no `send()` compartilhado — não em cada método público
    // (`sendText`, `sendMedia`, …) — porque todo envio que carrega um
    // destinatário passa por aqui. Um método novo (ou um já existente
    // como `sendLocation`/`sendPoll`/`sendReaction`) ganha o backfill de
    // graça, sem precisar lembrar de chamar nada.
    //
    // `after()`, não `void` solto: best-effort e fora do caminho
    // crítico — nunca pode atrasar o envio —, mas uma promessa solta
    // ainda corre o risco de ser abortada pelo runtime assim que a
    // resposta HTTP for enviada (mesma razão pela qual o webhook usa
    // `after()` pro processamento inteiro). `ensureContactIdentity` já é
    // idempotente (pula se já tem vínculo).
    const number = typeof body.number === 'string' ? body.number : null;
    if (number) {
      after(() =>
        ensureContactIdentity({
          accountId: ctx.accountId,
          instanceToken,
          phone: number,
        })
      );
    }

    return { providerMessageId: extractProviderMessageId(data) };
  } catch (err) {
    await flagAuthFailureIfNeeded(ctx, err);
    throw err;
  }
}

export const evolutionAdapter: ChannelAdapter = {
  type: 'whatsapp_qr',
  capabilities: capabilitiesFor('whatsapp_qr'),

  async sendText(ctx, p: SendTextParams): Promise<SendResult> {
    return send(ctx, '/send/text', {
      number: toEvolutionNumber(p.to),
      text: p.text,
      ...(p.quotedProviderMessageId
        ? { quoted: { messageId: p.quotedProviderMessageId } }
        : {}),
    });
  },

  async sendMedia(ctx, p: SendMediaParams): Promise<SendResult> {
    // Timeout maior: a Evolution baixa `p.url` e sobe pro WhatsApp
    // dentro da mesma requisição, então o teto genérico de
    // `requestTimeoutMs` (pensado pra chamadas rápidas de texto/gerência)
    // aborta vídeos maiores antes da Evolution terminar.
    return send(
      ctx,
      '/send/media',
      {
        number: toEvolutionNumber(p.to),
        url: p.url,
        // Valor livre no schema da Evolution ("não é enum fechado") —
        // 'image' | 'video' | 'audio' | 'document' bate com o uso comum
        // documentado.
        type: p.kind,
        ...(p.caption ? { caption: p.caption } : {}),
        ...(p.filename ? { filename: p.filename } : {}),
      },
      requireConfig().mediaRequestTimeoutMs
    );
  },

  async sendLocation(ctx, p: SendLocationParams): Promise<SendResult> {
    return send(ctx, '/send/location', {
      number: toEvolutionNumber(p.to),
      latitude: p.latitude,
      longitude: p.longitude,
      ...(p.name ? { name: p.name } : {}),
      ...(p.address ? { address: p.address } : {}),
    });
  },

  async sendPoll(ctx, p: SendPollParams): Promise<SendResult> {
    return send(ctx, '/send/poll', {
      number: toEvolutionNumber(p.to),
      question: p.question,
      options: p.options,
      ...(p.maxAnswers !== undefined ? { maxAnswer: p.maxAnswers } : {}),
    });
  },

  async sendReaction(ctx, p: SendReactionParams): Promise<SendResult> {
    // Schema real: `{id, number, reaction}` — sem `fromMe`/`participant`,
    // ao contrário de outras implementações da Evolution. Emoji vazio
    // remove a reação, mesma convenção da Cloud API.
    return send(ctx, '/message/react', {
      number: toEvolutionNumber(p.to),
      id: p.targetProviderMessageId,
      reaction: p.emoji,
    });
  },

  normalizeInbound(): NormalizedInbound[] {
    throw new Error(
      'evolution normalizeInbound is not used — the webhook route translates its own payload (LID resolution + media download need to be async); ingestion itself lives in lib/channels/ingest.ts'
    );
  },
};
