/**
 * Estimativa de alcance da audiência — fonte única de verdade.
 *
 * Antes desta função o número aparecia em dois lugares com lógicas
 * diferentes: o passo 2 aplicava `excludeTagIds` e sabia resolver
 * `custom_field`; o passo 4 não fazia nem uma coisa nem outra. O
 * usuário via "1 198 destinatários" na tela de audiência e "1 240" na
 * tela de confirmação, sem nada explicando a diferença. Os dois passos
 * agora chamam daqui (SPEC 044 §7, item 3).
 *
 * Sobre o teto de linhas do PostgREST
 *
 *   Um `select('contact_id')` sem paginação é silenciosamente cortado
 *   em ~1000 linhas — o mesmo problema documentado no cabeçalho da
 *   migração 025 e contornado por paginação em `fetchCustomValueIndex`.
 *   A implementação anterior no passo 2 caía nisso: uma etiqueta com
 *   3 000 contatos estimava 1 000. `fetchAllIds` pagina até o fim.
 *
 * Sobre opt-out (SPEC 044 §6.8)
 *
 *   Quem está em `opted_out` não entra em audiência de marketing — e o
 *   envio impõe isso no servidor (`broadcast-dispatch.ts`). A estimativa
 *   precisa aplicar a MESMA subtração, ou o wizard prometeria 1 198 e o
 *   disparo alcançaria 1 184: exatamente a divergência de duas fontes de
 *   verdade que o §7 item 3 existiu para eliminar.
 *
 *   Quem decide se a subtração vale é o CHAMADOR, via
 *   `excludeOptedOut` — porque a regra é por categoria de template
 *   (`excludesOptedOut` em `lib/contacts/consent.ts`) e a estimativa não
 *   conhece o template.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type CustomFieldOperator = 'is' | 'is_not' | 'contains';

export interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

export interface AudienceConfig {
  type: 'all' | 'tags' | 'custom_field' | 'csv' | 'staged';
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: { phone: string; name?: string }[];
  /** Contatos com qualquer uma destas etiquetas são subtraídos do resultado. */
  excludeTagIds?: string[];
  /**
   * Id do rascunho staged (`broadcasts.id`, status `draft`) — SPEC 044
   * §3.3. Presente só quando `type === 'staged'`: a audiência já foi
   * triada em `/broadcasts/new/[draftId]/triage` e o que resta é ler as
   * linhas `selected` de `broadcast_audience_staging`.
   */
  draftId?: string;
}

export interface EstimateOptions {
  /**
   * Subtrai da estimativa os contatos em `opted_out` (SPEC 044 §6.8).
   * A UI passa `excludesOptedOut(template.category)` — a regra vale para
   * marketing, não para Utility/Authentication.
   */
  excludeOptedOut?: boolean;
  /**
   * Subtrai da estimativa os contatos com `whatsapp_status = 'invalid'`
   * — número morto (SPEC 044 §6.4). Ao contrário de `excludeOptedOut`,
   * não depende da categoria do template: um número morto nunca vale a
   * pena tentar de novo, então todo chamador real passa `true`.
   * Continua sendo uma opção — e não um comportamento embutido — pelo
   * mesmo motivo do resto deste arquivo: `estimateAudience` é uma
   * função pura do que o chamador pede.
   */
  excludeInvalidWhatsapp?: boolean;
}

/** Tamanho de página das leituras de id. Abaixo do teto do PostgREST. */
const ID_PAGE_SIZE = 1000;

type IdRow = { contact_id: string | null };

/**
 * Lê todos os `contact_id` de uma query paginando até o fim, em vez de
 * aceitar o corte silencioso da primeira página.
 */
async function fetchAllIds(
  build: () => {
    range: (from: number, to: number) => PromiseLike<{ data: IdRow[] | null }>;
  }
): Promise<Set<string>> {
  const ids = new Set<string>();
  let from = 0;

  for (;;) {
    const { data } = await build().range(from, from + ID_PAGE_SIZE - 1);
    const page = data ?? [];
    for (const row of page) {
      if (row.contact_id) ids.add(row.contact_id);
    }
    if (page.length < ID_PAGE_SIZE) break;
    from += ID_PAGE_SIZE;
  }

  return ids;
}

/**
 * Contatos que carregam qualquer uma das etiquetas informadas.
 *
 * Exportada porque `resolve.ts` (o caminho de ENVIO) precisa do mesmo
 * predicado que a estimativa. Duas implementações seriam duas chances de
 * divergir, e a divergência apareceria como "a tela prometeu 3 000 e o
 * disparo alcançou 1 000".
 */
export async function contactIdsForTags(
  db: SupabaseClient,
  tagIds: string[]
): Promise<Set<string>> {
  if (tagIds.length === 0) return new Set();
  return fetchAllIds(() =>
    db.from('contact_tags').select('contact_id').in('tag_id', tagIds)
  );
}

/**
 * Contatos da conta em `opted_out` (SPEC 044 §6.8).
 *
 * Lê `id` (e não `contact_id`) porque a fonte é a própria `contacts` —
 * daí o builder próprio em vez de `fetchAllIds`. Pagina pelo mesmo
 * motivo de todo o resto deste arquivo: sem `.range()` o PostgREST
 * cortaria a lista em ~1000 e a subtração ficaria pela metade, sem erro
 * nenhum na tela.
 *
 * A RLS de `contacts` (017) escopa por conta; no caminho de service-role
 * (cron) esta função não é usada — lá o filtro acontece em memória sobre
 * as linhas já carregadas, que vêm escopadas por `accountId`.
 */
export async function contactIdsOptedOut(
  db: SupabaseClient
): Promise<Set<string>> {
  const ids = new Set<string>();

  for (let from = 0; ; from += ID_PAGE_SIZE) {
    const { data } = await db
      .from('contacts')
      .select('id')
      .eq('opt_in_status', 'opted_out')
      .range(from, from + ID_PAGE_SIZE - 1);

    const page = (data ?? []) as { id: string }[];
    for (const row of page) ids.add(row.id);
    if (page.length < ID_PAGE_SIZE) break;
  }

  return ids;
}

/**
 * Contatos da conta com `whatsapp_status = 'invalid'` — número morto
 * (SPEC 044 §6.4). Mesmo formato de `contactIdsOptedOut`, pelo mesmo
 * motivo: `resolve.ts`/`broadcast-dispatch.ts` filtram em memória sobre
 * contatos já carregados; a estimativa lê a lista à parte só quando
 * precisa DESCONTAR de um conjunto (etiqueta/campo), nunca no caminho
 * "todos" — ali o filtro entra direto no `count`.
 */
export async function contactIdsInvalidWhatsapp(
  db: SupabaseClient
): Promise<Set<string>> {
  const ids = new Set<string>();

  for (let from = 0; ; from += ID_PAGE_SIZE) {
    const { data } = await db
      .from('contacts')
      .select('id')
      .eq('whatsapp_status', 'invalid')
      .range(from, from + ID_PAGE_SIZE - 1);

    const page = (data ?? []) as { id: string }[];
    for (const row of page) ids.add(row.id);
    if (page.length < ID_PAGE_SIZE) break;
  }

  return ids;
}

/** Contatos cujo valor de campo personalizado casa com o filtro. Ver
 *  a nota de `contactIdsForTags` sobre por que é exportada. */
export async function contactIdsForCustomField(
  db: SupabaseClient,
  filter: CustomFieldFilter
): Promise<Set<string>> {
  return fetchAllIds(() => {
    const q = db
      .from('contact_custom_values')
      .select('contact_id')
      .eq('custom_field_id', filter.fieldId);

    if (filter.operator === 'is') return q.eq('value', filter.value);
    if (filter.operator === 'is_not') return q.neq('value', filter.value);
    return q.ilike('value', `%${filter.value}%`);
  });
}

/**
 * Estima quantos contatos receberiam este disparo.
 *
 * Devolve `null` quando a audiência está parcialmente configurada (o
 * usuário escolheu "por etiqueta" mas ainda não escolheu nenhuma) —
 * `null` significa "ainda não dá para saber", que é diferente de `0`
 * ("dá para saber, e é nenhum"). A UI trata os dois casos com textos
 * diferentes.
 */
export async function estimateAudience(
  db: SupabaseClient,
  audience: AudienceConfig,
  options: EstimateOptions = {}
): Promise<number | null> {
  const excludeOptedOut = options.excludeOptedOut ?? false;
  const excludeInvalidWhatsapp = options.excludeInvalidWhatsapp ?? false;

  // Staged: a triagem já decidiu quem entra (`selected`) e o que é
  // enviável (`invalid_reason IS NULL`).
  //
  // A contagem vem da RPC de resumo (046, ampliada na 048) e não de um
  // count direto na tabela: é a MESMA passada que alimenta os cards da
  // triagem, então "vai receber" tem um valor só. Um count paralelo aqui
  // voltaria a divergir da tela no dia em que a regra mudasse.
  //
  // ⚠️ Lacuna conhecida: `audience_engagement_summary` (048) ainda não
  // conhece `whatsapp_status` (§6.4, migração 049) — `sendable_rows`
  // não desconta número morto. O ponto de imposição de verdade
  // (`planDashboardBroadcast`) filtra correto mesmo assim, porque opera
  // sobre `Contact[]` já materializado, não sobre esta RPC; o único
  // efeito da lacuna é a triagem poder mostrar um número um pouco
  // otimista para audiências staged, até a view ganhar a coluna.
  if (audience.type === 'staged') {
    if (!audience.draftId) return null;
    const { data, error } = await db.rpc('audience_engagement_summary', {
      p_draft_id: audience.draftId,
      p_search: null,
      p_filter: 'all',
    });
    // Erro de RPC devolve `null` ("ainda não dá para saber"), não uma
    // exceção: os chamadores são efeitos de UI sem `catch` (o passo 4 e a
    // página de triagem), e lançar aqui viraria uma rejeição não tratada
    // no lugar de um número. `null` fecha o caminho no lado seguro — a
    // triagem trata como 0 e o botão de continuar fica desabilitado.
    if (error) {
      console.error('[estimate] audience_engagement_summary error:', error);
      return null;
    }
    const row = (
      data as { selected_valid_rows: number; sendable_rows: number }[] | null
    )?.[0];
    if (!row) return 0;
    return Number(
      excludeOptedOut ? row.sendable_rows : row.selected_valid_rows
    );
  }

  // CSV/planilha é auto-contido: as linhas já foram validadas e
  // deduplicadas no cliente, e contatos importados não carregam
  // etiquetas ainda — então exclude não se aplica.
  //
  // Opt-out também não é subtraído aqui: uma linha de planilha ainda não
  // é contato, e cruzar cada número com a base para descobrir quem está
  // em opt-out é exatamente o trabalho que a triagem (§3.3) faz — o
  // caminho `csv` direto existe para quem NÃO passou por ela. O envio
  // ainda remove os opted_out, então este número pode ficar acima do
  // alcance real; é o único ramo em que isso acontece.
  if (audience.type === 'csv') {
    const csv = audience.csvContacts;
    if (!csv || csv.length === 0) return null;
    return csv.length;
  }

  // `null` = "todos os contatos", resolvido por count no final.
  let baseIds: Set<string> | null = null;

  if (audience.type === 'tags') {
    if (!audience.tagIds || audience.tagIds.length === 0) return null;
    baseIds = await contactIdsForTags(db, audience.tagIds);
  } else if (audience.type === 'custom_field') {
    const cf = audience.customField;
    if (!cf?.fieldId || !cf.value) return null;
    baseIds = await contactIdsForCustomField(db, cf);
  } else if (audience.type !== 'all') {
    return null;
  }

  const excludeIds =
    audience.excludeTagIds && audience.excludeTagIds.length > 0
      ? await contactIdsForTags(db, audience.excludeTagIds)
      : null;

  // Os conjuntos de opted_out / número morto só são LIDOS quando alguém
  // vai consultá-los: com `baseIds` (etiqueta/campo) para subtrair, ou
  // com `excludeIds` para descontar a interseção. No caso "todos, sem
  // etiqueta de exclusão" o filtro acontece no próprio count, e ler a
  // lista aqui seria uma varredura paginada da base para nada.
  const optedOutIds =
    excludeOptedOut && (baseIds !== null || excludeIds !== null)
      ? await contactIdsOptedOut(db)
      : null;
  const invalidWhatsappIds =
    excludeInvalidWhatsapp && (baseIds !== null || excludeIds !== null)
      ? await contactIdsInvalidWhatsapp(db)
      : null;

  if (baseIds) {
    let count = 0;
    for (const id of baseIds) {
      if (excludeIds?.has(id)) continue;
      if (optedOutIds?.has(id)) continue;
      if (invalidWhatsappIds?.has(id)) continue;
      count++;
    }
    return count;
  }

  // "Todos" — um count exato da tabela, já sem os opted_out / número
  // morto (o filtro no banco é mais barato e mais exato do que subtrair
  // um conjunto lido à parte), menos os excluídos por etiqueta.
  let query = db.from('contacts').select('*', { count: 'exact', head: true });
  if (excludeOptedOut) query = query.neq('opt_in_status', 'opted_out');
  if (excludeInvalidWhatsapp) query = query.neq('whatsapp_status', 'invalid');
  const { count } = await query;
  const total = count ?? 0;

  if (!excludeIds) return total;

  // Um contato pode estar em mais de um conjunto ao mesmo tempo
  // (etiqueta excluída E opt-out, por exemplo); como opted_out/número
  // morto já saíram do `total` acima, subtrair o tamanho cheio de
  // `excludeIds` contaria alguns duas vezes. Por isso a interseção é
  // descontada explicitamente.
  //
  // `excludeIds` também pode conter ids de contatos já apagados (a FK de
  // contact_tags cascateia, mas a leitura e o count não são atômicos),
  // então o resultado é limitado em zero.
  let excluded = 0;
  for (const id of excludeIds) {
    if (optedOutIds?.has(id)) continue;
    if (invalidWhatsappIds?.has(id)) continue;
    excluded++;
  }
  return Math.max(0, total - excluded);
}
