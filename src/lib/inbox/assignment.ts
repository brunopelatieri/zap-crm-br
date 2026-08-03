// ============================================================
// Atribuição de conversa — wrapper dos RPCs da migração 039.
//
// Server-only por convenção (recebe um SupabaseClient já escopado
// pelo chamador), mas sem import de `next/headers`, então também
// serve a rotas que já resolveram o contexto via `requireRole`.
//
// Existe para que o mapeamento SQLSTATE → HTTP viva em UM lugar. Três
// chamadores precisam dele: as rotas /claim e /assign, e o caminho de
// envio (`/api/whatsapp/send`), que reivindica a conversa ANTES de
// falar com a Meta.
//
// Por que passar por RPC em vez de um `.update()` direto: o
// `claim_conversation` faz `UPDATE ... WHERE assigned_agent_id IS NULL`,
// e esse predicado É o lock. Dois agentes clicando na mesma conversa
// no mesmo milissegundo são serializados pelo Postgres — o segundo
// reavalia, encontra 0 linhas e falha com 55006. Um `.update()` do
// cliente não tem essa garantia: os dois passam e o último sobrescreve.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Conversation } from '@/types';

/**
 * Códigos que os RPCs levantam via `RAISE EXCEPTION`. O `message` do
 * erro do PostgREST carrega exatamente estas strings — são o contrato
 * entre a migração 039 e esta camada.
 */
export const ASSIGNMENT_ERROR = {
  ALREADY_CLAIMED: 'CONVERSATION_ALREADY_CLAIMED',
  NOT_FOUND: 'CONVERSATION_NOT_FOUND',
  INVALID_ASSIGNEE: 'INVALID_ASSIGNEE',
  INSUFFICIENT_ROLE: 'INSUFFICIENT_ROLE',
  ONLY_ADMIN: 'ONLY_ADMIN_CAN_REASSIGN_TO_OTHERS',
  NOT_OWNER: 'NOT_CONVERSATION_OWNER',
  UNAUTHORIZED: 'Unauthorized',
} as const;

export type AssignmentResult =
  | { ok: true; conversation: Conversation }
  | { ok: false; status: number; code: string; error: string };

/**
 * Traduz o erro do RPC em status HTTP + mensagem.
 *
 * `CONVERSATION_NOT_FOUND` vira um 404 genérico de propósito: sob a RLS
 * da 039, uma conversa de outro agente é indistinguível de uma que não
 * existe, e é assim que deve permanecer para quem sondar ids. Nunca
 * responder "você não tem permissão para esta conversa" — isso
 * confirmaria a existência do recurso.
 */
function mapError(message: string | undefined): {
  status: number;
  code: string;
  error: string;
} {
  switch (message) {
    case ASSIGNMENT_ERROR.ALREADY_CLAIMED:
      return {
        status: 409,
        code: ASSIGNMENT_ERROR.ALREADY_CLAIMED,
        error: 'This conversation has just been taken by another agent',
      };
    case ASSIGNMENT_ERROR.NOT_FOUND:
      return {
        status: 404,
        code: ASSIGNMENT_ERROR.NOT_FOUND,
        error: 'Conversation not found',
      };
    case ASSIGNMENT_ERROR.INVALID_ASSIGNEE:
      return {
        status: 400,
        code: ASSIGNMENT_ERROR.INVALID_ASSIGNEE,
        error: 'The selected agent is not a member of this account',
      };
    case ASSIGNMENT_ERROR.ONLY_ADMIN:
      return {
        status: 403,
        code: ASSIGNMENT_ERROR.ONLY_ADMIN,
        error: 'Only an admin can reassign a conversation to someone else',
      };
    case ASSIGNMENT_ERROR.NOT_OWNER:
      return {
        status: 403,
        code: ASSIGNMENT_ERROR.NOT_OWNER,
        error: 'Only the assigned agent or an admin can do this',
      };
    case ASSIGNMENT_ERROR.INSUFFICIENT_ROLE:
      return {
        status: 403,
        code: ASSIGNMENT_ERROR.INSUFFICIENT_ROLE,
        error: 'Your role cannot take conversations',
      };
    case ASSIGNMENT_ERROR.UNAUTHORIZED:
      return {
        status: 401,
        code: ASSIGNMENT_ERROR.UNAUTHORIZED,
        error: 'Unauthorized',
      };
    default:
      return {
        status: 500,
        code: 'ASSIGNMENT_FAILED',
        error: 'Failed to update the conversation assignment',
      };
  }
}

/**
 * Reivindica a conversa para o usuário do `supabase` informado.
 *
 * Idempotente: se a conversa já é do próprio chamador, devolve `ok`
 * com a linha (cobre duplo clique e retry de rede). Só falha com 409
 * quando OUTRO agente venceu a corrida.
 */
export async function claimConversation(
  supabase: SupabaseClient,
  conversationId: string
): Promise<AssignmentResult> {
  const { data, error } = await supabase.rpc('claim_conversation', {
    p_conversation_id: conversationId,
  });

  if (error) {
    // Erros do PostgREST têm propriedades não-enumeráveis — logar os
    // campos explicitamente, senão a mensagem no console vira `{}`.
    const mapped = mapError(error.message);
    if (mapped.status >= 500) {
      console.error('[assignment] claim_conversation failed:', {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code,
      });
    }
    return { ok: false, ...mapped };
  }

  return { ok: true, conversation: data as Conversation };
}

/**
 * Reatribui a conversa. `targetUserId` nulo devolve à fila (aba "Open").
 *
 * O RPC valida que o destino é membro DESTA conta com papel agent+ —
 * sem essa checagem, um payload forjado apontaria para um usuário de
 * outra conta e a linha sumiria para todo mundo (a coluna só ganhou FK
 * na 039, e a FK sozinha não garante que seja o MESMO inquilino).
 */
export async function reassignConversation(
  supabase: SupabaseClient,
  conversationId: string,
  targetUserId: string | null
): Promise<AssignmentResult> {
  const { data, error } = await supabase.rpc('reassign_conversation', {
    p_conversation_id: conversationId,
    p_target_user_id: targetUserId,
  });

  if (error) {
    const mapped = mapError(error.message);
    if (mapped.status >= 500) {
      console.error('[assignment] reassign_conversation failed:', {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code,
      });
    }
    return { ok: false, ...mapped };
  }

  return { ok: true, conversation: data as Conversation };
}
