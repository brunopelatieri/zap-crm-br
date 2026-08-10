/**
 * Varredura do gatilho `time_based` (SPEC 046 §6).
 *
 * Por que isto é uma varredura, e não um trigger de webhook
 *
 *   Como em `window-scan.ts`, não existe evento: "são 9h de segunda"
 *   não é algo que a Meta manda num webhook. Alguém precisa acordar de
 *   tempo em tempo e perguntar "algum agendamento bate com este
 *   instante?".
 *
 * Ordem: automações primeiro, contatos depois. Nunca o contrário.
 *
 *   Mesmo raciocínio de `window-scan.ts` §Fase A: uma instância sem
 *   nenhuma automação `time_based` ativa faz UMA query por tick e vai
 *   embora, em vez de varrer `contacts` de todas as contas do deploy.
 *
 * Por que a janela do tick é de 10 minutos, e não o instante exato
 *
 *   `now()` é quando a REQUISIÇÃO chegou, não quando o cron pretendia
 *   rodar — o `pg_net` é beta e não garante pontualidade ao segundo.
 *   Testar só `cronMatches(cron, now)` erraria o alvo sempre que o tick
 *   atrasasse alguns segundos além do minuto casado. Em vez disso,
 *   cada tick enumera os minutos de `(now - 10min, now]` e testa cada
 *   um contra o cron — dois ticks de 5 em 5 minutos sempre têm essa
 *   janela sobreposta, então os dois enxergam a MESMA ocorrência (o
 *   minuto exato em que ela cai) e disputam o MESMO claim, em vez de
 *   cada um criar um diferente.
 *
 * O claim é o lock (migração 054), mesmo padrão de `window-scan.ts`
 *
 *   `INSERT … ON CONFLICT DO NOTHING RETURNING id` com `RETURNING`
 *   vazio é o que distingue "este tick reivindicou" de "outro tick já
 *   tinha". A chave é (automação × contato × ocorrência) — não há
 *   conversa nem janela de 24h aqui, então não há âncora para reabrir:
 *   uma ocorrência perdida (agendador fora do ar) fica perdida, nunca
 *   recuperada depois — disparar tarde um "bom dia" das 9h às 11h é
 *   pior que não disparar.
 *
 * O que este arquivo NÃO faz
 *
 *   Não chama `runAutomationsForTrigger` — o mesmo aviso de
 *   `window-scan.ts` vale aqui: aquela função roda TODAS as automações
 *   do trigger na conta, e o loop de claim é POR automação. Usa
 *   `runSingleAutomation`, que já resolve isso (SPEC 045 §5.5.3).
 */

import type { Automation } from '@/types';
import {
  DEFAULT_TIME_ZONE,
  isWithinSendWindow,
  resolveTimeZone,
} from '@/lib/broadcasts/send-window';
import { isOptedOut } from '@/lib/contacts/consent';
import { supabaseAdmin } from './admin-client';
import { runSingleAutomation } from './engine';
import { cronMatches } from './schedule';

/** Dois ticks de cron (5 min cada) — tolera um tick perdido. Mesmo
 *  raciocínio do piso de granularidade em `schedule.ts`. */
const TICK_WINDOW_MINUTES = 10;

/**
 * Teto de contatos que UMA (automação × ocorrência) despacha por tick.
 *
 * ⚠️ NÃO é o teto de `window-scan.ts`, e o raciocínio de lá NÃO vale
 * aqui. Naquela varredura a faixa de elegibilidade tem `margin_minutes`
 * de largura (240 min = 48 ticks por padrão), então o excedente
 * realmente entra nos ticks seguintes. Aqui a ocorrência só existe
 * dentro de `TICK_WINDOW_MINUTES` — dois ticks — e depois some para
 * sempre. "Fica para o próximo tick" seria mentira: seria "nunca".
 *
 * É por isso que a query de contatos exclui quem JÁ tem claim desta
 * ocorrência: sem isso o segundo tick releria os mesmos contatos, os
 * encontraria todos reivindicados e despacharia zero — travando a
 * entrega no primeiro lote, em silêncio, todo dia, para os mesmos
 * contatos.
 *
 * 100 e não 50: a 300 ms por contato (o custo por item que
 * `window-scan.ts` mediu), 100 são ~30 s, e esta fase divide o
 * `maxDuration = 300` da rota com a varredura de janela. Dois ticks por
 * ocorrência ⇒ teto efetivo de 200 contatos por disparo agendado.
 * Acima disso o resultado marca `truncated` e a varredura loga — o
 * volume passa a ser visível em vez de sumir. Audiência maior que isso
 * é campanha, e campanha é o módulo de disparos (SPEC 046 §10).
 */
const MAX_CONTACTS_PER_OCCURRENCE = 100;

/**
 * Teto do primeiro passo (buscar quem tem a etiqueta) — `contact_tags`
 * não tem `account_id` (comentário em `engine.ts`), então o escopo por
 * conta só acontece na query seguinte, contra `contacts`. Este teto
 * limita o tamanho do `IN (...)` daquela segunda query.
 *
 * A query é ORDENADA por `contact_id`: sem `ORDER BY`, *quais* mil
 * linhas o Postgres devolve é indefinido, e a audiência efetiva de uma
 * etiqueta grande mudaria entre execuções sem nada mudar na
 * configuração.
 */
const CANDIDATE_TAG_ROWS_CAP = 1000;

/** Retenção das linhas de claim — mesmo prazo de `window-scan.ts`. */
const CLAIM_RETENTION_DAYS = 30;

export interface ScheduleScanResult {
  /** Automações `time_based` ativas encontradas na fase A. */
  automations: number;
  /** Pares (automação × minuto casado) encontrados na janela do tick. */
  occurrences: number;
  /** Contatos elegíveis somados por todas as ocorrências. */
  eligible: number;
  /** Claims que ESTA invocação ganhou. */
  claimed: number;
  /** Despachos concluídos sem exceção de infraestrutura. */
  dispatched: number;
  /** Despachos que lançaram — a linha de claim registra `failed_at`. */
  failed: number;
  /**
   * Alguma (automação × ocorrência) tinha mais contatos elegíveis do
   * que o teto do tick. Existe para a truncagem não ser silenciosa: sem
   * este sinal, uma etiqueta grande entrega parte da audiência e nada
   * no log denuncia que o resto ficou de fora.
   */
  truncated: boolean;
}

function emptyResult(): ScheduleScanResult {
  return {
    automations: 0,
    occurrences: 0,
    eligible: 0,
    claimed: 0,
    dispatched: 0,
    failed: 0,
    truncated: false,
  };
}

/**
 * Uma passada completa da varredura. Nunca lança — é chamada de dentro
 * de `after()` na rota de cron, onde uma exceção não tem quem a leia.
 */
export async function scanSchedules(
  now: Date = new Date()
): Promise<ScheduleScanResult> {
  try {
    const db = supabaseAdmin();

    // ── Fase A: quem quer este trigger (uma query por tick) ─────────
    const { data: automations, error: autoErr } = await db
      .from('automations')
      .select('*')
      .eq('trigger_type', 'time_based')
      .eq('is_active', true);

    if (autoErr) {
      console.error('[schedule-scan] phase A failed:', autoErr.message);
      return emptyResult();
    }
    if (!automations || automations.length === 0) {
      return emptyResult();
    }

    const result = emptyResult();
    result.automations = automations.length;

    for (const automation of automations as Automation[]) {
      try {
        await scanForAutomation(automation, now, result);
      } catch (err) {
        // Uma automação com config estranha não pode derrubar a
        // varredura das outras contas.
        console.error('[schedule-scan] automation failed:', automation.id, err);
      }
    }

    await purgeOldClaims(now);
    return result;
  } catch (err) {
    console.error('[schedule-scan] scan failed:', err);
    return emptyResult();
  }
}

interface TimeBasedConfig {
  schedule?: string;
  timezone?: string;
  audience_tag_id?: string;
}

async function scanForAutomation(
  automation: Automation,
  now: Date,
  result: ScheduleScanResult
): Promise<void> {
  const cfg = (automation.trigger_config ?? {}) as TimeBasedConfig;
  // Ativação já exige os dois (validate.ts, §6.5) — esta checagem
  // protege contra uma linha gravada antes dessa validação existir.
  if (!cfg.schedule || !cfg.audience_tag_id) return;

  const timezone = resolveTimeZone(cfg.timezone) || DEFAULT_TIME_ZONE;

  // ── Guardrail 1: janela de horário (§6.4) ───────────────────────
  //
  // Testada em cada OCORRÊNCIA, não em `now`. `now` é quando a
  // requisição chegou, e usá-lo produzia decisões erradas nas bordas:
  // uma ocorrência das 19h58 morria porque o tick chegou às 20h01, e
  // uma das 08h58 passava porque o tick chegou às 09h01. Quem tem de
  // estar dentro do horário permitido é o disparo, não o ping do cron.
  //
  // O fuso é o da AUTOMAÇÃO — diferente de `window-scan.ts`, onde não
  // existe "quem agendou" e por isso vale o DEFAULT_TIME_ZONE global.
  // Aqui existe: alguém escolheu "9h", e "9h" não significa nada sem o
  // fuso de quem escolheu (§3.5).
  //
  // Continua saindo antes de qualquer query quando nada sobra: o
  // cálculo abaixo é puro.
  const occurrences = occurrencesInWindow(cfg.schedule, timezone, now).filter(
    (occurrenceAt) => isWithinSendWindow(occurrenceAt, timezone)
  );
  if (occurrences.length === 0) return;
  result.occurrences += occurrences.length;

  const db = supabaseAdmin();

  // ── Fase C: audiência (§6.2) ────────────────────────────────────
  //
  // `contact_tags` não tem `account_id` — o escopo por conta só
  // acontece na query seguinte, contra `contacts`. Ordenado para o
  // recorte do teto ser estável entre ticks (ver CANDIDATE_TAG_ROWS_CAP).
  const { data: tagRows, error: tagErr } = await db
    .from('contact_tags')
    .select('contact_id')
    .eq('tag_id', cfg.audience_tag_id)
    .order('contact_id', { ascending: true })
    .limit(CANDIDATE_TAG_ROWS_CAP);

  if (tagErr) {
    console.error(
      '[schedule-scan] tag lookup failed:',
      automation.id,
      tagErr.message
    );
    return;
  }
  const candidateIds = [
    ...new Set((tagRows ?? []).map((r) => r.contact_id as string)),
  ];
  if (candidateIds.length === 0) return;

  // ── Guardrail 5: isolamento de tenant ────────────────────────────
  //
  // Sem `.limit()` aqui: o teto do tick é aplicado DEPOIS de descartar
  // opt-outs e quem já foi reivindicado, senão um lote inteiro de
  // contatos já atendidos consumiria a cota e o restante da audiência
  // nunca sairia. O tamanho é limitado por `candidateIds`, que já veio
  // com teto.
  const { data: contacts, error: contactsErr } = await db
    .from('contacts')
    .select('id, opt_in_status')
    .eq('account_id', automation.account_id)
    .in('id', candidateIds)
    .order('id', { ascending: true });

  // FALHA FECHADA, de propósito — mesmo padrão de `window-scan.ts`: um
  // erro transitório de rede não pode virar "manda mesmo assim".
  if (contactsErr) {
    console.error(
      '[schedule-scan] contact lookup failed:',
      automation.id,
      contactsErr.message
    );
    return;
  }
  if (!contacts || contacts.length === 0) return;

  // ── Guardrail 2: opt-out (LGPD) ──────────────────────────────────
  const optedIn = (
    contacts as { id: string; opt_in_status: string | null }[]
  ).filter((c) => !isOptedOut(c));
  if (optedIn.length === 0) return;

  // ── Guardrail 4: uma automação por vez, nunca runAutomationsForTrigger ──
  for (const occurrenceAt of occurrences) {
    // Quem já foi reivindicado NESTA ocorrência sai da fila antes do
    // teto ser aplicado. É isto que faz o segundo tick da janela
    // entregar o lote SEGUINTE em vez de reler o primeiro e despachar
    // zero.
    const alreadyClaimed = await claimedContactIds(automation, occurrenceAt);
    if (alreadyClaimed === null) continue; // falha fechada: sem lock, não despacha

    const pending = optedIn.filter((c) => !alreadyClaimed.has(c.id));
    result.eligible += pending.length;

    if (pending.length > MAX_CONTACTS_PER_OCCURRENCE) {
      result.truncated = true;
      console.warn(
        '[schedule-scan] audience above per-tick cap:',
        automation.id,
        `${pending.length} pending, dispatching ${MAX_CONTACTS_PER_OCCURRENCE}`
      );
    }

    for (const contact of pending.slice(0, MAX_CONTACTS_PER_OCCURRENCE)) {
      const claimId = await claimOccurrence(
        automation,
        contact.id,
        occurrenceAt
      );
      if (!claimId) continue; // outro tick reivindicou entre a leitura e agora
      result.claimed++;

      try {
        await runSingleAutomation(automation, {
          accountId: automation.account_id,
          triggerType: 'time_based',
          contactId: contact.id,
        });
        await markClaim(claimId, 'sent_at');
        result.dispatched++;
      } catch (err) {
        // O claim entra ANTES do despacho porque ele É o lock — uma
        // falha aqui deixa a linha gravada e a ocorrência não é
        // reprocessada no próximo tick (não há "reabrir" sem âncora,
        // ao contrário do reengajamento de janela).
        console.error(
          '[schedule-scan] dispatch failed:',
          automation.id,
          contact.id,
          err
        );
        await markClaim(claimId, 'failed_at');
        result.failed++;
      }
    }
  }
}

/**
 * Instantes truncados ao minuto, dentro de `(now - 10min, now]`, em
 * que este cron dispara. Ordem cronológica ascendente.
 */
function occurrencesInWindow(
  cron: string,
  timeZone: string,
  now: Date
): Date[] {
  const matches: Date[] = [];
  for (let back = TICK_WINDOW_MINUTES - 1; back >= 0; back--) {
    const candidate = new Date(now.getTime() - back * 60_000);
    candidate.setUTCSeconds(0, 0);
    if (cronMatches(cron, candidate, timeZone)) matches.push(candidate);
  }
  return matches;
}

/**
 * Contatos que já têm claim desta ocorrência. `null` sinaliza falha da
 * consulta — o chamador pula a ocorrência em vez de arriscar despachar
 * de novo para quem já recebeu (a UNIQUE ainda protegeria, mas
 * gastaria uma tentativa de claim por contato à toa).
 */
async function claimedContactIds(
  automation: Automation,
  occurrenceAt: Date
): Promise<Set<string> | null> {
  const { data, error } = await supabaseAdmin()
    .from('automation_schedule_claims')
    .select('contact_id')
    .eq('automation_id', automation.id)
    .eq('occurrence_at', occurrenceAt.toISOString());

  if (error) {
    console.error('[schedule-scan] claim lookup failed:', error.message);
    return null;
  }
  return new Set(
    ((data ?? []) as { contact_id: string }[]).map((r) => r.contact_id)
  );
}

/**
 * Reivindica (automação × contato × ocorrência). Devolve o id da linha
 * quando ESTA invocação criou o claim, e `null` quando ele já existia.
 * Mesmo formato de `claimWindow` em `window-scan.ts`.
 */
async function claimOccurrence(
  automation: Automation,
  contactId: string,
  occurrenceAt: Date
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('automation_schedule_claims')
    .upsert(
      {
        account_id: automation.account_id,
        automation_id: automation.id,
        contact_id: contactId,
        occurrence_at: occurrenceAt.toISOString(),
      },
      {
        onConflict: 'automation_id,contact_id,occurrence_at',
        ignoreDuplicates: true,
      }
    )
    .select('id')
    .maybeSingle();

  if (error) {
    // Sem a garantia do lock, o risco é envio duplicado — não vale a
    // pena arriscar.
    console.error('[schedule-scan] claim failed:', error.message);
    return null;
  }
  return (data?.id as string | undefined) ?? null;
}

async function markClaim(
  claimId: string,
  column: 'sent_at' | 'failed_at'
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from('automation_schedule_claims')
    .update({ [column]: new Date().toISOString() })
    .eq('id', claimId);
  if (error) {
    // Best-effort: o claim já cumpriu seu papel de lock. Perder o
    // carimbo custa a métrica, não a corretude.
    console.error('[schedule-scan] claim mark failed:', column, error.message);
  }
}

async function purgeOldClaims(now: Date): Promise<void> {
  const cutoff = new Date(
    now.getTime() - CLAIM_RETENTION_DAYS * 24 * 60 * 60 * 1000
  );
  const { error } = await supabaseAdmin()
    .from('automation_schedule_claims')
    .delete()
    .lt('created_at', cutoff.toISOString());
  if (error) {
    console.error('[schedule-scan] purge failed:', error.message);
  }
}
