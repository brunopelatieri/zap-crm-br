import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const cloudSendTemplate = vi.fn(async () => ({ providerMessageId: 'wamid.1' }));
vi.mock('@/lib/channels/registry', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/channels/registry')>();
  return {
    ...actual,
    getAdapter: (type: string) =>
      type === 'whatsapp_cloud'
        ? {
            type: 'whatsapp_cloud',
            capabilities: {},
            sendText: vi.fn(),
            sendMedia: vi.fn(),
            sendTemplate: cloudSendTemplate,
            normalizeInbound: () => [],
          }
        : actual.getAdapter(type as never),
  };
});

import { encrypt } from '@/lib/whatsapp/encryption';
import { sendIngestTemplate, IngestSendError } from './send';

const APPROVED_TEMPLATE = {
  id: 'tpl-1',
  user_id: 'u1',
  account_id: 'acc-1',
  name: 'promo_july',
  language: 'en_US',
  category: 'Marketing',
  body_text: 'Hello {{1}}',
  status: 'APPROVED',
  created_at: '2026-01-01T00:00:00Z',
};

const CONFIG_ROW = {
  id: 'cfg-1',
  account_id: 'acc-1',
  user_id: 'u1',
  phone_number_id: '1234567890',
  access_token: encrypt('fake-access-token'),
  status: 'connected',
};

interface FakeDbOptions {
  channelRows?: { type: string }[] | null;
  config?: Record<string, unknown> | null;
  template?: Record<string, unknown> | null;
}

function fakeDb(opts: FakeDbOptions = {}): {
  db: SupabaseClient;
  calls: string[];
  recipientUpdates: Record<string, unknown>[];
} {
  const calls: string[] = [];
  const recipientUpdates: Record<string, unknown>[] = [];

  const client = {
    from: (table: string) => {
      calls.push(table);
      if (table === 'channels') {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: opts.channelRows ?? null }),
          }),
        };
      }
      if (table === 'whatsapp_config') {
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve(
                  opts.config
                    ? { data: opts.config, error: null }
                    : { data: null, error: { message: 'not found' } }
                ),
            }),
          }),
        };
      }
      if (table === 'message_templates') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({ data: opts.template ?? null, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === 'broadcast_recipients') {
        return {
          update: (patch: Record<string, unknown>) => ({
            eq: () => {
              recipientUpdates.push(patch);
              return Promise.resolve({ error: null });
            },
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };

  return { db: client as unknown as SupabaseClient, calls, recipientUpdates };
}

beforeEach(() => {
  cloudSendTemplate.mockClear();
  cloudSendTemplate.mockImplementation(async () => ({
    providerMessageId: 'wamid.1',
  }));
});

describe('sendIngestTemplate — channel capability (SPEC 049 §5.3)', () => {
  it('QR-only account: throws channel_not_capable, never queries whatsapp_config/message_templates', async () => {
    const { db, calls } = fakeDb({ channelRows: [{ type: 'whatsapp_qr' }] });

    await expect(
      sendIngestTemplate(db, {
        accountId: 'acc-1',
        phone: '5519992496598',
        templateId: 'tpl-1',
        templateParams: [],
        recipientRowId: 'rec-1',
      })
    ).rejects.toMatchObject({ code: 'channel_not_capable' });

    expect(calls).toEqual(['channels']);
    expect(cloudSendTemplate).not.toHaveBeenCalled();
  });
});

describe('sendIngestTemplate — template lookup', () => {
  it('throws template_not_found when the id does not exist in this account', async () => {
    const { db } = fakeDb({ channelRows: [], template: null });

    await expect(
      sendIngestTemplate(db, {
        accountId: 'acc-1',
        phone: '5519992496598',
        templateId: 'missing',
        templateParams: [],
        recipientRowId: 'rec-1',
      })
    ).rejects.toBeInstanceOf(IngestSendError);
    await expect(
      sendIngestTemplate(db, {
        accountId: 'acc-1',
        phone: '5519992496598',
        templateId: 'missing',
        templateParams: [],
        recipientRowId: 'rec-1',
      })
    ).rejects.toMatchObject({ code: 'template_not_found' });
  });

  it('throws template_not_approved for a PENDING template', async () => {
    const { db } = fakeDb({
      channelRows: [],
      template: { ...APPROVED_TEMPLATE, status: 'PENDING' },
    });

    await expect(
      sendIngestTemplate(db, {
        accountId: 'acc-1',
        phone: '5519992496598',
        templateId: 'tpl-1',
        templateParams: [],
        recipientRowId: 'rec-1',
      })
    ).rejects.toMatchObject({
      code: 'template_not_approved',
      status: 'PENDING',
    });
  });
});

describe('sendIngestTemplate — channel not configured', () => {
  it('throws channel_not_capable when whatsapp_config is missing despite capability', async () => {
    const { db } = fakeDb({
      channelRows: [],
      template: APPROVED_TEMPLATE,
      config: null,
    });

    await expect(
      sendIngestTemplate(db, {
        accountId: 'acc-1',
        phone: '5519992496598',
        templateId: 'tpl-1',
        templateParams: [],
        recipientRowId: 'rec-1',
      })
    ).rejects.toMatchObject({ code: 'channel_not_capable' });
  });
});

describe('sendIngestTemplate — send success/failure', () => {
  it('sends, stamps the recipient row as sent, and returns the provider message id', async () => {
    const { db, recipientUpdates } = fakeDb({
      channelRows: [],
      template: APPROVED_TEMPLATE,
      config: CONFIG_ROW,
    });

    const result = await sendIngestTemplate(db, {
      accountId: 'acc-1',
      phone: '5519992496598',
      templateId: 'tpl-1',
      templateParams: ['Maria'],
      recipientRowId: 'rec-1',
    });

    expect(result).toEqual({ messageId: 'wamid.1' });
    expect(recipientUpdates).toEqual([
      expect.objectContaining({
        status: 'sent',
        whatsapp_message_id: 'wamid.1',
        error_message: null,
      }),
    ]);
  });

  it('a Meta failure marks the recipient row failed and throws send_failed', async () => {
    cloudSendTemplate.mockRejectedValueOnce(
      new Error('Meta API error: bad param')
    );
    const { db, recipientUpdates } = fakeDb({
      channelRows: [],
      template: APPROVED_TEMPLATE,
      config: CONFIG_ROW,
    });

    await expect(
      sendIngestTemplate(db, {
        accountId: 'acc-1',
        phone: '5519992496598',
        templateId: 'tpl-1',
        templateParams: [],
        recipientRowId: 'rec-1',
      })
    ).rejects.toMatchObject({ code: 'send_failed' });

    expect(recipientUpdates).toEqual([
      expect.objectContaining({
        status: 'failed',
        error_message: expect.stringContaining('Meta API error'),
      }),
    ]);
  });
});
