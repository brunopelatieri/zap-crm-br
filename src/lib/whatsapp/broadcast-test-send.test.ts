import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createSupabaseMock,
  opArgs,
  type MockResult,
  type QueryOp,
} from '@/lib/audience/supabase-mock';

// O token está cifrado em repouso; o mesmo padrão de
// broadcast-dispatch.test.ts — o valor não importa aqui, só que nunca
// vaze cru para fora do módulo.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `plain:${v}`,
}));

const sendTemplateMessage = vi.fn();
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTemplateMessage: (...args: unknown[]) => sendTemplateMessage(...args),
}));

import { BroadcastError } from './broadcast-core';
import { MAX_TEST_SEND_RECIPIENTS, sendBroadcastTest } from './broadcast-test-send';

const ACCOUNT = 'acct-1';

const CONFIG = {
  phone_number_id: 'PNID-1',
  access_token: 'enc-token',
};

const TEMPLATE = {
  id: 'tmpl-1',
  user_id: 'user-1',
  name: 'promo',
  language: 'en_US',
  category: 'Marketing',
  body_text: 'Hi {{1}}, {{2}}% off today!',
};

const CONTACT_A = {
  id: 'c-a',
  account_id: ACCOUNT,
  name: 'Alice',
  phone: '+15550001111',
  opt_in_status: 'unknown',
};

const CONTACT_OPTED_OUT = {
  id: 'c-out',
  account_id: ACCOUNT,
  name: 'Bob',
  phone: '+15550002222',
  opt_in_status: 'opted_out',
};

const CONTACT_BAD_PHONE = {
  id: 'c-bad',
  account_id: ACCOUNT,
  name: 'Carol',
  phone: 'not-a-phone',
  opt_in_status: 'unknown',
};

const CONTACT_DEAD_NUMBER = {
  id: 'c-dead',
  account_id: ACCOUNT,
  name: 'Dave',
  phone: '+15550003333',
  opt_in_status: 'unknown',
  whatsapp_status: 'invalid',
};

interface Scenario {
  contacts: Record<string, unknown>[];
  template?: Record<string, unknown> | null;
  config?: Record<string, unknown> | null;
}

beforeEach(() => {
  sendTemplateMessage.mockReset();
});

function makeDb(scenario: Scenario) {
  const { contacts, template = TEMPLATE, config = CONFIG } = scenario;

  const handler = (table: string, ops: QueryOp[]): MockResult | undefined => {
    switch (table) {
      case 'whatsapp_config':
        return { data: config };
      case 'message_templates':
        return { data: template };
      case 'contacts': {
        const ids = opArgs(ops, 'in')?.[1] as string[] | undefined;
        return { data: contacts.filter((c) => ids?.includes(c.id as string)) };
      }
      case 'contact_custom_values':
        return { data: [] };
      default:
        return undefined;
    }
  };

  return createSupabaseMock(handler);
}

describe('sendBroadcastTest', () => {
  it('sends to a valid contact with resolved variables and no side tables written', async () => {
    sendTemplateMessage.mockResolvedValue({ messageId: 'wamid.1' });
    const { db, callsFor } = makeDb({ contacts: [CONTACT_A] });

    const results = await sendBroadcastTest(db, {
      accountId: ACCOUNT,
      input: {
        templateName: 'promo',
        templateLanguage: 'en_US',
        variables: {
          '1': { type: 'field', value: 'name' },
          '2': { type: 'static', value: '20' },
        },
        contactIds: ['c-a'],
      },
    });

    expect(results).toEqual([
      {
        contactId: 'c-a',
        name: 'Alice',
        phone: '+15550001111',
        status: 'sent',
        messageId: 'wamid.1',
      },
    ]);

    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
    const call = sendTemplateMessage.mock.calls[0][0];
    expect(call.to).toBe('15550001111');
    expect(call.accessToken).toBe('plain:enc-token');
    expect(call.messageParams.body).toEqual(['Alice', '20']);

    // Nenhuma escrita em broadcasts/broadcast_recipients — dry run não
    // cria campanha (§6.7: "sem criar linhas de broadcast_recipients").
    expect(callsFor('broadcasts')).toHaveLength(0);
    expect(callsFor('broadcast_recipients')).toHaveLength(0);
  });

  it('marks a missing contact as not_found without calling Meta', async () => {
    const { db } = makeDb({ contacts: [] });

    const results = await sendBroadcastTest(db, {
      accountId: ACCOUNT,
      input: {
        templateName: 'promo',
        templateLanguage: 'en_US',
        variables: {},
        contactIds: ['ghost'],
      },
    });

    expect(results).toEqual([
      { contactId: 'ghost', name: null, phone: '', status: 'not_found' },
    ]);
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('marks an unparseable phone as invalid_phone without calling Meta', async () => {
    const { db } = makeDb({ contacts: [CONTACT_BAD_PHONE] });

    const results = await sendBroadcastTest(db, {
      accountId: ACCOUNT,
      input: {
        templateName: 'promo',
        templateLanguage: 'en_US',
        variables: {},
        contactIds: ['c-bad'],
      },
    });

    expect(results[0].status).toBe('invalid_phone');
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('excludes an opted-out contact from a Marketing template test', async () => {
    const { db } = makeDb({ contacts: [CONTACT_OPTED_OUT] });

    const results = await sendBroadcastTest(db, {
      accountId: ACCOUNT,
      input: {
        templateName: 'promo',
        templateLanguage: 'en_US',
        variables: {},
        contactIds: ['c-out'],
      },
    });

    expect(results[0].status).toBe('opted_out');
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('excludes a dead-number contact regardless of template category (§6.4)', async () => {
    const { db } = makeDb({
      contacts: [CONTACT_DEAD_NUMBER],
      template: { ...TEMPLATE, category: 'Utility' },
    });

    const results = await sendBroadcastTest(db, {
      accountId: ACCOUNT,
      input: {
        templateName: 'promo',
        templateLanguage: 'en_US',
        variables: {},
        contactIds: ['c-dead'],
      },
    });

    expect(results[0].status).toBe('whatsapp_invalid');
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('still reaches an opted-out contact for a Utility template test', async () => {
    sendTemplateMessage.mockResolvedValue({ messageId: 'wamid.2' });
    const { db } = makeDb({
      contacts: [CONTACT_OPTED_OUT],
      template: { ...TEMPLATE, category: 'Utility' },
    });

    const results = await sendBroadcastTest(db, {
      accountId: ACCOUNT,
      input: {
        templateName: 'promo',
        templateLanguage: 'en_US',
        variables: {},
        contactIds: ['c-out'],
      },
    });

    expect(results[0].status).toBe('sent');
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
  });

  it('records a Meta API failure as failed with the error message', async () => {
    sendTemplateMessage.mockRejectedValue(new Error('Meta API error: 400'));
    const { db } = makeDb({ contacts: [CONTACT_A] });

    const results = await sendBroadcastTest(db, {
      accountId: ACCOUNT,
      input: {
        templateName: 'promo',
        templateLanguage: 'en_US',
        variables: {},
        contactIds: ['c-a'],
      },
    });

    expect(results[0]).toMatchObject({
      status: 'failed',
      error: 'Meta API error: 400',
    });
  });

  it('rejects more than MAX_TEST_SEND_RECIPIENTS contacts', async () => {
    const { db } = makeDb({ contacts: [] });
    const contactIds = Array.from(
      { length: MAX_TEST_SEND_RECIPIENTS + 1 },
      (_, i) => `c-${i}`
    );

    await expect(
      sendBroadcastTest(db, {
        accountId: ACCOUNT,
        input: {
          templateName: 'promo',
          templateLanguage: 'en_US',
          variables: {},
          contactIds,
        },
      })
    ).rejects.toThrow(BroadcastError);
  });

  it('throws whatsapp_not_configured when there is no config row', async () => {
    const { db } = makeDb({ contacts: [CONTACT_A], config: null });

    await expect(
      sendBroadcastTest(db, {
        accountId: ACCOUNT,
        input: {
          templateName: 'promo',
          templateLanguage: 'en_US',
          variables: {},
          contactIds: ['c-a'],
        },
      })
    ).rejects.toThrow(/not configured/);
  });

  it('throws template_not_found when the template row is missing', async () => {
    const { db } = makeDb({ contacts: [CONTACT_A], template: null });

    await expect(
      sendBroadcastTest(db, {
        accountId: ACCOUNT,
        input: {
          templateName: 'promo',
          templateLanguage: 'en_US',
          variables: {},
          contactIds: ['c-a'],
        },
      })
    ).rejects.toThrow(/Template not found/);
  });
});
