/**
 * Qual consulta a página de contatos faz, dados os filtros ativos
 * (SPEC 049 §4.5 · F5.1).
 *
 * ## Por que isto é um módulo, e não um `if` na página
 *
 * A página tem DOIS caminhos de leitura: o RPC `filter_contacts_by_tags`
 * (migração 025, agora 061) e um `select('*', { count: 'exact' })` direto
 * em `contacts`. Escolher errado não quebra a tela — ela renderiza uma
 * lista plausível com contatos faltando, porque resolver o filtro no
 * cliente estoura o teto de ~1000 linhas do PostgREST em silêncio (o
 * motivo documentado na 025 e repetido na SPEC 049 §1.4).
 *
 * A regra é curta e a falha é muda: exatamente o par que merece teste.
 *
 * ## A regra
 *
 * Qualquer filtro que precise de JOIN (etiqueta ou canal) vai pelo RPC.
 * Só busca textual, ou nada, continua no caminho direto — que já pagina
 * e conta corretamente sozinho.
 */

export const CONTACTS_PAGE_SIZE = 25;

export interface ContactFilterState {
  /** Termo digitado, ainda sem `trim`. */
  search: string;
  /** Etiquetas selecionadas — OR entre elas. */
  tagIds: string[];
  /** Canais selecionados — "tem conversa neste canal", OR entre eles. */
  channelIds: string[];
  /** Página 0-based. */
  page: number;
  pageSize?: number;
}

/** Argumentos nomeados do RPC — o formato que o PostgREST recebe. */
export interface ContactFilterRpcParams {
  p_tag_ids: string[];
  p_search: string | null;
  p_limit: number;
  p_offset: number;
  /**
   * `null` (e não `[]`) quando não há filtro de canal: é o valor que
   * mantém a chamada idêntica à da 025 para quem só filtra etiqueta.
   */
  p_channel_ids: string[] | null;
}

export type ContactQueryPlan =
  | { mode: 'rpc'; params: ContactFilterRpcParams }
  | {
      mode: 'table';
      /** `null` quando não há busca — evita um `.or()` vazio. */
      search: string | null;
      /** Índices inclusivos para `.range(from, to)`. */
      from: number;
      to: number;
    };

export function planContactQuery(state: ContactFilterState): ContactQueryPlan {
  const pageSize = state.pageSize ?? CONTACTS_PAGE_SIZE;
  const from = state.page * pageSize;
  const term = state.search.trim();
  const search = term.length > 0 ? term : null;

  const needsJoin = state.tagIds.length > 0 || state.channelIds.length > 0;

  if (!needsJoin) {
    return { mode: 'table', search, from, to: from + pageSize - 1 };
  }

  return {
    mode: 'rpc',
    params: {
      // Vazio é legítimo desde a 061: significa "não filtre por
      // etiqueta", e é o que o caminho "só canal" manda.
      p_tag_ids: state.tagIds,
      p_search: search,
      p_limit: pageSize,
      p_offset: from,
      p_channel_ids: state.channelIds.length > 0 ? state.channelIds : null,
    },
  };
}

/** Há filtro ativo? Decide a mensagem da lista vazia. */
export function hasActiveContactFilters(state: {
  search: string;
  tagIds: string[];
  channelIds: string[];
}): boolean {
  return (
    state.search.trim().length > 0 ||
    state.tagIds.length > 0 ||
    state.channelIds.length > 0
  );
}
