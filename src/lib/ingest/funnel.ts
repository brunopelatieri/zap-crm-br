// ============================================================
// Funil por webhook_id — SPEC 055 D-4/D-5/D-15, F6.
//
// Duas operações, cada uma sua própria RPC (migração 065) porque
// ambas precisam ser atômicas sob concorrência — um n8n disparando
// dezenas de leads em paralelo com o mesmo `webhook_id` não pode
// perder a corrida de um SELECT→INSERT feito aqui em TypeScript:
//
//   upsertFunnel        — encontra-ou-cria a linha `broadcasts`
//                          (source='webhook') deste webhook_id e
//                          incrementa `ingested_count`. Chamado em
//                          TODO POST aceito, com ou sem disparo (D-15).
//   addFunnelRecipient  — cria a linha de `broadcast_recipients`
//                          (status inicial 'pending') e incrementa
//                          `total_recipients`. Chamado só quando há
//                          `template_id` — é o que faz `total_recipients`
//                          contar ENVIOS, não ingestões (D-5 nota 1).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

export class IngestFunnelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IngestFunnelError';
  }
}

export interface UpsertFunnelParams {
  accountId: string;
  userId: string;
  webhookId: string;
  webhookName: string;
}

/**
 * Encontra-ou-cria o funil (`broadcasts.source = 'webhook'`) deste
 * `webhook_id` na conta, incrementando `ingested_count` na mesma
 * chamada. `webhookName` sempre atualiza o rótulo — o último POST
 * vence.
 */
export async function upsertFunnel(
  db: SupabaseClient,
  { accountId, userId, webhookId, webhookName }: UpsertFunnelParams
): Promise<{ broadcastId: string }> {
  const { data, error } = await db.rpc('upsert_webhook_funnel', {
    p_account_id: accountId,
    p_user_id: userId,
    p_webhook_id: webhookId,
    p_webhook_name: webhookName,
  });

  if (error || !data) {
    throw new IngestFunnelError('Failed to upsert webhook funnel');
  }

  return { broadcastId: data as string };
}

export interface AddFunnelRecipientParams {
  broadcastId: string;
  contactId: string;
}

/**
 * Sobe `total_recipients` no pai e SÓ DEPOIS cria a linha de
 * destinatário (`status: 'pending'`, carimbada mais tarde por
 * `ingest/send.ts`). As duas escritas não precisam da mesma
 * transação, mas a ORDEM importa: bump primeiro, insert depois — se o
 * insert falhar, a pior consequência é `total_recipients` adiantado
 * em 1 sem uma linha correspondente (drift inofensivo, do mesmo jeito
 * que `createBroadcast` já aceita ao semear a coluna sem o trigger).
 *
 * A ordem inversa (insert primeiro) foi tentada e revertida: um bump
 * que falhasse DEPOIS do insert já bem-sucedido deixava uma linha
 * `broadcast_recipients` órfã em `pending` para sempre — nada no
 * sistema revisita esse status — e o chamador (`route.ts`) trata a
 * falha como "nenhum envio foi tentado", nunca chegando a chamar
 * `sendIngestTemplate`. Nesta ordem isso não pode acontecer: sem bump
 * bem-sucedido, nenhuma linha é criada.
 */
export async function addFunnelRecipient(
  db: SupabaseClient,
  { broadcastId, contactId }: AddFunnelRecipientParams
): Promise<{ recipientRowId: string }> {
  const { error: bumpError } = await db.rpc(
    'increment_broadcast_total_recipients',
    { p_broadcast_id: broadcastId }
  );
  if (bumpError) {
    throw new IngestFunnelError('Failed to bump broadcast total_recipients');
  }

  const { data, error } = await db
    .from('broadcast_recipients')
    .insert({
      broadcast_id: broadcastId,
      contact_id: contactId,
      status: 'pending',
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new IngestFunnelError('Failed to create funnel recipient row');
  }

  return { recipientRowId: data.id as string };
}
