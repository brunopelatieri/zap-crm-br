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
import {
  assignImportedContactTags,
  resolveImportTagIds,
  type ContactTagAssignment,
} from '@/lib/contacts/resolve-import-tags';
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
  /** SPEC 057 F2 — perdido antes desta SPEC: só `phone`/`name` eram gravados. */
  email?: string;
  company?: string;
  /** SPEC 057 F3 — nomes de etiqueta da planilha, resolvidos via `resolveImportTagIds`. */
  tagNames?: string[];
}

export interface UpsertImportedContactsResult {
  /** Na mesma ordem do arquivo — novos e já existentes. */
  contacts: Contact[];
  /** Nomes de etiqueta que não puderam ser criados (sem permissão, D-1). */
  tagsSkipped: string[];
  /** Nomes de etiqueta criados por esta chamada. */
  tagsCreated: string[];
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
  params: {
    accountId: string;
    userId: string;
    rows: ImportedRow[];
    /** Admin+ da conta pode criar etiquetas ausentes da planilha (D-1). */
    canCreateTags?: boolean;
  }
): Promise<UpsertImportedContactsResult> {
  const { accountId, userId, rows, canCreateTags = false } = params;
  if (rows.length === 0)
    return { contacts: [], tagsSkipped: [], tagsCreated: [] };

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
    const chunk = chunkKeys.map((key) => {
      const row = uniqueByKey.get(key)!;
      return {
        user_id: userId,
        account_id: accountId,
        phone: row.phone,
        name: row.name ?? null,
        email: row.email?.trim() || null,
        company: row.company?.trim() || null,
      };
    });

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

  // D-2: preenche email/company vazios em contatos JÁ existentes — nunca
  // sobrescreve um valor já preenchido. Cobre tanto quem veio da leitura
  // original quanto quem acabou de ser inserido/raceado acima (nesses
  // casos o contato já reflete a linha, então o "preenchimento" é um
  // no-op barato).
  await fillMissingContactFields(db, uniqueByKey, byKey);

  // F3: etiquetas da planilha. Resolvidas uma única vez para TODOS os
  // nomes (R-5) — nunca dentro do laço por contato.
  const { tagsSkipped, tagsCreated } = await assignTagsFromRows(db, {
    accountId,
    userId,
    canCreateTags,
    uniqueByKey,
    byKey,
  });

  // Preserva a ordem do arquivo para a tabela de destinatários bater
  // com a planilha que o usuário tem aberta ao lado.
  const contacts = keys
    .map((k) => byKey.get(k))
    .filter((c): c is Contact => Boolean(c));

  return { contacts, tagsSkipped, tagsCreated };
}

/**
 * D-2 — preenche `email`/`company` vazios em contatos existentes.
 *
 * Muta o `Contact` em `byKey` NA HORA (antes do write), não só grava no
 * banco: `upsertImportedContacts` devolve os mesmos objetos deste mapa, e
 * `resolveVariables` (personalização do disparo) lê `contact.email`
 * direto do objeto em memória. Sem a mutação, o disparo que ACABOU de
 * trazer o e-mail pela planilha o personalizaria com string vazia — a
 * SPEC 057 corrigiu a perda de dado na base e reintroduziria a mesma
 * perda na mensagem enviada (achado de revisão pós-057).
 *
 * Os writes são agrupados por FORMATO (só email / só company / os dois)
 * em vez de um `upsert` só: um lote misturando "só email" e "só company"
 * formaria uma única lista de colunas para o INSERT do upsert, e a linha
 * que não tem `company` gravaria NULL nela via `ON CONFLICT DO UPDATE
 * SET company = EXCLUDED.company` — a sobrescrita silenciosa que D-2
 * proíbe (R-2). Dentro de um grupo todo contato tem exatamente as mesmas
 * colunas, então o upsert é seguro — e cada linha carrega
 * `account_id`/`user_id`/`phone` (NOT NULL sem default) porque o
 * Postgres valida a tupla do INSERT antes de sequer checar o
 * ON CONFLICT; omiti-las faria o upsert falhar mesmo o conflito sempre
 * acontecendo.
 */
async function fillMissingContactFields(
  db: SupabaseClient,
  uniqueByKey: Map<string, ImportedRow>,
  byKey: Map<string, Contact>
): Promise<void> {
  const both: Contact[] = [];
  const emailOnly: Contact[] = [];
  const companyOnly: Contact[] = [];

  for (const [key, contact] of byKey) {
    const row = uniqueByKey.get(key);
    if (!row) continue;

    const email = row.email?.trim() || undefined;
    const company = row.company?.trim() || undefined;
    const needsEmail = !contact.email && Boolean(email);
    const needsCompany = !contact.company && Boolean(company);
    if (!needsEmail && !needsCompany) continue;

    if (needsEmail) contact.email = email;
    if (needsCompany) contact.company = company;

    if (needsEmail && needsCompany) both.push(contact);
    else if (needsEmail) emailOnly.push(contact);
    else companyOnly.push(contact);
  }

  await upsertContactFieldGroup(db, both, ['email', 'company']);
  await upsertContactFieldGroup(db, emailOnly, ['email']);
  await upsertContactFieldGroup(db, companyOnly, ['company']);
}

async function upsertContactFieldGroup(
  db: SupabaseClient,
  contacts: Contact[],
  fields: ('email' | 'company')[]
): Promise<void> {
  if (contacts.length === 0) return;

  for (let i = 0; i < contacts.length; i += INSERT_CHUNK) {
    const chunk = contacts.slice(i, i + INSERT_CHUNK).map((c) => {
      const row: Record<string, unknown> = {
        id: c.id,
        account_id: c.account_id,
        user_id: c.user_id,
        phone: c.phone,
      };
      for (const field of fields) row[field] = c[field];
      return row;
    });

    const { error } = await db.from('contacts').upsert(chunk, {
      onConflict: 'id',
    });
    if (error) {
      console.error('[upsertImportedContacts] fill fields error:', error);
    }
  }
}

/**
 * F3 — resolve os nomes de etiqueta de TODAS as linhas em uma só ida ao
 * banco (R-5) e vincula cada contato às suas. Reusa `resolveImportTagIds`
 * / `assignImportedContactTags` (SPEC 055) em vez de duplicar a lógica —
 * ver A-6.
 */
async function assignTagsFromRows(
  db: SupabaseClient,
  params: {
    accountId: string;
    userId: string;
    canCreateTags: boolean;
    uniqueByKey: Map<string, ImportedRow>;
    byKey: Map<string, Contact>;
  }
): Promise<{ tagsSkipped: string[]; tagsCreated: string[] }> {
  const { accountId, userId, canCreateTags, uniqueByKey, byKey } = params;

  const allNames: string[] = [];
  for (const row of uniqueByKey.values()) {
    if (row.tagNames) allNames.push(...row.tagNames);
  }
  if (allNames.length === 0) return { tagsSkipped: [], tagsCreated: [] };

  const { tagIdByKey, skippedNames, createdNames } = await resolveImportTagIds(
    db,
    { accountId, userId, tagNames: allNames, canCreateTags }
  );

  const assignments: ContactTagAssignment[] = [];
  for (const [key, row] of uniqueByKey) {
    if (!row.tagNames || row.tagNames.length === 0) continue;
    const contact = byKey.get(key);
    if (!contact) continue;
    assignments.push({ contactId: contact.id, tagNames: row.tagNames });
  }

  if (assignments.length > 0) {
    await assignImportedContactTags(db, assignments, tagIdByKey);
  }

  return { tagsSkipped: skippedNames, tagsCreated: createdNames };
}

/** Linhas por página ao ler o rascunho staged. Abaixo do teto do PostgREST. */
const STAGING_PAGE_SIZE = 1000;

interface StagingRow {
  phone: string;
  name: string | null;
  email: string | null;
  company: string | null;
  tag_names: string[] | null;
  existing_contact_id: string | null;
}

/**
 * Resolve a audiência `staged` (SPEC 044 §3.3, §6.1 item "quando a fase
 * 4 chegar"): lê as linhas SELECIONADAS e VÁLIDAS de
 * `broadcast_audience_staging`, hidrata as já casadas por
 * `existing_contact_id` (o contato que o operador de fato revisou na
 * triagem), materializa as demais pelo mesmo caminho do `csv`, e aplica
 * o preenchimento de email/company (D-2) + as etiquetas da planilha (F3)
 * às DUAS — não só às novas.
 *
 * Por que a hidratação por id voltou (revisão de código pós-057)
 *
 *   Uma versão anterior desta função tinha as já-casadas passando pelo
 *   MESMO cruzamento por `phone_normalized` que as novas — o raciocínio
 *   era "uma função só para os dois casos". Mas `phone_normalized` re-
 *   deriva o vínculo a partir do telefone da PLANILHA, não do contato
 *   que o operador aprovou: se o contato foi apagado entre a triagem e o
 *   envio (ex.: pedido de exclusão LGPD), o telefone não casa mais e a
 *   linha vira "nova" — RESSUSCITANDO um contato apagado. Se o telefone
 *   do contato foi editado no meio do caminho, a linha também não casa
 *   e uma SEGUNDA pessoa é criada com o número antigo, enquanto o
 *   contato de verdade (já corrigido) nunca recebe o disparo. A
 *   hidratação por id evita os dois: um contato apagado simplesmente sai
 *   da lista (mesmo comportamento de antes da SPEC 057), e um contato
 *   com telefone editado continua sendo O MESMO destinatário.
 *
 * A leitura é direta na tabela (não pela view `broadcast_audience_triage`
 * da 046): o envio não precisa do histórico de engajamento, e ler a
 * tabela base evita o custo do LEFT JOIN LATERAL da view por linha.
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
  params: {
    accountId: string;
    userId: string;
    draftId: string;
    canCreateTags: boolean;
  }
): Promise<UpsertImportedContactsResult> {
  const { accountId, userId, draftId, canCreateTags } = params;
  const rows: StagingRow[] = [];

  for (let from = 0; ; from += STAGING_PAGE_SIZE) {
    const { data, error } = await db
      .from('broadcast_audience_staging')
      .select('phone, name, email, company, tag_names, existing_contact_id')
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

  // Hidrata por id — nunca re-deriva pelo telefone da planilha (ver o
  // cabeçalho). Um contato apagado desde a triagem simplesmente não
  // volta em `contactsByIds`, e a linha correspondente sai da audiência
  // em silêncio, como sempre foi antes da SPEC 057.
  const matchedContacts = await contactsByIds(
    db,
    accountId,
    withContact.map((r) => r.existing_contact_id)
  );
  const matchedById = new Map(matchedContacts.map((c) => [c.id, c]));

  // Chaveia por `existing_contact_id` (não por telefone) para reusar
  // `fillMissingContactFields`/`assignTagsFromRows` sem duplicar a
  // lógica de COALESCE (D-2) e de etiquetas (F3) — as duas funções são
  // genéricas na chave, contanto que `uniqueByKey`/`byKey` apontem para
  // o MESMO contato.
  const idKeyedRows = new Map<string, ImportedRow>();
  const idKeyedContacts = new Map<string, Contact>();
  for (const r of withContact) {
    const contact = matchedById.get(r.existing_contact_id);
    if (!contact) continue;
    idKeyedRows.set(r.existing_contact_id, {
      phone: r.phone,
      name: r.name ?? undefined,
      email: r.email ?? undefined,
      company: r.company ?? undefined,
      tagNames: r.tag_names ?? undefined,
    });
    idKeyedContacts.set(r.existing_contact_id, contact);
  }
  await fillMissingContactFields(db, idKeyedRows, idKeyedContacts);
  const matchedTags = await assignTagsFromRows(db, {
    accountId,
    userId,
    canCreateTags,
    uniqueByKey: idKeyedRows,
    byKey: idKeyedContacts,
  });

  const materialized = await upsertImportedContacts(db, {
    accountId,
    userId,
    canCreateTags,
    rows: withoutContact.map((r) => ({
      phone: r.phone,
      name: r.name ?? undefined,
      email: r.email ?? undefined,
      company: r.company ?? undefined,
      tagNames: r.tag_names ?? undefined,
    })),
  });

  // Reata a ordem original do arquivo: cada linha resolve pelo bucket em
  // que caiu (id ou telefone), nunca pelos dois.
  const materializedByPhone = new Map<string, Contact>();
  for (const c of materialized.contacts) {
    const key = normalizeKey(c.phone ?? '');
    if (key) materializedByPhone.set(key, c);
  }
  const contacts: Contact[] = [];
  for (const r of rows) {
    if (r.existing_contact_id) {
      const c = idKeyedContacts.get(r.existing_contact_id);
      if (c) contacts.push(c);
      continue;
    }
    const c = materializedByPhone.get(normalizeKey(r.phone));
    if (c) contacts.push(c);
  }

  return {
    contacts,
    tagsSkipped: [...matchedTags.tagsSkipped, ...materialized.tagsSkipped],
    tagsCreated: [...matchedTags.tagsCreated, ...materialized.tagsCreated],
  };
}

export interface ResolveAudienceParams {
  accountId: string;
  /** Dono das linhas de contato criadas por uma importação. */
  userId: string;
  audience: AudienceConfig;
  /** Admin+ pode criar etiquetas ausentes da planilha (D-1). Default false. */
  canCreateTags?: boolean;
}

/**
 * Traduz uma `AudienceConfig` na lista de contatos que vão receber o
 * disparo. Nunca devolve o mesmo contato duas vezes.
 */
export async function resolveAudienceContacts(
  db: SupabaseClient,
  { accountId, userId, audience, canCreateTags = false }: ResolveAudienceParams
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
    const result = await upsertImportedContacts(db, {
      accountId,
      userId,
      canCreateTags,
      rows: audience.csvContacts ?? [],
    });
    contacts = result.contacts;
  } else if (audience.type === 'staged') {
    if (!audience.draftId) {
      throw new BroadcastError(
        'bad_request',
        'Staged audience is missing draftId.',
        400
      );
    }
    const result = await resolveStagedAudience(db, {
      accountId,
      userId,
      draftId: audience.draftId,
      canCreateTags,
    });
    contacts = result.contacts;
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
