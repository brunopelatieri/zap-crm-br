/**
 * Varredura de reengajamento: conversas cuja janela de 24h está prestes
 * a fechar (SPEC 045 §5.5).
 *
 * Por que isto é uma varredura, e não um trigger de webhook
 *
 *   Todos os outros triggers do motor reagem a um evento pontual que a
 *   Meta entrega. Aqui não existe evento: "a janela está fechando" é uma
 *   condição de TEMPO sobre conversas paradas — ninguém manda um webhook
 *   avisando que o cliente parou de responder. Alguém precisa acordar de
 *   tempo em tempo e perguntar.
 *
 * Ordem: automações primeiro, conversas depois. Nunca o contrário.
 *
 *   A fase A lista as automações ativas deste trigger (índice
 *   `idx_automations_active_trigger`, global por `trigger_type`), e só
 *   então a fase B varre as conversas DAS CONTAS que a fase A devolveu.
 *   O inverso — varrer `conversations` globalmente e depois perguntar
 *   quem se importa — é funcionalmente idêntico e operacionalmente
 *   péssimo: cresce com o total de conversas de TODAS as contas do
 *   deploy, inclusive as que não têm nenhuma automação deste trigger.
 *   Com a ordem correta, uma instância sem nenhuma automação de
 *   reengajamento faz UMA query por tick e vai embora.
 *
 * O claim é o lock (§5.5.2)
 *
 *   `SELECT` seguido de `INSERT` não é atômico, e dois pings de cron
 *   sobrepostos (o `pg_net` é beta, e um tick que demore mais de 5 min
 *   sobrepõe o seguinte) leriam "ainda não disparou" antes de qualquer
 *   um dos dois gravar — e o contato receberia o reengajamento duas
 *   vezes. Então a criação da linha É o lock: um upsert com
 *   `ON CONFLICT DO NOTHING` cuja cláusula RETURNING vem VAZIA quando a
 *   linha já existia. É isso que distingue "reivindiquei" de "outro já
 *   tinha".
 *
 *   A âncora entra na chave de propósito: uma mensagem nova do cliente
 *   move `last_customer_message_at`, gera uma chave nova, e a
 *   elegibilidade reabre — que é exatamente o comportamento desejado.
 *
 * O que este arquivo NÃO faz
 *
 *   Não chama `runAutomationsForTrigger`. Ver o aviso em
 *   `runSingleAutomation` (§5.5.3): aquela função roda TODAS as
 *   automações do trigger na conta, e o loop de claim aqui é POR
 *   automação — a combinação produz N² execuções e mensagens
 *   duplicadas, com a tabela de claims registrando que está tudo certo.
 */

import type { Automation } from '@/types';
import {
  DEFAULT_TIME_ZONE,
  isWithinSendWindow,
} from '@/lib/broadcasts/send-window';
import { isOptedOut } from '@/lib/contacts/consent';
import { SESSION_WINDOW_MS } from '@/lib/whatsapp/session-window';
import { shouldTrackSessionWindow } from '@/lib/channels/session-window';
import type { ChannelType } from '@/lib/channels/types';
import { supabaseAdmin } from './admin-client';
import { runSingleAutomation } from './engine';
import { resolveMarginMinutes } from './window-trigger';

/**
 * Teto de conversas que UMA automação processa por tick.
 *
 * É um teto de segurança, não paginação: o excedente entra no tick
 * seguinte, ainda dentro da margem — que é de horas. Sem o teto, uma
 * conta grande no primeiro dia (o backfill da migração 052 torna todas
 * as conversas antigas elegíveis de uma vez) prenderia o cron.
 *
 * 50, não 200: cada conversa custa um round-trip à Meta com retry de
 * variante de telefone, INSERT em `messages` e UPDATE em
 * `conversations`. A 300 ms por conversa, 200 já é um minuto de
 * execução em série — e 200 foi um número escolhido antes de alguém
 * contar o custo por item.
 */
const MAX_CONVERSATIONS_PER_AUTOMATION = 50;

/** Retenção das linhas de claim. */
const CLAIM_RETENTION_DAYS = 30;

export interface SessionWindowScanResult {
  /** Automações ativas deste trigger encontradas na fase A. */
  automations: number;
  /** Conversas que passaram por todos os guardrails. */
  eligible: number;
  /** Claims que ESTA invocação ganhou (as demais eram de outro tick). */
  claimed: number;
  /** Despachos concluídos sem exceção. */
  dispatched: number;
  /** Despachos que lançaram — a linha de claim registra `failed_at`. */
  failed: number;
  /** Preenchido quando a varredura parou antes da fase B. */
  skipped?: 'outside_send_window' | 'no_automations';
}

function emptyResult(
  skipped?: SessionWindowScanResult['skipped']
): SessionWindowScanResult {
  return {
    automations: 0,
    eligible: 0,
    claimed: 0,
    dispatched: 0,
    failed: 0,
    ...(skipped ? { skipped } : {}),
  };
}

/**
 * Uma passada completa da varredura. Nunca lança — é chamada de dentro
 * de `after()` na rota de cron, onde uma exceção não tem quem a leia.
 */
export async function scanSessionWindows(
  now: Date = new Date()
): Promise<SessionWindowScanResult> {
  try {
    // ── Guardrail 9: janela de horário (§5.6, item 9) ──────────────
    //
    // Um reengajamento às 04h é o mesmo dano de reputação que um
    // broadcast às 23h, e o argumento da urgência ("a janela vai
    // fechar") é fraco: se a única hora possível é de madrugada, o
    // custo do disparo excede o benefício de manter aberta uma conversa
    // que o cliente abandonou.
    //
    // Diferente do broadcast, aqui NÃO existe "adiar" — a janela de 24h
    // não espera. Perder o reengajamento é a consequência assumida.
    //
    // Fuso: `isWithinSendWindow` exige um IANA timezone e o broadcast o
    // tira de quem agendou (`broadcasts.scheduled_timezone`). Aqui não
    // há "quem agendou", então vale o DEFAULT_TIME_ZONE — coerente com
    // um CRM localizado para o Brasil. O lugar certo para configurar por
    // conta, se um dia for preciso, é `whatsapp_config`.
    if (!isWithinSendWindow(now, DEFAULT_TIME_ZONE)) {
      return emptyResult('outside_send_window');
    }

    const db = supabaseAdmin();

    // ── Fase A: quem quer este trigger (uma query por tick) ─────────
    const { data: automations, error: autoErr } = await db
      .from('automations')
      .select('*')
      .eq('trigger_type', 'session_window_expiring')
      .eq('is_active', true);

    if (autoErr) {
      console.error('[window-scan] phase A failed:', autoErr.message);
      return emptyResult();
    }
    if (!automations || automations.length === 0) {
      return emptyResult('no_automations');
    }

    const result = emptyResult();
    result.automations = automations.length;

    for (const automation of automations as Automation[]) {
      try {
        await scanForAutomation(automation, now, result);
      } catch (err) {
        // Uma automação com config estranha não pode derrubar a
        // varredura das outras contas.
        console.error('[window-scan] automation failed:', automation.id, err);
      }
    }

    await purgeOldClaims(now);
    return result;
  } catch (err) {
    console.error('[window-scan] scan failed:', err);
    return emptyResult();
  }
}

interface ConversationRow {
  id: string;
  contact_id: string;
  last_customer_message_at: string;
  last_message_at: string | null;
}

async function scanForAutomation(
  automation: Automation,
  now: Date,
  result: SessionWindowScanResult
): Promise<void> {
  const db = supabaseAdmin();
  const marginMinutes = resolveMarginMinutes(automation.trigger_config);

  // A âncora cuja janela fecha EXATAMENTE agora, e a âncora que ainda
  // tem `marginMinutes` de sobra. Elegível = anexo estritamente depois
  // da primeira (senão a janela já fechou — o fechamento é exclusivo,
  // mesma convenção de `computeSessionWindow`) e até a segunda.
  const closesNow = new Date(now.getTime() - SESSION_WINDOW_MS);
  const closesWithinMargin = new Date(
    closesNow.getTime() + marginMinutes * 60_000
  );

  // ── Fase B ──────────────────────────────────────────────────────
  //
  // `account_id` é a coluna LÍDER de idx_conversations_last_customer_msg
  // (§5.2); sem ele no WHERE o índice não vira range seek. O
  // `status = 'open'` precisa aparecer literalmente para o índice
  // PARCIAL ser aproveitado.
  //
  // Guardrail 8 (§5.6): `assigned_agent_id IS NULL`. Reengajar
  // automaticamente uma conversa que já tem dono humano interfere no
  // atendimento de alguém que pode estar prestes a responder. Pular é
  // defensável e não pular também — o que não é defensável é não
  // decidir, porque o comportamento emergente ("reengaja todo mundo")
  // é o mais intrusivo dos dois.
  //
  // Ordena pela âncora mais antiga: quando o LIMIT trunca, quem está
  // mais perto de fechar é quem passa.
  const { data: rows, error } = await db
    .from('conversations')
    .select('id, contact_id, last_customer_message_at, last_message_at')
    .eq('account_id', automation.account_id)
    .eq('status', 'open')
    .is('assigned_agent_id', null)
    .gt('last_customer_message_at', closesNow.toISOString())
    .lte('last_customer_message_at', closesWithinMargin.toISOString())
    .order('last_customer_message_at', { ascending: true })
    .limit(MAX_CONVERSATIONS_PER_AUTOMATION);

  if (error) {
    console.error('[window-scan] phase B failed:', error.message);
    return;
  }
  if (!rows || rows.length === 0) return;

  // ── Guardrail de canal (PRD 047 §7.1.2) ─────────────────────────
  //
  // Reengajamento é conversa de janela: só existe onde a Meta impõe a
  // janela. Numa conversa de canal QRCode a âncora fica NULL para
  // sempre (`shouldTrackSessionWindow`), então o range seek acima já
  // não a traria — MAS depender disso é depender de uma invariante que
  // o próximo backfill quebra sem perceber. O filtro abaixo torna a
  // exclusão intenção declarada, e não efeito colateral de um NULL.
  const eligibleChannelIds = await channelsWithSessionWindow(
    automation.account_id
  );
  const scoped = eligibleChannelIds
    ? (rows as (ConversationRow & { channel_id?: string | null })[]).filter(
        (c) => !c.channel_id || eligibleChannelIds.has(c.channel_id)
      )
    : (rows as ConversationRow[]);
  if (scoped.length === 0) return;

  // ── Guardrail 6: não reengajar com a bola do NOSSO lado ──────────
  //
  // O caso: o cliente perguntou algo às 10h, ninguém respondeu, e às
  // 06h do dia seguinte o bot dispara "Posso ajudar com mais alguma
  // coisa?". Do lado de lá isso lê como deboche, e é o cenário mais
  // comum numa conta com equipe pequena — justamente a que este produto
  // atende. Janela fechando com mensagem do cliente sem resposta não é
  // caso de reengajamento, é caso de SLA.
  //
  // O teste é `last_message_at > last_customer_message_at` (a última
  // palavra foi nossa). Roda aqui em JS, e não como filtro no banco,
  // porque PostgREST não compara duas COLUNAS entre si — o segundo
  // argumento de `.gt()` seria interpretado como literal. As duas
  // colunas já vêm no SELECT, então o custo é zero; o efeito colateral
  // é que o LIMIT se aplica antes deste filtro, e um tick pode
  // processar menos que o teto. Aceitável: a margem tem horas de
  // largura e o tick seguinte pega o resto.
  const awaitingUs = scoped.filter(
    (c) =>
      c.last_message_at !== null &&
      new Date(c.last_message_at) > new Date(c.last_customer_message_at)
  );
  if (awaitingUs.length === 0) return;

  const contactIds = [...new Set(awaitingUs.map((c) => c.contact_id))];

  // ── Guardrail 2: opt-out (§5.6, item 2) ─────────────────────────
  //
  // Mesmo sendo mensagem de SESSÃO (sem categoria formal na Meta, ver
  // §8.1), respeitar quem pediu para não receber contato automatizado.
  // `excludesOptedOut` trata categoria ausente como marketing, e uma
  // mensagem de sessão não tem categoria nenhuma — ou seja, ela cai
  // exatamente nesse caso conservador.
  const { data: contacts, error: contactsErr } = await db
    .from('contacts')
    .select('id, opt_in_status')
    .eq('account_id', automation.account_id)
    .in('id', contactIds);

  // FALHA FECHADA, de propósito. `data` vem `null` quando a query erra,
  // e um `?? []` aqui produziria um conjunto vazio de opt-outs — ou
  // seja, um erro transitório de rede faria a varredura mandar mensagem
  // para exatamente quem pediu para não receber, acreditando que o
  // guardrail rodou. Um guardrail de consentimento que falha aberto é
  // pior que nenhum, porque ninguém vai auditá-lo.
  if (contactsErr) {
    console.error('[window-scan] consent lookup failed:', contactsErr.message);
    return;
  }

  const optedOut = new Set(
    ((contacts ?? []) as { id: string; opt_in_status: string | null }[])
      .filter((c) => isOptedOut(c))
      .map((c) => c.id)
  );

  // ── Guardrail 7: não falar por cima de um Flow ativo ────────────
  //
  // O motor de Flows mantém no máximo um run ativo por contato, e o
  // webhook já suprime os triggers de conteúdo quando o run consome a
  // mensagem — ou seja, o repositório JÁ reconhece que os dois motores
  // não devem falar por cima um do outro. Esta varredura não passa pelo
  // webhook e furaria essa proteção: o cliente parado no meio de um
  // menu receberia um segundo menu, de outro motor, com botões que o
  // flow não sabe interpretar.
  //
  // Não prende ninguém para sempre: o /api/flows/cron encerra runs
  // abandonados (`timed_out`, 24h por padrão).
  const { data: activeRuns, error: runsErr } = await db
    .from('flow_runs')
    .select('contact_id')
    .eq('account_id', automation.account_id)
    .eq('status', 'active')
    .in('contact_id', contactIds);

  // Mesma postura da consulta de consentimento acima: sem a resposta,
  // não dá para saber quem está no meio de um menu, e o padrão seguro
  // para "não sei" é não falar por cima.
  if (runsErr) {
    console.error('[window-scan] flow-run lookup failed:', runsErr.message);
    return;
  }

  const inFlow = new Set(
    ((activeRuns ?? []) as { contact_id: string }[]).map((r) => r.contact_id)
  );

  const eligible = awaitingUs.filter(
    (c) => !optedOut.has(c.contact_id) && !inFlow.has(c.contact_id)
  );
  result.eligible += eligible.length;

  for (const conv of eligible) {
    const claimId = await claimWindow(automation, conv);
    if (!claimId) continue; // outro tick já reivindicou esta janela
    result.claimed++;

    const minutesRemaining = Math.floor(
      (new Date(conv.last_customer_message_at).getTime() +
        SESSION_WINDOW_MS -
        now.getTime()) /
        60_000
    );

    try {
      await runSingleAutomation(automation, {
        accountId: automation.account_id,
        triggerType: 'session_window_expiring',
        contactId: conv.contact_id,
        context: {
          // Sem isto, TODO step de envio cairia no ramo de fallback de
          // `resolveConversationId()` e refaria, por conversa e por
          // step, um SELECT que a varredura já fez. Com isto, zero
          // queries extras.
          conversation_id: conv.id,
          // Interpolável via `{{ vars.* }}`, que o motor já suporta.
          // Cuidado de produto: "sua janela fecha em 4h" não significa
          // nada para o cliente final — o uso legítimo é interno.
          vars: {
            minutes_remaining: String(minutesRemaining),
            hours_remaining: String(Math.floor(minutesRemaining / 60)),
          },
        },
      });
      await markClaim(claimId, 'sent_at');
      result.dispatched++;
    } catch (err) {
      // O claim entra ANTES do envio porque ele É o lock, então uma
      // falha aqui deixa a linha gravada e a conversa inelegível até a
      // próxima âncora. Isso é deliberado: em mensageria at-most-once é
      // o padrão certo — um envio duplicado é visível para o cliente e
      // não tem desfazer; um envio perdido custa uma janela.
      // `failed_at` é o que torna os dois casos distinguíveis depois
      // (e habilita uma retentativa opcional no futuro, §5.5.5).
      console.error(
        '[window-scan] dispatch failed:',
        automation.id,
        conv.id,
        err
      );
      await markClaim(claimId, 'failed_at');
      result.failed++;
    }
  }
}

/**
 * Ids dos canais da conta que TÊM janela de 24h (PRD 047 §7.1.2).
 *
 * Devolve `null` quando a tabela `channels` ainda não existe (antes da
 * migração 055) — nesse caso não há o que filtrar, toda conversa é do
 * canal oficial e o comportamento é idêntico ao de antes.
 */
async function channelsWithSessionWindow(
  accountId: string
): Promise<Set<string> | null> {
  const { data, error } = await supabaseAdmin()
    .from('channels')
    .select('id, type')
    .eq('account_id', accountId);

  if (error || !data) return null;

  return new Set(
    (data as { id: string; type: string }[])
      .filter((c) => shouldTrackSessionWindow(c.type as ChannelType))
      .map((c) => c.id)
  );
}

/**
 * Reivindica (automação × conversa × âncora). Devolve o id da linha
 * quando ESTA invocação criou o claim, e `null` quando ele já existia.
 *
 * `ignoreDuplicates: true` é `ON CONFLICT DO NOTHING` — com ele, o
 * RETURNING vem vazio na colisão, que é precisamente o sinal que
 * distingue os dois casos. Mesmo formato de upsert que o motor já usa
 * para `contact_tags`.
 */
async function claimWindow(
  automation: Automation,
  conv: ConversationRow
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('automation_window_claims')
    .upsert(
      {
        account_id: automation.account_id,
        automation_id: automation.id,
        conversation_id: conv.id,
        window_anchor: conv.last_customer_message_at,
      },
      {
        onConflict: 'automation_id,conversation_id,window_anchor',
        ignoreDuplicates: true,
      }
    )
    .select('id')
    .maybeSingle();

  if (error) {
    // Um erro no claim NÃO pode virar "manda mesmo assim": sem a
    // garantia do lock, o risco é envio duplicado.
    console.error('[window-scan] claim failed:', error.message);
    return null;
  }
  return (data?.id as string | undefined) ?? null;
}

async function markClaim(
  claimId: string,
  column: 'sent_at' | 'failed_at'
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from('automation_window_claims')
    .update({ [column]: new Date().toISOString() })
    .eq('id', claimId);
  if (error) {
    // Best-effort: o claim já cumpriu seu papel de lock. Perder o
    // carimbo custa a métrica, não a corretude.
    console.error('[window-scan] claim mark failed:', column, error.message);
  }
}

/**
 * Limpeza das linhas de claim. Seguro porque uma âncora com mais de 24h
 * já não pode voltar a ser elegível — a janela dela fechou há muito.
 */
async function purgeOldClaims(now: Date): Promise<void> {
  const cutoff = new Date(
    now.getTime() - CLAIM_RETENTION_DAYS * 24 * 60 * 60 * 1000
  );
  const { error } = await supabaseAdmin()
    .from('automation_window_claims')
    .delete()
    .lt('created_at', cutoff.toISOString());
  if (error) {
    console.error('[window-scan] purge failed:', error.message);
  }
}
