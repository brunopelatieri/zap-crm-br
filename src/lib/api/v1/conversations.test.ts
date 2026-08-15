import { describe, it, expect } from 'vitest';
import type { Conversation, Message } from '@/types';
import { serializeConversation, serializeMessage } from './conversations';

describe('serializeConversation', () => {
  it('projects public fields + nested contact/tags and drops internals', () => {
    const conv = {
      id: 'conv1',
      user_id: 'internal-user',
      account_id: 'internal-acct',
      contact_id: 'c1',
      status: 'open',
      last_message_text: 'hi',
      last_message_at: '2026-01-01T00:00:00Z',
      unread_count: 2,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      contact: {
        id: 'c1',
        phone: '+1',
        name: 'Jane',
        tags: [{ id: 't1', name: 'vip', color: '#fff' }],
      },
    } as unknown as Conversation;

    const out = serializeConversation(conv);
    expect(out).not.toHaveProperty('user_id');
    expect(out).not.toHaveProperty('account_id');
    expect(out.contact?.tags).toEqual([
      { id: 't1', name: 'vip', color: '#fff' },
    ]);
    expect(out.unread_count).toBe(2);
  });

  // SPEC 049 §5.4 — GET /api/v1/conversations exposes channel_id.
  it('includes channel_id, and null when the row has none', () => {
    const withChannel = {
      id: 'conv1',
      contact_id: 'c1',
      status: 'open',
      unread_count: 0,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      channel_id: 'chan-qr-1',
      contact: null,
    } as unknown as Conversation;
    expect(serializeConversation(withChannel).channel_id).toBe('chan-qr-1');

    const withoutChannel = {
      ...withChannel,
      channel_id: undefined,
    } as unknown as Conversation;
    expect(serializeConversation(withoutChannel).channel_id).toBeNull();
  });
});

describe('serializeMessage', () => {
  it('maps message_id → whatsapp_message_id and derives direction', () => {
    const inbound = {
      id: 'm1',
      conversation_id: 'conv1',
      sender_type: 'customer',
      content_type: 'text',
      content_text: 'hello',
      message_id: 'wamid.123',
      status: 'delivered',
      created_at: '2026-01-01T00:00:00Z',
    } as unknown as Message;
    const outMsg = serializeMessage(inbound);
    expect(outMsg.direction).toBe('inbound');
    expect(outMsg.whatsapp_message_id).toBe('wamid.123');
    expect(outMsg).not.toHaveProperty('message_id');

    const agent = { ...inbound, sender_type: 'agent' } as unknown as Message;
    expect(serializeMessage(agent).direction).toBe('outbound');
  });
});
