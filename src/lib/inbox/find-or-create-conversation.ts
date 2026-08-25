/**
 * Find-or-create da thread de um contato num canal — variante do PAINEL.
 *
 * Por que esta função existe separada da de `resolve-conversation.ts`
 *
 *   As duas fazem find-or-create por `(conta, contato, canal)` e param
 *   aí. A diferença é de SEMÂNTICA, não de mecânica, e trocar uma pela
 *   outra quebra coisas diferentes em cada direção:
 *
 *   | | `resolve-conversation.ts` | esta |
 *   |-|---------------------------|------|
 *   | Cliente | service-role (API pública, sem humano) | do usuário, sob RLS |
 *   | Nasce atribuída? | Não | **Sim, a quem iniciou** |
 *   | Corrida no índice único | Re-resolve a vencedora | **409** |
 *
 *   O 409 não é pessimismo: sob a RLS da 039 a conversa de OUTRO agente
 *   é invisível ao SELECT, então o INSERT que colide com o índice único
 *   da 059 quase sempre significa "este contato já está sendo atendido",
 *   e não "perdi uma corrida". Re-resolver ali devolveria um id que o
 *   chamador não pode ler — 500 opaco alguns passos adiante.
 *
 *   Nascer atribuída é a regra "quem fala, assume": abrir thread a
 *   partir do contato (ou transferir de canal) é alguém tomando o
 *   atendimento, não enfileirando trabalho para outra pessoa.
 *
 * Extraída de `/api/whatsapp/send/route.ts` (SPEC 056 F2) sem uma linha
 * de mudança de comportamento — a rota de transferência precisa das
 * MESMAS três decisões acima, e uma terceira cópia deste find-or-create
 * é exatamente o que a SPEC 048 §5 desmontou no caminho de envio.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { isUniqueViolation } from '@/lib/contacts/dedupe';

export type FindOrCreateConversationResult =
  | { ok: true; id: string; assignedAgentId: string | null }
  | { ok: false; status: number; error: string };

/**
 * A conversa do contato neste canal, criando-a se ainda não existir.
 *
 * Roda sob a RLS do chamador — a policy `conversations_insert` exige
 * ser membro-agente da conta, o que o chamador já é.
 */
export async function findOrCreateInboxConversation(
  supabase: SupabaseClient,
  accountId: string,
  userId: string,
  contactId: string,
  channelId: string
): Promise<FindOrCreateConversationResult> {
  const { data: existing } = await supabase
    .from('conversations')
    .select('id, assigned_agent_id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('channel_id', channelId)
    .maybeSingle();

  if (existing) {
    return {
      ok: true,
      id: existing.id,
      assignedAgentId: existing.assigned_agent_id ?? null,
    };
  }

  const { data: created, error } = await supabase
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: userId,
      contact_id: contactId,
      channel_id: channelId,
      // Nasce já atribuída a quem iniciou: enviar a partir do Contato é,
      // por definição, alguém assumindo o atendimento. Poupa o
      // round-trip do claim logo em seguida — e a política
      // `conversations_insert` (039) aceita `= auth.uid()`.
      assigned_agent_id: userId,
    })
    .select('id, assigned_agent_id')
    .single();

  if (error) {
    // Duas causas, e distinguir importa:
    //   a) perdemos uma corrida — outro envio criou a thread agora;
    //   b) a conversa JÁ EXISTE mas pertence a outro agente, e a RLS da
    //      039 a escondeu do SELECT acima.
    // Nos dois casos o índice único de (account_id, contact_id,
    // channel_id) da migração 059 rejeita o INSERT. Antes disto, (b)
    // virava um 500 opaco ("Failed to open a conversation") — um erro de
    // servidor para o que na verdade é "este contato já está sendo
    // atendido".
    if (isUniqueViolation(error)) {
      return {
        ok: false,
        status: 409,
        error: 'This contact is already being handled by another agent',
      };
    }
    console.error(
      'Error creating conversation for contact send:',
      error.message
    );
    return {
      ok: false,
      status: 500,
      error: 'Failed to open a conversation for this contact',
    };
  }

  return {
    ok: true,
    id: created.id,
    assignedAgentId: created.assigned_agent_id ?? null,
  };
}
