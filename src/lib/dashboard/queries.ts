import type { SupabaseClient } from '@supabase/supabase-js';
import {
  daysAgoStart,
  DOW_SHORT_MON_FIRST,
  lastNDayKeys,
  localDayKey,
  mondayIndex,
  startOfLocalDay,
} from './date-utils';
import type {
  ActivityItem,
  ConversationsSeriesPoint,
  MetricsBundle,
  PipelineDonutData,
  PipelineStageSlice,
  ResponseTimeBucket,
  ResponseTimeSummary,
} from './types';

// ------------------------------------------------------------
// Agregação no cliente. A RLS escopa cada query — MAS, desde a
// migração 039, `conversations` e `messages` são visíveis POR LINHA:
// um agente só enxerga as conversas atribuídas a ele mais a fila.
//
// Isso quebraria silenciosamente todo número desta tela. Não com um
// erro — com um valor MENOR: "Conversas ativas" viraria "as minhas",
// o gráfico de tempo de resposta ficaria vazio para um agente recém-
// chegado, e admin e agente veriam totais diferentes na mesma tela
// sem nada indicando o porquê. É o pior modo de falha possível,
// porque parece funcionar.
//
// Por isso tudo o que toca `conversations` / `messages` passa pelas
// RPCs `dashboard_*` (039): SECURITY DEFINER, escopadas por
// `account_id` e com guarda de `is_account_member` — o dashboard
// continua sendo da CONTA para todos os papéis. Daí o parâmetro
// `accountId` que estas funções agora exigem.
//
// `contacts`, `deals` e `pipeline_stages` seguem em queries diretas:
// suas políticas continuam planas por conta e não foram tocadas.
//
// Toda a lógica de bucket por dia LOCAL continua aqui, em TS. Mover
// datas para o SQL trocaria um problema conhecido por um de fuso.
// ------------------------------------------------------------

type DB = SupabaseClient;

// --- 1. Metric cards ---------------------------------------------------

/** Uma linha de `dashboard_counts` (039). */
interface DashboardCountsRow {
  open_conversations: number;
  new_conversations_today: number;
  new_conversations_yesterday: number;
  agent_messages_today: number;
  agent_messages_yesterday: number;
}

export async function loadMetrics(
  db: DB,
  accountId: string
): Promise<MetricsBundle> {
  const todayStart = startOfLocalDay().toISOString();
  const yesterdayStart = daysAgoStart(1).toISOString();

  const [counts, newContactsToday, newContactsYesterday, openDeals] =
    await Promise.all([
      // As cinco contagens que tocam conversations/messages numa RPC só
      // — quatro round-trips a menos que a versão anterior, de quebra.
      db.rpc('dashboard_counts', {
        p_account_id: accountId,
        p_today_start: todayStart,
        p_yesterday_start: yesterdayStart,
      }),
      db
        .from('contacts')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', todayStart),
      db
        .from('contacts')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', yesterdayStart)
        .lt('created_at', todayStart),
      db.from('deals').select('value, status').eq('status', 'open'),
    ]);

  if (counts.error) throw counts.error;

  // `RETURNS TABLE` chega como array de uma linha. Ausência só ocorre
  // se a guarda de conta rejeitar — que já teria lançado acima.
  const c = (counts.data as DashboardCountsRow[] | null)?.[0];

  const openDealsRows = (openDeals.data ?? []) as { value: number | null }[];
  const openDealsValue = openDealsRows.reduce(
    (sum, d) => sum + (d.value ?? 0),
    0
  );

  return {
    activeConversations: {
      current: c?.open_conversations ?? 0,
      // "vs yesterday" on a current-state count has no clean answer
      // without snapshots — we show the delta in NEW open conversations
      // today vs yesterday. That's the business-meaningful daily signal.
      previous:
        (c?.new_conversations_today ?? 0) -
        (c?.new_conversations_yesterday ?? 0),
    },
    newContactsToday: {
      current: newContactsToday.count ?? 0,
      previous: newContactsYesterday.count ?? 0,
    },
    openDealsValue,
    openDealsCount: openDealsRows.length,
    messagesSentToday: {
      current: c?.agent_messages_today ?? 0,
      previous: c?.agent_messages_yesterday ?? 0,
    },
  };
}

// --- 2. Conversations over time ---------------------------------------

export async function loadConversationsSeries(
  db: DB,
  accountId: string,
  rangeDays: number
): Promise<ConversationsSeriesPoint[]> {
  const start = daysAgoStart(rangeDays - 1).toISOString();
  const { data, error } = await db.rpc('dashboard_message_series', {
    p_account_id: accountId,
    p_start: start,
  });
  if (error) throw error;

  const keys = lastNDayKeys(rangeDays);
  const buckets = new Map<string, { incoming: number; outgoing: number }>();
  for (const k of keys) buckets.set(k, { incoming: 0, outgoing: 0 });

  for (const row of (data ?? []) as {
    created_at: string;
    sender_type: string;
  }[]) {
    const key = localDayKey(row.created_at);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    if (row.sender_type === 'customer') bucket.incoming += 1;
    else bucket.outgoing += 1; // agent + bot both count as outgoing
  }

  return keys.map((day) => ({
    day,
    ...(buckets.get(day) ?? { incoming: 0, outgoing: 0 }),
  }));
}

// --- 3. Pipeline donut -------------------------------------------------

export async function loadPipelineDonut(db: DB): Promise<PipelineDonutData> {
  const [stagesRes, dealsRes] = await Promise.all([
    db
      .from('pipeline_stages')
      .select('id, name, color, pipeline_id, position')
      .order('position'),
    db.from('deals').select('stage_id, value, status').eq('status', 'open'),
  ]);

  const stages = (stagesRes.data ?? []) as {
    id: string;
    name: string;
    color: string;
  }[];
  const deals = (dealsRes.data ?? []) as {
    stage_id: string;
    value: number | null;
  }[];

  const byStage = new Map<string, { count: number; total: number }>();
  for (const d of deals) {
    const row = byStage.get(d.stage_id) ?? { count: 0, total: 0 };
    row.count += 1;
    row.total += d.value ?? 0;
    byStage.set(d.stage_id, row);
  }

  const slices: PipelineStageSlice[] = stages
    .map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color || '#64748b',
      dealCount: byStage.get(s.id)?.count ?? 0,
      totalValue: byStage.get(s.id)?.total ?? 0,
    }))
    // Hide empty stages from the ring (but we'd still show them in the
    // legend if the user wanted a full breakdown — trimming keeps the
    // visual clean for the common case).
    .filter((s) => s.totalValue > 0 || s.dealCount > 0);

  return {
    stages: slices,
    totalValue: slices.reduce((sum, s) => sum + s.totalValue, 0),
  };
}

// --- 4. Response time by day of week ----------------------------------

export async function loadResponseTime(
  db: DB,
  accountId: string
): Promise<ResponseTimeSummary> {
  // Pull the last 14 days of messages in one shot, then walk per
  // conversation to find each "first inbound" → "first subsequent
  // outbound" pair. 14 days gives us both "this week" + "last week"
  // with enough overlap if the user opens the dashboard late on a
  // Monday.
  const fourteenDaysAgo = daysAgoStart(13).toISOString();
  // A RPC já devolve ordenado por (conversation_id, created_at) — a
  // ordenação faz parte do contrato dela, porque o pareamento abaixo
  // percorre as linhas em sequência e depende disso.
  const { data, error } = await db.rpc('dashboard_response_samples', {
    p_account_id: accountId,
    p_start: fourteenDaysAgo,
  });
  if (error) throw error;

  const rows = (data ?? []) as {
    conversation_id: string;
    sender_type: string;
    created_at: string;
  }[];

  // Group per conversation, pair unreplied customer messages with the
  // next outbound message from the agent/bot. A single customer message
  // can only count once (avoids inflating averages if the customer
  // double-messages while the agent takes time to reply).
  interface Sample {
    customerAt: Date;
    responseAt: Date;
  }
  const samples: Sample[] = [];

  let currentConv = '';
  let pendingCustomer: Date | null = null;
  for (const row of rows) {
    if (row.conversation_id !== currentConv) {
      currentConv = row.conversation_id;
      pendingCustomer = null;
    }
    const ts = new Date(row.created_at);
    if (row.sender_type === 'customer') {
      if (!pendingCustomer) pendingCustomer = ts;
    } else if (pendingCustomer) {
      samples.push({ customerAt: pendingCustomer, responseAt: ts });
      pendingCustomer = null;
    }
  }

  const now = new Date();
  const thisWeekStart = daysAgoStart(mondayIndex(now));
  const lastWeekStart = daysAgoStart(mondayIndex(now) + 7);

  // Per-day-of-week buckets, averaged over both weeks' worth of data
  // so each bar has more samples to stand on. If a day has no samples
  // its avgMinutes stays null and the chart renders the bar muted.
  const byDow = new Map<number, number[]>();
  for (let i = 0; i < 7; i++) byDow.set(i, []);
  const thisWeekMins: number[] = [];
  const lastWeekMins: number[] = [];

  for (const s of samples) {
    const diffMin = (s.responseAt.getTime() - s.customerAt.getTime()) / 60_000;
    if (diffMin < 0) continue;
    const dow = mondayIndex(s.customerAt);
    byDow.get(dow)!.push(diffMin);
    if (s.customerAt >= thisWeekStart) {
      thisWeekMins.push(diffMin);
    } else if (s.customerAt >= lastWeekStart && s.customerAt < thisWeekStart) {
      lastWeekMins.push(diffMin);
    }
  }

  const avg = (arr: number[]) =>
    arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length;

  const buckets: ResponseTimeBucket[] = Array.from({ length: 7 }, (_, dow) => {
    const samples = byDow.get(dow) ?? [];
    return {
      dow,
      avgMinutes: avg(samples),
      samples: samples.length,
    };
  });

  // Silence unused-label warnings — keep the arrays explicitly named
  // for readability above.
  void DOW_SHORT_MON_FIRST;

  return {
    buckets,
    thisWeekAvg: avg(thisWeekMins),
    lastWeekAvg: avg(lastWeekMins),
  };
}

// --- 5. Activity feed --------------------------------------------------

export async function loadActivity(
  db: DB,
  accountId: string,
  limit = 20
): Promise<ActivityItem[]> {
  // Pull ~10 from each source (plenty of headroom after merge-sort),
  // then interleave by timestamp. The individual per-table limits
  // keep the payload small; the final limit is enforced after sort.
  const [msgs, contacts, deals, broadcasts, autoLogs] = await Promise.all([
    // Via RPC, e não só por causa da RLS: o embed do PostgREST
    // (`conversations(contact_id, contacts(...))`) é um LEFT JOIN, então
    // uma conversa invisível não removeria a mensagem do feed — ela
    // apareceria como "Unknown", com link para uma thread que o usuário
    // não consegue abrir. A RPC faz o join do lado do servidor e só
    // devolve o que é da conta.
    db.rpc('dashboard_recent_inbound', {
      p_account_id: accountId,
      p_limit: 10,
    }),
    db
      .from('contacts')
      .select('id, name, phone, created_at')
      .order('created_at', { ascending: false })
      .limit(10),
    db
      .from('deals')
      .select('id, title, updated_at, stage:pipeline_stages(name)')
      .order('updated_at', { ascending: false })
      .limit(10),
    db
      .from('broadcasts')
      .select('id, name, status, total_recipients, created_at')
      .order('created_at', { ascending: false })
      .limit(5),
    db
      .from('automation_logs')
      .select(
        'id, trigger_event, status, created_at, automation:automations(name), contact:contacts(name, phone)'
      )
      .order('created_at', { ascending: false })
      .limit(10),
  ]);

  const items: ActivityItem[] = [];

  // A RPC devolve o contato já achatado, então o desembrulho em dois
  // níveis de array que o embed do PostgREST exigia deixou de existir.
  for (const m of (msgs.data ?? []) as Array<{
    id: string;
    content_text: string | null;
    created_at: string;
    conversation_id: string;
    contact_name: string | null;
    contact_phone: string | null;
  }>) {
    const who = m.contact_name || m.contact_phone || 'Unknown';
    items.push({
      id: `msg-${m.id}`,
      kind: 'message',
      text: `Nova msg de ${who}`,
      at: m.created_at,
      href: `/inbox?c=${m.conversation_id}`,
    });
  }

  for (const c of (contacts.data ?? []) as Array<{
    id: string;
    name: string | null;
    phone: string;
    created_at: string;
  }>) {
    items.push({
      id: `contact-${c.id}`,
      kind: 'contact',
      text: `Novo contato: ${c.name || c.phone}`,
      at: c.created_at,
      href: '/contacts',
    });
  }

  for (const d of (deals.data ?? []) as unknown as Array<{
    id: string;
    title: string;
    updated_at: string;
    stage: { name: string }[] | { name: string } | null;
  }>) {
    const stage = Array.isArray(d.stage) ? d.stage[0] : d.stage;
    items.push({
      id: `deal-${d.id}`,
      kind: 'deal',
      text: stage?.name
        ? `Negócio "${d.title}" - ${stage.name}`
        : `Negócio "${d.title}" atualizado`,
      at: d.updated_at,
      href: '/pipelines',
    });
  }

  for (const b of (broadcasts.data ?? []) as Array<{
    id: string;
    name: string;
    status: string;
    total_recipients: number;
    created_at: string;
  }>) {
    const label =
      b.status === 'sent'
        ? `enviado para ${b.total_recipients} contatos`
        : `${b.status} (${b.total_recipients} destinatários)`;
    items.push({
      id: `broadcast-${b.id}`,
      kind: 'broadcast',
      text: `Broadcast "${b.name}" ${label}`,
      at: b.created_at,
      href: '/broadcasts',
    });
  }

  for (const l of (autoLogs.data ?? []) as unknown as Array<{
    id: string;
    trigger_event: string;
    status: string;
    created_at: string;
    automation: { name: string }[] | { name: string } | null;
    contact:
      | { name: string | null; phone: string }[]
      | { name: string | null; phone: string }
      | null;
  }>) {
    const automation = Array.isArray(l.automation)
      ? l.automation[0]
      : l.automation;
    const contact = Array.isArray(l.contact) ? l.contact[0] : l.contact;
    const who = contact?.name || contact?.phone || 'a contact';
    const autoName = automation?.name || 'Automation';
    items.push({
      id: `auto-${l.id}`,
      kind: 'automation',
      text: `Automação "${autoName}" ${l.status === 'failed' ? 'falhou para' : 'acionada para'} ${who}`,
      at: l.created_at,
    });
  }

  return items
    .sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : 0))
    .slice(0, limit);
}
