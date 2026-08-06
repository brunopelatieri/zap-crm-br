import { describe, expect, it } from 'vitest';
import {
  BOARD_STATUSES,
  UNASSIGNED_COLUMN_ID,
  appendCards,
  applyColumnCounts,
  boardColumnIdToAgentId,
  buildBoardColumns,
  clearCardPending,
  hydrateCards,
  insertCard,
  isBoardEligibleStatus,
  moveCard,
  pickPrimaryDeal,
  removeCard,
  restoreCard,
  setColumnLoadingMore,
  settleCard,
  toBoardCard,
  type BoardCard,
  type BoardColumnStateMap,
  type BoardDealRow,
} from './assignment-board';
import type { Conversation, Profile } from '@/types';

function makeProfile(overrides: Partial<Profile>): Profile {
  return {
    id: overrides.user_id ?? 'profile-id',
    user_id: 'user-id',
    full_name: 'Someone',
    email: 'someone@example.com',
    role: 'user',
    account_id: 'account-1',
    account_role: 'agent',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildBoardColumns', () => {
  it('a fila (UNASSIGNED_COLUMN_ID) vem sempre em primeiro', () => {
    const columns = buildBoardColumns([]);
    expect(columns).toHaveLength(1);
    expect(columns[0].id).toBe(UNASSIGNED_COLUMN_ID);
    expect(columns[0].agent).toBeNull();
  });

  it('inclui owner, admin e agent como colunas', () => {
    const owner = makeProfile({ user_id: 'u-owner', account_role: 'owner' });
    const admin = makeProfile({ user_id: 'u-admin', account_role: 'admin' });
    const agent = makeProfile({ user_id: 'u-agent', account_role: 'agent' });
    const columns = buildBoardColumns([owner, admin, agent]);
    expect(columns.map((c) => c.id)).toEqual([
      UNASSIGNED_COLUMN_ID,
      'u-owner',
      'u-admin',
      'u-agent',
    ]);
  });

  it('exclui viewer — uma coluna viewer faria o drop falhar com INVALID_ASSIGNEE', () => {
    const viewer = makeProfile({ user_id: 'u-viewer', account_role: 'viewer' });
    const agent = makeProfile({ user_id: 'u-agent', account_role: 'agent' });
    const columns = buildBoardColumns([viewer, agent]);
    expect(columns.map((c) => c.id)).toEqual([UNASSIGNED_COLUMN_ID, 'u-agent']);
  });

  it('exclui membro sem account_role resolvido', () => {
    const noRole = makeProfile({ user_id: 'u-none', account_role: undefined });
    const columns = buildBoardColumns([noRole]);
    expect(columns).toHaveLength(1);
  });

  it('preserva a ordem de entrada (o chamador já ordena por full_name)', () => {
    const b = makeProfile({ user_id: 'u-b', full_name: 'Bruno' });
    const a = makeProfile({ user_id: 'u-a', full_name: 'Ana' });
    const columns = buildBoardColumns([b, a]);
    expect(columns.map((c) => c.id)).toEqual([
      UNASSIGNED_COLUMN_ID,
      'u-b',
      'u-a',
    ]);
  });
});

describe('boardColumnIdToAgentId', () => {
  it('UNASSIGNED_COLUMN_ID vira null (o valor que /assign espera para devolver à fila)', () => {
    expect(boardColumnIdToAgentId(UNASSIGNED_COLUMN_ID)).toBeNull();
  });

  it('qualquer outro id passa como o próprio agentId', () => {
    expect(boardColumnIdToAgentId('user-123')).toBe('user-123');
  });
});

describe('BOARD_STATUSES', () => {
  it('cobre open e pending, não closed', () => {
    expect(BOARD_STATUSES).toEqual(['open', 'pending']);
  });
});

function makeDeal(overrides: Partial<BoardDealRow>): BoardDealRow {
  return {
    contact_id: 'contact-1',
    status: 'open',
    created_at: '2026-01-01T00:00:00.000Z',
    stage: { id: 'stage-1', name: 'Qualificação', color: '#3b82f6' },
    pipeline: { id: 'pipeline-1', name: 'Funil de Vendas' },
    ...overrides,
  };
}

describe('pickPrimaryDeal', () => {
  it('sem deals: null (sem badge)', () => {
    expect(pickPrimaryDeal([])).toBeNull();
  });

  it('só deals fechados (won/lost): mostra o mais recente, stale=true', () => {
    const lost = makeDeal({
      status: 'lost',
      created_at: '2026-01-02T00:00:00.000Z',
      stage: { id: 's-lost', name: 'Perdido', color: '#ef4444' },
    });
    const won = makeDeal({
      status: 'won',
      created_at: '2026-01-01T00:00:00.000Z',
      stage: { id: 's-won', name: 'Ganho', color: '#22c55e' },
    });
    // Já ordenado created_at desc, como a query real devolve.
    const result = pickPrimaryDeal([lost, won]);
    expect(result).toEqual({
      pipelineName: 'Funil de Vendas',
      stageName: 'Perdido',
      stageColor: '#ef4444',
      stale: true,
    });
  });

  it('deal open antigo vence um deal fechado mais recente', () => {
    const recentLost = makeDeal({
      status: 'lost',
      created_at: '2026-02-01T00:00:00.000Z',
      stage: { id: 's-lost', name: 'Perdido', color: '#ef4444' },
    });
    const olderOpen = makeDeal({
      status: 'open',
      created_at: '2026-01-01T00:00:00.000Z',
      stage: { id: 's-open', name: 'Qualificação', color: '#3b82f6' },
    });
    // Ordem desc por created_at: o fechado recente vem primeiro na lista.
    const result = pickPrimaryDeal([recentLost, olderOpen]);
    expect(result).toEqual({
      pipelineName: 'Funil de Vendas',
      stageName: 'Qualificação',
      stageColor: '#3b82f6',
      stale: false,
    });
  });

  it('deal open mais recente entre vários open usa o primeiro da lista (já ordenada)', () => {
    const older = makeDeal({
      status: 'open',
      created_at: '2026-01-01T00:00:00.000Z',
      stage: { id: 's-old', name: 'Antiga', color: '#000000' },
    });
    const newer = makeDeal({
      status: 'open',
      created_at: '2026-02-01T00:00:00.000Z',
      stage: { id: 's-new', name: 'Nova', color: '#ffffff' },
    });
    const result = pickPrimaryDeal([newer, older]);
    expect(result?.stageName).toBe('Nova');
    expect(result?.stale).toBe(false);
  });

  it('deal sem stage ou pipeline resolvido não produz badge', () => {
    const broken = makeDeal({ stage: null });
    expect(pickPrimaryDeal([broken])).toBeNull();
  });
});

// ============================================================
// Redutores de estado do quadro
//
// Cobrem a reconciliação entre a mutação otimista do drop (§5.2) e os
// eventos de realtime (§4.6) — a parte da feature onde uma corrida
// produz corrupção visível (card travado, card duplicado, contagem
// mentindo) em vez de um erro. Como o repo não tem infraestrutura de
// teste de componentes, é aqui que essa lógica fica coberta.
// ============================================================

const QUEUE = UNASSIGNED_COLUMN_ID;
const ANA = 'user-ana';
const BRUNO = 'user-bruno';

function makeConversation(id: string, overrides: Partial<Conversation> = {}) {
  return {
    id,
    user_id: 'owner-1',
    account_id: 'account-1',
    contact_id: `contact-${id}`,
    status: 'open',
    assigned_agent_id: null,
    unread_count: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Conversation;
}

function makeCard(id: string, overrides: Partial<BoardCard> = {}): BoardCard {
  return { ...toBoardCard(makeConversation(id)), ...overrides };
}

/** Mapa de 3 colunas (fila, Ana, Bruno) com os cards informados. */
function makeState(
  layout: Record<string, { ids: string[]; total?: number }>
): BoardColumnStateMap {
  const state: BoardColumnStateMap = {};
  for (const [columnId, { ids, total }] of Object.entries(layout)) {
    state[columnId] = {
      column: {
        id: columnId,
        agent:
          columnId === QUEUE
            ? null
            : makeProfile({ user_id: columnId, full_name: columnId }),
      },
      cards: ids.map((id) => makeCard(id)),
      total: total ?? ids.length,
      loadingMore: false,
    };
  }
  return state;
}

const idsOf = (state: BoardColumnStateMap, columnId: string) =>
  state[columnId].cards.map((c) => c.conversation.id);

describe('isBoardEligibleStatus', () => {
  it('aceita open e pending, rejeita closed e indefinido', () => {
    expect(isBoardEligibleStatus('open')).toBe(true);
    expect(isBoardEligibleStatus('pending')).toBe(true);
    expect(isBoardEligibleStatus('closed')).toBe(false);
    expect(isBoardEligibleStatus(undefined)).toBe(false);
  });
});

describe('moveCard', () => {
  it('move o card e ajusta os dois totais', () => {
    const state = makeState({
      [QUEUE]: { ids: ['c1', 'c2'], total: 40 },
      [ANA]: { ids: ['c3'], total: 7 },
    });
    const next = moveCard(state, {
      conversationId: 'c1',
      fromColumnId: QUEUE,
      toColumnId: ANA,
    });

    expect(idsOf(next, QUEUE)).toEqual(['c2']);
    expect(idsOf(next, ANA)).toEqual(['c1', 'c3']); // entra no topo
    expect(next[QUEUE].total).toBe(39);
    expect(next[ANA].total).toBe(8);
  });

  it('marca pending e grava o novo dono quando pedido', () => {
    const state = makeState({ [QUEUE]: { ids: ['c1'] }, [ANA]: { ids: [] } });
    const next = moveCard(state, {
      conversationId: 'c1',
      fromColumnId: QUEUE,
      toColumnId: ANA,
      markPending: true,
      assignedAgentId: ANA,
    });
    const moved = next[ANA].cards[0];
    expect(moved.pending).toBe(true);
    expect(moved.conversation.assigned_agent_id).toBe(ANA);
  });

  it('sem assignedAgentId preserva o dono que o card já tinha', () => {
    const state = makeState({ [QUEUE]: { ids: ['c1'] }, [ANA]: { ids: [] } });
    const next = moveCard(state, {
      conversationId: 'c1',
      fromColumnId: QUEUE,
      toColumnId: ANA,
    });
    expect(next[ANA].cards[0].conversation.assigned_agent_id).toBeNull();
  });

  it('origem igual ao destino é no-op', () => {
    const state = makeState({ [QUEUE]: { ids: ['c1'] } });
    expect(
      moveCard(state, {
        conversationId: 'c1',
        fromColumnId: QUEUE,
        toColumnId: QUEUE,
      })
    ).toBe(state);
  });

  it('coluna inexistente é no-op', () => {
    const state = makeState({ [QUEUE]: { ids: ['c1'] } });
    expect(
      moveCard(state, {
        conversationId: 'c1',
        fromColumnId: QUEUE,
        toColumnId: 'coluna-fantasma',
      })
    ).toBe(state);
  });

  // A regressão que motivou a extração: sem esta guarda o `total` da
  // origem era decrementado por um movimento que não aconteceu.
  it('card ausente da origem é no-op — nenhum total é mexido', () => {
    const state = makeState({
      [QUEUE]: { ids: ['c1'], total: 30 },
      [ANA]: { ids: [], total: 5 },
    });
    const next = moveCard(state, {
      conversationId: 'nao-esta-aqui',
      fromColumnId: QUEUE,
      toColumnId: ANA,
    });
    expect(next).toBe(state);
  });

  // Idem: sem esta guarda um evento de realtime que já tivesse inserido
  // o card no destino produzia uma segunda cópia (chave React repetida).
  it('card já presente no destino é no-op — não duplica', () => {
    const state = makeState({
      [QUEUE]: { ids: ['c1'] },
      [ANA]: { ids: ['c1'] },
    });
    const next = moveCard(state, {
      conversationId: 'c1',
      fromColumnId: QUEUE,
      toColumnId: ANA,
    });
    expect(next).toBe(state);
    expect(idsOf(next, ANA)).toEqual(['c1']);
  });

  it('não muta a entrada', () => {
    const state = makeState({ [QUEUE]: { ids: ['c1'] }, [ANA]: { ids: [] } });
    moveCard(state, {
      conversationId: 'c1',
      fromColumnId: QUEUE,
      toColumnId: ANA,
    });
    expect(idsOf(state, QUEUE)).toEqual(['c1']);
    expect(idsOf(state, ANA)).toEqual([]);
  });
});

describe('restoreCard (rollback do drop)', () => {
  it('devolve o card ao índice original e reverte os totais', () => {
    const original = makeState({
      [QUEUE]: { ids: ['a', 'b', 'c'], total: 20 },
      [ANA]: { ids: [], total: 4 },
    });
    const card = original[QUEUE].cards[1]; // 'b', no índice 1
    const moved = moveCard(original, {
      conversationId: 'b',
      fromColumnId: QUEUE,
      toColumnId: ANA,
      markPending: true,
    });

    const restored = restoreCard(moved, {
      sourceColumnId: QUEUE,
      targetColumnId: ANA,
      cardIndex: 1,
      card,
    });

    expect(idsOf(restored, QUEUE)).toEqual(['a', 'b', 'c']);
    expect(idsOf(restored, ANA)).toEqual([]);
    expect(restored[QUEUE].total).toBe(20);
    expect(restored[ANA].total).toBe(4);
    expect(restored[QUEUE].cards[1].pending).toBe(false);
  });

  // A regressão de severidade alta: um evento de realtime intercalado
  // levou o card para uma terceira coluna. Restaurar às cegas criaria
  // uma segunda cópia e inflaria o total da origem.
  it('card já movido para outra coluna: no-op, sem duplicar', () => {
    const state = makeState({
      [QUEUE]: { ids: [], total: 10 },
      [ANA]: { ids: [], total: 3 },
      [BRUNO]: { ids: ['b'], total: 6 },
    });
    const next = restoreCard(state, {
      sourceColumnId: QUEUE,
      targetColumnId: ANA,
      cardIndex: 0,
      card: makeCard('b'),
    });
    expect(next).toBe(state);
    expect(idsOf(next, QUEUE)).toEqual([]);
    expect(idsOf(next, BRUNO)).toEqual(['b']);
  });

  it('card já presente na origem: no-op', () => {
    const state = makeState({
      [QUEUE]: { ids: ['b'] },
      [ANA]: { ids: ['b'] },
    });
    expect(
      restoreCard(state, {
        sourceColumnId: QUEUE,
        targetColumnId: ANA,
        cardIndex: 0,
        card: makeCard('b'),
      })
    ).toBe(state);
  });

  it('índice maior que a lista atual é clampado para o fim', () => {
    const state = makeState({ [QUEUE]: { ids: ['a'] }, [ANA]: { ids: ['b'] } });
    const next = restoreCard(state, {
      sourceColumnId: QUEUE,
      targetColumnId: ANA,
      cardIndex: 99,
      card: makeCard('b'),
    });
    expect(idsOf(next, QUEUE)).toEqual(['a', 'b']);
  });
});

describe('settleCard', () => {
  it('limpa pending e grava o dono quando patchAssignment', () => {
    const state = makeState({ [ANA]: { ids: ['c1'] } });
    state[ANA].cards[0] = { ...state[ANA].cards[0], pending: true };

    const next = settleCard(state, {
      conversationId: 'c1',
      columnId: ANA,
      assignedAgentId: ANA,
      patchAssignment: true,
    });

    expect(next[ANA].cards[0].pending).toBe(false);
    expect(next[ANA].cards[0].conversation.assigned_agent_id).toBe(ANA);
  });

  // O card mudou de coluna durante o voo: o realtime é mais recente que
  // a nossa resposta, então só o `pending` sai.
  it('sem patchAssignment preserva o dono atual do card', () => {
    const state = makeState({ [BRUNO]: { ids: ['c1'] } });
    state[BRUNO].cards[0] = {
      ...state[BRUNO].cards[0],
      pending: true,
      conversation: makeConversation('c1', { assigned_agent_id: BRUNO }),
    };

    const next = settleCard(state, {
      conversationId: 'c1',
      columnId: BRUNO,
      assignedAgentId: ANA,
      patchAssignment: false,
    });

    expect(next[BRUNO].cards[0].pending).toBe(false);
    expect(next[BRUNO].cards[0].conversation.assigned_agent_id).toBe(BRUNO);
  });

  it('card ausente da coluna é no-op', () => {
    const state = makeState({ [ANA]: { ids: ['c1'] } });
    expect(
      settleCard(state, {
        conversationId: 'outro',
        columnId: ANA,
        assignedAgentId: null,
        patchAssignment: true,
      })
    ).toBe(state);
  });

  it('clearCardPending é settleCard sem tocar no dono', () => {
    const state = makeState({ [ANA]: { ids: ['c1'] } });
    state[ANA].cards[0] = {
      ...state[ANA].cards[0],
      pending: true,
      conversation: makeConversation('c1', { assigned_agent_id: ANA }),
    };
    const next = clearCardPending(state, {
      conversationId: 'c1',
      columnId: ANA,
    });
    expect(next[ANA].cards[0].pending).toBe(false);
    expect(next[ANA].cards[0].conversation.assigned_agent_id).toBe(ANA);
  });
});

describe('removeCard / insertCard', () => {
  it('remove decrementa o total', () => {
    const state = makeState({ [ANA]: { ids: ['c1', 'c2'], total: 9 } });
    const next = removeCard(state, { conversationId: 'c1', columnId: ANA });
    expect(idsOf(next, ANA)).toEqual(['c2']);
    expect(next[ANA].total).toBe(8);
  });

  it('remover card ausente é no-op — total intacto', () => {
    const state = makeState({ [ANA]: { ids: ['c1'], total: 9 } });
    expect(
      removeCard(state, { conversationId: 'fantasma', columnId: ANA })
    ).toBe(state);
  });

  it('insere no topo e incrementa o total', () => {
    const state = makeState({ [ANA]: { ids: ['c2'], total: 4 } });
    const next = insertCard(state, { card: makeCard('c1'), columnId: ANA });
    expect(idsOf(next, ANA)).toEqual(['c1', 'c2']);
    expect(next[ANA].total).toBe(5);
  });

  it('inserir card já presente é no-op — não duplica nem conta duas vezes', () => {
    const state = makeState({ [ANA]: { ids: ['c1'], total: 4 } });
    expect(insertCard(state, { card: makeCard('c1'), columnId: ANA })).toBe(
      state
    );
  });

  it('total nunca fica negativo', () => {
    const state = makeState({ [ANA]: { ids: ['c1'], total: 0 } });
    const next = removeCard(state, { conversationId: 'c1', columnId: ANA });
    expect(next[ANA].total).toBe(0);
  });
});

describe('appendCards (carregar mais)', () => {
  it('acrescenta ao fim, sem mexer no total', () => {
    const state = makeState({ [ANA]: { ids: ['c1'], total: 50 } });
    const next = appendCards(state, {
      columnId: ANA,
      cards: [makeCard('c2'), makeCard('c3')],
    });
    expect(idsOf(next, ANA)).toEqual(['c1', 'c2', 'c3']);
    expect(next[ANA].total).toBe(50);
  });

  // Um realtime pode ter inserido no topo um card que também vem nesta
  // página — sem o filtro ele apareceria duas vezes.
  it('deduplica contra os cards já presentes', () => {
    const state = makeState({ [ANA]: { ids: ['c1', 'c2'] } });
    const next = appendCards(state, {
      columnId: ANA,
      cards: [makeCard('c2'), makeCard('c3')],
    });
    expect(idsOf(next, ANA)).toEqual(['c1', 'c2', 'c3']);
  });

  it('página inteiramente duplicada é no-op', () => {
    const state = makeState({ [ANA]: { ids: ['c1'] } });
    expect(appendCards(state, { columnId: ANA, cards: [makeCard('c1')] })).toBe(
      state
    );
  });
});

describe('setColumnLoadingMore', () => {
  it('alterna a flag e é no-op quando já está no valor pedido', () => {
    const state = makeState({ [ANA]: { ids: [] } });
    const on = setColumnLoadingMore(state, {
      columnId: ANA,
      loadingMore: true,
    });
    expect(on[ANA].loadingMore).toBe(true);
    expect(setColumnLoadingMore(on, { columnId: ANA, loadingMore: true })).toBe(
      on
    );
  });
});

describe('applyColumnCounts', () => {
  it('aplica só os totais, sem tocar nos cards', () => {
    const state = makeState({
      [QUEUE]: { ids: ['c1'], total: 1 },
      [ANA]: { ids: ['c2'], total: 1 },
    });
    const next = applyColumnCounts(state, [
      { id: QUEUE, count: 137 },
      { id: ANA, count: 42 },
    ]);
    expect(next[QUEUE].total).toBe(137);
    expect(next[ANA].total).toBe(42);
    expect(idsOf(next, QUEUE)).toEqual(['c1']);
    expect(next[QUEUE].cards[0]).toBe(state[QUEUE].cards[0]);
  });

  it('count null (query daquela coluna falhou) preserva o total antigo', () => {
    const state = makeState({ [ANA]: { ids: [], total: 12 } });
    const next = applyColumnCounts(state, [{ id: ANA, count: null }]);
    expect(next).toBe(state);
    expect(next[ANA].total).toBe(12);
  });

  it('coluna desconhecida é ignorada', () => {
    const state = makeState({ [ANA]: { ids: [], total: 3 } });
    expect(applyColumnCounts(state, [{ id: 'sumiu', count: 9 }])).toBe(state);
  });

  it('contagens iguais às atuais devolvem a mesma referência', () => {
    const state = makeState({ [ANA]: { ids: [], total: 3 } });
    expect(applyColumnCounts(state, [{ id: ANA, count: 3 }])).toBe(state);
  });
});

describe('hydrateCards', () => {
  const notes = new Map([['contact-c1', 'Retornar na segunda']]);
  const deals = new Map<string, BoardDealRow[]>([
    [
      'contact-c1',
      [
        makeDeal({
          contact_id: 'contact-c1',
          stage: { id: 's1', name: 'Qualificação', color: '#3b82f6' },
        }),
      ],
    ],
  ]);

  it('preenche nota e deal dos contatos consultados', () => {
    const state = makeState({ [ANA]: { ids: ['c1'] } });
    const next = hydrateCards(state, ['contact-c1'], notes, deals);
    const card = next[ANA].cards[0];
    expect(card.hydrated).toBe(true);
    expect(card.latestNote).toBe('Retornar na segunda');
    expect(card.primaryDeal?.stageName).toBe('Qualificação');
  });

  it('contato consultado sem nota nem deal fica hidratado com nulls', () => {
    const state = makeState({ [ANA]: { ids: ['c9'] } });
    const next = hydrateCards(state, ['contact-c9'], new Map(), new Map());
    expect(next[ANA].cards[0].hydrated).toBe(true);
    expect(next[ANA].cards[0].latestNote).toBeNull();
    expect(next[ANA].cards[0].primaryDeal).toBeNull();
  });

  it('não revisita cards já hidratados', () => {
    const state = makeState({ [ANA]: { ids: ['c1'] } });
    const first = hydrateCards(state, ['contact-c1'], notes, deals);
    const second = hydrateCards(first, ['contact-c1'], new Map(), new Map());
    expect(second).toBe(first);
    expect(second[ANA].cards[0].latestNote).toBe('Retornar na segunda');
  });

  it('lote que não toca nenhum card devolve a mesma referência', () => {
    const state = makeState({ [ANA]: { ids: ['c1'] } });
    expect(hydrateCards(state, ['contact-outro'], notes, deals)).toBe(state);
  });
});
