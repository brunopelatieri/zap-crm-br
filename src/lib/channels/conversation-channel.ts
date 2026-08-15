/**
 * Tipo do canal de uma conversa — a leitura BARATA (SPEC 049 §5.2).
 *
 * Por que não `resolveChannelForConversation`
 *
 *   Aquela (em `send.ts`) resolve CREDENCIAIS: abre `channels`, resolve a
 *   instância na Evolution, decripta token. É o que o caminho de SAÍDA
 *   precisa. Quem só quer saber "este canal renderiza botão?" — o
 *   matcher do flow, os avisos de editor, a UI — não pode pagar por um
 *   token que não vai usar, e muito menos falhar porque uma instância
 *   está fora do ar. Aqui a pergunta é sobre a MATRIZ de capacidades, e
 *   a matriz depende só do `type`.
 *
 * Duas consultas, não um embed
 *
 *   Mesmo motivo de `resolveChannelForConversation`: `channels!inner(type)`
 *   depende do cache de schema do PostgREST, que devolve `PGRST200` para
 *   relacionamento recém-criado (055/059). Um erro assim aqui derrubaria
 *   o dispatch de flows inteiro.
 *
 * Nunca lança
 *
 *   Este resolvedor está no caminho de ENTRADA (o webhook chamando o
 *   motor). Uma exceção aqui não vira erro visível: vira mensagem do
 *   cliente que o flow não processou. Qualquer falha degrada para
 *   `whatsapp_cloud`, que é o comportamento anterior à camada de canais
 *   — e é a verdade em toda conta que só usa o oficial.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { CHANNEL_CAPABILITIES } from './capabilities';
import { DEFAULT_CHANNEL_TYPE } from './send';
import type { ChannelType } from './types';

/**
 * O valor é um `ChannelType` conhecido? A checagem é feita contra a
 * MATRIZ (e não contra uma lista repetida aqui) para que um canal novo
 * passe a ser reconhecido só por declarar suas capacidades.
 */
function isKnownChannelType(value: unknown): value is ChannelType {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(CHANNEL_CAPABILITIES, value)
  );
}

/**
 * Tipo do canal desta conversa, com `whatsapp_cloud` como padrão seguro.
 *
 * `conversationId` aceita `null` porque os motores carregam runs que
 * podem não ter conversa associada — e um run sem conversa não tem canal
 * do qual degradar.
 */
export async function resolveChannelTypeForConversation(
  db: SupabaseClient,
  accountId: string,
  conversationId: string | null
): Promise<ChannelType> {
  if (!conversationId) return DEFAULT_CHANNEL_TYPE;

  const { data: conversation, error: convErr } = await db
    .from('conversations')
    .select('channel_id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (convErr) return DEFAULT_CHANNEL_TYPE;

  const channelId = (conversation as { channel_id?: string } | null)
    ?.channel_id;
  if (!channelId) return DEFAULT_CHANNEL_TYPE;

  const { data: channel, error: chanErr } = await db
    .from('channels')
    .select('type')
    .eq('id', channelId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (chanErr) return DEFAULT_CHANNEL_TYPE;

  const type = (channel as { type?: string } | null)?.type;
  return isKnownChannelType(type) ? type : DEFAULT_CHANNEL_TYPE;
}
