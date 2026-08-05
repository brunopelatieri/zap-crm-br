// ============================================================
// Helpers de negócio (deals) — camada única de leitura/mutação.
//
// Todas as funções recebem o client como primeiro argumento em vez de
// construí-lo — mesma convenção de `src/lib/tags.ts`: mantém o módulo
// puro e testável, e deixa o chamador decidir entre o client de
// browser e o de servidor.
//
// `fetchPipelines`/`fetchStages` lançam em erro (não engolem com
// console.error como `loadPipelines` em pipelines/page.tsx) — o
// chamador decide o que mostrar ("sem funis" vs. "falha de rede" não
// são o mesmo estado para o usuário).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Deal, Pipeline, PipelineStage } from '@/types';

/**
 * FK violada. Num insert de `deals` significa que o `stage_id` (ou o
 * `pipeline_id`) apontado pelo formulário não existe mais — um admin
 * excluiu a etapa entre o carregamento do modal e o envio. É o único
 * erro desta lib em que o estado em memória do chamador está
 * comprovadamente velho, então merece tratamento próprio: repuxar, em
 * vez do toast genérico de falha.
 */
export const PG_FOREIGN_KEY_VIOLATION = '23503';

/**
 * RLS negou a escrita (`deals_insert` exige agent+). Não deve chegar
 * aqui — a UI já é gatada por `canSendMessages` — mas o código
 * distingue "sem permissão" de "falha genérica" na mensagem.
 */
export const PG_INSUFFICIENT_PRIVILEGE = '42501';

/** Funis da conta. A RLS (`pipelines_select`) faz o escopo. */
export async function fetchPipelines(
  supabase: SupabaseClient
): Promise<Pipeline[]> {
  const { data, error } = await supabase
    .from('pipelines')
    .select('*')
    .order('created_at');
  if (error) throw error;
  return (data ?? []) as Pipeline[];
}

/**
 * Etapas de um funil, ordenadas por `position` (a mesma ordem do board
 * e da tela de configurações). `pipeline_stages` não tem `account_id`
 * — a RLS resolve o escopo via join em `pipelines`.
 */
export async function fetchStages(
  supabase: SupabaseClient,
  pipelineId: string
): Promise<PipelineStage[]> {
  const { data, error } = await supabase
    .from('pipeline_stages')
    .select('*')
    .eq('pipeline_id', pipelineId)
    .order('position');
  if (error) throw error;
  return (data ?? []) as PipelineStage[];
}

export interface CreateDealInput {
  userId: string;
  accountId: string;
  pipelineId: string;
  stageId: string;
  contactId: string;
  title: string;
  value?: number;
  currency: string;
  assignedTo?: string | null;
  /**
   * Fora do escopo do modal do Inbox (SPEC de integração Kanban §1.3)
   * — só o formulário completo de `/pipelines` os expõe. Opcionais
   * aqui para que `deal-form.tsx` possa reusar este helper sem perder
   * os dois campos.
   */
  notes?: string | null;
  expectedCloseDate?: string | null;
}

/**
 * Cria um negócio já vinculado a um contato. O embed de `stage` não é
 * decorativo: a sidebar do Inbox renderiza `deal.stage.color/name` do
 * card recém-criado sem refetch — sem o embed ele apareceria sem a
 * pílula da etapa até a próxima troca de conversa.
 */
export async function createDeal(
  supabase: SupabaseClient,
  input: CreateDealInput
): Promise<Deal> {
  const { data, error } = await supabase
    .from('deals')
    .insert({
      user_id: input.userId,
      account_id: input.accountId,
      pipeline_id: input.pipelineId,
      stage_id: input.stageId,
      contact_id: input.contactId,
      title: input.title.trim(),
      value: input.value ?? 0,
      currency: input.currency,
      assigned_to: input.assignedTo || null,
      notes: input.notes || null,
      expected_close_date: input.expectedCloseDate || null,
      status: 'open',
    })
    .select('*, stage:pipeline_stages(*)')
    .single();

  if (error) throw error;
  return data as Deal;
}
