/**
 * Coleta em lotes para a exportação de contatos (SPEC 051 §5).
 *
 * O cliente recebido AQUI é sempre o de sessão (RLS do usuário) — nunca
 * `supabaseAdmin()`. `filter_contacts_by_tags` é `SECURITY INVOKER` e
 * não recebe `account_id`: chamá-la com service role devolveria
 * contatos de TODAS as contas (§1.2).
 *
 * Duas fontes de estouro silencioso do teto de ~1000 linhas do
 * PostgREST, e como cada uma é evitada:
 *
 *   1. A lista de contatos em si — resolvida com `planContactQuery`
 *      (o mesmo módulo que a tela usa), paginando com `page` crescente
 *      em vez de um único `select` sem `.range()`.
 *   2. As tabelas filhas (etiquetas, canais, campos personalizados,
 *      notas) — mesmo poucas linhas por contato somam rápido (500
 *      contatos × 4 etiquetas já estoura). `fetchAllRows` pagina com
 *      `.range()` até o lote vir incompleto; "simplificar" isso de
 *      volta para uma query sem paginação reintroduz o teto silencioso.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Contact } from '@/types';
import type { ChannelType } from '@/lib/channels/types';
import { resolveSessionWindow } from '@/lib/channels/session-window';
import { planContactQuery } from './contact-filter-query';
import type { ContactExportFieldId } from './export-fields';
import type { ContactExportRow } from './export-serialize';

export const CONTACT_EXPORT_BATCH = 1000;
export const CONTACT_EXPORT_MAX_ROWS = 50_000;

/** Quantos ids de contato entram num único `.in()` — mantém a URL da
 *  requisição PostgREST num tamanho razoável; o teto de linhas em si
 *  é resolvido por `fetchAllRows`, não por este número. 500 UUIDs vira
 *  uma URL de ~18KB de puro filtro (36 chars por id), o bastante para
 *  um proxy/CDN no meio do caminho derrubar a conexão com um "fetch
 *  failed" genérico antes de qualquer resposta do PostgREST — visto em
 *  teste manual contra uma conta com 533 contatos. 200 já reduz isso a
 *  ~7KB; o teste "chunking de ids acima de CONTACT_ID_CHUNK" em
 *  `export-fetch.test.ts` fixa que múltiplos chunks não perdem nem
 *  duplicam etiqueta de contato nenhum, para não regredir. */
const CONTACT_ID_CHUNK = 200;

export type ContactExportScope =
  | { mode: 'filter'; search: string; tagIds: string[]; channelIds: string[] }
  | { mode: 'selection'; ids: string[] };

interface FetchContactsForExportResult {
  rows: ContactExportRow[];
  truncated: boolean;
  /** Total do escopo — usado pela rota na mensagem de erro do 413. */
  total: number;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Pagina por `.range()` até o lote vir incompleto — o antídoto ao teto
 * silencioso do PostgREST nas tabelas filhas. NÃO troque isto por uma
 * única `.select()`: um contato com centenas de notas, ou uma conta com
 * poucos contatos mas muitas etiquetas cada, estoura em silêncio do
 * mesmo jeito que a listagem principal estourava antes da 025/049.
 */
export async function fetchAllRows<T>(
  makeQuery: (
    from: number,
    to: number
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;

  while (true) {
    const to = from + CONTACT_EXPORT_BATCH - 1;
    const { data, error } = await makeQuery(from, to);
    if (error) throw new Error(error.message);

    const batch = data ?? [];
    rows.push(...batch);

    if (batch.length < CONTACT_EXPORT_BATCH) break;
    from += CONTACT_EXPORT_BATCH;
  }

  return rows;
}

interface ContactQueryPageResult {
  rows: Contact[];
  total: number;
}

/** Executa uma página do plano de `planContactQuery` — mesma
 *  bifurcação RPC/tabela da tela de contatos (SPEC 049 §4.5). */
async function runContactQueryPage(
  supabase: SupabaseClient,
  plan: ReturnType<typeof planContactQuery>
): Promise<ContactQueryPageResult> {
  if (plan.mode === 'rpc') {
    const { data, error } = await supabase.rpc(
      'filter_contacts_by_tags',
      plan.params
    );
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { contact: Contact; total_count: number }[];
    return {
      rows: rows.map((r) => r.contact),
      total: rows.length > 0 ? Number(rows[0].total_count) : 0,
    };
  }

  let query = supabase
    .from('contacts')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(plan.from, plan.to);

  if (plan.search) {
    const like = `%${plan.search}%`;
    query = query.or(
      `name.ilike.${like},phone.ilike.${like},email.ilike.${like}`
    );
  }

  const { data, count, error } = await query;
  if (error) throw new Error(error.message);
  return { rows: (data ?? []) as Contact[], total: count ?? 0 };
}

/** Passo 1 (filtro): pagina `planContactQuery` com página crescente até
 *  esgotar. Corta assim que sabe que o total excede o teto — sem buscar
 *  as páginas seguintes à toa. */
async function fetchContactsByFilter(
  supabase: SupabaseClient,
  scope: { search: string; tagIds: string[]; channelIds: string[] }
): Promise<{ contacts: Contact[]; total: number }> {
  const contacts: Contact[] = [];
  let total = 0;
  let page = 0;

  while (true) {
    const plan = planContactQuery({
      search: scope.search,
      tagIds: scope.tagIds,
      channelIds: scope.channelIds,
      page,
      pageSize: CONTACT_EXPORT_BATCH,
    });

    const { rows: pageRows, total: pageTotal } = await runContactQueryPage(
      supabase,
      plan
    );

    if (page === 0) {
      total = pageTotal;
      if (total > CONTACT_EXPORT_MAX_ROWS) return { contacts: [], total };
    }

    contacts.push(...pageRows);

    if (pageRows.length < CONTACT_EXPORT_BATCH) break;
    page++;
  }

  return { contacts, total };
}

/** Passo 1 (seleção): `.in('id', ids)` em lotes de 1000, mesma
 *  ordenação da tela (`created_at DESC, id`). */
async function fetchContactsBySelection(
  supabase: SupabaseClient,
  ids: string[]
): Promise<{ contacts: Contact[]; total: number }> {
  const total = ids.length;
  if (total > CONTACT_EXPORT_MAX_ROWS) return { contacts: [], total };

  const contacts: Contact[] = [];
  for (const chunk of chunkArray(ids, CONTACT_EXPORT_BATCH)) {
    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .in('id', chunk)
      .order('created_at', { ascending: false })
      .order('id', { ascending: true });
    if (error) throw new Error(error.message);
    contacts.push(...((data ?? []) as Contact[]));
  }

  return { contacts, total };
}

async function fetchTagsByContact(
  supabase: SupabaseClient,
  contactIds: string[]
): Promise<Map<string, string[]>> {
  const { data: tagRows, error: tagsErr } = await supabase
    .from('tags')
    .select('id, name');
  if (tagsErr) throw new Error(tagsErr.message);
  const tagNameById = new Map<string, string>(
    ((tagRows ?? []) as { id: string; name: string }[]).map((t) => [
      t.id,
      t.name,
    ])
  );

  const byContact = new Map<string, string[]>();
  for (const chunk of chunkArray(contactIds, CONTACT_ID_CHUNK)) {
    const rows = await fetchAllRows<{ contact_id: string; tag_id: string }>(
      (from, to) =>
        supabase
          .from('contact_tags')
          .select('contact_id, tag_id')
          .in('contact_id', chunk)
          .range(from, to)
    );
    for (const row of rows) {
      const name = tagNameById.get(row.tag_id);
      if (!name) continue;
      const list = byContact.get(row.contact_id) ?? [];
      list.push(name);
      byContact.set(row.contact_id, list);
    }
  }

  for (const list of byContact.values())
    list.sort((a, b) => a.localeCompare(b));
  return byContact;
}

interface ConversationSignal {
  channelId: string | null;
  lastMessageAt: string | null;
  lastCustomerMessageAt: string | null;
}

interface ChannelInfo {
  name: string;
  type: ChannelType;
}

/** Uma única passada por `conversations` alimenta tanto `channels`
 *  quanto `last_interaction` — evita duas varreduras da mesma tabela. */
async function fetchConversationSignalsByContact(
  supabase: SupabaseClient,
  contactIds: string[]
): Promise<Map<string, ConversationSignal[]>> {
  const byContact = new Map<string, ConversationSignal[]>();

  for (const chunk of chunkArray(contactIds, CONTACT_ID_CHUNK)) {
    const rows = await fetchAllRows<{
      contact_id: string;
      channel_id: string | null;
      last_message_at: string | null;
      last_customer_message_at: string | null;
    }>((from, to) =>
      supabase
        .from('conversations')
        .select(
          'contact_id, channel_id, last_message_at, last_customer_message_at'
        )
        .in('contact_id', chunk)
        .range(from, to)
    );
    for (const row of rows) {
      const list = byContact.get(row.contact_id) ?? [];
      list.push({
        channelId: row.channel_id,
        lastMessageAt: row.last_message_at,
        lastCustomerMessageAt: row.last_customer_message_at,
      });
      byContact.set(row.contact_id, list);
    }
  }

  return byContact;
}

async function fetchChannelsById(
  supabase: SupabaseClient
): Promise<Map<string, ChannelInfo>> {
  const { data, error } = await supabase
    .from('channels')
    .select('id, name, type');
  if (error) throw new Error(error.message);
  return new Map(
    ((data ?? []) as { id: string; name: string; type: ChannelType }[]).map(
      (c) => [c.id, { name: c.name, type: c.type }]
    )
  );
}

async function fetchCustomValuesByContact(
  supabase: SupabaseClient,
  contactIds: string[]
): Promise<Map<string, Record<string, string>>> {
  const byContact = new Map<string, Record<string, string>>();

  for (const chunk of chunkArray(contactIds, CONTACT_ID_CHUNK)) {
    const rows = await fetchAllRows<{
      contact_id: string;
      custom_field_id: string;
      value: string | null;
    }>((from, to) =>
      supabase
        .from('contact_custom_values')
        .select('contact_id, custom_field_id, value')
        .in('contact_id', chunk)
        .range(from, to)
    );
    for (const row of rows) {
      const values = byContact.get(row.contact_id) ?? {};
      values[row.custom_field_id] = row.value ?? '';
      byContact.set(row.contact_id, values);
    }
  }

  return byContact;
}

interface NoteRow {
  created_at: string;
  note_text: string;
}

async function fetchNotesByContact(
  supabase: SupabaseClient,
  contactIds: string[]
): Promise<Map<string, NoteRow[]>> {
  const byContact = new Map<string, NoteRow[]>();

  for (const chunk of chunkArray(contactIds, CONTACT_ID_CHUNK)) {
    // Ordenado antes do `.range()`: cada página é uma fatia contígua da
    // sequência global mais-recente-primeiro, então a lista de um
    // contato específico sai ordenada mesmo se suas notas caírem em
    // páginas diferentes (uma subsequência de uma lista ordenada
    // continua ordenada).
    const rows = await fetchAllRows<{
      contact_id: string;
      note_text: string;
      created_at: string;
    }>((from, to) =>
      supabase
        .from('contact_notes')
        .select('contact_id, note_text, created_at')
        .in('contact_id', chunk)
        .order('created_at', { ascending: false })
        .range(from, to)
    );
    for (const row of rows) {
      const list = byContact.get(row.contact_id) ?? [];
      list.push({ created_at: row.created_at, note_text: row.note_text });
      byContact.set(row.contact_id, list);
    }
  }

  return byContact;
}

/**
 * Escolhe a conversa "atual" do contato (maior `last_message_at`) e
 * resolve a janela de 24h a partir do CANAL dela — não é "fechada" por
 * padrão: um canal não resolvido (conversa órfã de um canal apagado)
 * vira `null` (não se aplica), a mesma leitura conservadora que
 * `resolveSessionWindow` já usa para canais sem a regra (§3, §5.9).
 */
function resolveLastInteraction(
  signals: ConversationSignal[],
  channelsById: Map<string, ChannelInfo>
): { lastMessageAt: string | null; sessionWindowOpen: boolean | null } {
  let latest: ConversationSignal | null = null;
  for (const signal of signals) {
    if (!signal.lastMessageAt) continue;
    if (!latest || signal.lastMessageAt > (latest.lastMessageAt ?? '')) {
      latest = signal;
    }
  }
  if (!latest) return { lastMessageAt: null, sessionWindowOpen: null };

  const channel = latest.channelId ? channelsById.get(latest.channelId) : null;
  if (!channel) {
    return { lastMessageAt: latest.lastMessageAt, sessionWindowOpen: null };
  }

  const anchor = latest.lastCustomerMessageAt
    ? new Date(latest.lastCustomerMessageAt)
    : null;
  const window = resolveSessionWindow(channel.type, anchor);
  return {
    lastMessageAt: latest.lastMessageAt,
    sessionWindowOpen: window.applicable ? window.isOpen : null,
  };
}

export async function fetchContactsForExport(
  supabase: SupabaseClient,
  scope: ContactExportScope,
  fields: ContactExportFieldId[]
): Promise<FetchContactsForExportResult> {
  const { contacts, total } =
    scope.mode === 'filter'
      ? await fetchContactsByFilter(supabase, scope)
      : await fetchContactsBySelection(supabase, scope.ids);

  if (total > CONTACT_EXPORT_MAX_ROWS) {
    return { rows: [], truncated: true, total };
  }
  if (contacts.length === 0) {
    return { rows: [], truncated: false, total };
  }

  const contactIds = contacts.map((c) => c.id);

  const needsTags = fields.includes('tags');
  const needsCustomFields = fields.includes('custom_fields');
  const needsNotes = fields.includes('notes');
  const needsChannels = fields.includes('channels');
  const needsLastInteraction = fields.includes('last_interaction');
  const needsConversations = needsChannels || needsLastInteraction;

  const [tagsByContact, customValuesByContact, notesByContact] =
    await Promise.all([
      needsTags
        ? fetchTagsByContact(supabase, contactIds)
        : Promise.resolve(new Map<string, string[]>()),
      needsCustomFields
        ? fetchCustomValuesByContact(supabase, contactIds)
        : Promise.resolve(new Map<string, Record<string, string>>()),
      needsNotes
        ? fetchNotesByContact(supabase, contactIds)
        : Promise.resolve(new Map<string, NoteRow[]>()),
    ]);

  let channelsById = new Map<string, ChannelInfo>();
  let conversationsByContact = new Map<string, ConversationSignal[]>();
  if (needsConversations) {
    [channelsById, conversationsByContact] = await Promise.all([
      fetchChannelsById(supabase),
      fetchConversationSignalsByContact(supabase, contactIds),
    ]);
  }

  const rows: ContactExportRow[] = contacts.map((contact) => {
    const signals = conversationsByContact.get(contact.id) ?? [];
    const channelNames = needsChannels
      ? [
          ...new Set(
            signals
              .map((s) =>
                s.channelId ? channelsById.get(s.channelId)?.name : null
              )
              .filter((name): name is string => !!name)
          ),
        ].sort((a, b) => a.localeCompare(b))
      : [];
    const { lastMessageAt, sessionWindowOpen } = needsLastInteraction
      ? resolveLastInteraction(signals, channelsById)
      : { lastMessageAt: null, sessionWindowOpen: null };

    return {
      contact,
      tagNames: tagsByContact.get(contact.id) ?? [],
      channelNames,
      customValues: customValuesByContact.get(contact.id) ?? {},
      notes: notesByContact.get(contact.id) ?? [],
      lastMessageAt,
      sessionWindowOpen,
    };
  });

  return { rows, truncated: false, total };
}
