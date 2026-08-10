import { NextResponse, after } from 'next/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { resumePendingExecution } from '@/lib/automations/engine';
import type { AutomationContext } from '@/lib/automations/engine';
import { scanSessionWindows } from '@/lib/automations/window-scan';
import { scanSchedules } from '@/lib/automations/schedule-scan';

/**
 * Três fases, um único agendamento:
 *
 *   1. **Drenar** as `automation_pending_executions` vencidas (o step
 *      `wait`). Comportamento original desta rota.
 *   2. **Varrer** as janelas de 24h prestes a fechar (SPEC 045 §5.5).
 *   3. **Varrer** os agendamentos do gatilho `time_based` (SPEC 046 §6).
 *
 * Por que a varredura mora AQUI e não numa rota nova (§5.5.1, e o mesmo
 * argumento vale para a fase 3 — SPEC 046 §6.1)
 *
 *   O agendamento não é código: vive em `supabase/setup/cron-jobs.sql`,
 *   que não é uma migração — é configuração de ambiente, carrega a URL e
 *   o segredo do deploy, e instrui o operador a preencher, rodar e
 *   descartar sem commitar. Uma rota nova significaria um quarto
 *   `cron.schedule` e, portanto, uma ação MANUAL de todo operador já em
 *   produção (incluindo forks). Quem não fizesse essa ação teria a
 *   feature aparecendo na UI, salvando automação, ativando — e nunca
 *   disparando, sem nenhum erro em lugar nenhum. É o pior modo de falha
 *   possível para uma feature de automação. Pendurando na rota que já é
 *   pingada a cada 5 min, quem já configurou o cron ganha a feature no
 *   deploy.
 *
 * Auth: segredo compartilhado via header `x-cron-secret`, conferido
 * contra `AUTOMATION_CRON_SECRET`.
 *
 * O claim (status = 'running') serve de lock simples para que
 * invocações sobrepostas não processem a mesma linha duas vezes.
 * Best-effort: um `SELECT ... FOR UPDATE` caro é evitado em favor de um
 * UPDATE-por-id em dois passos. As varreduras das fases 2 e 3 têm cada
 * uma o seu próprio lock, pelo mesmo motivo e com o mesmo formato
 * (§5.5.2 e SPEC 046 §6.3, respectivamente — tabelas de claim distintas
 * porque a chave de idempotência é diferente: conversa×janela numa,
 * contato×ocorrência na outra).
 */

/**
 * Mesmo teto de `/api/broadcasts/cron`, e pela mesma razão: as fases 2
 * e 3 rodam em `after()` e podem encostar em dezenas de envios pela
 * Meta em série. Sem declarar isto, valeria o padrão da plataforma e o
 * corte aconteceria NO MEIO de um envio — deixando a dúvida mais cara
 * possível: a mensagem saiu para a Meta e o INSERT local não aconteceu?
 */
export const maxDuration = 300;

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }
  const supplied = request.headers.get('x-cron-secret');
  if (supplied !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = supabaseAdmin();
  const { data: due, error } = await admin
    .from('automation_pending_executions')
    .select('*')
    .eq('status', 'pending')
    .lte('run_at', new Date().toISOString())
    .order('run_at', { ascending: true })
    .limit(50);

  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  // ── Fase 1: drenagem ──────────────────────────────────────────────
  //
  // Nada de `return` antecipado quando a fila está vazia: fila vazia é o
  // caso COMUM, e sair aqui pularia a varredura quase sempre — a feature
  // inteira nunca dispararia.
  let processed = 0;
  for (const row of due ?? []) {
    const { data: claim } = await admin
      .from('automation_pending_executions')
      .update({ status: 'running' })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();
    if (!claim) continue;

    await resumePendingExecution({
      id: row.id as string,
      automation_id: row.automation_id as string,
      // account_id is NOT NULL on automation_pending_executions
      // post-017; the engine uses it for tenant-scoped lookups.
      account_id: row.account_id as string,
      user_id: row.user_id as string,
      contact_id: (row.contact_id as string | null) ?? null,
      log_id: (row.log_id as string | null) ?? null,
      parent_step_id: (row.parent_step_id as string | null) ?? null,
      branch: (row.branch as 'yes' | 'no' | null) ?? null,
      next_step_position: row.next_step_position as number,
      context: (row.context as AutomationContext) ?? {},
    });
    processed++;
  }

  // ── Fases 2 e 3: varreduras de janela e de agendamento ────────────
  //
  // Depois da drenagem (a ordem que §5.5.1 pede) e FORA do caminho da
  // resposta. `after()` casa com o `timeout_milliseconds := 20000` do
  // job de pg_cron, que corta apenas a ESPERA pela resposta, não o
  // trabalho no servidor: o HTTP responde assim que a drenagem termina e
  // as varreduras seguem dentro do `maxDuration` acima.
  //
  // Sequenciais, não `Promise.all` — as duas competem pelo mesmo teto
  // de `maxDuration`, e rodá-las em série mantém o corte previsível
  // (a fase 3 nunca começa sem saber quanto tempo a 2 já consumiu).
  // Nenhuma das duas lança — aqui dentro não há quem leia uma exceção.
  after(async () => {
    const windowResult = await scanSessionWindows();
    if (windowResult.dispatched > 0 || windowResult.failed > 0) {
      console.log(
        '[automations-cron] window scan:',
        JSON.stringify(windowResult)
      );
    }

    const scheduleResult = await scanSchedules();
    // `truncated` entra na condição de propósito: uma audiência acima
    // do teto do tick é justamente o caso que precisa aparecer no log,
    // mesmo quando o despacho em si correu sem falha.
    if (
      scheduleResult.dispatched > 0 ||
      scheduleResult.failed > 0 ||
      scheduleResult.truncated
    ) {
      console.log(
        '[automations-cron] schedule scan:',
        JSON.stringify(scheduleResult)
      );
    }
  });

  return NextResponse.json({ processed, scan: 'scheduled' });
}
