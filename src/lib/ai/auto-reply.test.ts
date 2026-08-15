import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AiConfig } from './types';

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
    /**
     * Resultado da checagem de elegibilidade do agente de handoff
     * (`profiles` filtrada por conta + papel). `null` = aquele uuid não
     * é mais membro elegível — o motor deve deixar a conversa na fila
     * em vez de escondê-la (SPEC 041, F-41-A).
     */
    eligibleProfile: null as { user_id: string } | null,
    /**
     * `resolveChannelTypeForConversation` (SPEC 049 §5.6) reads
     * `conversations.channel_id` then `channels.type`. `null` on either
     * degrades to `whatsapp_cloud` — the default in every test that
     * doesn't set these explicitly.
     */
    conversationChannelId: null as string | null,
    channelType: null as string | null,
  },
}));

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }));
vi.mock('./context', () => ({
  buildConversationContext: h.buildConversationContext,
}));
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }));
vi.mock('./generate', () => ({ generateReply: h.generateReply }));
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }));
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        };
        return chain;
      }
      if (table === 'profiles') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          maybeSingle: () =>
            Promise.resolve({ data: h.state.eligibleProfile, error: null }),
        };
        return chain;
      }
      if (table === 'channels') {
        // resolveChannelTypeForConversation: .select('type').eq('id',…)
        // .eq('account_id',…).maybeSingle()
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () =>
            Promise.resolve({
              data: h.state.channelType ? { type: h.state.channelType } : null,
              error: null,
            }),
        };
        return chain;
      }
      // conversations — two different call shapes hit this table:
      //   1) the eligibility read (`.select('assigned_agent_id, …')
      //      .eq('id',…).maybeSingle()`) — ONE `.eq()`.
      //   2) resolveChannelTypeForConversation's channel lookup
      //      (`.select('channel_id').eq('id',…).eq('account_id',…)
      //      .maybeSingle()`) — TWO chained `.eq()` calls.
      // Both resolve to the SAME terminal `.maybeSingle()`, so a single
      // chain object that supports repeated `.eq()` answers both; which
      // fields the caller asked for doesn't matter to this fake.
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () =>
          Promise.resolve({
            data: h.state.conv
              ? { ...h.state.conv, channel_id: h.state.conversationChannelId }
              : null,
            error: null,
          }),
      };
      return {
        ...chain,
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = payload;
          return { eq: () => Promise.resolve({ error: null }) };
        },
      };
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args });
      return Promise.resolve({ data: h.state.claim, error: null });
    },
  }),
}));

import { dispatchInboundToAiReply } from './auto-reply';

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
};

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  };
}

beforeEach(() => {
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  };
  h.state.autoResponders = [];
  h.state.claim = true;
  h.state.updatePayload = null;
  h.state.rpcCalls = [];
  // Por padrão o agente de handoff configurado É elegível — os testes
  // que exercitam o caminho inverso sobrescrevem isto.
  h.state.eligibleProfile = { user_id: 'agent-7' };
  h.state.conversationChannelId = null;
  h.state.channelType = null;
  h.loadAiConfig.mockResolvedValue(aiConfig());
  h.buildConversationContext.mockResolvedValue([
    { role: 'user', content: 'hi' },
  ]);
  h.retrieveKnowledge.mockResolvedValue([]);
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false });
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' });
});

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS);
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ]);
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' })
    );
  });

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.']);
    await dispatchInboundToAiReply(ARGS);
    expect(h.retrieveKnowledge).toHaveBeenCalled();
    const systemPrompt = h.generateReply.mock.calls[0][0]
      .systemPrompt as string;
    expect(systemPrompt).toContain('Returns accepted within 30 days.');
  });

  // SPEC 049 §5.6 — the prompt must not promise a UI the channel can't
  // render.
  describe('channel-aware prompt (SPEC 049 §5.6)', () => {
    it('QR conversation: system prompt tells the model to use numbered plain text', async () => {
      h.state.conversationChannelId = 'chan-qr-1';
      h.state.channelType = 'whatsapp_qr';

      await dispatchInboundToAiReply(ARGS);

      const systemPrompt = h.generateReply.mock.calls[0][0]
        .systemPrompt as string;
      expect(systemPrompt).toContain('cannot render buttons');
      expect(systemPrompt).toContain('numbered plain-text list');
    });

    it('Cloud conversation (or no channel resolved): prompt says nothing about the restriction', async () => {
      h.state.conversationChannelId = 'chan-cloud-1';
      h.state.channelType = 'whatsapp_cloud';

      await dispatchInboundToAiReply(ARGS);

      const systemPrompt = h.generateReply.mock.calls[0][0]
        .systemPrompt as string;
      expect(systemPrompt).not.toContain('cannot render buttons');
    });
  });

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }];
    await dispatchInboundToAiReply(ARGS);
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false;
    await dispatchInboundToAiReply(ARGS);
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1);
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null);
    await dispatchInboundToAiReply(ARGS);
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }));
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    };
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    };
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('skips when the per-conversation cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    };
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([]);
    await dispatchInboundToAiReply(ARGS);
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();
  });
});

describe('dispatchInboundToAiReply — handoff', () => {
  it('disables auto-reply, writes a summary, and does not send on handoff', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true });
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
    expect(h.state.rpcCalls).toHaveLength(0);
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
    });
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'AI agent handed off'
    );
    // No handoff target configured → conversation left unassigned.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id');
  });

  it('routes to the configured handoff agent on handoff', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }));
    h.generateReply.mockResolvedValue({ text: '', handoff: true });
    await dispatchInboundToAiReply(ARGS);
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    });
  });

  it('leaves the conversation in the queue when the handoff agent is no longer eligible', async () => {
    // SPEC 041, F-41-A. `handoffAgentId` é gravado uma vez na config da
    // IA e nunca revalidado. Se aquele agente saiu da conta (ou virou
    // `viewer`), atribuir a ele tiraria a conversa da fila sem dar dono
    // a ninguém que possa atendê-la — ela sumiria para a conta inteira,
    // justamente quando a IA desistiu e um humano precisa assumir.
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'ex-agent' }));
    h.state.eligibleProfile = null; // não é mais membro elegível
    h.generateReply.mockResolvedValue({ text: '', handoff: true });

    await dispatchInboundToAiReply(ARGS);

    // O handoff em si acontece — o que se perde é só a atribuição.
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
    });
    expect(h.state.updatePayload?.ai_handoff_summary).toBeTruthy();
    // E a conversa fica SEM dono, portanto visível na fila.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id');
  });
});
