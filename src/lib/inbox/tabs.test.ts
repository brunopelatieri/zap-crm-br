import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TAB,
  TAB_DEFINITIONS,
  TAB_IDS,
  conversationTabPredicate,
  isConversationTab,
  isTabId,
  matchesConversationTab,
  resolveTab,
  visibleTabDefinitions,
} from './tabs';

describe('isTabId', () => {
  it('accepts every value in TAB_IDS', () => {
    for (const id of TAB_IDS) {
      expect(isTabId(id)).toBe(true);
    }
  });

  it('rejects garbage / case mismatch / non-strings', () => {
    expect(isTabId('Chat')).toBe(false);
    expect(isTabId('')).toBe(false);
    expect(isTabId(null)).toBe(false);
    expect(isTabId(undefined)).toBe(false);
    expect(isTabId(123)).toBe(false);
    expect(isTabId('archived')).toBe(false);
  });
});

describe('isConversationTab', () => {
  it('is true for chat and open, false for contacts and board', () => {
    expect(isConversationTab('chat')).toBe(true);
    expect(isConversationTab('open')).toBe(true);
    expect(isConversationTab('contacts')).toBe(false);
    expect(isConversationTab('board')).toBe(false);
  });
});

describe('DEFAULT_TAB', () => {
  it('is the unassigned queue, matching the pre-tabs default filter', () => {
    expect(DEFAULT_TAB).toBe('open');
  });
});

describe('TAB_DEFINITIONS', () => {
  it('has one entry per TAB_IDS, in the same order', () => {
    expect(TAB_DEFINITIONS.map((d) => d.id)).toEqual(TAB_IDS);
  });
});

describe('conversationTabPredicate', () => {
  it('chat: eq assigned_agent_id = userId', () => {
    expect(conversationTabPredicate('chat', 'user-1')).toEqual({
      column: 'assigned_agent_id',
      op: 'eq',
      value: 'user-1',
    });
  });

  it('open: is assigned_agent_id null', () => {
    expect(conversationTabPredicate('open', 'user-1')).toEqual({
      column: 'assigned_agent_id',
      op: 'is',
      value: null,
    });
  });
});

describe('matchesConversationTab', () => {
  it("chat matches only the caller's own assignment", () => {
    expect(matchesConversationTab('chat', 'user-1', 'user-1')).toBe(true);
    expect(matchesConversationTab('chat', 'user-2', 'user-1')).toBe(false);
    expect(matchesConversationTab('chat', null, 'user-1')).toBe(false);
    expect(matchesConversationTab('chat', undefined, 'user-1')).toBe(false);
  });

  it('open matches only unassigned conversations', () => {
    expect(matchesConversationTab('open', null, 'user-1')).toBe(true);
    expect(matchesConversationTab('open', undefined, 'user-1')).toBe(true);
    expect(matchesConversationTab('open', 'user-1', 'user-1')).toBe(false);
    expect(matchesConversationTab('open', 'user-2', 'user-1')).toBe(false);
  });

  it('chat and open are mutually exclusive for any assignment state', () => {
    // A conversation can never "belong" to both feeds at once — this is
    // the invariant inbox/page.tsx relies on when it decides which of
    // the two feeds to remove a conversation from during reconciliation.
    for (const assigned of [null, undefined, 'user-1', 'user-2']) {
      const chat = matchesConversationTab('chat', assigned, 'user-1');
      const open = matchesConversationTab('open', assigned, 'user-1');
      expect(chat && open).toBe(false);
    }
  });

  it('stays in sync with conversationTabPredicate for the eq case', () => {
    const predicate = conversationTabPredicate('chat', 'user-1');
    expect(predicate.op).toBe('eq');
    expect(matchesConversationTab('chat', predicate.value, 'user-1')).toBe(
      true
    );
  });

  it('stays in sync with conversationTabPredicate for the is-null case', () => {
    const predicate = conversationTabPredicate('open', 'user-1');
    expect(predicate.op).toBe('is');
    expect(matchesConversationTab('open', predicate.value, 'user-1')).toBe(
      true
    );
  });
});

describe('viewAs — "ver como" de outro alvo (SPEC 042, D7)', () => {
  // O predicado não distingue "eu" de "o agente que o admin está
  // observando" — os dois são só o segundo argumento. Estes testes
  // travam que um alvo QUALQUER (não a sessão) funciona igual.
  it('conversationTabPredicate aceita qualquer alvo, não só a sessão', () => {
    expect(conversationTabPredicate('chat', 'agent-observado')).toEqual({
      column: 'assigned_agent_id',
      op: 'eq',
      value: 'agent-observado',
    });
  });

  it('matchesConversationTab casa pelo alvo observado, não pela sessão', () => {
    expect(
      matchesConversationTab('chat', 'agent-observado', 'agent-observado')
    ).toBe(true);
    // A sessão de quem está observando NUNCA entra na comparação — só o
    // alvo importa. Um admin (user-admin) observando outro agente não
    // deve ver suas PRÓPRIAS conversas na aba Chat enquanto observa.
    expect(
      matchesConversationTab('chat', 'user-admin', 'agent-observado')
    ).toBe(false);
  });
});

describe('visibleTabDefinitions (SPEC 043)', () => {
  it('owner e admin veem as 4 abas, incluindo "board"', () => {
    expect(visibleTabDefinitions('owner').map((d) => d.id)).toEqual(TAB_IDS);
    expect(visibleTabDefinitions('admin').map((d) => d.id)).toEqual(TAB_IDS);
  });

  it('agent e viewer não veem "board"', () => {
    expect(visibleTabDefinitions('agent').map((d) => d.id)).toEqual([
      'chat',
      'open',
      'contacts',
    ]);
    expect(visibleTabDefinitions('viewer').map((d) => d.id)).toEqual([
      'chat',
      'open',
      'contacts',
    ]);
  });

  it('role null (sessão ainda não resolvida) degrada como o papel menos privilegiado', () => {
    expect(visibleTabDefinitions(null).map((d) => d.id)).toEqual([
      'chat',
      'open',
      'contacts',
    ]);
  });
});

describe('resolveTab (SPEC 043, §3.7)', () => {
  it('valor fora de TAB_IDS cai em DEFAULT_TAB, independente do papel', () => {
    expect(resolveTab('bogus', 'owner', false)).toBe(DEFAULT_TAB);
    expect(resolveTab(null, 'owner', false)).toBe(DEFAULT_TAB);
    expect(resolveTab('bogus', null, false)).toBe(DEFAULT_TAB);
  });

  it('devolve null enquanto o papel ainda carrega, mesmo para uma aba válida sem minRole', () => {
    expect(resolveTab('open', null, true)).toBeNull();
    expect(resolveTab('board', null, true)).toBeNull();
  });

  it('agent com ?tab=board degrada para DEFAULT_TAB', () => {
    expect(resolveTab('board', 'agent', false)).toBe(DEFAULT_TAB);
  });

  it('viewer com ?tab=board degrada para DEFAULT_TAB', () => {
    expect(resolveTab('board', 'viewer', false)).toBe(DEFAULT_TAB);
  });

  it('admin e owner com ?tab=board recebem "board"', () => {
    expect(resolveTab('board', 'admin', false)).toBe('board');
    expect(resolveTab('board', 'owner', false)).toBe('board');
  });

  it('abas sem minRole passam para qualquer papel resolvido', () => {
    expect(resolveTab('chat', 'viewer', false)).toBe('chat');
    expect(resolveTab('contacts', 'agent', false)).toBe('contacts');
  });
});
