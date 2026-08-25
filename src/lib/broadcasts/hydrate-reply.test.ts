import { describe, expect, it } from 'vitest';

import { hydrateBroadcastReply } from './hydrate-reply';
import { createSupabaseMock, opArgs } from '../audience/supabase-mock';

const ACCOUNT = 'acct-1';
const CONVERSATION = 'conv-1';
const CONTACT = 'contact-1';
const BROADCAST = 'broadcast-1';
const RECIPIENT = 'recipient-1';

const SENT_AT = '2026-08-20T12:00:00.000Z';
const WAMID = 'wamid.XXXX';

function baseParams() {
  return {
    conversationId: CONVERSATION,
    accountId: ACCOUNT,
    contactId: CONTACT,
    broadcastId: BROADCAST,
    recipientId: RECIPIENT,
  };
}

describe('hydrateBroadcastReply', () => {
  it('insere o template com created_at = sent_at e broadcast_id setado', async () => {
    const inserted: Record<string, unknown>[] = [];

    const mock = createSupabaseMock((table, ops) => {
      if (table === 'broadcast_recipients') {
        return { data: { sent_at: SENT_AT, whatsapp_message_id: WAMID } };
      }
      if (table === 'messages') {
        const insertArgs = opArgs(ops, 'insert');
        if (insertArgs) {
          inserted.push(insertArgs[0] as Record<string, unknown>);
          return { data: null };
        }
        // Checagem de replay (R-8): nenhuma mensagem com este wamid ainda.
        return { data: null };
      }
      if (table === 'broadcasts') {
        return {
          data: {
            template_name: 'promo',
            template_language: 'pt_BR',
            template_variables: {},
          },
        };
      }
      if (table === 'contacts') {
        return {
          data: { id: CONTACT, name: 'Alice', phone: '+5511999990001' },
        };
      }
      if (table === 'message_templates') {
        return {
          data: {
            body_text: 'Olá {{1}}, promoção especial!',
            header_type: null,
            header_content: null,
            footer_text: 'Responda SAIR para descadastrar',
            buttons: null,
          },
        };
      }
      return undefined;
    });

    await hydrateBroadcastReply(mock.db, baseParams());

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      conversation_id: CONVERSATION,
      sender_type: 'agent',
      content_type: 'template',
      template_name: 'promo',
      message_id: WAMID,
      status: 'sent',
      created_at: SENT_AT,
      broadcast_id: BROADCAST,
    });
    expect((inserted[0].template_preview as { body: string }).body).toContain(
      'promoção especial'
    );
  });

  it('sem sent_at ainda não hidrata (R-11 — corrida com o fan-out)', async () => {
    const mock = createSupabaseMock((table) => {
      if (table === 'broadcast_recipients') {
        // Fan-out ainda não carimbou esta linha.
        return { data: { sent_at: null, whatsapp_message_id: null } };
      }
      return undefined;
    });

    await hydrateBroadcastReply(mock.db, baseParams());

    expect(mock.callsFor('messages')).toHaveLength(0);
  });

  it('não duplica a bolha em replay do webhook (R-8)', async () => {
    const mock = createSupabaseMock((table, ops) => {
      if (table === 'broadcast_recipients') {
        return { data: { sent_at: SENT_AT, whatsapp_message_id: WAMID } };
      }
      if (table === 'messages') {
        // Já existe uma mensagem com este message_id nesta conversa.
        if (!opArgs(ops, 'insert')) return { data: { id: 'msg-already' } };
        return { data: null };
      }
      return undefined;
    });

    await hydrateBroadcastReply(mock.db, baseParams());

    expect(mock.callsFor('messages').some((c) => opArgs(c.ops, 'insert'))).toBe(
      false
    );
  });

  it('sem a linha local do template, cai para texto simples — nunca bolha vazia (R-6)', async () => {
    const inserted: Record<string, unknown>[] = [];
    const mock = createSupabaseMock((table, ops) => {
      if (table === 'broadcast_recipients') {
        return { data: { sent_at: SENT_AT, whatsapp_message_id: WAMID } };
      }
      if (table === 'messages') {
        const insertArgs = opArgs(ops, 'insert');
        if (insertArgs) {
          inserted.push(insertArgs[0] as Record<string, unknown>);
          return { data: null };
        }
        return { data: null };
      }
      if (table === 'broadcasts') {
        return {
          data: {
            template_name: 'removido-da-meta',
            template_language: 'pt_BR',
            template_variables: {},
          },
        };
      }
      if (table === 'contacts') {
        return {
          data: { id: CONTACT, name: 'Alice', phone: '+5511999990001' },
        };
      }
      if (table === 'message_templates') {
        // Template não sincronizado localmente.
        return { data: null };
      }
      return undefined;
    });

    await hydrateBroadcastReply(mock.db, baseParams());

    expect(inserted).toHaveLength(1);
    expect(inserted[0].content_type).toBe('text');
    expect(inserted[0].template_preview).toBeNull();
    expect(inserted[0].content_text).toBe('removido-da-meta');
  });

  it('best-effort: um erro não propaga para quem chamou', async () => {
    const mock = createSupabaseMock(() => {
      throw new Error('boom');
    });

    await expect(
      hydrateBroadcastReply(mock.db, baseParams())
    ).resolves.toBeUndefined();
  });
});
