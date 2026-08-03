import { describe, it, expect, beforeEach, vi } from 'vitest';

// Shared mock state for the service-role client. Lives in a hoisted block
// so the vi.mock factory below can close over it.
const h = vi.hoisted(() => ({
  state: {
    owned: null as { id: string } | null,
    ownedCustomField: null as { id: string } | null,
    // Resultado da checagem de elegibilidade do destino de uma
    // atribuição (`profiles` filtrada por conta + papel). `null` = o
    // uuid configurado não é membro elegível desta conta.
    eligibleProfile: null as { user_id: string } | null,
    /** Filtros de cada consulta a `profiles`, para assertar o gate de papel. */
    profileQueries: [] as [string, string, unknown][][],
    automations: [] as Record<string, unknown>[],
    steps: [] as Record<string, unknown>[],
    fromCalls: [] as string[],
    updateCalls: [] as {
      table: string;
      filters: [string, string, unknown][];
    }[],
    upsertCalls: [] as { table: string; payload: unknown }[],
  },
}));

vi.mock('./admin-client', () => {
  const { state } = h;

  function resolve(ops: {
    table: string;
    type: string;
    payload?: unknown;
    filters: [string, string, unknown][];
  }) {
    const { table, type } = ops;
    if (table === 'contacts') {
      if (type === 'update') {
        state.updateCalls.push({ table, filters: ops.filters });
        return { data: null, error: null };
      }
      // ownership guard / condition read
      return { data: state.owned, error: null };
    }
    if (table === 'profiles') {
      state.profileQueries.push(ops.filters);
      // Tanto o `.maybeSingle()` da checagem de elegibilidade quanto o
      // `.limit(1)` do round_robin passam por aqui. O primeiro espera um
      // objeto; o segundo, um array — o `type` não distingue, então
      // devolvemos o objeto e o round_robin lê `?.[0]` de um objeto
      // (undefined), que é justamente o caminho "no agent resolved".
      // Os testes de round_robin usam `roundRobinProfiles` abaixo.
      return { data: state.eligibleProfile, error: null };
    }
    if (table === 'conversations') {
      if (type === 'update') {
        state.updateCalls.push({ table, filters: ops.filters });
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    if (table === 'custom_fields') {
      // account-scoped ownership lookup for a custom field definition
      return { data: state.ownedCustomField, error: null };
    }
    if (table === 'contact_custom_values') {
      if (type === 'upsert') {
        state.upsertCalls.push({ table, payload: ops.payload });
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    if (table === 'automations')
      return { data: state.automations, error: null };
    if (table === 'automation_logs') {
      if (type === 'insert') return { data: { id: 'log1' }, error: null };
      if (type === 'update') return { data: null, error: null };
      return { data: { steps_executed: [], status: 'success' }, error: null };
    }
    if (table === 'automation_steps') return { data: state.steps, error: null };
    return { data: null, error: null };
  }

  function builder(table: string) {
    const ops = {
      table,
      type: 'select',
      payload: undefined as unknown,
      filters: [] as [string, string, unknown][],
    };
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => ((ops.type = 'insert'), (ops.payload = p), b),
      update: (p: unknown) => ((ops.type = 'update'), (ops.payload = p), b),
      delete: () => ((ops.type = 'delete'), b),
      upsert: (p: unknown) => ((ops.type = 'upsert'), (ops.payload = p), b),
      eq: (k: string, v: unknown) => (ops.filters.push(['eq', k, v]), b),
      in: (k: string, v: unknown) => (ops.filters.push(['in', k, v]), b),
      gte: () => b,
      is: () => b,
      order: () => b,
      limit: () => b,
      single: () => Promise.resolve(resolve(ops)),
      maybeSingle: () => Promise.resolve(resolve(ops)),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(resolve(ops)).then(onF, onR),
    };
    return b;
  }

  return {
    supabaseAdmin: () => ({
      from: (t: string) => {
        state.fromCalls.push(t);
        return builder(t);
      },
      rpc: () => Promise.resolve({ error: null }),
    }),
  };
});

vi.mock('./meta-send', () => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: 'm1' })),
  engineSendTemplate: vi.fn(async () => ({ whatsapp_message_id: 'm1' })),
  engineSendInteractive: vi.fn(async () => ({ whatsapp_message_id: 'm1' })),
}));

import { runAutomationsForTrigger, triggerMatches } from './engine';
import type { Automation } from '@/types';

const ACCOUNT = 'acct-1';

beforeEach(() => {
  h.state.owned = null;
  h.state.ownedCustomField = null;
  h.state.eligibleProfile = null;
  h.state.profileQueries = [];
  h.state.automations = [];
  h.state.steps = [];
  h.state.fromCalls = [];
  h.state.updateCalls = [];
  h.state.upsertCalls = [];
});

describe('runAutomationsForTrigger — tenant isolation', () => {
  it('refuses to dispatch when the contact is not in the account (GHSA-63cv-2c49-m5v3)', async () => {
    // Ownership lookup returns nothing — the contact belongs to another tenant.
    h.state.owned = null;
    // If the guard failed, this automation would run an update_contact_field step.
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'victim-contact-uuid',
      context: { message_text: 'manual trigger' },
    });

    // Bailed at the guard: never fetched automations, never wrote a contact.
    expect(h.state.fromCalls).toContain('contacts');
    expect(h.state.fromCalls).not.toContain('automations');
    expect(h.state.updateCalls).toHaveLength(0);
  });

  it('proceeds past the guard when the contact belongs to the account', async () => {
    h.state.owned = { id: 'c1' };
    h.state.automations = []; // no matching automations; just prove we got past the guard

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    expect(h.state.fromCalls).toContain('automations');
  });

  it("scopes the update_contact_field write to the automation's account", async () => {
    h.state.owned = { id: 'c1' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    expect(h.state.updateCalls).toHaveLength(1);
    const filters = h.state.updateCalls[0].filters;
    expect(filters).toContainEqual(['eq', 'id', 'c1']);
    expect(filters).toContainEqual(['eq', 'account_id', ACCOUNT]);
  });
});

describe('update_contact_field — custom fields', () => {
  it('upserts contact_custom_values when the field is account-owned', async () => {
    h.state.owned = { id: 'c1' };
    h.state.ownedCustomField = { id: 'cf1' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep('custom:cf1', 'Premium')];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    // No direct contacts column write for a custom field.
    expect(h.state.updateCalls).toHaveLength(0);
    expect(h.state.upsertCalls).toHaveLength(1);
    expect(h.state.upsertCalls[0].payload).toEqual({
      contact_id: 'c1',
      custom_field_id: 'cf1',
      value: 'Premium',
    });
  });

  it('interpolates {{ vars.* }} into the custom value', async () => {
    h.state.owned = { id: 'c1' };
    h.state.ownedCustomField = { id: 'cf1' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep('custom:cf1', '{{ vars.source }}')];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: { vars: { source: 'WhatsApp Ad' } },
    });

    expect(h.state.upsertCalls).toHaveLength(1);
    expect((h.state.upsertCalls[0].payload as { value: string }).value).toBe(
      'WhatsApp Ad'
    );
  });

  it('refuses to write a custom field from another account', async () => {
    h.state.owned = { id: 'c1' };
    h.state.ownedCustomField = null; // account-scoped lookup finds nothing
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep('custom:foreign-cf', 'x')];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    expect(h.state.upsertCalls).toHaveLength(0);
    expect(h.state.updateCalls).toHaveLength(0);
  });
});

describe('send_webhook — SSRF guard (GHSA-8jqh-598v-rfxc)', () => {
  it('refuses a private / link-local destination and never calls fetch', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    h.state.owned = { id: 'c1' };
    h.state.automations = [automationWithUpdateStep()];
    // Aimed at the cloud metadata endpoint — the classic SSRF target.
    h.state.steps = [webhookStep('http://169.254.169.254/latest/meta-data/')];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    // The automation matched and its steps were loaded (so we genuinely
    // reached the send_webhook case)...
    expect(h.state.fromCalls).toContain('automation_steps');
    // ...yet the guard blocked it before any outbound request left the box.
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

function webhookStep(url: string) {
  return {
    id: 's1',
    automation_id: 'a1',
    step_type: 'send_webhook',
    position: 0,
    parent_step_id: null,
    step_config: {
      url,
      headers: { 'Metadata-Flavor': 'Google' },
      body_template: '{}',
    },
  };
}

function automationWithUpdateStep() {
  return {
    id: 'a1',
    account_id: ACCOUNT,
    user_id: 'u1',
    trigger_type: 'new_message_received',
    trigger_config: {},
    is_active: true,
  };
}

function updateStep() {
  return {
    id: 's1',
    automation_id: 'a1',
    step_type: 'update_contact_field',
    position: 0,
    parent_step_id: null,
    step_config: { field: 'company', value: 'pwned-by-automation' },
  };
}

function customStep(field: string, value: string) {
  return {
    id: 's1',
    automation_id: 'a1',
    step_type: 'update_contact_field',
    position: 0,
    parent_step_id: null,
    step_config: { field, value },
  };
}

describe('triggerMatches — interactive_reply', () => {
  function automation(reply_ids: string[]): Automation {
    return {
      id: 'a1',
      account_id: ACCOUNT,
      user_id: 'u1',
      name: 'menu step',
      trigger_type: 'interactive_reply',
      trigger_config: { reply_ids },
      is_active: true,
      execution_count: 0,
      created_at: '',
      updated_at: '',
    };
  }

  it('matches when the tapped id is in reply_ids (exact)', () => {
    expect(
      triggerMatches(automation(['yes', 'no']), { interactive_reply_id: 'yes' })
    ).toBe(true);
  });

  it('does not match a different id', () => {
    expect(
      triggerMatches(automation(['yes']), { interactive_reply_id: 'maybe' })
    ).toBe(false);
  });

  it('does not match on a substring (exact only)', () => {
    expect(
      triggerMatches(automation(['yes']), {
        interactive_reply_id: 'yes_please',
      })
    ).toBe(false);
  });

  it('does not match when no reply id is present or config is empty', () => {
    expect(triggerMatches(automation(['yes']), {})).toBe(false);
    expect(
      triggerMatches(automation([]), { interactive_reply_id: 'yes' })
    ).toBe(false);
  });
});

// ============================================================
// assign_conversation — elegibilidade do destino (SPEC 041, F-41-A)
//
// O motor roda com SERVICE ROLE: a RLS não opina, e nenhuma das travas
// que a 039 criou (policy `conversations_update` com WITH CHECK, RPC
// `reassign_conversation`) se aplica. O `agent_id` vem de
// `step_config`, um JSON gravado quando a automação foi criada, e nada
// o revalida na hora de executar.
//
// Se um destino inválido passar, a conversa ganha dono e some da fila,
// mas o dono não é ninguém que a conta enxergue — ela fica INVISÍVEL
// PARA TODOS, sem erro nenhum. Estes testes travam o comportamento.
// ============================================================

function assignStep(config: Record<string, unknown>) {
  return {
    id: 's1',
    automation_id: 'a1',
    step_type: 'assign_conversation',
    position: 0,
    parent_step_id: null,
    step_config: config,
  };
}

/** Só as escritas em `conversations` — o resto do motor também usa updateCalls. */
function conversationUpdates() {
  return h.state.updateCalls.filter((c) => c.table === 'conversations');
}

describe('assign_conversation — eligibility of the target (F-41-A)', () => {
  it('assigns when the target is an eligible member of the account', async () => {
    h.state.owned = { id: 'c1' };
    h.state.eligibleProfile = { user_id: 'agent-1' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [assignStep({ mode: 'specific', agent_id: 'agent-1' })];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    const updates = conversationUpdates();
    expect(updates).toHaveLength(1);
    // A escrita continua escopada à conta e ao contato.
    expect(updates[0].filters).toContainEqual(['eq', 'account_id', ACCOUNT]);
    expect(updates[0].filters).toContainEqual(['eq', 'contact_id', 'c1']);
  });

  it('refuses an agent_id from another account and leaves the conversation untouched', async () => {
    // Cenário 3 da SPEC: a FK da 039 aponta para `auth.users`, não para
    // `profiles`, então um uuid de outro inquilino passa pelo banco.
    h.state.owned = { id: 'c1' };
    h.state.eligibleProfile = null; // não é membro desta conta
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [
      assignStep({ mode: 'specific', agent_id: 'agent-de-outra-conta' }),
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    // Chegou ao passo e consultou a elegibilidade com os três filtros
    // que importam: o uuid pedido, a conta da automação e o papel.
    const check = h.state.profileQueries.at(-1)!;
    expect(check).toContainEqual(['eq', 'user_id', 'agent-de-outra-conta']);
    expect(check).toContainEqual(['eq', 'account_id', ACCOUNT]);
    expect(check).toContainEqual([
      'in',
      'account_role',
      ['owner', 'admin', 'agent'],
    ]);
    // …e não escreveu nada.
    expect(conversationUpdates()).toHaveLength(0);
  });

  it('refuses a viewer as the target', async () => {
    // Cenário 2: um `viewer` não pode responder nem devolver a conversa
    // à fila. Atribuir a ele a tira da fila e a trava. O filtro de papel
    // vive na query (`.in('account_role', …)`), então um viewer não
    // aparece no resultado — mesmo caminho do teste acima.
    h.state.owned = { id: 'c1' };
    h.state.eligibleProfile = null;
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [assignStep({ mode: 'specific', agent_id: 'viewer-1' })];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    expect(conversationUpdates()).toHaveLength(0);
  });

  it('filters the round_robin candidate query by assignable role', async () => {
    // O `limit(1)` sem filtro de papel podia sortear um `viewer`.
    h.state.owned = { id: 'c1' };
    h.state.eligibleProfile = null;
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [assignStep({ mode: 'round_robin' })];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    // A consulta de candidatos precisa carregar o filtro de papel. Sem
    // ele, o sorteio pega `profiles` de qualquer papel e pode cair num
    // `viewer` — que é exatamente o bug.
    const candidateQuery = h.state.profileQueries[0];
    expect(candidateQuery).toContainEqual([
      'in',
      'account_role',
      ['owner', 'admin', 'agent'],
    ]);
    expect(candidateQuery).toContainEqual(['eq', 'account_id', ACCOUNT]);

    // E, sem candidato elegível, não há atribuição — nunca um fallback
    // para "qualquer membro".
    expect(conversationUpdates()).toHaveLength(0);
  });

  it('does nothing when no agent is configured at all', async () => {
    h.state.owned = { id: 'c1' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [assignStep({ mode: 'specific' })];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    expect(conversationUpdates()).toHaveLength(0);
  });
});
