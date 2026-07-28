// ============================================================
// Helpers de etiqueta (tags) — camada única de mutação.
//
// Antes desta lib, três módulos falavam com `tags` / `contact_tags`
// direto e divergiam entre si:
//
//   - settings/tag-manager.tsx      → criar / excluir do catálogo
//   - contacts/contact-detail-view  → toggle atribuir / remover
//   - contacts/contact-form.tsx     → sync no save
//
// A divergência não era só estilística: o toggle do contact-detail-view
// usava `insert` puro em contact_tags, que estoura com 23505
// (UNIQUE(contact_id, tag_id)) num duplo-clique ou numa corrida entre
// dois operadores. Centralizar aqui deixa a correção em um lugar só.
//
// Todas as funções recebem o client como primeiro argumento em vez de
// construí-lo — mantém o módulo puro e testável, e deixa o chamador
// decidir entre o client de browser e o de servidor.
//
// Nenhuma delas envia `account_id` em `contact_tags`: essa tabela não
// tem a coluna (a RLS resolve tenancy via join em `contacts`), então
// mandá-la faria o insert falhar.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Tag } from '@/types';

/**
 * Paleta fixa oferecida ao criar uma etiqueta. Os `name` casam com as
 * chaves de tradução em `Settings.tagsAndFields.colors.*`, reusadas
 * pelo picker do Inbox — não duplicar essas strings.
 */
export const PRESET_COLORS = [
  { name: 'red', value: '#ef4444' },
  { name: 'orange', value: '#f97316' },
  { name: 'amber', value: '#f59e0b' },
  { name: 'emerald', value: '#10b981' },
  { name: 'cyan', value: '#06b6d4' },
  { name: 'blue', value: '#3b82f6' },
  { name: 'violet', value: '#8b5cf6' },
  { name: 'pink', value: '#ec4899' },
] as const;

/** Cor padrão de uma etiqueta nova (emerald). */
export const DEFAULT_TAG_COLOR = PRESET_COLORS[3].value;

/** Violação de unicidade no Postgres — o nome de etiqueta já existe. */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Normaliza um nome de etiqueta para comparação. Espelha o
 * `lower(name)` do índice único da migração 038 — usar isto em toda
 * checagem client-side de "já existe" para que a UI e o banco
 * concordem sobre o que é duplicata.
 */
export function normalizeTagName(name: string): string {
  return name.trim().toLowerCase();
}

/** Busca no catálogo local uma etiqueta com o mesmo nome (case-insensitive). */
export function findTagByName(tags: Tag[], name: string): Tag | undefined {
  const norm = normalizeTagName(name);
  return tags.find((t) => normalizeTagName(t.name) === norm);
}

/** Catálogo de etiquetas da conta. A RLS (`tags_select`) faz o escopo. */
export async function fetchTags(supabase: SupabaseClient): Promise<Tag[]> {
  const { data, error } = await supabase.from('tags').select('*').order('name');
  if (error) throw error;
  return (data ?? []) as Tag[];
}

// Não há `fetchContactTags` aqui de propósito: as etiquetas de um
// contato já chegam hidratadas no estado da página via
// CONVERSATION_SELECT (`contact_tags(tags(*))`). Buscá-las de novo
// criaria uma segunda fonte de verdade que diverge da primeira depois
// de cada mutação — foi exatamente o que a ContactSidebar fazia antes.

/**
 * Vincula uma etiqueta a um contato.
 *
 * `upsert` e não `insert`: `UNIQUE(contact_id, tag_id)` faz o insert
 * puro estourar 23505 num duplo-clique ou quando outro operador
 * atribuiu a mesma etiqueta primeiro. Com `ignoreDuplicates` a
 * operação é idempotente e o "já estava atribuída" deixa de ser erro.
 */
export async function assignTag(
  supabase: SupabaseClient,
  contactId: string,
  tagId: string
): Promise<void> {
  const { error } = await supabase
    .from('contact_tags')
    .upsert(
      { contact_id: contactId, tag_id: tagId },
      { onConflict: 'contact_id,tag_id', ignoreDuplicates: true }
    );
  if (error) throw error;
}

/** Desvincula uma etiqueta de um contato. Remover o que não existe é no-op. */
export async function unassignTag(
  supabase: SupabaseClient,
  contactId: string,
  tagId: string
): Promise<void> {
  const { error } = await supabase
    .from('contact_tags')
    .delete()
    .eq('contact_id', contactId)
    .eq('tag_id', tagId);
  if (error) throw error;
}

export interface CreateTagInput {
  userId: string;
  accountId: string;
  name: string;
  color: string;
}

/**
 * Cria uma etiqueta, ou devolve a existente se o nome já estiver em uso
 * na conta (comparação case-insensitive).
 *
 * A atomicidade vem do índice único da migração 038: em vez de
 * "SELECT, e se não achar INSERT" — que perde a corrida entre dois
 * operadores digitando o mesmo nome — nós inserimos direto e tratamos
 * o 23505 como "alguém chegou antes, busca e usa aquela".
 *
 * Erros de RLS (42501) sobem para o chamador; a UI já deveria ter
 * gatado a ação por `canEditSettings`, então chegar aqui indica um gate
 * furado e merece um toast explícito.
 */
export async function createTag(
  supabase: SupabaseClient,
  { userId, accountId, name, color }: CreateTagInput
): Promise<Tag> {
  const trimmed = name.trim();

  const { data, error } = await supabase
    .from('tags')
    .insert({
      user_id: userId,
      account_id: accountId,
      name: trimmed,
      color,
    })
    .select()
    .single();

  if (!error) return data as Tag;

  if (error.code === PG_UNIQUE_VIOLATION) {
    // Deliberadamente NÃO usamos `.ilike('name', trimmed)` aqui: um
    // nome legítimo como "50% off" ou "lead_frio" seria interpretado
    // como padrão LIKE e casaria com a etiqueta errada. O catálogo é
    // um recurso de configuração (dezenas de linhas, não milhares),
    // então buscar tudo e comparar com o mesmo `normalizeTagName` que
    // o índice usa é barato e exato.
    const all = await fetchTags(supabase);
    const existing = findTagByName(all, trimmed);
    if (existing) return existing;
  }

  throw error;
}
