/**
 * Resolução da audiência em contatos reais — lado SERVIDOR (SPEC 044 §6.1).
 *
 * Antes disto a resolução morava dentro de `useBroadcastSending`, no
 * navegador: o wizard baixava a base inteira para a aba, criava os
 * contatos importados dali e só então disparava. Com o envio migrado
 * para o servidor, esta é a etapa que precisava vir junto — não faz
 * sentido o servidor enviar para uma lista que o cliente montou (e que
 * um cliente adulterado poderia montar como quisesse).
 *
 * Dois cuidados que a versão do navegador não tinha
 *
 *   1. **Paginação.** `select('*')` sem `.range()` é cortado em ~1000
 *      linhas pelo PostgREST, calado. Uma conta com 3 000 contatos
 *      disparava para 1 000 e mostrava "3 000" na tela de confirmação —
 *      a mesma armadilha que a `estimate.ts` documenta no cabeçalho.
 *   2. **Um só predicado.** As etiquetas e o campo personalizado são
 *      resolvidos pelas MESMAS funções que a estimativa usa
 *      (`contactIdsForTags` / `contactIdsForCustomField`), não por uma
 *      segunda cópia.
 *
 * Sobre etiquetas de exclusão e listas importadas
 *
 *   `excludeTagIds` NÃO se aplica ao tipo `csv`, deliberadamente, e é
 *   assim que a estimativa também se comporta (`estimate.ts`, ramo do
 *   csv) e o que a UI avisa em `audience.excludeNotAppliedToImport`.
 *   Uma linha importada é uma intenção explícita do usuário sobre
 *   aquele número; deixá-la cair por uma etiqueta que ele nem vê na
 *   planilha seria uma remoção invisível.
 *
 * Por que `accountId` é obrigatório nas leituras de contato
 *
 *   Até a fase 7 este módulo só rodava sob o cliente SSR do usuário, e a
 *   RLS por conta (017) fazia o escopo sozinha. O cron de agendamento
 *   (§6.3) roda com **service-role**, onde a RLS não existe: um
 *   `select('*')` em `contacts` devolveria a base de TODAS as contas, e
 *   uma audiência `all` agendada disparia para o banco inteiro. Por isso
 *   `fetchAllContacts` e `contactsByIds` passaram a exigir a conta
 *   explicitamente — redundante sob RLS, indispensável sem ela.
 *
 *   O mesmo vale para o caminho por etiqueta: `contact_tags` não tem
 *   `account_id`, então um id de etiqueta forjado poderia devolver ids
 *   de contato de outra conta. Como a hidratação filtra por conta, esses
 *   ids simplesmente não viram linha alguma.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { isUniqueViolation, normalizeKey } from '@/lib/contacts/dedupe';
import { BroadcastError } from '@/lib/whatsapp/broadcast-core';
import type { Contact } from '@/types';

import {
  contactIdsForCustomField,
  contactIdsForTags,
  type AudienceConfig,
} from './estimate';

/** Tamanho de página das leituras de contatos. Abaixo do teto do PostgREST. */
const PAGE_SIZE = 1000;

/** Valores por `.in(...)`. Meio do teto do PostgREST, com folga. */
const LOOKUP_CHUNK = 500;

/** Linhas por INSERT. O PostgREST tem teto de payload; 200 é folgado. */
const INSERT_CHUNK = 200;

export interface ImportedRow {
  phone: string;
  name?: string;
}

/**
 * Lê os contatos da conta paginando até o fim, em vez de aceitar o corte.
 *
 * `accountId` é obrigatório — ver a nota do cabeçalho sobre service-role.
 */
export async function fetchAllContacts(
  db: SupabaseClient,
  accountId: string
): Promise<Contact[]> {
  const out: Contact[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await db
      .from('contacts')
      .select('*')
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      throw new BroadcastError(
        'internal',
        `Failed to load contacts: ${error.message}`,
        500
      );
    }

    const page = (data ?? []) as Contact[];
    out.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  return out;
}

/**
 * Hidrata ids em linhas completas, fatiando o `.in(...)`.
 *
 * O filtro por conta é o que impede um id vindo de `contact_tags` (tabela
 * sem `account_id`) de virar contato de outra conta quando não há RLS.
 */
export async function contactsByIds(
  db: SupabaseClient,
  accountId: string,
  ids: string[]
): Promise<Contact[]> {
  const out: Contact[] = [];

  for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
    const slice = ids.slice(i, i + LOOKUP_CHUNK);
    const { data, error } = await db
      .from('contacts')
      .select('*')
      .eq('account_id', accountId)
      .in('id', slice);

    if (error) {
      throw new BroadcastError(
        'internal',
        `Failed to load contacts: ${error.message}`,
        500
      );
    }
    out.push(...((data ?? []) as Contact[]));
  }

  return out;
}

/**
 * Materializa linhas importadas (CSV / Excel / Sheets) em `contacts`.
 *
 * Veio de `useBroadcastSending.upsertCsvContacts` (SPEC 044 §1.4), com
 * o histórico de correções preservado porque cada uma custou um bug:
 *
 *   - O id de destinatário precisa ser um `contacts.id` real. A versão
 *     original sintetizava `csv-N`, que estourava o cast de UUID no
 *     insert — todo disparo por planilha criava zero destinatários.
 *   - O escopo é a CONTA, não o usuário. A RLS virou por conta na
 *     migração 017; filtrar por `user_id` fazia um número já salvo por
 *     um colega parecer novo, e o insert então batia no índice UNIQUE
 *     (account_id, phone_normalized) da migração 022 — ou duplicava a
 *     pessoa (SPEC 044 §7, item 2).
 *   - O casamento é por `phone_normalized`, coluna gerada só de
 *     dígitos, exatamente o que `sanitizePhoneForMeta` produz. Comparar
 *     `phone` cru fazia o match depender de como o número foi digitado.
 */
export async function upsertImportedContacts(
  db: SupabaseClient,
  params: { accountId: string; userId: string; rows: ImportedRow[] }
): Promise<Contact[]> {
  const { accountId, userId, rows } = params;
  if (rows.length === 0) return [];

  // Deduplica dentro do arquivo pela mesma chave canônica que o banco
  // usa, para duas grafias de um número colapsarem antes da consulta.
  const uniqueByKey = new Map<string, ImportedRow>();
  for (const row of rows) {
    const key = normalizeKey(row.phone);
    if (key && !uniqueByKey.has(key)) uniqueByKey.set(key, row);
  }
  const keys = [...uniqueByKey.keys()];

  const byKey = new Map<string, Contact>();
  for (let i = 0; i < keys.length; i += LOOKUP_CHUNK) {
    const slice = keys.slice(i, i + LOOKUP_CHUNK);
    const { data: existing, error: lookupErr } = await db
      .from('contacts')
      .select('*')
      .eq('account_id', accountId)
      .in('phone_normalized', slice);

    if (lookupErr) {
      throw new BroadcastError(
        'internal',
        `Failed to look up imported contacts: ${lookupErr.message}`,
        500
      );
    }
    for (const c of (existing ?? []) as Contact[]) {
      const key = normalizeKey(c.phone ?? '');
      if (key) byKey.set(key, c);
    }
  }

  const missingKeys = keys.filter((k) => !byKey.has(k));

  for (let i = 0; i < missingKeys.length; i += INSERT_CHUNK) {
    const chunkKeys = missingKeys.slice(i, i + INSERT_CHUNK);
    const chunk = chunkKeys.map((key) => ({
      user_id: userId,
      account_id: accountId,
      phone: uniqueByKey.get(key)!.phone,
      name: uniqueByKey.get(key)?.name ?? null,
    }));

    const { data: inserted, error: insertErr } = await db
      .from('contacts')
      .insert(chunk)
      .select();

    if (insertErr) {
      // 23505 aqui significa que um colega criou um destes contatos
      // entre a nossa leitura e este insert. Isso é uma corrida, não uma
      // falha — relê o lote e segue. Abortar o disparo inteiro porque um
      // número foi cadastrado concorrentemente seria pior do que enviar.
      if (!isUniqueViolation(insertErr)) {
        throw new BroadcastError(
          'internal',
          `Failed to create imported contacts: ${insertErr.message}`,
          500
        );
      }
      const { data: raced } = await db
        .from('contacts')
        .select('*')
        .eq('account_id', accountId)
        .in('phone_normalized', chunkKeys);
      for (const c of (raced ?? []) as Contact[]) {
        const key = normalizeKey(c.phone ?? '');
        if (key) byKey.set(key, c);
      }
      continue;
    }

    for (const c of (inserted ?? []) as Contact[]) {
      const key = normalizeKey(c.phone ?? '');
      if (key) byKey.set(key, c);
    }
  }

  // Preserva a ordem do arquivo para a tabela de destinatários bater
  // com a planilha que o usuário tem aberta ao lado.
  return keys.map((k) => byKey.get(k)).filter((c): c is Contact => Boolean(c));
}

/** Linhas por página ao ler o rascunho staged. Abaixo do teto do PostgREST. */
const STAGING_PAGE_SIZE = 1000;

interface StagingRow {
  phone: string;
  name: string | null;
  existing_contact_id: string | null;
}

/**
 * Resolve a audiência `staged` (SPEC 044 §3.3, §6.1 item "quando a fase
 * 4 chegar"): lê as linhas SELECIONADAS e VÁLIDAS de
 * `broadcast_audience_staging`, hidrata as que já são contato por id, e
 * materializa as demais — o mesmo caminho que o `csv` sempre usou.
 *
 * A leitura é direta na tabela (não pela view `broadcast_audience_triage`
 * da 046): o envio não precisa do histórico de engajamento, só de
 * telefone/nome/id, e ler a tabela base evita o custo do LEFT JOIN
 * LATERAL da view por linha.
 *
 * ⚠️ **O filtro por `account_id` NÃO é redundante.** `draftId` chega de
 * `audience_filter`, um JSONB que o dono da campanha consegue editar
 * direto pelo PostgREST (a política `broadcasts_update` da 017 libera
 * `agent` na PRÓPRIA linha). Sob RLS, apontá-lo para o rascunho de outra
 * conta não devolve nada — mas o cron da §6.3 lê com **service-role**,
 * onde RLS não existe: sem este filtro, um `draftId` de outra conta faria
 * o cron ler a audiência staged dela (telefone, nome, e-mail),
 * materializá-la como contato aqui e disparar para aquelas pessoas. É a
 * mesma travessia de conta que a política `bas_modify` da 045 fecha no
 * lado da escrita.
 */
async function resolveStagedAudience(
  db: SupabaseClient,
  params: { accountId: string; userId: string; draftId: string }
): Promise<Contact[]> {
  const { accountId, userId, draftId } = params;
  const rows: StagingRow[] = [];

  for (let from = 0; ; from += STAGING_PAGE_SIZE) {
    const { data, error } = await db
      .from('broadcast_audience_staging')
      .select('phone, name, existing_contact_id')
      .eq('broadcast_id', draftId)
      .eq('account_id', accountId)
      .eq('selected', true)
      .is('invalid_reason', null)
      .order('created_at', { ascending: true })
      .range(from, from + STAGING_PAGE_SIZE - 1);

    if (error) {
      throw new BroadcastError(
        'internal',
        `Failed to load staged audience: ${error.message}`,
        500
      );
    }

    const page = (data ?? []) as StagingRow[];
    rows.push(...page);
    if (page.length < STAGING_PAGE_SIZE) break;
  }

  const withContact = rows.filter(
    (r): r is StagingRow & { existing_contact_id: string } =>
      Boolean(r.existing_contact_id)
  );
  const withoutContact = rows.filter((r) => !r.existing_contact_id);

  const existing = await contactsByIds(
    db,
    accountId,
    withContact.map((r) => r.existing_contact_id)
  );

  const materialized = await upsertImportedContacts(db, {
    accountId,
    userId,
    rows: withoutContact.map((r) => ({
      phone: r.phone,
      name: r.name ?? undefined,
    })),
  });

  return [...existing, ...materialized];
}

export interface ResolveAudienceParams {
  accountId: string;
  /** Dono das linhas de contato criadas por uma importação. */
  userId: string;
  audience: AudienceConfig;
}

/**
 * Traduz uma `AudienceConfig` na lista de contatos que vão receber o
 * disparo. Nunca devolve o mesmo contato duas vezes.
 */
export async function resolveAudienceContacts(
  db: SupabaseClient,
  { accountId, userId, audience }: ResolveAudienceParams
): Promise<Contact[]> {
  let contacts: Contact[] = [];

  if (audience.type === 'all') {
    contacts = await fetchAllContacts(db, accountId);
  } else if (audience.type === 'tags') {
    const ids = await contactIdsForTags(db, audience.tagIds ?? []);
    contacts = await contactsByIds(db, accountId, [...ids]);
  } else if (audience.type === 'custom_field') {
    const cf = audience.customField;
    if (cf?.fieldId && cf.value) {
      const ids = await contactIdsForCustomField(db, cf);
      contacts = await contactsByIds(db, accountId, [...ids]);
    }
  } else if (audience.type === 'csv') {
    contacts = await upsertImportedContacts(db, {
      accountId,
      userId,
      rows: audience.csvContacts ?? [],
    });
  } else if (audience.type === 'staged') {
    if (!audience.draftId) {
      throw new BroadcastError(
        'bad_request',
        'Staged audience is missing draftId.',
        400
      );
    }
    contacts = await resolveStagedAudience(db, {
      accountId,
      userId,
      draftId: audience.draftId,
    });
  }

  // Exclusão por etiqueta — ver a nota do cabeçalho sobre o csv. O
  // mesmo raciocínio vale para `staged`: a triagem já É a exclusão, com
  // muito mais nuance do que uma etiqueta permitiria.
  if (
    audience.type !== 'csv' &&
    audience.type !== 'staged' &&
    audience.excludeTagIds &&
    audience.excludeTagIds.length > 0
  ) {
    const excluded = await contactIdsForTags(db, audience.excludeTagIds);
    contacts = contacts.filter((c) => !excluded.has(c.id));
  }

  // Defensivo: uma união de etiquetas já vem deduplicada por Set, mas
  // um contato repetido aqui viraria duas mensagens para a mesma pessoa
  // e dois consumos de cota.
  const seen = new Set<string>();
  return contacts.filter((c) => {
    if (!c.id || seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
}
