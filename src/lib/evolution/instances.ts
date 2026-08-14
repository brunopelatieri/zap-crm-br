/**
 * Orquestração do gerenciamento de instâncias Evolution (SPEC 048 §7).
 *
 * Este é o único módulo que junta as três peças: o cliente HTTP
 * (`client.ts`), o banco (`channels` + `evolution_instances` +
 * `evolution_instance_secrets`, sempre via `supabaseAdmin()` porque a
 * tabela de segredos não tem NENHUMA policy de leitura) e as regras de
 * negócio (nome namespaced, limite D-1). As rotas em
 * `src/app/api/channels/evolution/instances/` só validam a sessão, o
 * papel e o corpo da requisição — toda lógica fica aqui, testável sem
 * subir um servidor Next.
 *
 * Fora de escopo aqui, de propósito (F4): envio de mensagem, tradução
 * de webhook inbound, e qualquer coisa que registre `whatsapp_qr` em
 * `src/lib/channels/registry.ts`.
 */

import { randomBytes, randomUUID } from 'crypto';

import { supabaseAdmin } from '@/lib/supabase/admin';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import {
  EvolutionApiError,
  evolutionRequest,
  isAlreadyLoggedInError,
  unwrap,
} from './client';
import { readEvolutionConfig, type EvolutionConfig } from './config';
import { buildInstanceName } from './instance-name';
import { checkInstanceLimit, type InstanceLimitDecision } from './limits';

const SUBSCRIBED_EVENTS = [
  'MESSAGE',
  'SEND_MESSAGE',
  'READ_RECEIPT',
  'CONNECTION',
  'QRCODE',
] as const;

export class EvolutionNotConfiguredError extends Error {
  constructor() {
    super(
      'EVOLUTION_API_URL / EVOLUTION_GLOBAL_API_KEY not set — the WhatsApp QRCode channel is disabled'
    );
    this.name = 'EvolutionNotConfiguredError';
  }
}

export class InstanceLimitReachedError extends Error {
  readonly decision: InstanceLimitDecision;
  constructor(decision: InstanceLimitDecision) {
    super(
      decision.reason === 'deployment_limit'
        ? `deployment instance limit reached (${decision.totalCount}/${decision.maxTotal})`
        : `account instance limit reached (${decision.accountCount}/${decision.accountLimit})`
    );
    this.name = 'InstanceLimitReachedError';
    this.decision = decision;
  }
}

export class InstanceNotFoundError extends Error {
  constructor() {
    super('Evolution instance not found for this account');
    this.name = 'InstanceNotFoundError';
  }
}

function requireConfig(): EvolutionConfig {
  const config = readEvolutionConfig();
  if (!config) throw new EvolutionNotConfiguredError();
  return config;
}

/**
 * Best-effort: apaga na VPS uma instância que acabamos de criar mas
 * que uma escrita no NOSSO banco impediu de ficar utilizável (ver os
 * três pontos de falha em `createEvolutionInstance`). Nunca lança —
 * uma falha de limpeza não pode mascarar o erro original que já vai
 * subir para o chamador; sem `remoteInstanceId` não há o que limpar.
 */
async function cleanupOrphanedVpsInstance(
  config: EvolutionConfig,
  remoteInstanceId: string | null
): Promise<void> {
  if (!remoteInstanceId) return;
  try {
    await evolutionRequest(config, `/instance/delete/${remoteInstanceId}`, {
      method: 'DELETE',
      key: config.globalApiKey,
    });
  } catch (err) {
    console.error(
      `[evolution] failed to clean up orphaned VPS instance ${remoteInstanceId}:`,
      err
    );
  }
}

// ------------------------------------------------------------
// Leitura
// ------------------------------------------------------------

export interface EvolutionInstanceSummary {
  id: string;
  channelId: string;
  name: string;
  status: string;
  statusDetail: string | null;
  connectedPhone: string | null;
  connectedJid: string | null;
  isDefault: boolean;
  lastQrAt: string | null;
  createdAt: string;
}

/**
 * Duas queries + merge em JS, em vez de um embed `channels!inner(...)`.
 * A 056 é uma migração NOVA — logo após aplicá-la o cache de schema do
 * PostgREST costuma estar desatualizado e um embed falha com
 * `PGRST200` (mesma armadilha documentada em `lib/auth/account.ts`).
 * Um lookup por id não depende de relacionamento nenhum no cache.
 */
export async function listEvolutionInstances(
  accountId: string
): Promise<EvolutionInstanceSummary[]> {
  const db = supabaseAdmin();
  const { data: instances, error } = await db
    .from('evolution_instances')
    .select(
      'id, channel_id, connected_phone, connected_jid, last_qr_at, created_at'
    )
    .eq('account_id', accountId)
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`failed to list Evolution instances: ${error.message}`);
  }
  if (!instances || instances.length === 0) return [];

  const channelIds = instances.map((i) => i.channel_id);
  const { data: channels, error: channelsErr } = await db
    .from('channels')
    .select('id, name, status, status_detail, is_default')
    .in('id', channelIds);
  if (channelsErr) {
    throw new Error(
      `failed to load channels for Evolution instances: ${channelsErr.message}`
    );
  }
  const channelById = new Map((channels ?? []).map((c) => [c.id, c]));

  return instances.flatMap((row) => {
    const channel = channelById.get(row.channel_id);
    // Linha órfã (canal apagado fora do fluxo normal) — omitida em vez
    // de quebrar a lista inteira.
    if (!channel) return [];
    return [
      {
        id: row.id,
        channelId: row.channel_id,
        name: channel.name,
        status: channel.status,
        statusDetail: channel.status_detail,
        connectedPhone: row.connected_phone,
        connectedJid: row.connected_jid,
        isDefault: channel.is_default,
        lastQrAt: row.last_qr_at,
        createdAt: row.created_at,
      },
    ];
  });
}

export type InstanceLimitStatus = InstanceLimitDecision;

export async function getInstanceLimitStatus(
  accountId: string
): Promise<InstanceLimitStatus> {
  const config = requireConfig();
  const db = supabaseAdmin();

  const [{ count: accountCount }, { count: totalCount }, { data: account }] =
    await Promise.all([
      db
        .from('evolution_instances')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId),
      db
        .from('evolution_instances')
        .select('id', { count: 'exact', head: true }),
      db
        .from('accounts')
        .select('evolution_instance_limit')
        .eq('id', accountId)
        .maybeSingle(),
    ]);

  return checkInstanceLimit({
    accountCount: accountCount ?? 0,
    totalCount: totalCount ?? 0,
    accountOverride: account?.evolution_instance_limit ?? null,
    defaultPerAccount: config.maxInstancesPerAccount,
    maxTotal: config.maxInstancesTotal,
  });
}

export interface ResolvedInstance {
  instanceId: string;
  channelId: string;
  accountId: string;
  remoteInstanceId: string | null;
  remoteInstanceName: string;
  token: string;
  channelName: string;
}

/**
 * Junta `evolution_instances` + `channels` + o segredo decriptado, dada
 * uma linha de `evolution_instances` já resolvida e escopada à conta.
 * Compartilhado pelas duas formas de resolver: por `instanceId` (rotas
 * de gerenciamento, F3) e por `channelId` (adaptador de mensageria, F4
 * — `ChannelContext` só carrega o id do CANAL, nunca o id da instância).
 */
async function loadResolvedInstance(instance: {
  id: string;
  channel_id: string;
  account_id: string;
  remote_instance_id: string | null;
  remote_instance_name: string;
}): Promise<ResolvedInstance> {
  const db = supabaseAdmin();
  const [{ data: channel }, { data: secret }] = await Promise.all([
    db
      .from('channels')
      .select('name')
      .eq('id', instance.channel_id)
      .maybeSingle(),
    db
      .from('evolution_instance_secrets')
      .select('instance_token_encrypted')
      .eq('instance_id', instance.id)
      .maybeSingle(),
  ]);
  if (!channel || !secret) throw new InstanceNotFoundError();

  return {
    instanceId: instance.id,
    channelId: instance.channel_id,
    accountId: instance.account_id,
    remoteInstanceId: instance.remote_instance_id,
    remoteInstanceName: instance.remote_instance_name,
    token: decrypt(secret.instance_token_encrypted),
    channelName: channel.name,
  };
}

/** Resolve uma instância PELA CONTA e decripta o token. Tenancy aqui é
 *  defesa em profundidade: a rota já filtra por sessão, mas o acesso
 *  via `supabaseAdmin()` ignora RLS, então o filtro explícito por
 *  `account_id` é o único que resta. */
async function resolveInstance(
  accountId: string,
  instanceId: string
): Promise<ResolvedInstance> {
  const db = supabaseAdmin();
  const { data: instance, error } = await db
    .from('evolution_instances')
    .select(
      'id, channel_id, account_id, remote_instance_id, remote_instance_name'
    )
    .eq('id', instanceId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error || !instance) throw new InstanceNotFoundError();
  return loadResolvedInstance(instance);
}

/**
 * Resolve uma instância PELO CANAL — é o que o adaptador de mensageria
 * (F4) usa: `ChannelContext.channel.id` é sempre `channels.id`, nunca
 * `evolution_instances.id` (esse é um detalhe interno de gerenciamento
 * que o resto do sistema não vê).
 */
export async function resolveInstanceByChannelId(
  accountId: string,
  channelId: string
): Promise<ResolvedInstance> {
  const db = supabaseAdmin();
  const { data: instance, error } = await db
    .from('evolution_instances')
    .select(
      'id, channel_id, account_id, remote_instance_id, remote_instance_name'
    )
    .eq('channel_id', channelId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error || !instance) throw new InstanceNotFoundError();
  return loadResolvedInstance(instance);
}

// ------------------------------------------------------------
// Criação
// ------------------------------------------------------------

export interface CreateInstanceInput {
  accountId: string;
  userId: string;
  label: string;
}

export interface CreateInstanceResult {
  instanceId: string;
  channelId: string;
  /** `null` quando o create foi bem-sucedido mas o connect falhou —
   *  a instância existe, só não foi encadeada. A UI orienta a tentar
   *  "Ver QR" de novo, que reexecuta o connect internamente. */
  connectWarning: string | null;
}

/**
 * Cria a instância na VPS, guarda o token cifrado, e encadeia o
 * `connect` (que registra webhook + eventos). Falha de `connect` NÃO
 * desfaz a criação — a instância existe e pode ser reconectada; sem
 * isso um timeout de rede no segundo passo obrigaria o operador a
 * lidar com uma instância "fantasma" na VPS.
 */
export async function createEvolutionInstance(
  input: CreateInstanceInput
): Promise<CreateInstanceResult> {
  const config = requireConfig();
  const limitStatus = await getInstanceLimitStatus(input.accountId);
  if (!limitStatus.allowed) throw new InstanceLimitReachedError(limitStatus);

  const trimmedLabel = input.label.trim();
  if (!trimmedLabel) throw new Error('label is required');

  const remoteInstanceName = buildInstanceName(
    config.instancePrefix,
    input.accountId,
    trimmedLabel
  );
  const instanceToken = randomUUID();

  const created = unwrap(
    await evolutionRequest(config, '/instance/create', {
      method: 'POST',
      key: config.globalApiKey,
      body: { name: remoteInstanceName, token: instanceToken },
    })
  );
  const remoteInstanceId = typeof created.id === 'string' ? created.id : null;

  const db = supabaseAdmin();

  const { data: channel, error: channelErr } = await db
    .from('channels')
    .insert({
      account_id: input.accountId,
      user_id: input.userId,
      type: 'whatsapp_qr',
      name: trimmedLabel,
      status: 'connecting',
    })
    .select('id')
    .single();
  if (channelErr || !channel) {
    await cleanupOrphanedVpsInstance(config, remoteInstanceId);
    throw new Error(
      `Evolution instance created on the VPS but failed to save channel: ${channelErr?.message}`
    );
  }

  const { data: instance, error: instanceErr } = await db
    .from('evolution_instances')
    .insert({
      channel_id: channel.id,
      account_id: input.accountId,
      remote_instance_id: remoteInstanceId,
      remote_instance_name: remoteInstanceName,
      subscribed_events: SUBSCRIBED_EVENTS,
    })
    .select('id')
    .single();
  if (instanceErr || !instance) {
    await cleanupOrphanedVpsInstance(config, remoteInstanceId);
    await db.from('channels').delete().eq('id', channel.id);
    throw new Error(
      `Evolution instance created on the VPS but failed to save evolution_instances row: ${instanceErr?.message}`
    );
  }

  const webhookSecret = randomBytes(32).toString('hex');
  const { error: secretErr } = await db
    .from('evolution_instance_secrets')
    .insert({
      instance_id: instance.id,
      instance_token_encrypted: encrypt(instanceToken),
      webhook_secret: webhookSecret,
    });
  if (secretErr) {
    // Sem segredo, a instância é INUTILIZÁVEL para sempre — nenhuma
    // chamada futura consegue decriptar um token que nunca foi salvo.
    // Desfaz tudo em vez de deixar um registro morto no banco.
    await cleanupOrphanedVpsInstance(config, remoteInstanceId);
    await db.from('evolution_instances').delete().eq('id', instance.id);
    await db.from('channels').delete().eq('id', channel.id);
    throw new Error(
      `Evolution instance created but failed to save its secret: ${secretErr.message}`
    );
  }

  let connectWarning: string | null = null;
  try {
    await connectInstance(config, {
      token: instanceToken,
      webhookSecret,
    });
  } catch (err) {
    connectWarning = err instanceof Error ? err.message : String(err);
    await db
      .from('channels')
      .update({ status: 'error', status_detail: connectWarning })
      .eq('id', channel.id);
  }

  return { instanceId: instance.id, channelId: channel.id, connectWarning };
}

/**
 * `POST /instance/connect` — registra webhook + eventos. Reexecutável:
 * a rota de "Ver QR" chama de novo antes de buscar o QR para garantir
 * que o webhook está registrado, mesmo se o `connect` do create tiver
 * falhado (SPEC 048 §1.3 R10 — comparamos o `eventString` devolvido
 * com o que enviamos e alertamos se divergir).
 */
async function connectInstance(
  config: EvolutionConfig,
  { token, webhookSecret }: { token: string; webhookSecret: string }
): Promise<{ eventStringMismatch: boolean }> {
  if (!config.webhookPublicUrl) {
    throw new Error(
      'EVOLUTION_WEBHOOK_PUBLIC_URL (or NEXT_PUBLIC_SITE_URL) is not set — cannot register the Evolution webhook'
    );
  }
  const webhookUrl = `${config.webhookPublicUrl.replace(/\/+$/, '')}/api/channels/evolution/webhook/${webhookSecret}`;

  const result = unwrap(
    await evolutionRequest(config, '/instance/connect', {
      method: 'POST',
      key: token,
      body: {
        immediate: true,
        subscribe: [...SUBSCRIBED_EVENTS],
        webhookUrl,
      },
    })
  );

  const eventString =
    typeof result.eventString === 'string' ? result.eventString : '';
  const acceptedEvents = new Set(
    eventString
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean)
  );
  const eventStringMismatch = SUBSCRIBED_EVENTS.some(
    (e) => !acceptedEvents.has(e)
  );

  return { eventStringMismatch };
}

// ------------------------------------------------------------
// QR e pareamento por código
// ------------------------------------------------------------

export interface QrResult {
  alreadyConnected: boolean;
  qrcode: string | null;
  code: string | null;
}

/**
 * Reexecuta `connect` antes de buscar o QR (idempotente — R10) e
 * então busca o QR. `GET /instance/qr` custa ~3s FIXOS (SPEC 048
 * §1.3 R7); o chamador (a rota) não deve fazer polling curto disto.
 */
export async function getInstanceQr(
  accountId: string,
  instanceId: string
): Promise<QrResult> {
  const config = requireConfig();
  const resolved = await resolveInstance(accountId, instanceId);

  const db = supabaseAdmin();
  const { data: secret } = await db
    .from('evolution_instance_secrets')
    .select('webhook_secret')
    .eq('instance_id', resolved.instanceId)
    .maybeSingle();
  if (secret?.webhook_secret) {
    try {
      await connectInstance(config, {
        token: resolved.token,
        webhookSecret: secret.webhook_secret,
      });
    } catch {
      // Best-effort: se o connect falhar aqui, ainda tentamos o QR —
      // uma instância já pareada não precisa dele para nada.
    }
  }

  try {
    const data = unwrap(
      await evolutionRequest(config, '/instance/qr', {
        method: 'GET',
        key: resolved.token,
      })
    );
    const qrcode =
      typeof data.qrcode === 'string'
        ? data.qrcode
        : typeof data.Qrcode === 'string'
          ? data.Qrcode
          : typeof data.qrCode === 'string'
            ? data.qrCode
            : null;
    const code =
      typeof data.code === 'string'
        ? data.code
        : typeof data.Code === 'string'
          ? data.Code
          : null;

    await db
      .from('evolution_instances')
      .update({ last_qr_at: new Date().toISOString() })
      .eq('id', resolved.instanceId);

    return { alreadyConnected: false, qrcode, code };
  } catch (err) {
    if (isAlreadyLoggedInError(err)) {
      return { alreadyConnected: true, qrcode: null, code: null };
    }
    throw err;
  }
}

export async function pairInstanceByPhone(
  accountId: string,
  instanceId: string,
  phone: string
): Promise<{ pairingCode: string }> {
  const config = requireConfig();
  const resolved = await resolveInstance(accountId, instanceId);

  const data = unwrap(
    await evolutionRequest(config, '/instance/pair', {
      method: 'POST',
      key: resolved.token,
      body: { phone, subscribe: [...SUBSCRIBED_EVENTS] },
    })
  );
  const pairingCode =
    typeof data.pairingCode === 'string'
      ? data.pairingCode
      : typeof data.PairingCode === 'string'
        ? data.PairingCode
        : null;
  if (!pairingCode) {
    throw new Error('Evolution did not return a pairing code');
  }
  return { pairingCode };
}

// ------------------------------------------------------------
// Status ao vivo
// ------------------------------------------------------------

export interface LiveStatus {
  connected: boolean;
  loggedIn: boolean;
  name: string | null;
}

export async function getInstanceLiveStatus(
  accountId: string,
  instanceId: string
): Promise<LiveStatus> {
  const config = requireConfig();
  const resolved = await resolveInstance(accountId, instanceId);

  const data = unwrap(
    await evolutionRequest(config, '/instance/status', {
      method: 'GET',
      key: resolved.token,
    })
  );
  const connected = data.Connected === true || data.connected === true;
  const loggedIn = data.LoggedIn === true || data.loggedIn === true;
  const name =
    typeof data.Name === 'string'
      ? data.Name
      : typeof data.name === 'string'
        ? data.name
        : null;

  const status =
    connected && loggedIn
      ? 'connected'
      : connected
        ? 'connecting'
        : 'disconnected';
  const db = supabaseAdmin();
  await db
    .from('channels')
    .update({
      status,
      // Só limpa o motivo do erro quando a conexão de fato se
      // restabeleceu — caso contrário o polling apaga o contexto de
      // por que a instância caiu antes que o operador consiga lê-lo.
      ...(status === 'connected' ? { status_detail: null } : {}),
      connected_at:
        status === 'connected' ? new Date().toISOString() : undefined,
      last_seen_at: new Date().toISOString(),
    })
    .eq('id', resolved.channelId);

  return { connected, loggedIn, name };
}

// ------------------------------------------------------------
// Vínculo canal ↔ número do WhatsApp
// ------------------------------------------------------------

export interface BindChannelResult {
  /** O canal que a instância passa a usar — o adotado, quando houve
   *  adoção; o próprio, quando não. */
  channelId: string;
  adopted: boolean;
}

/**
 * O que identifica um canal QRCode é o NÚMERO, não a instância.
 *
 * O problema que isto resolve
 *
 *   Excluir a instância e parear o mesmo número de novo criava um
 *   `channels` novo. Como `conversations.channel_id` é NOT NULL desde a
 *   059 e a busca por conversa filtra por canal, todo o histórico do
 *   número ficava preso ao canal velho e o inbox recomeçava vazio — com
 *   as conversas antigas invisíveis, não apagadas, o que é pior.
 *
 *   O nome da instância é rótulo do operador ("bruno", "bruno teste 1")
 *   e pode mudar à vontade. O vínculo real é o número: reconectou o
 *   mesmo WhatsApp, é o mesmo canal, e a conversa continua de onde
 *   parou.
 *
 * Quando roda
 *
 *   No evento de conexão do webhook, único momento em que o número fica
 *   conhecido — a Evolution só informa o JID depois do pareamento. Na
 *   criação da instância ainda não há número nenhum, e é por isso que o
 *   canal nasce com `identifier` nulo e é reconciliado aqui.
 *
 * O que NÃO faz
 *
 *   Não move conversas entre canais. Se o canal recém-criado já tiver
 *   conversas (impossível no fluxo normal — mensagem só trafega depois
 *   do pareamento, que é o que dispara esta função), a adoção é abortada
 *   com log: dois canais separados são um incômodo, histórico órfão é
 *   perda de dado.
 */
export async function bindChannelToPhone(input: {
  accountId: string;
  instanceId: string;
  channelId: string;
  phone: string;
}): Promise<BindChannelResult> {
  const { accountId, instanceId, channelId, phone } = input;
  const db = supabaseAdmin();

  const { data: current } = await db
    .from('channels')
    .select('name, identifier')
    .eq('id', channelId)
    .maybeSingle();

  if (current?.identifier !== phone) {
    await db.from('channels').update({ identifier: phone }).eq('id', channelId);
  }

  // Canal mais antigo desta conta que já atendeu este número. `disabled`
  // entra na busca de propósito: é exatamente o estado em que
  // `deleteEvolutionInstance` deixa o canal ao excluir a instância.
  const { data: previous } = await db
    .from('channels')
    .select('id')
    .eq('account_id', accountId)
    .eq('type', 'whatsapp_qr')
    .eq('identifier', phone)
    .neq('id', channelId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!previous) return { channelId, adopted: false };

  const { count: strandedConversations } = await db
    .from('conversations')
    .select('id', { count: 'exact', head: true })
    .eq('channel_id', channelId);

  if ((strandedConversations ?? 0) > 0) {
    console.warn(
      `[evolution] canal ${channelId} já tem ${strandedConversations} conversa(s); ` +
        `adoção de ${previous.id} abortada para não deixar histórico órfão. ` +
        `O número ${phone} fica com dois canais — resolver manualmente.`
    );
    return { channelId, adopted: false };
  }

  const { error: repointError } = await db
    .from('evolution_instances')
    .update({ channel_id: previous.id })
    .eq('id', instanceId);
  if (repointError) {
    console.error(
      '[evolution] falha ao reapontar a instância para o canal do número:',
      repointError.message
    );
    return { channelId, adopted: false };
  }

  // O rótulo novo vence: o operador acabou de escolhê-lo ao recriar a
  // instância, e o canal adotado pode carregar um nome de meses atrás.
  await db
    .from('channels')
    .update({
      identifier: phone,
      status: 'connected',
      status_detail: null,
      ...(current?.name ? { name: current.name } : {}),
    })
    .eq('id', previous.id);

  // Sem instância e sem conversa, o canal recém-criado não serve para
  // nada — deixá-lo poluiria a lista a cada reconexão.
  const { error: deleteError } = await db
    .from('channels')
    .delete()
    .eq('id', channelId);
  if (deleteError) {
    await db
      .from('channels')
      .update({
        status: 'disabled',
        status_detail: `Substituído pelo canal do número ${phone}`,
      })
      .eq('id', channelId);
  }

  console.warn(
    `[evolution] número ${phone} reconectado — instância ${instanceId} adotou ` +
      `o canal ${previous.id}, preservando o histórico de conversas.`
  );
  return { channelId: previous.id, adopted: true };
}

// ------------------------------------------------------------
// Edição — rótulo local + flags avançadas
// ------------------------------------------------------------

export interface AdvancedSettingsInput {
  alwaysOnline?: boolean;
  rejectCall?: boolean;
  msgRejectCall?: string;
  readMessages?: boolean;
  ignoreGroups?: boolean;
  ignoreStatus?: boolean;
}

export async function patchInstance(
  accountId: string,
  instanceId: string,
  input: { label?: string; advancedSettings?: AdvancedSettingsInput }
): Promise<void> {
  const resolved = await resolveInstance(accountId, instanceId);
  const db = supabaseAdmin();

  if (input.label !== undefined) {
    const trimmed = input.label.trim();
    if (!trimmed) throw new Error('label cannot be empty');
    const { error } = await db
      .from('channels')
      .update({ name: trimmed })
      .eq('id', resolved.channelId);
    if (error) throw new Error(`failed to rename channel: ${error.message}`);
  }

  if (input.advancedSettings !== undefined) {
    if (!resolved.remoteInstanceId) {
      throw new Error(
        'this instance has no remote_instance_id on record — cannot update advanced settings'
      );
    }
    const config = requireConfig();
    const updated = unwrap(
      await evolutionRequest(
        config,
        `/instance/${resolved.remoteInstanceId}/advanced-settings`,
        { method: 'PUT', key: resolved.token, body: input.advancedSettings }
      )
    );
    const { error } = await db
      .from('evolution_instances')
      .update({ advanced_settings: updated })
      .eq('id', resolved.instanceId);
    if (error) {
      throw new Error(
        `advanced settings updated on the VPS but failed to cache locally: ${error.message}`
      );
    }
  }
}

// ------------------------------------------------------------
// Ciclo de vida
// ------------------------------------------------------------

async function setChannelStatus(
  channelId: string,
  status: string,
  detail: string | null = null
): Promise<void> {
  const db = supabaseAdmin();
  await db
    .from('channels')
    .update({ status, status_detail: detail })
    .eq('id', channelId);
}

export async function disconnectInstance(
  accountId: string,
  instanceId: string
): Promise<void> {
  const config = requireConfig();
  const resolved = await resolveInstance(accountId, instanceId);
  await evolutionRequest(config, '/instance/disconnect', {
    method: 'POST',
    key: resolved.token,
  });
  await setChannelStatus(resolved.channelId, 'disconnected');
}

export async function logoutInstance(
  accountId: string,
  instanceId: string
): Promise<void> {
  const config = requireConfig();
  const resolved = await resolveInstance(accountId, instanceId);
  await evolutionRequest(config, '/instance/logout', {
    method: 'DELETE',
    key: resolved.token,
  });
  const db = supabaseAdmin();
  await db
    .from('evolution_instances')
    .update({ connected_phone: null, connected_jid: null })
    .eq('id', resolved.instanceId);
  await setChannelStatus(resolved.channelId, 'disconnected');
}

export async function reconnectInstance(
  accountId: string,
  instanceId: string
): Promise<void> {
  const config = requireConfig();
  const resolved = await resolveInstance(accountId, instanceId);
  await evolutionRequest(config, '/instance/reconnect', {
    method: 'POST',
    key: resolved.token,
  });
  await setChannelStatus(resolved.channelId, 'connecting');
}

/**
 * Exclui a INSTÂNCIA (VPS + `evolution_instances` + segredos), mas
 * preserva o CANAL: `channels` vira `status='disabled'` em vez de ser
 * apagado, porque conversas existentes apontam (ou apontarão, a partir
 * da migração 057) para `channels.id` — apagar a linha derrubaria o
 * histórico junto com a instância, que o PRD (§9.1) proíbe
 * explicitamente.
 */
export async function deleteEvolutionInstance(
  accountId: string,
  instanceId: string
): Promise<void> {
  const config = requireConfig();
  const resolved = await resolveInstance(accountId, instanceId);

  if (resolved.remoteInstanceId) {
    try {
      await evolutionRequest(
        config,
        `/instance/delete/${resolved.remoteInstanceId}`,
        { method: 'DELETE', key: config.globalApiKey }
      );
    } catch (err) {
      // 404 aqui significa "já não existe na VPS" — segue o fluxo e
      // limpa o nosso lado mesmo assim. Qualquer outro erro sobe.
      if (!(err instanceof EvolutionApiError && err.kind === 'not_found')) {
        throw err;
      }
    }
  }

  const db = supabaseAdmin();
  const { error: deleteErr } = await db
    .from('evolution_instances')
    .delete()
    .eq('id', resolved.instanceId);
  if (deleteErr) {
    throw new Error(
      `deleted on the VPS but failed to remove evolution_instances row: ${deleteErr.message}`
    );
  }

  await setChannelStatus(
    resolved.channelId,
    'disabled',
    'Instância excluída pelo operador'
  );
}
