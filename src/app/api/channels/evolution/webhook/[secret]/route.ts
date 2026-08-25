/**
 * POST /api/channels/evolution/webhook/[secret] — inbound do canal
 * WhatsApp QRCode (SPEC 048 §6.3-§6.5).
 *
 * ⚠️ LEIA ANTES DE MEXER — duas lições caras estão embutidas aqui.
 *
 * 1. `event` NÃO carrega o nome da FAMÍLIA que se assinou. Assinar
 *    `SEND_MESSAGE` faz chegar um evento chamado `SendMessage`; assinar
 *    `READ_RECEIPT` faz chegar `Receipt`; `CONNECTION` faz chegar
 *    `Connected`/`LoggedOut`/`PairSuccess`. Ver `EVENT_KINDS` abaixo.
 *
 * 2. O `URL` de um proto de mídia aponta para o CDN do WhatsApp e o
 *    conteúdo ali é CIFRADO. Quem serve são o `base64` (que a Evolution
 *    decripta e manda junto) ou um `mediaUrl` de MinIO/S3. Ver
 *    `resolveMediaSource`.
 *
 * Nos dois casos o sintoma não foi erro nenhum — foi mensagem que não
 * aparece e áudio que não toca. Por isso toda leitura aqui é DEFENSIVA e
 * indiferente à caixa (`lib/evolution/payload.ts`): o servidor mistura
 * `encoding/json` sobre struct Go (`Info`, `Chat`, `ID`) com protojson
 * sobre o proto da mensagem (`audioMessage`, `mediaKey`).
 *
 * O que ainda NÃO foi medido contra o servidor real fica marcado caso a
 * caso. Com `EVOLUTION_DEBUG=true` o payload recebido é logado em forma
 * estrutural (sem base64, sem segredo) — é a ferramenta para fechar o
 * resto, e o plano de teste manual da SPEC 048 §8.3 continua sendo o que
 * confirma cada nome.
 *
 * Verificação em cadeia (§6.3), as três obrigatórias antes de qualquer
 * processamento — qualquer falha é 401, sem detalhe no corpo:
 *   1. `secret` do path — timing-safe contra `evolution_instance_secrets`.
 *   2. `instanceId` do payload — bate com a instância dona do secret.
 *   3. `instanceToken` do payload — timing-safe contra o token decriptado.
 *
 * Responde 200 IMEDIATAMENTE e processa em `after()` — a Evolution
 * reentrega 5× a cada 30s e depois desiste, sem dead-letter (§9). Igual
 * ao webhook da Meta (`app/api/whatsapp/webhook/route.ts`), mas aqui a
 * idempotência por `(conversation_id, message_id)` em `ingest.ts` é
 * caminho QUENTE, não defesa em profundidade (§5) — a Evolution
 * reentrega por desenho.
 */

import crypto from 'node:crypto';
import { NextResponse, after } from 'next/server';

import { supabaseAdmin } from '@/lib/supabase/admin';
import { decrypt } from '@/lib/whatsapp/encryption';
import { baseMimeType, buildMediaPath } from '@/lib/storage/upload-media';
import { bindChannelToPhone } from '@/lib/evolution/instances';
import { evolutionDebugLog } from '@/lib/evolution/debug';
import { ensureContactIdentity } from '@/lib/evolution/contact-identity';
import {
  asRecord,
  pickBoolean,
  pickKey,
  pickRecord,
  pickString as firstString,
} from '@/lib/evolution/payload';
import { ingestInbound, type IngestContext } from '@/lib/channels/ingest';
import type {
  NormalizedMessage,
  NormalizedReaction,
} from '@/lib/channels/types';

type Params = { params: Promise<{ secret: string }> };

// ------------------------------------------------------------
// Verificação em cadeia
// ------------------------------------------------------------

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

interface EvolutionWebhookPayload {
  event?: string;
  instanceId?: string;
  instanceToken?: string;
  data?: unknown;
}

interface ResolvedWebhookInstance {
  instanceId: string;
  channelId: string;
  accountId: string;
  ownerUserId: string;
  /** Token já decriptado — reaproveitado pelo backfill de LID abaixo,
   *  sem precisar decriptar de novo. */
  instanceToken: string;
}

async function verifyAndResolve(
  pathSecret: string,
  payload: EvolutionWebhookPayload
): Promise<ResolvedWebhookInstance | null> {
  if (!pathSecret || !payload.instanceId || !payload.instanceToken) {
    return null;
  }
  const db = supabaseAdmin();

  // 1) secret do path.
  const { data: secretRow } = await db
    .from('evolution_instance_secrets')
    .select('instance_id, webhook_secret, instance_token_encrypted')
    .eq('webhook_secret', pathSecret)
    .maybeSingle();
  if (
    !secretRow ||
    !timingSafeEqualStrings(secretRow.webhook_secret, pathSecret)
  ) {
    return null;
  }

  // 2) instanceId do payload — tem que ser da MESMA instância do secret.
  const { data: instance } = await db
    .from('evolution_instances')
    .select('id, channel_id, account_id, remote_instance_id')
    .eq('id', secretRow.instance_id)
    .maybeSingle();
  if (!instance) return null;
  if (
    instance.remote_instance_id &&
    instance.remote_instance_id !== payload.instanceId
  ) {
    return null;
  }

  // 3) instanceToken do payload.
  const instanceToken = decrypt(secretRow.instance_token_encrypted);
  if (!timingSafeEqualStrings(instanceToken, payload.instanceToken)) {
    return null;
  }

  const { data: channel } = await db
    .from('channels')
    .select('user_id')
    .eq('id', instance.channel_id)
    .maybeSingle();
  if (!channel) return null;

  return {
    instanceId: instance.id,
    channelId: instance.channel_id,
    accountId: instance.account_id,
    ownerUserId: channel.user_id,
    instanceToken,
  };
}

export async function POST(request: Request, { params }: Params) {
  const { secret } = await params;
  const rawBody = await request.text();

  let payload: EvolutionWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  // Depois da verificação seria tarde para o caso mais útil (um payload
  // que a cadeia rejeita), mas antes dela um atacante poderia encher o
  // log. Fica aqui, entre os dois: o parse já passou, a autenticação
  // vem a seguir, e o `instanceToken` é redigido pelo próprio logger.
  evolutionDebugLog(`webhook ${payload.event ?? '(sem event)'}`, payload);

  const resolved = await verifyAndResolve(secret, payload);
  if (!resolved) {
    console.warn(
      '[evolution webhook] rejected — secret/instanceId/instanceToken mismatch'
    );
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Mesmo motivo do webhook da Meta: `after()` mantém a função viva até
  // o processamento terminar, mesmo que a plataforma congele a resposta
  // logo após o 200 (serverless).
  after(async () => {
    try {
      await processEvolutionEvent(resolved, payload);
    } catch (err) {
      console.error('[evolution webhook] processing failed:', err);
    }
  });

  return NextResponse.json({ status: 'received' }, { status: 200 });
}

// ------------------------------------------------------------
// Roteamento por evento (§6.3)
// ------------------------------------------------------------

type EventKind =
  'message' | 'send_message' | 'receipt' | 'connection' | 'qrcode';

/**
 * `subscribe[]` e `event` NÃO usam o mesmo vocabulário — e confundir os
 * dois foi o bug que quebrou metade do canal.
 *
 * O que se INSCREVE são famílias (`MESSAGE`, `SEND_MESSAGE`,
 * `READ_RECEIPT`, `CONNECTION`, `QRCODE`); o que CHEGA no campo `event`
 * é o nome específico do evento do whatsmeow (`Message`, `SendMessage`,
 * `Receipt`, `Connected`, `LoggedOut`, `PairSuccess`, `QRCode`) — a
 * tabela da referência §10 mostra a relação, uma família para vários
 * eventos. O código comparava `event.toUpperCase()` com os nomes de
 * FAMÍLIA, então só `Message` e `QRCode` casavam, por coincidência de
 * grafia. `SendMessage` ("SENDMESSAGE" ≠ "SEND_MESSAGE"), `Receipt`
 * ("RECEIPT" ≠ "READ_RECEIPT") e `Connected` ("CONNECTED" ≠
 * "CONNECTION") caíam todos no `default`.
 *
 * O sintoma nunca foi um erro: mensagem enviada pelo celular do operador
 * não aparecia no CRM, recibo de leitura não avançava o status, e
 * `connected_jid`/`connected_phone` ficavam nulos mesmo com a instância
 * pareada — foi essa última pista, visível no banco, que denunciou o
 * padrão.
 *
 * As duas grafias ficam aceitas: a normalização remove `_` e caixa, e a
 * família continua mapeada. Um servidor que mande `READ_RECEIPT` no
 * lugar de `Receipt` funciona igual.
 */
const EVENT_KINDS: Record<string, EventKind> = {
  MESSAGE: 'message',
  SENDMESSAGE: 'send_message',
  RECEIPT: 'receipt',
  READRECEIPT: 'receipt',
  CONNECTION: 'connection',
  CONNECTED: 'connection',
  DISCONNECTED: 'connection',
  LOGGEDOUT: 'connection',
  PAIRSUCCESS: 'connection',
  OFFLINESYNCCOMPLETED: 'connection',
  QRCODE: 'qrcode',
  QRTIMEOUT: 'qrcode',
  QRSUCCESS: 'qrcode',
};

function normalizeEventName(raw: string): string {
  return raw.replace(/[_\s-]/g, '').toUpperCase();
}

async function processEvolutionEvent(
  resolved: ResolvedWebhookInstance,
  payload: EvolutionWebhookPayload
): Promise<void> {
  const rawEvent = payload.event ?? '';
  const normalized = normalizeEventName(rawEvent);
  const kind = EVENT_KINDS[normalized];
  const data = asRecord(payload.data) ?? {};

  switch (kind) {
    case 'message':
      await handleMessageEvent(resolved, data, false);
      break;
    case 'send_message':
      await handleMessageEvent(resolved, data, true);
      break;
    case 'receipt':
      await handleReadReceipt(resolved, payload, data);
      break;
    case 'connection':
      await handleConnectionUpdate(resolved, normalized, data);
      break;
    case 'qrcode':
      // O QR em si NUNCA é persistido (PRD §11) — só o timestamp, para
      // a UI saber que um QR novo foi gerado.
      await supabaseAdmin()
        .from('evolution_instances')
        .update({ last_qr_at: new Date().toISOString() })
        .eq('id', resolved.instanceId);
      break;
    default:
      console.warn('[evolution webhook] evento não reconhecido:', rawEvent);
  }
}

// ------------------------------------------------------------
// MESSAGE / SEND_MESSAGE
// ------------------------------------------------------------

interface ParsedJid {
  phone: string | null;
  lid: string | null;
}

/**
 * Remove o sufixo `:NN` de dispositivo antes do `@` (SPEC 048 §1.2 R4) —
 * sem isso o dedupe da migração 022 nunca casa.
 *
 * O sufixo existe nas DUAS formas de identificador, não só na do
 * telefone: a própria §1.2 R3 mostra o servidor devolvendo
 * `["226559659127039@lid", "226559659127039:11@lid", "226559659127039:12@lid"]`.
 * Como `contact_identities.external_id` guarda o LID CANÔNICO (o que
 * `/user/check` devolve, sem sufixo), normalizar o LID aqui é o que
 * impede uma mensagem de um segundo aparelho do mesmo contato de não
 * casar e ser descartada em silêncio.
 */
function parseJid(raw: string | null | undefined): ParsedJid {
  if (!raw) return { phone: null, lid: null };

  const lidMatch = raw.match(/^(\d+)(?::\d+)?@lid$/);
  if (lidMatch) return { phone: null, lid: `${lidMatch[1]}@lid` };

  const match = raw.match(/^(\d+)(?::\d+)?@s\.whatsapp\.net$/);
  if (match) return { phone: match[1], lid: null };

  // Formato inesperado (grupo, broadcast, etc.) — não adivinha.
  return { phone: null, lid: null };
}

/**
 * `/user/info` NÃO traduz LID em telefone (SPEC 048 §1.2 R3 — medido).
 * O único caminho é a tabela `contact_identities`, populada no sentido
 * telefone→LID por `backfillContactIdentity` abaixo. Sem vínculo
 * conhecido, o chamador descarta — nunca cria contato sintético.
 */
async function resolveSenderPhone(
  accountId: string,
  jid: ParsedJid
): Promise<string | null> {
  if (jid.phone) return jid.phone;
  if (!jid.lid) return null;

  const db = supabaseAdmin();
  const { data: identity } = await db
    .from('contact_identities')
    .select('contact_id')
    .eq('account_id', accountId)
    .eq('channel_type', 'whatsapp_qr')
    .eq('external_id', jid.lid)
    .maybeSingle();
  if (!identity) return null;

  const { data: contact } = await db
    .from('contacts')
    .select('phone')
    .eq('id', identity.contact_id)
    .maybeSingle();
  return contact?.phone ?? null;
}

/** Segundos (whatsmeow) ou milissegundos — heurística pela magnitude,
 *  igual ao resto do sistema quando a origem do timestamp é duvidosa. */
function parseEvolutionTimestamp(raw: unknown): Date {
  const asNumber =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' &&
          raw.trim() !== '' &&
          !Number.isNaN(Number(raw))
        ? Number(raw)
        : null;
  if (asNumber !== null) {
    return new Date(asNumber > 1e12 ? asNumber : asNumber * 1000);
  }
  if (typeof raw === 'string') {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

type MediaSource =
  { kind: 'url'; url: string } | { kind: 'base64'; base64: string };

interface ExtractedContent {
  contentType: NormalizedMessage['contentType'];
  text: string | null;
  mediaSource: MediaSource | null;
  filename: string | null;
  mimeType: string | null;
  providerContentLabel: string | null;
}

const EMPTY_CONTENT: ExtractedContent = {
  contentType: 'text',
  text: null,
  mediaSource: null,
  filename: null,
  mimeType: null,
  providerContentLabel: null,
};

const MEDIA_MESSAGE_KEYS: Array<[string, NormalizedMessage['contentType']]> = [
  ['imageMessage', 'image'],
  ['videoMessage', 'video'],
  ['audioMessage', 'audio'],
  ['documentMessage', 'document'],
  // Figurinha É imagem por baixo, e é MUITO comum no WhatsApp. Sem esta
  // linha ela cairia no ramo "não reconhecido" e viraria uma bolha
  // vazia. O webhook da Meta faz o mesmo mapeamento (`sticker` →
  // `image`), então os dois canais renderizam igual.
  ['stickerMessage', 'image'],
];

/**
 * De onde tirar os BYTES da mídia — e a ordem importa.
 *
 * O campo `URL` de um proto de mídia do WhatsApp aponta para o CDN
 * (`mmg.whatsapp.net/...enc`) e o conteúdo ali é AES-CBC, chaveado pelo
 * `mediaKey` da própria mensagem. Baixar e subir esses bytes ao bucket
 * "funciona" — o upload dá 200, `media_path` fica preenchido, a bolha
 * aparece com o player — e nada toca, porque o arquivo é ruído cifrado.
 * Foi o que aconteceu com o primeiro áudio de teste.
 *
 * A Evolution já resolve isso: com `WEBHOOK_FILES=true` (o padrão) ela
 * baixa, DECRIPTA e manda o conteúdo em base64 no próprio webhook; com
 * MinIO/S3 configurado, manda um `mediaUrl` para um objeto já em claro.
 * Qualquer um dos dois serve; a URL do CDN não serve para nada sem
 * implementar a decriptação, que é trabalho de outra fase.
 *
 * Por isso: base64 primeiro, `mediaUrl` depois, e a URL cifrada é
 * recusada com log explicando o que configurar — melhor bolha sem mídia
 * e motivo no log do que um player mudo sem explicação.
 */
function isEncryptedWhatsappUrl(url: string): boolean {
  if (/\.enc(\?|#|$)/i.test(url)) return true;
  try {
    return /(^|\.)whatsapp\.net$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function resolveMediaSource(
  media: Record<string, unknown>,
  fallbackBase64: string | null
): MediaSource | null {
  const base64 = firstString(media, 'base64', 'data') ?? fallbackBase64;
  if (base64) return { kind: 'base64', base64 };

  // `mediaUrl` é o objeto já em claro do MinIO/S3; `directPath` é
  // caminho relativo do CDN e continua cifrado, então não entra aqui.
  const plainUrl = firstString(media, 'mediaUrl', 'fileUrl');
  if (plainUrl && !isEncryptedWhatsappUrl(plainUrl)) {
    return { kind: 'url', url: plainUrl };
  }

  const cdnUrl = firstString(media, 'URL', 'url');
  if (cdnUrl && !isEncryptedWhatsappUrl(cdnUrl)) {
    return { kind: 'url', url: cdnUrl };
  }

  if (cdnUrl || plainUrl) {
    console.warn(
      '[evolution webhook] mídia só disponível como URL cifrada do CDN do WhatsApp — ' +
        'a mensagem entra sem mídia. Ligue WEBHOOK_FILES=true (base64 no webhook) ' +
        'ou configure MINIO_ENABLED no servidor Evolution.'
    );
  }
  return null;
}

/**
 * Traduz `data.Message`/`data.message` (o proto do whatsmeow) para o
 * vocabulário normalizado. Ver o aviso no topo do arquivo.
 *
 * `fallbackBase64` existe porque a Evolution pendura o conteúdo
 * decriptado FORA do proto da mídia. O payload medido é:
 *
 *   data.Message = { audioMessage: {URL, mediaKey, mimetype, …},
 *                    base64: "T2dnUw…",
 *                    messageContextInfo: {…} }
 *
 * ou seja, `base64` é IRMÃO de `audioMessage`, não filho — e também não
 * está no nível de `data`, que foi o primeiro palpite. Procurar só dentro
 * do proto (e depois só em `data`) é o que fez todo áudio e toda foto
 * recebidos caírem no ramo da URL cifrada e entrarem sem mídia. As três
 * posições ficam aceitas; quem chama passa a que vale.
 *
 * Devolve `null` quando NADA foi reconhecido — e o chamador descarta.
 * Antes isto devolvia um conteúdo de texto vazio, o que gravava uma
 * bolha em branco no inbox e trocava o preview da conversa por
 * `[unsupported]`. Um proto que não sabemos ler é melhor descartado com
 * log do que exibido como mensagem que o cliente não mandou.
 */
function extractMessageContent(
  msg: Record<string, unknown>,
  fallbackBase64: string | null = null
): ExtractedContent | null {
  const conversation = firstString(msg, 'conversation');
  if (conversation) {
    return {
      ...EMPTY_CONTENT,
      text: conversation,
      providerContentLabel: 'text',
    };
  }
  const extText = firstString(pickRecord(msg, 'extendedTextMessage'), 'text');
  if (extText) {
    return {
      ...EMPTY_CONTENT,
      text: extText,
      providerContentLabel: 'text',
    };
  }

  for (const [key, contentType] of MEDIA_MESSAGE_KEYS) {
    const media = pickRecord(msg, key);
    if (!media) continue;
    return {
      contentType,
      text: firstString(media, 'caption'),
      mediaSource: resolveMediaSource(media, fallbackBase64),
      filename: firstString(media, 'fileName', 'filename', 'title'),
      mimeType: firstString(media, 'mimetype', 'mimeType'),
      providerContentLabel: key.replace('Message', '').toLowerCase(),
    };
  }

  const location = pickRecord(msg, 'locationMessage');
  if (location) {
    const lat =
      typeof location.degreesLatitude === 'number'
        ? location.degreesLatitude
        : null;
    const lng =
      typeof location.degreesLongitude === 'number'
        ? location.degreesLongitude
        : null;
    const name = firstString(location, 'name');
    const text = [name, lat != null && lng != null ? `${lat},${lng}` : null]
      .filter(Boolean)
      .join(' - ');
    return {
      ...EMPTY_CONTENT,
      contentType: 'location',
      text: text || null,
      providerContentLabel: 'location',
    };
  }

  return null;
}

/**
 * Extensão a partir do mimetype, para a mídia que chega SEM nome.
 *
 * Áudio de voz do WhatsApp não tem `fileName` — é gravação, não arquivo.
 * Sem isto, `buildMediaPath` cai no fallback `.bin` e todo áudio, foto e
 * vídeo recebido vira `media.bin` no bucket. O player até funciona (o
 * Content-Type guardado é o que vale), mas o objeto fica opaco para
 * quem abre o bucket, e qualquer ferramenta que decida pelo sufixo erra.
 */
const MIME_EXTENSIONS: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/wav': 'wav',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'video/quicktime': 'mov',
  'application/pdf': 'pdf',
};

export function storedFileNameFor(
  filename: string | null,
  mimeType: string | null
): string {
  if (filename) return filename;
  const base = baseMimeType(mimeType);
  const ext = base ? MIME_EXTENSIONS[base] : undefined;
  return ext ? `media.${ext}` : 'media';
}

/**
 * Baixa (URL) ou decodifica (base64) a mídia e sobe ao bucket privado
 * `chat-media` (SPEC 048 §6.5) — ao contrário do canal Cloud, a
 * Evolution não expõe um id reconsultável, então a mídia é copiada uma
 * vez, na entrada. Best-effort: falha aqui vira mensagem sem mídia, não
 * webhook rejeitado — a Evolution não tem dead-letter (§9).
 */
async function storeInboundMedia(
  accountId: string,
  source: MediaSource,
  filename: string | null,
  mimeType: string | null
): Promise<string | null> {
  try {
    let buffer: Buffer;
    if (source.kind === 'url') {
      const res = await fetch(source.url);
      if (!res.ok) {
        console.error(
          `[evolution webhook] media fetch failed: HTTP ${res.status} — ${source.url}`
        );
        return null;
      }
      buffer = Buffer.from(await res.arrayBuffer());
    } else {
      buffer = Buffer.from(source.base64, 'base64');
    }
    if (buffer.length === 0) {
      console.error('[evolution webhook] mídia veio vazia — nada a guardar.');
      return null;
    }

    const path = buildMediaPath(
      accountId,
      storedFileNameFor(filename, mimeType)
    );
    const { error } = await supabaseAdmin()
      .storage.from('chat-media')
      .upload(path, buffer, {
        // SEM os parâmetros do mimetype: o WhatsApp manda
        // `audio/ogg; codecs=opus` e o bucket compara a string literal
        // contra `allowed_mime_types`, que lista `audio/ogg` puro. Ver
        // `baseMimeType`.
        contentType: baseMimeType(mimeType) ?? undefined,
        upsert: false,
      });
    if (error) {
      console.error(
        `[evolution webhook] media upload failed (${baseMimeType(mimeType) ?? 'sem mimetype'}):`,
        error.message,
        '— se o tipo for legítimo, ele precisa entrar em allowed_mime_types do bucket chat-media.'
      );
      return null;
    }
    return path;
  } catch (err) {
    // O caso mais comum aqui não é bug nosso: é `MINIO_ENDPOINT` com um
    // hostname interno do Docker (`minio_minio`), que o servidor
    // Evolution resolve e este CRM não. Nomear a URL poupa a caçada.
    const where = source.kind === 'url' ? ` (${source.url})` : '';
    console.error(
      `[evolution webhook] falha ao baixar/guardar a mídia${where}. ` +
        `Se o host não for resolvível a partir daqui, publique o MinIO num ` +
        `domínio acessível ou use WEBHOOK_FILES=true (base64 no webhook).`,
      err
    );
    return null;
  }
}

/**
 * O eco de algo que o PRÓPRIO CRM acabou de mandar já está no banco.
 *
 * `ingest.ts` também descarta esse eco, mas só DEPOIS de a mídia ter sido
 * baixada e subida ao bucket — e o eco de uma imagem carrega o arquivo
 * inteiro em base64 (2,3 MB numa foto do teste real). Sem esta porta,
 * toda mídia enviada pelo inbox era decodificada, gravada no
 * `chat-media` e então abandonada: um objeto órfão por envio, acumulando
 * para sempre, mais o pico de memória de segurar o Buffer.
 *
 * Escopado às conversas DESTE canal — `messages.message_id` não é único
 * (migração 009), então uma checagem global poderia casar com a mensagem
 * de outro inquilino. Falha aberta de propósito: erro de consulta segue
 * o caminho normal, porque desperdiçar banda é melhor que perder a
 * mensagem que o operador mandou pelo celular.
 */
async function echoAlreadyStored(
  resolved: ResolvedWebhookInstance,
  providerMessageId: string
): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id, conversations!inner(channel_id)')
    .eq('message_id', providerMessageId)
    .eq('conversations.channel_id', resolved.channelId)
    .limit(1);
  if (error) {
    console.error(
      '[evolution webhook] checagem de eco já gravado falhou; seguindo pelo caminho normal:',
      error.message
    );
    return false;
  }
  return (data?.length ?? 0) > 0;
}

async function handleMessageEvent(
  resolved: ResolvedWebhookInstance,
  data: Record<string, unknown>,
  isEcho: boolean
): Promise<void> {
  const info = pickRecord(data, 'Info');
  if (!info) {
    console.warn('[evolution webhook] MESSAGE sem Info — ignorado');
    return;
  }

  const fromMe = isEcho || pickBoolean(info, 'IsFromMe') === true;

  // `Chat` é o destino da thread (o contato) nos DOIS sentidos — é a
  // leitura correta tanto para `MESSAGE` quanto para `SEND_MESSAGE`.
  //
  // `Sender` só serve de fallback no inbound: numa mensagem RECEBIDA ele
  // é o cliente, mas num eco (`SEND_MESSAGE`) ele é o NOSSO PRÓPRIO
  // número. Cair nele ali criaria um contato com o número do operador e
  // uma "conversa consigo mesmo" que acumularia toda mensagem enviada
  // pelo celular. Por isso o fallback é condicionado a `!fromMe`.
  const chatJid = firstString(info, 'Chat', 'chat');
  const senderJid = fromMe ? null : firstString(info, 'Sender', 'sender');
  const jid = parseJid(chatJid ?? senderJid);

  const providerMessageId = firstString(info, 'ID', 'Id', 'id');
  if (!providerMessageId) {
    console.warn('[evolution webhook] MESSAGE sem id — ignorado');
    return;
  }

  // Antes de qualquer download: se este eco é de algo que o CRM já
  // gravou, não há nada a fazer. Ver `echoAlreadyStored`.
  if (isEcho && (await echoAlreadyStored(resolved, providerMessageId))) {
    return;
  }

  const phone =
    jid.phone ?? (await resolveSenderPhone(resolved.accountId, jid));
  if (!phone) {
    console.warn(
      '[evolution webhook] remetente só identificável por LID sem vínculo conhecido — descartado (nunca cria contato sintético):',
      jid.lid,
      providerMessageId
    );
    return;
  }

  const pushName = firstString(info, 'PushName') ?? '';
  const occurredAt = parseEvolutionTimestamp(pickKey(info, 'Timestamp'));

  const msg = pickRecord(data, 'Message') ?? {};

  // Reação: whatsmeow entrega como MESSAGE com `reactionMessage`, não
  // como um tipo de evento à parte.
  const reaction = pickRecord(msg, 'reactionMessage');
  if (reaction) {
    // Reação que o PRÓPRIO operador deu no celular: não há onde
    // registrá-la — `message_reactions` é chaveado por
    // (mensagem, actor_type, actor_id) e não existe `actor_id` de agente
    // para quem reagiu fora do CRM. Descartada de propósito. O que NÃO
    // pode acontecer é cair no caminho de mensagem abaixo e virar uma
    // bolha vazia na thread.
    if (isEcho) {
      console.warn(
        '[evolution webhook] reação do operador pelo aparelho — sem actor_id de agente para gravar; ignorada:',
        providerMessageId
      );
      return;
    }
    const targetId = firstString(pickRecord(reaction, 'key'), 'ID', 'id');
    const event: NormalizedReaction = {
      kind: 'reaction',
      fromPhone: phone,
      fromExternalId: jid.lid,
      pushName,
      targetProviderMessageId: targetId ?? '',
      emoji: firstString(reaction, 'text') ?? '',
      occurredAt,
    };
    await ingestInbound(buildIngestContext(resolved), event);
    return;
  }

  // O base64 decriptado é IRMÃO do proto dentro de `Message` (medido);
  // `data.base64` fica como alternativa — ver `resolveMediaSource`.
  const content = extractMessageContent(
    msg,
    firstString(msg, 'base64') ?? firstString(data, 'base64')
  );
  if (!content) {
    console.warn(
      '[evolution webhook] proto de mensagem não reconhecido — descartado em vez de virar bolha vazia. Chaves:',
      Object.keys(msg).join(', ') || '(vazio)',
      providerMessageId
    );
    return;
  }

  const mediaPath = content.mediaSource
    ? await storeInboundMedia(
        resolved.accountId,
        content.mediaSource,
        content.filename,
        content.mimeType
      )
    : null;

  const event: NormalizedMessage = {
    kind: 'message',
    fromPhone: phone,
    fromExternalId: jid.lid,
    pushName,
    providerMessageId,
    fromMe,
    contentType: content.contentType,
    text: content.text,
    mediaUrl: null,
    mediaId: null,
    mediaPath,
    occurredAt,
    providerContentLabel: content.providerContentLabel,
  };

  await ingestInbound(buildIngestContext(resolved), event);

  // Backfill best-effort do vínculo telefone→LID (§6.4) — só quando o
  // remetente chegou identificado por telefone. É sobra do caminho
  // original: hoje o vínculo nasce principalmente do lado OUTBOUND (ver
  // `ensureContactIdentity` / `lib/channels/adapters/evolution.ts`),
  // porque muitos contatos nunca chegam identificados por telefone no
  // sentido inbound — e sem o lado outbound este `if` nunca dispararia
  // pra eles.
  //
  // `await`, não `void`: esta função inteira já roda dentro do `after()`
  // do handler (ver o topo do arquivo) — já estamos fora do caminho
  // crítico da resposta, então uma promessa solta aqui só arrisca ser
  // abortada pelo runtime antes de terminar, sem ganhar nada em troca.
  if (!isEcho && jid.phone) {
    await ensureContactIdentity({
      accountId: resolved.accountId,
      instanceToken: resolved.instanceToken,
      phone: jid.phone,
    });
  }
}

function buildIngestContext(resolved: ResolvedWebhookInstance): IngestContext {
  return {
    db: supabaseAdmin(),
    accountId: resolved.accountId,
    ownerUserId: resolved.ownerUserId,
    channelType: 'whatsapp_qr',
    channelId: resolved.channelId,
  };
}

// ------------------------------------------------------------
// READ_RECEIPT
// ------------------------------------------------------------

/** Chaveado em minúsculas: a grafia do provedor (`Read`, `ReadSelf`)
 *  convive com variantes, e o mapa não pode depender de qual chegou. */
const EVOLUTION_RECEIPT_STATUS: Record<string, 'delivered' | 'read'> = {
  delivered: 'delivered',
  read: 'read',
  readself: 'read',
};

/** Mesma escada anti-regressão do webhook da Meta — reentregas fora de
 *  ordem não podem derrubar um status já mais avançado. */
const STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const;
function ladderLevel(s: string): number {
  return (STATUS_LADDER as readonly string[]).indexOf(s);
}

function extractMessageIds(data: Record<string, unknown>): string[] {
  const list = pickKey(data, 'MessageIDs', 'messageIds', 'ids');
  if (Array.isArray(list)) {
    return list.filter((v): v is string => typeof v === 'string' && v !== '');
  }
  const single = firstString(data, 'MessageID', 'ID', 'id');
  return single ? [single] : [];
}

/**
 * Resolve as linhas alvo do recibo, com espera curta.
 *
 * O recibo CORRE com a nossa própria gravação, e o teste real mostrou o
 * recibo ganhando: no envio de uma imagem, `POST /api/whatsapp/send`
 * levou 5,6s (assinar a URL, subir ao bucket, esperar a Evolution) e o
 * `Delivered` daquele mesmo id chegou ANTES da resposta do provedor —
 * ou seja, antes de existir linha em `messages` para atualizar. Sem
 * espera, a consulta não casava nada, o recibo era descartado em
 * silêncio e toda mídia enviada ficava presa em "enviada" para sempre.
 *
 * A espera só acontece no caso do MISS, dentro do `after()` (a resposta
 * 200 ao provedor já saiu) e é curta e limitada: um recibo que de fato
 * não é nosso custa ~3,5s de trabalho em segundo plano e nada mais.
 *
 * O escopo por conversa do canal é de tenancy: `messages.message_id` não
 * é único (migração 009) e `supabaseAdmin()` ignora RLS — sem ele, um
 * recibo poderia mexer na linha de outro inquilino da mesma VPS.
 */
const RECEIPT_RETRY_DELAYS_MS = [0, 1000, 2500];

async function findReceiptTargets(
  resolved: ResolvedWebhookInstance,
  ids: string[]
): Promise<Array<{ id: string; status: string }>> {
  const db = supabaseAdmin();

  for (const delay of RECEIPT_RETRY_DELAYS_MS) {
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    // Recarregado a cada tentativa: numa primeira mensagem a conversa
    // também pode ainda não existir quando o recibo chega.
    const { data: conversations } = await db
      .from('conversations')
      .select('id')
      .eq('account_id', resolved.accountId)
      .eq('channel_id', resolved.channelId);
    const conversationIds = (conversations ?? []).map((c) => c.id);
    if (conversationIds.length === 0) continue;

    const { data: rows } = await db
      .from('messages')
      .select('id, status')
      .in('message_id', ids)
      .in('conversation_id', conversationIds);
    if (rows && rows.length > 0) return rows;
  }

  return [];
}

/**
 * Recibo de entrega/leitura.
 *
 * Duas restrições que o código anterior não respeitava:
 *
 *   1. `messages.message_id` NÃO é único — a migração 009 diz isso na
 *      cabeça ("Meta IDs aren't unique"), e é por isso que
 *      `reply_to_message_id` referencia o UUID interno. Ler UMA linha
 *      (`limit(1)`) e escrever em TODAS que compartilham o id fazia o
 *      guard proteger uma linha e atualizar outra: dependendo de qual o
 *      Postgres devolvia primeiro, ou uma linha em `sent` nunca avançava,
 *      ou uma já em `read` regredia para `delivered` — exatamente o que
 *      a escada existe para impedir.
 *
 *   2. Sem escopo de conta, um `supabaseAdmin()` (que ignora RLS) podia
 *      tocar linha de outro inquilino. As instâncias dividem a mesma VPS.
 *
 * A correção resolve as linhas por id INTERNO, dentro das conversas do
 * canal que mandou o recibo, e decide a escada linha a linha.
 */
async function handleReadReceipt(
  resolved: ResolvedWebhookInstance,
  payload: EvolutionWebhookPayload,
  data: Record<string, unknown>
): Promise<void> {
  // O tipo do recibo (`Read` | `ReadSelf` | `Delivered`) chega em `state`
  // NO ENVELOPE, irmão de `event` — não dentro de `data`, onde o código
  // anterior o procurava como `Type`. Com `data.Type` ausente a função
  // retornava na primeira linha e nenhum recibo jamais avançava o
  // status. As duas posições ficam aceitas.
  const rawType =
    firstString(payload as unknown as Record<string, unknown>, 'state') ??
    firstString(data, 'state', 'Type');
  const mapped = rawType
    ? EVOLUTION_RECEIPT_STATUS[rawType.toLowerCase()]
    : undefined;
  if (!mapped) return;

  const ids = extractMessageIds(data);
  if (ids.length === 0) return;

  const db = supabaseAdmin();
  const rows = await findReceiptTargets(resolved, ids);
  if (rows.length === 0) return;

  const incoming = ladderLevel(mapped);
  for (const row of rows) {
    const current = ladderLevel(row.status);
    // Escada só para frente; status desconhecido aceita o recibo.
    if (current >= 0 && incoming <= current) continue;
    await db.from('messages').update({ status: mapped }).eq('id', row.id);
  }
}

// ------------------------------------------------------------
// CONNECTION
// ------------------------------------------------------------

/**
 * `Connected`, `PairSuccess`, `LoggedOut` e `OfflineSyncCompleted` são
 * eventos DISTINTOS, e é o NOME deles que carrega o estado — o payload
 * do `Connected` é `{status:"open", jid, pushName}`, sem nenhum booleano
 * `Connected`/`LoggedIn` (esses existem só na resposta de
 * `GET /instance/status`, que é outra coisa).
 *
 * Lendo booleanos que nunca vêm, um evento `Connected` era interpretado
 * como `connected=false` e marcava o canal como DESCONECTADO — o oposto
 * do que acabara de acontecer. E `connected_jid`/`connected_phone`
 * ficavam nulos mesmo com a instância pareada, que foi a pista que
 * revelou o problema de nomes de evento como um todo.
 *
 * Os booleanos continuam sendo aceitos como reforço, para o caso de uma
 * versão do servidor mandar o envelope de status aqui.
 */
function connectionStatusFor(
  normalizedEvent: string,
  data: Record<string, unknown>
): 'connected' | 'connecting' | 'disconnected' {
  if (normalizedEvent === 'LOGGEDOUT' || normalizedEvent === 'DISCONNECTED') {
    return 'disconnected';
  }
  if (
    normalizedEvent === 'CONNECTED' ||
    normalizedEvent === 'PAIRSUCCESS' ||
    normalizedEvent === 'OFFLINESYNCCOMPLETED'
  ) {
    return 'connected';
  }

  // Família genérica (`CONNECTION`): cai nos sinais do corpo.
  const statusText = firstString(data, 'status')?.toLowerCase();
  if (statusText === 'open' || statusText === 'connected') return 'connected';
  if (statusText === 'close' || statusText === 'closed') return 'disconnected';

  const connected = pickBoolean(data, 'Connected') === true;
  const loggedIn = pickBoolean(data, 'LoggedIn') === true;
  if (connected && loggedIn) return 'connected';
  return connected ? 'connecting' : 'disconnected';
}

async function handleConnectionUpdate(
  resolved: ResolvedWebhookInstance,
  normalizedEvent: string,
  data: Record<string, unknown>
): Promise<void> {
  const jid = firstString(data, 'JID', 'ID');
  const status = connectionStatusFor(normalizedEvent, data);
  const phone = jid ? parseJid(jid).phone : null;

  const db = supabaseAdmin();

  // A adoção vem ANTES do UPDATE de status, e a ordem importa: se o
  // número já tinha um canal (instância excluída e repareada), é AQUELE
  // que precisa receber o status — escrever no canal recém-criado e só
  // depois adotar deixaria o canal vivo marcado como desconectado.
  let channelId = resolved.channelId;
  if (phone) {
    const bind = await bindChannelToPhone({
      accountId: resolved.accountId,
      instanceId: resolved.instanceId,
      channelId: resolved.channelId,
      phone,
    });
    channelId = bind.channelId;
  }

  await db
    .from('channels')
    .update({
      status,
      // Só limpa o motivo do erro quando reconecta de fato — senão o
      // evento apaga o contexto de por que a instância caiu.
      ...(status === 'connected' ? { status_detail: null } : {}),
      connected_at:
        status === 'connected' ? new Date().toISOString() : undefined,
      last_seen_at: new Date().toISOString(),
    })
    .eq('id', channelId);

  if (jid) {
    await db
      .from('evolution_instances')
      .update({
        connected_jid: jid,
        ...(phone ? { connected_phone: phone } : {}),
      })
      .eq('id', resolved.instanceId);
  }
}
