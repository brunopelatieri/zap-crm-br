// ============================================================
// Modelo de colunas e regra do badge de CRM do Quadro de Atribuição
// (SPEC 043).
//
// Módulo puro — sem React, sem Supabase — mesma filosofia de
// `lib/inbox/tabs.ts`: testável isolado (assignment-board.test.ts) e
// importado tanto pelo hook de dados quanto pelos componentes de
// apresentação.
//
// ⚠️ Vocabulário do quadro (SPEC 043, §3.1, invariante 4): aqui
// "coluna" é um AGENTE e "card" é uma CONVERSA — não confundir com o
// funil de vendas (`src/components/pipelines/`), que opera sobre
// `deals`/`pipeline_stages`. Os únicos pontos de contato com aquele
// domínio são `BoardDealRow` e `pickPrimaryDeal`, deliberadamente
// prefixados para se destacarem.
//
// Além do modelo de colunas, este arquivo concentra os REDUTORES do
// estado do quadro (`moveCard`, `restoreCard`, `settleCard`, …). Eles
// vivem aqui, e não dentro do hook, porque são a parte mais delicada da
// feature — a reconciliação entre a mutação otimista e os eventos de
// realtime — e como funções puras sobre um mapa simples ficam cobertas
// por testes sem precisar de `renderHook` nem de mock de rede (o repo
// não tem infraestrutura de teste de componentes; ver §10 da SPEC).
//
// Contrato comum a TODOS os redutores: recebem e devolvem
// `BoardColumnStateMap` sem mutar a entrada, e devolvem **a mesma
// referência** quando nada muda — é isso que deixa o `setState` do React
// desistir do re-render e o que os testes usam para afirmar "foi no-op".
// ============================================================

import { ASSIGNABLE_ACCOUNT_ROLES } from '@/lib/auth/roles';
import type {
  Conversation,
  ConversationStatus,
  DealStatus,
  Profile,
} from '@/types';

/**
 * Id sentinela da primeira coluna (a fila de não-atribuídos). String
 * literal, não `null`: o `over.id` do @dnd-kit é sempre
 * `string | number`, e um `null` ali seria indistinguível de "soltou
 * fora de qualquer coluna". O prefixo `__` garante que nunca colide
 * com um `user_id` (UUID).
 */
export const UNASSIGNED_COLUMN_ID = '__unassigned__';

/** Tamanho da página por coluna (SPEC 043, §4.3 — teto + "carregar mais"). */
export const BOARD_PAGE_SIZE = 50;

/**
 * Recorte de status que o quadro carrega — conversas encerradas não
 * fazem parte de nenhuma carteira ativa. Mesmo array em toda consulta
 * (onda 1 e o guard de elegibilidade do handler de realtime), para as
 * duas fontes nunca divergirem sobre o que "conta".
 */
export const BOARD_STATUSES: readonly ConversationStatus[] = [
  'open',
  'pending',
];

/**
 * `select` das queries por coluna — deliberadamente mais enxuto que
 * `CONVERSATION_SELECT` (que faz `contact:contacts(*)`): o quadro
 * carrega N vezes mais linhas que a lista do Inbox (uma query por
 * coluna), então cada campo a mais custa N vezes. Só os campos que o
 * card (§6.3 da SPEC) renderiza.
 */
export const BOARD_CONVERSATION_SELECT =
  'id, contact_id, assigned_agent_id, status, last_message_at, unread_count, ' +
  'contact:contacts(id, name, phone, avatar_url, company, contact_tags(tags(*)))';

export interface BoardColumn {
  /** `UNASSIGNED_COLUMN_ID` para a fila, ou `profile.user_id` para um agente. */
  id: string;
  /** `null` ⇒ a coluna é a fila de não-atribuídos. */
  agent: Profile | null;
}

/**
 * Monta as colunas do quadro: a fila sempre em primeiro, seguida de
 * uma coluna por membro com papel atribuível (SPEC 043, §2.2 —
 * `owner`/`admin`/`agent`; nunca `viewer`, que faria o drop falhar com
 * `INVALID_ASSIGNEE`).
 *
 * Preserva a ordem de `members` — não reordena. O chamador
 * (`useAccountMembers`) já pede `.order('full_name')` ao banco; refazer
 * o sort aqui seria trabalho duplicado sem efeito visível.
 */
export function buildBoardColumns(members: readonly Profile[]): BoardColumn[] {
  const assignable = members.filter(
    (m) =>
      m.account_role &&
      (ASSIGNABLE_ACCOUNT_ROLES as readonly string[]).includes(m.account_role)
  );
  return [
    { id: UNASSIGNED_COLUMN_ID, agent: null },
    ...assignable.map((agent) => ({ id: agent.user_id, agent })),
  ];
}

/**
 * Inverso de `BoardColumn.id` para o corpo das rotas de atribuição —
 * `null` é o valor que `/assign` espera para devolver à fila.
 */
export function boardColumnIdToAgentId(columnId: string): string | null {
  return columnId === UNASSIGNED_COLUMN_ID ? null : columnId;
}

/**
 * Linha crua da query de deals da onda 2 (SPEC 043, §4.4). `stage` e
 * `pipeline` são embeds many-to-one (cada deal tem exatamente um
 * `stage_id`/`pipeline_id` `NOT NULL`) — o PostgREST devolve objeto,
 * não array; `| null` cobre só a janela teórica de uma FK sem embed
 * resolvido (nunca deveria ocorrer, dado `stage_id`/`pipeline_id`
 * `NOT NULL` — ver 001_initial_schema.sql).
 */
export interface BoardDealRow {
  contact_id: string | null;
  status: DealStatus;
  created_at: string;
  stage: { id: string; name: string; color: string } | null;
  pipeline: { id: string; name: string } | null;
}

/** O que o badge de CRM do card (§6.3) precisa para renderizar. */
export interface PrimaryDeal {
  pipelineName: string;
  stageName: string;
  stageColor: string;
  /**
   * `true` quando não há deal `open` e o mais recente exibido é
   * ganho/perdido — o card renderiza esmaecido (SPEC 043, §6.3), porque
   * "este contato já passou pelo funil" ainda é informação útil ao
   * supervisor, mas não é o mesmo que "está no funil agora".
   */
  stale: boolean;
}

/**
 * Escolhe qual deal do contato o badge do card mostra (SPEC 043, §2.4
 * e §4.4 — decisão registrada, não um join óbvio, porque um contato
 * pode ter N deals em N funis e não existe "a" etapa atual).
 *
 * Regra: o deal `open` mais recente; na ausência de um `open`, o mais
 * recente de qualquer status, marcado `stale`. Sem deals, `null` — sem
 * badge.
 *
 * `deals` deve vir ordenado por `created_at DESC` (a query da onda 2
 * já pede isso) — a função não reordena.
 */
export function pickPrimaryDeal(
  deals: readonly BoardDealRow[]
): PrimaryDeal | null {
  const open = deals.find((d) => d.status === 'open');
  if (open) return toPrimaryDeal(open, false);
  const latest = deals[0];
  return latest ? toPrimaryDeal(latest, true) : null;
}

function toPrimaryDeal(deal: BoardDealRow, stale: boolean): PrimaryDeal | null {
  if (!deal.stage || !deal.pipeline) return null;
  return {
    pipelineName: deal.pipeline.name,
    stageName: deal.stage.name,
    stageColor: deal.stage.color,
    stale,
  };
}

// ============================================================
// Estado do quadro e seus redutores
// ============================================================

export interface BoardCard {
  conversation: Conversation;
  latestNote: string | null;
  primaryDeal: PrimaryDeal | null;
  /** A onda 2 (notas + deal) já chegou para o contato deste card. */
  hydrated: boolean;
  /** Mutação de atribuição em voo — ver §5.2 da SPEC. */
  pending: boolean;
}

export interface BoardColumnState {
  column: BoardColumn;
  cards: BoardCard[];
  /** `count` exato do servidor — NUNCA `cards.length` (§4.3/§6.2). */
  total: number;
  loadingMore: boolean;
}

/** Estado completo do quadro, indexado por `BoardColumn.id`. */
export type BoardColumnStateMap = Record<string, BoardColumnState>;

/**
 * Destino oferecido pelo menu "atribuir a…" do card (§9 → §6.4). Já
 * carrega o rótulo resolvido: o card não precisa de `useTranslations`
 * nem do roster para montar o menu.
 */
export interface BoardAssignTarget {
  /** `BoardColumn.id` — entra direto em `moveConversation`. */
  id: string;
  label: string;
  /** `true` para a fila de não-atribuídos (renderiza separada). */
  isQueue: boolean;
}

/** O necessário para desfazer um movimento otimista (§5.2). */
export interface DropSnapshot {
  sourceColumnId: string;
  targetColumnId: string;
  cardIndex: number;
  card: BoardCard;
}

/** Card recém-chegado do servidor, ainda sem a hidratação da onda 2. */
export function toBoardCard(conversation: Conversation): BoardCard {
  return {
    conversation,
    latestNote: null,
    primaryDeal: null,
    hydrated: false,
    pending: false,
  };
}

/** A conversa se qualifica para o quadro? (§4.3 — `BOARD_STATUSES`) */
export function isBoardEligibleStatus(status: string | undefined): boolean {
  return !!status && (BOARD_STATUSES as readonly string[]).includes(status);
}

function hasCard(column: BoardColumnState, conversationId: string): boolean {
  return column.cards.some((c) => c.conversation.id === conversationId);
}

/**
 * Move um card entre colunas, ajustando os dois `total`.
 *
 * As duas guardas de idempotência são o coração da correção da §5.2:
 * um evento de realtime pode ter reposicionado o card entre a decisão
 * do chamador e a aplicação deste redutor. Sem elas, um card já ausente
 * da origem ainda decrementaria `total[origem]` (contagem passa a
 * mentir) e um card já presente no destino seria inserido em duplicata
 * (chave React repetida).
 */
export function moveCard(
  state: BoardColumnStateMap,
  options: {
    conversationId: string;
    fromColumnId: string;
    toColumnId: string;
    /** Marca a cópia movida como "mutação em voo". */
    markPending?: boolean;
    /** Quando informado, grava o novo dono na cópia movida. */
    assignedAgentId?: string | null;
  }
): BoardColumnStateMap {
  const {
    conversationId,
    fromColumnId,
    toColumnId,
    markPending = false,
    assignedAgentId,
  } = options;

  if (fromColumnId === toColumnId) return state;
  const from = state[fromColumnId];
  const to = state[toColumnId];
  if (!from || !to) return state;

  const card = from.cards.find((c) => c.conversation.id === conversationId);
  if (!card) return state;
  if (hasCard(to, conversationId)) return state;

  const moved: BoardCard = {
    ...card,
    pending: markPending,
    conversation:
      assignedAgentId === undefined
        ? card.conversation
        : { ...card.conversation, assigned_agent_id: assignedAgentId },
  };

  return {
    ...state,
    [fromColumnId]: {
      ...from,
      cards: from.cards.filter((c) => c.conversation.id !== conversationId),
      total: Math.max(0, from.total - 1),
    },
    [toColumnId]: {
      ...to,
      cards: [moved, ...to.cards],
      total: to.total + 1,
    },
  };
}

/**
 * Desfaz um movimento otimista, recolocando o card no índice original.
 *
 * ⚠️ Só age se o card AINDA estiver na coluna de destino do snapshot.
 * Se um evento de realtime já o levou para outro lugar, o servidor é
 * mais recente que o snapshot: reinserir na origem criaria uma segunda
 * cópia (a remoção do destino não encontraria nada, mas a inserção
 * aconteceria mesmo assim). Nesse caso o chamador deve apenas limpar o
 * `pending` — ver `clearCardPending`.
 */
export function restoreCard(
  state: BoardColumnStateMap,
  snapshot: DropSnapshot
): BoardColumnStateMap {
  const { sourceColumnId, targetColumnId, cardIndex, card } = snapshot;
  const conversationId = card.conversation.id;

  const src = state[sourceColumnId];
  const tgt = state[targetColumnId];
  if (!src || !tgt) return state;
  if (!hasCard(tgt, conversationId)) return state;
  if (hasCard(src, conversationId)) return state;

  const restored = src.cards.slice();
  restored.splice(Math.min(cardIndex, restored.length), 0, {
    ...card,
    pending: false,
  });

  return {
    ...state,
    [sourceColumnId]: { ...src, cards: restored, total: src.total + 1 },
    [targetColumnId]: {
      ...tgt,
      cards: tgt.cards.filter((c) => c.conversation.id !== conversationId),
      total: Math.max(0, tgt.total - 1),
    },
  };
}

/**
 * Encerra a mutação de um card: limpa `pending` e, se
 * `patchAssignment`, grava o `assigned_agent_id` devolvido pelo
 * servidor.
 *
 * `patchAssignment: false` é o caso em que o card mudou de coluna
 * enquanto o POST estava em voo — o evento de realtime é mais recente
 * que a nossa resposta, então sobrescrever o dono devolveria a UI ao
 * agente que pedimos em vez do que de fato venceu a corrida.
 */
export function settleCard(
  state: BoardColumnStateMap,
  options: {
    conversationId: string;
    columnId: string;
    assignedAgentId: string | null;
    patchAssignment: boolean;
  }
): BoardColumnStateMap {
  const { conversationId, columnId, assignedAgentId, patchAssignment } =
    options;
  const column = state[columnId];
  if (!column || !hasCard(column, conversationId)) return state;

  return {
    ...state,
    [columnId]: {
      ...column,
      cards: column.cards.map((c) =>
        c.conversation.id === conversationId
          ? {
              ...c,
              pending: false,
              conversation: patchAssignment
                ? { ...c.conversation, assigned_agent_id: assignedAgentId }
                : c.conversation,
            }
          : c
      ),
    },
  };
}

/** Limpa só o `pending`, preservando o dono que o card já tem. */
export function clearCardPending(
  state: BoardColumnStateMap,
  options: { conversationId: string; columnId: string }
): BoardColumnStateMap {
  return settleCard(state, {
    ...options,
    assignedAgentId: null,
    patchAssignment: false,
  });
}

/** Remove um card e decrementa o `total` da coluna. */
export function removeCard(
  state: BoardColumnStateMap,
  options: { conversationId: string; columnId: string }
): BoardColumnStateMap {
  const { conversationId, columnId } = options;
  const column = state[columnId];
  if (!column || !hasCard(column, conversationId)) return state;

  return {
    ...state,
    [columnId]: {
      ...column,
      cards: column.cards.filter((c) => c.conversation.id !== conversationId),
      total: Math.max(0, column.total - 1),
    },
  };
}

/** Insere um card no topo da coluna. Idempotente por id. */
export function insertCard(
  state: BoardColumnStateMap,
  options: { card: BoardCard; columnId: string }
): BoardColumnStateMap {
  const { card, columnId } = options;
  const column = state[columnId];
  if (!column) return state;
  if (hasCard(column, card.conversation.id)) return state;

  return {
    ...state,
    [columnId]: {
      ...column,
      cards: [card, ...column.cards],
      total: column.total + 1,
    },
  };
}

/**
 * Acrescenta a próxima página ao fim da coluna ("carregar mais").
 *
 * Deduplica por id: entre o disparo da query e a sua resposta, um
 * evento de realtime pode ter inserido no topo um card que também vem
 * nesta página — sem o filtro, ele apareceria duas vezes.
 */
export function appendCards(
  state: BoardColumnStateMap,
  options: { columnId: string; cards: readonly BoardCard[] }
): BoardColumnStateMap {
  const { columnId, cards } = options;
  const column = state[columnId];
  if (!column) return state;

  const existing = new Set(column.cards.map((c) => c.conversation.id));
  const fresh = cards.filter((c) => !existing.has(c.conversation.id));
  if (fresh.length === 0) return state;

  return {
    ...state,
    [columnId]: { ...column, cards: [...column.cards, ...fresh] },
  };
}

/** Liga/desliga o spinner do "carregar mais" de uma coluna. */
export function setColumnLoadingMore(
  state: BoardColumnStateMap,
  options: { columnId: string; loadingMore: boolean }
): BoardColumnStateMap {
  const { columnId, loadingMore } = options;
  const column = state[columnId];
  if (!column || column.loadingMore === loadingMore) return state;
  return { ...state, [columnId]: { ...column, loadingMore } };
}

/**
 * Aplica contagens relidas do servidor (§4.6 — correção da deriva do
 * `total` para conversas fora da página carregada).
 *
 * Escreve exclusivamente em `total`, nunca em `cards`: as duas coisas
 * têm ritmos diferentes, e sobrescrever a lista aqui descartaria a
 * hidratação da onda 2 e competiria com um drop em voo. `count: null`
 * (a query daquela coluna falhou) preserva o valor antigo — um total
 * velho é menos ruim que um cabeçalho zerado.
 */
export function applyColumnCounts(
  state: BoardColumnStateMap,
  counts: readonly { id: string; count: number | null }[]
): BoardColumnStateMap {
  let changed = false;
  const next: BoardColumnStateMap = { ...state };

  for (const { id, count } of counts) {
    if (count === null) continue;
    const column = next[id];
    if (!column || column.total === count) continue;
    next[id] = { ...column, total: count };
    changed = true;
  }

  return changed ? next : state;
}

/**
 * Aplica os resultados da onda 2 (notas + deal primário) aos cards cujo
 * `contact_id` foi consultado. Cards já hidratados não são tocados —
 * uma segunda onda para outro lote não deve reverter os anteriores.
 */
export function hydrateCards(
  state: BoardColumnStateMap,
  queriedContactIds: readonly string[],
  notes: Map<string, string>,
  deals: Map<string, BoardDealRow[]>
): BoardColumnStateMap {
  const queried = new Set(queriedContactIds);
  let changed = false;
  const next: BoardColumnStateMap = {};

  for (const [columnId, column] of Object.entries(state)) {
    let columnChanged = false;
    const cards = column.cards.map((card) => {
      const contactId = card.conversation.contact_id;
      if (!contactId || card.hydrated || !queried.has(contactId)) return card;
      columnChanged = true;
      return {
        ...card,
        latestNote: notes.get(contactId) ?? null,
        primaryDeal: pickPrimaryDeal(deals.get(contactId) ?? []),
        hydrated: true,
      };
    });
    next[columnId] = columnChanged ? { ...column, cards } : column;
    changed = changed || columnChanged;
  }

  return changed ? next : state;
}
