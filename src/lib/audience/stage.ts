/**
 * Staging da audiência — lado SERVIDOR (SPEC 044 §3.3, §3.5, §8.2).
 *
 * O que isto resolve
 *
 *   Antes desta rota a audiência do wizard vivia em `useState`: um F5
 *   apagava o trabalho, e uma "área de triagem" ROTEADA
 *   (`/broadcasts/new/[draftId]/triage`) não tem como existir sem um
 *   identificador persistido. `stageAudience` é o que cria esse
 *   identificador — grava um `broadcasts` com `status = 'draft'` e a
 *   audiência inteira em `broadcast_audience_staging` (migração 045),
 *   pronta para a triagem ler pela RPC `triage_audience_page` (046).
 *
 * Por que TODAS as fontes passam por aqui, não só planilha
 *
 *   O diagrama da §2 funila as seis fontes (Sheets/Excel/CSV/Tags/Campo
 *   personalizado/Todos) para o mesmo `[Analisar audiência]`. Uma
 *   triagem que só existisse para importação deixaria de fora o caso
 *   mais comum do produto — "enviar para a etiqueta X" — que se
 *   beneficia igualmente de ver quem está prestes a receber antes de
 *   queimar cota.
 *
 * Duas formas de virar uma linha staged
 *
 *   1. `csv` — o cliente já paginou o arquivo pelo parser (§3.2, §3.5) e
 *      manda linhas normalizadas + inválidas. Este módulo só CRUZA cada
 *      telefone com `contacts` (leitura, sem criar nada — a
 *      materialização fica para o envio, exatamente como `resolve.ts`
 *      já fazia para `csvContacts`).
 *   2. `all` / `tags` / `custom_field` — resolvidos aqui com as MESMAS
 *      funções que `estimate.ts` e `resolve.ts` usam
 *      (`contactIdsForTags`, `contactIdsForCustomField`,
 *      `fetchAllContacts`), então "quantos entram na triagem" nunca
 *      diverge de "quantos a estimativa do passo 2 prometeu".
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { normalizeKey } from '@/lib/contacts/dedupe';
import { BroadcastError } from '@/lib/whatsapp/broadcast-core';
import type { Contact } from '@/types';

import {
  contactIdsForCustomField,
  contactIdsForTags,
  type CustomFieldFilter,
} from './estimate';
import { contactsByIds, fetchAllContacts } from './resolve';
import type { InvalidReason } from './types';
import { MAX_AUDIENCE_ROWS } from '@/lib/spreadsheet/types';

/** Linhas por INSERT em `broadcast_audience_staging`. */
const INSERT_CHUNK = 200;

/** Valores por `.in(phone_normalized, …)`. Metade do teto do PostgREST. */
const LOOKUP_CHUNK = 500;

export interface StageRawRow {
  phone: string;
  name?: string;
  email?: string;
  company?: string;
  tagNames?: string[];
  sourceRow?: number;
}

export interface StageInvalidRow {
  sourceRow: number;
  rawPhone: string;
  name?: string;
  reason: InvalidReason;
}

export type StageAudienceInput =
  | { type: 'all'; excludeTagIds?: string[] }
  | { type: 'tags'; tagIds: string[]; excludeTagIds?: string[] }
  | {
      type: 'custom_field';
      customField: CustomFieldFilter;
      excludeTagIds?: string[];
    }
  | { type: 'csv'; rows: StageRawRow[]; invalidRows: StageInvalidRow[] };

export interface StageAudienceParams {
  accountId: string;
  userId: string;
  templateName: string;
  templateLanguage: string;
  audience: StageAudienceInput;
  /**
   * SPEC 057 D-1 — `canEditSettings(role)` de quem está montando o
   * disparo. Decide só a PROJEÇÃO de `tagsToCreate`/`tagsSkipped` (D-7):
   * a criação de verdade acontece no envio, com o mesmo valor recalculado
   * lá — este parâmetro nunca grava nada aqui.
   */
  canCreateTags: boolean;
}

export interface StageAudienceSummary {
  read: number;
  valid: number;
  duplicates: number;
  invalid: number;
  /** Quantas linhas válidas já casaram com um `contacts.id` existente. */
  existingContacts: number;
  /**
   * SPEC 057 D-7 — projeção do que o ENVIO vai fazer, não fato: nada é
   * escrito em `contacts`/`tags` no stage. `willCreate` conta linhas sem
   * contato existente; `willUpdate` conta contatos existentes cujo
   * e-mail ou empresa está vazio e a planilha traz um valor (D-2 —
   * campo já preenchido nunca é sobrescrito, então não conta aqui).
   */
  willCreate: number;
  willUpdate: number;
  /** Nomes de etiqueta da planilha que ainda não existem na conta. */
  tagsToCreate: string[];
  /** Subconjunto de `tagsToCreate` que NÃO será criado (sem permissão). */
  tagsSkipped: string[];
}

export interface StageAudienceResult {
  draftId: string;
  summary: StageAudienceSummary;
}

/** Forma exata do INSERT em `broadcast_audience_staging`. */
interface StagingInsertRow {
  account_id: string;
  phone: string;
  name: string | null;
  email: string | null;
  company: string | null;
  tag_names: string[];
  existing_contact_id: string | null;
  invalid_reason: string | null;
  source_row: number | null;
}

interface CrossReferencedContact {
  id: string;
  email: string | null;
  company: string | null;
}

/**
 * Cruza chaves de telefone já normalizadas contra `contacts` — leitura
 * pura, nunca cria. Espelha o loop de lookup de `upsertImportedContacts`
 * (SPEC 044 §1.4) sem a metade que insere: a triagem pode descartar a
 * linha antes de virar contato de verdade.
 *
 * Traz também `email`/`company` (SPEC 057 D-7): é o que permite projetar
 * `willUpdate` sem escrever nada — o envio decide de verdade com a MESMA
 * regra de COALESCE (D-2).
 */
async function crossReferenceContacts(
  db: SupabaseClient,
  accountId: string,
  keys: string[]
): Promise<Map<string, CrossReferencedContact>> {
  const byKey = new Map<string, CrossReferencedContact>();

  for (let i = 0; i < keys.length; i += LOOKUP_CHUNK) {
    const slice = keys.slice(i, i + LOOKUP_CHUNK);
    const { data, error } = await db
      .from('contacts')
      .select('id, phone, email, company')
      .eq('account_id', accountId)
      .in('phone_normalized', slice);

    if (error) {
      throw new BroadcastError(
        'internal',
        `Failed to cross-reference contacts: ${error.message}`,
        500
      );
    }
    for (const row of (data ?? []) as {
      id: string;
      phone: string;
      email: string | null;
      company: string | null;
    }[]) {
      const key = normalizeKey(row.phone);
      if (key)
        byKey.set(key, { id: row.id, email: row.email, company: row.company });
    }
  }

  return byKey;
}

/**
 * SPEC 057 D-7 — projeta `tagsToCreate`/`tagsSkipped` SEM criar nada:
 * lê os nomes de etiqueta já existentes na conta e separa os ausentes da
 * planilha conforme `canCreateTags`. A criação de verdade só acontece no
 * envio, via `resolveImportTagIds` (mesma regra, recalculada lá).
 */
async function projectTagOutcomes(
  db: SupabaseClient,
  accountId: string,
  rows: StageRawRow[],
  canCreateTags: boolean
): Promise<{ tagsToCreate: string[]; tagsSkipped: string[] }> {
  const uniqueNames: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const raw of row.tagNames ?? []) {
      const name = raw.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueNames.push(name);
    }
  }
  if (uniqueNames.length === 0) return { tagsToCreate: [], tagsSkipped: [] };

  const { data: existing, error } = await db
    .from('tags')
    .select('name')
    .eq('account_id', accountId);
  if (error) {
    throw new BroadcastError(
      'internal',
      `Failed to read tags: ${error.message}`,
      500
    );
  }
  const existingKeys = new Set(
    (existing ?? []).map((t) => t.name.trim().toLowerCase())
  );
  const missing = uniqueNames.filter((n) => !existingKeys.has(n.toLowerCase()));

  return canCreateTags
    ? { tagsToCreate: missing, tagsSkipped: [] }
    : { tagsToCreate: [], tagsSkipped: missing };
}

function contactToStagingRow(
  accountId: string,
  contact: Contact
): StagingInsertRow {
  return {
    account_id: accountId,
    phone: contact.phone,
    name: contact.name ?? null,
    email: contact.email ?? null,
    company: contact.company ?? null,
    // Tags reais chegam pela view (join em `contact_tags` por
    // `existing_contact_id`), não por este campo — que existe só para
    // guardar o nome de etiqueta vindo de uma planilha.
    tag_names: [],
    existing_contact_id: contact.id,
    invalid_reason: null,
    source_row: null,
  };
}

async function buildCsvStagingRows(
  db: SupabaseClient,
  accountId: string,
  audience: Extract<StageAudienceInput, { type: 'csv' }>,
  canCreateTags: boolean
): Promise<{ rows: StagingInsertRow[]; summary: StageAudienceSummary }> {
  const { rows, invalidRows } = audience;

  if (rows.length + invalidRows.length > MAX_AUDIENCE_ROWS) {
    throw new BroadcastError(
      'too_many_rows',
      `A spreadsheet is capped at ${MAX_AUDIENCE_ROWS} rows.`,
      400
    );
  }
  if (rows.length === 0 && invalidRows.length === 0) {
    throw new BroadcastError('empty_audience', 'No rows to stage.', 400);
  }

  const keys = [
    ...new Set(rows.map((r) => normalizeKey(r.phone)).filter(Boolean)),
  ];
  const byKey = await crossReferenceContacts(db, accountId, keys);

  const validRows: StagingInsertRow[] = rows.map((r) => ({
    account_id: accountId,
    phone: r.phone,
    name: r.name?.trim() || null,
    email: r.email?.trim() || null,
    company: r.company?.trim() || null,
    tag_names: r.tagNames ?? [],
    existing_contact_id: byKey.get(normalizeKey(r.phone))?.id ?? null,
    invalid_reason: null,
    source_row: r.sourceRow ?? null,
  }));

  const invalidStagingRows: StagingInsertRow[] = invalidRows.map((r) => ({
    account_id: accountId,
    phone: r.rawPhone,
    name: r.name?.trim() || null,
    email: null,
    company: null,
    tag_names: [],
    existing_contact_id: null,
    invalid_reason: r.reason,
    source_row: r.sourceRow,
  }));

  // SPEC 057 D-7 — projeção do que o ENVIO fará, sem escrever nada aqui.
  let willUpdate = 0;
  for (const r of rows) {
    const match = byKey.get(normalizeKey(r.phone));
    if (!match) continue;
    const email = r.email?.trim();
    const company = r.company?.trim();
    if ((!match.email && email) || (!match.company && company)) willUpdate++;
  }
  const { tagsToCreate, tagsSkipped } = await projectTagOutcomes(
    db,
    accountId,
    rows,
    canCreateTags
  );

  return {
    rows: [...validRows, ...invalidStagingRows],
    summary: {
      read: rows.length + invalidRows.length,
      valid: rows.length,
      duplicates: invalidRows.filter((r) => r.reason === 'duplicate_in_file')
        .length,
      invalid: invalidRows.filter((r) => r.reason !== 'duplicate_in_file')
        .length,
      existingContacts: validRows.filter((r) => r.existing_contact_id).length,
      willCreate: validRows.filter((r) => !r.existing_contact_id).length,
      willUpdate,
      tagsToCreate,
      tagsSkipped,
    },
  };
}

async function buildFilterStagingRows(
  db: SupabaseClient,
  accountId: string,
  audience: Exclude<StageAudienceInput, { type: 'csv' }>
): Promise<{ rows: StagingInsertRow[]; summary: StageAudienceSummary }> {
  let contacts: Contact[];

  if (audience.type === 'all') {
    contacts = await fetchAllContacts(db, accountId);
  } else if (audience.type === 'tags') {
    const ids = await contactIdsForTags(db, audience.tagIds);
    contacts = await contactsByIds(db, accountId, [...ids]);
  } else {
    const ids = await contactIdsForCustomField(db, audience.customField);
    contacts = await contactsByIds(db, accountId, [...ids]);
  }

  if (audience.excludeTagIds && audience.excludeTagIds.length > 0) {
    const excluded = await contactIdsForTags(db, audience.excludeTagIds);
    contacts = contacts.filter((c) => !excluded.has(c.id));
  }

  if (contacts.length === 0) {
    throw new BroadcastError(
      'empty_audience',
      'No contacts found for this audience.',
      400
    );
  }
  if (contacts.length > MAX_AUDIENCE_ROWS) {
    throw new BroadcastError(
      'too_many_rows',
      `This audience has more than ${MAX_AUDIENCE_ROWS} contacts — narrow it before staging.`,
      400
    );
  }

  return {
    rows: contacts.map((c) => contactToStagingRow(accountId, c)),
    summary: {
      read: contacts.length,
      valid: contacts.length,
      duplicates: 0,
      invalid: 0,
      existingContacts: contacts.length,
      // Fonte é `contacts` — nenhuma linha é nova nem traz dado de fora
      // para preencher, e não há coluna de etiquetas soltas neste ramo.
      willCreate: 0,
      willUpdate: 0,
      tagsToCreate: [],
      tagsSkipped: [],
    },
  };
}

/**
 * Cria o rascunho + grava a audiência staged. Lança {@link BroadcastError},
 * que a rota mapeia para status + código.
 */
export async function stageAudience(
  db: SupabaseClient,
  params: StageAudienceParams
): Promise<StageAudienceResult> {
  const {
    accountId,
    userId,
    templateName,
    templateLanguage,
    audience,
    canCreateTags,
  } = params;

  // Falha cedo, antes de gravar qualquer linha — mesmo cuidado de
  // `planDashboardBroadcast` (broadcast-dispatch.ts).
  const { data: templateRow } = await db
    .from('message_templates')
    .select('id')
    .eq('account_id', accountId)
    .eq('name', templateName)
    .eq('language', templateLanguage)
    .maybeSingle();
  if (!templateRow) {
    throw new BroadcastError(
      'template_not_found',
      'Template not found for this account.',
      404
    );
  }

  const { rows, summary } =
    audience.type === 'csv'
      ? await buildCsvStagingRows(db, accountId, audience, canCreateTags)
      : await buildFilterStagingRows(db, accountId, audience);

  // O nome real só é escolhido no passo 4; até lá o nome do template é
  // um placeholder identificável na lista de disparos.
  const { data: broadcast, error: broadcastError } = await db
    .from('broadcasts')
    .insert({
      user_id: userId,
      account_id: accountId,
      name: templateName,
      template_name: templateName,
      template_language: templateLanguage,
      status: 'draft',
      total_recipients: summary.valid,
    })
    .select('id')
    .single();

  if (broadcastError || !broadcast) {
    console.error('[stage-audience] create draft error:', broadcastError);
    throw new BroadcastError('internal', 'Failed to create draft', 500);
  }
  const draftId = broadcast.id as string;

  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows
      .slice(i, i + INSERT_CHUNK)
      .map((r) => ({ ...r, broadcast_id: draftId }));
    const { error } = await db.from('broadcast_audience_staging').insert(chunk);

    if (error) {
      // Rascunho sem a audiência inteira é pior do que nenhum — a
      // triagem mostraria uma foto incompleta sem avisar. Marca como
      // falho em vez de deixar um draft fantasma na lista.
      await db
        .from('broadcasts')
        .update({ status: 'failed' })
        .eq('id', draftId);
      console.error('[stage-audience] insert staging rows error:', error);
      throw new BroadcastError('internal', 'Failed to stage audience', 500);
    }
  }

  // Anti-fadiga (§6.2): quem já recebeu marketing dentro da janela de
  // cooldown da conta chega à triagem JÁ desmarcado — "filtro
  // automático", não um preset que o agente precisa lembrar de aplicar.
  // Reusa a MESMA `triage_set_selection` do §5.3 em vez de reimplementar
  // o predicado aqui; best-effort porque a audiência já foi gravada
  // corretamente — uma falha neste passo não deve derrubar o stage
  // inteiro, só deixar o preset "cooldown" como leitura manual.
  const { error: cooldownError } = await db.rpc('triage_set_selection', {
    p_draft_id: draftId,
    p_selected: false,
    p_search: null,
    p_filter: 'cooldown',
  });
  if (cooldownError) {
    console.error(
      '[stage-audience] cooldown auto-deselect error:',
      cooldownError
    );
  }

  return { draftId, summary };
}
