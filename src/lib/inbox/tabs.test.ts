import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TAB,
  TAB_DEFINITIONS,
  TAB_IDS,
  conversationTabPredicate,
  isConversationTab,
  isTabId,
  matchesConversationTab,
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
  it('is true for chat and open, false for contacts', () => {
    expect(isConversationTab('chat')).toBe(true);
    expect(isConversationTab('open')).toBe(true);
    expect(isConversationTab('contacts')).toBe(false);
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
  it('chat matches only the caller\'s own assignment', () => {
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
