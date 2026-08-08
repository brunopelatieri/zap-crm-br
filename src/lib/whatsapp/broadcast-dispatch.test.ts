import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createSupabaseMock,
  opArgs,
  type MockResult,
  type QueryOp,
} from '@/lib/audience/supabase-mock';

// O token está cifrado em repouso; o planner decifra. Nos testes o
// valor não importa — só que ele nunca vaze para fora do servidor.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `plain:${v}`,
}));

import {
  MAX_DASHBOARD_RECIPIENTS,
  planAbTestBroadcast,
  planDashboardBroadcast,
  scheduleDashboardBroadcast,
} from './broadcast-dispatch';

const ACCOUNT = 'acct-1';
const USER = 'user-1';

const CONFIG = {
  phone_number_id: 'PNID-1',
  access_token: 'enc-token',
};

interface Scenario {
  /** Contatos devolvidos pela audiência `all`. */
  contacts: Record<string, unknown>[];
  template?: Record<string, unknown> | null;
  /** Teste A/B: uma linha de template por NOME, em vez de uma só. */
  templatesByName?: Record<string, Record<string, unknown> | null>;
  config?: Record<string, unknown> | null;
  /** Erro a devolver no insert de destinatários. */
  recipientInsertError?: { message: string } | null;
  /** Linhas de `broadcast_audience_staging` do caminho `staged`. */
  stagingRows?: Record<string, unknown>[];
}

const recipientUpdates: { ids: unknown; patch: Record<string, unknown> }[] = [];
const broadcastInserts: Record<string, unknown>[] = [];
const broadcastUpdates: Record<string, unknown>[] = [];
/** Os `.eq(...)` de cada UPDATE em `broadcasts`, na ordem em que saíram. */
const broadcastUpdateFilters: unknown[][][] = [];

/** Valor devolvido por `broadcasts.scheduled_at` no mock. */
const SCHEDULED_AT = '2026-08-10T12:00:00.000Z';

beforeEach(() => {
  recipientUpdates.length = 0;
  broadcastInserts.length = 0;
  broadcastUpdates.length = 0;
  broadcastUpdateFilters.length = 0;
});

function makeDb(scenario: Scenario) {
  const {
    contacts,
    template = null,
    templatesByName,
    config = CONFIG,
    recipientInsertError = null,
    stagingRows = [],
  } = scenario;

  // Um teste A/B insere DUAS linhas em `broadcasts`; devolver o mesmo id
  // para as duas esconderia justamente o erro que importa (os dois braços
  // gravando destinatários na mesma campanha).
  let insertedBroadcasts = 0;

  const handler = (table: string, ops: QueryOp[]): MockResult | undefined => {
    switch (table) {
      case 'whatsapp_config':
        return { data: config };

      case 'message_templates': {
        if (!templatesByName) return { data: template };
        const name =
          opArgs(ops, 'eq')?.[0] === 'account_id'
            ? (ops.filter((o) => o.fn === 'eq')[1]?.args[1] as string)
            : undefined;
        return { data: name ? (templatesByName[name] ?? null) : null };
      }

      case 'contacts': {
        // Hidratação por id (caminho `staged`): devolve os contatos do
        // cenário que casam com o `.in('id', …)`.
        const ids = opArgs(ops, 'in')?.[1] as string[] | undefined;
        if (ids) {
          return {
            data: contacts.filter((c) => ids.includes(c.id as string)),
          };
        }
        const range = opArgs(ops, 'range');
        if (!range) return { data: [] };
        return range[0] === 0 ? { data: contacts } : { data: [] };
      }

      case 'contact_custom_values':
        return { data: [] };

      case 'broadcasts': {
        const insertArgs = opArgs(ops, 'insert');
        if (insertArgs) {
          broadcastInserts.push(insertArgs[0] as Record<string, unknown>);
          insertedBroadcasts++;
          return {
            data: {
              id: `bc-${insertedBroadcasts}`,
              scheduled_at: SCHEDULED_AT,
            },
          };
        }
        const updateArgs = opArgs(ops, 'update');
        if (updateArgs) {
          broadcastUpdates.push(updateArgs[0] as Record<string, unknown>);
          broadcastUpdateFilters.push(
            ops.filter((o) => o.fn === 'eq').map((o) => o.args)
          );
          // Só um UPDATE que pede a linha de volta (`.select(...)`) é uma
          // ADOÇÃO; os outros (marcar como falho) descartam o retorno.
          if (ops.some((o) => o.fn === 'select')) {
            return { data: { id: 'bc-1', scheduled_at: SCHEDULED_AT } };
          }
        }
        return { data: null };
      }

      case 'broadcast_audience_staging': {
        // A leitura da triagem devolve as linhas do cenário; o DELETE de
        // limpeza pós-envio não devolve nada.
        if (opArgs(ops, 'delete')) return { data: null };
        return { data: opArgs(ops, 'range') ? stagingRows : [] };
      }

      case 'broadcast_recipients': {
        const insertArgs = opArgs(ops, 'insert');
        if (insertArgs) {
          if (recipientInsertError) {
            return { data: null, error: recipientInsertError };
          }
          const rows = insertArgs[0] as { contact_id: string }[];
          return {
            data: rows.map((r) => ({
              id: `row-${r.contact_id}`,
              contact_id: r.contact_id,
            })),
          };
        }
        const updateArgs = opArgs(ops, 'update');
        if (updateArgs) {
          recipientUpdates.push({
            ids: opArgs(ops, 'in')?.[1],
            patch: updateArgs[0] as Record<string, unknown>,
          });
        }
        return { data: null };
      }

      default:
        return undefined;
    }
  };

  return createSupabaseMock(handler);
}

function contact(
  id: string,
  phone: string,
  extra: Record<string, unknown> = {}
) {
  return { id, phone, account_id: ACCOUNT, user_id: USER, ...extra };
}

/** Linha mínima que passa pelo guard de `template-row-guard`. */
const TEMPLATE_ROW = {
  id: 't-1',
  user_id: USER,
  name: 'promo',
  body_text: 'Olá {{1}}',
};

const BASE_INPUT = {
  name: 'Promo',
  templateName: 'promo',
  templateLanguage: 'pt_BR',
  audience: { type: 'all' as const },
  variables: {},
};

describe('planDashboardBroadcast — cota', () => {
  it('recusa quando a audiência não cabe no que resta da janela de 24 h', async () => {
    // §4.5, item 4: os avisos do wizard são UX; um cliente adulterado
    // passa por cima deles. Este é o controle que protege o número.
    const mock = makeDb({
      contacts: [
        contact('c-1', '+5511999990001'),
        contact('c-2', '+5511999990002'),
        contact('c-3', '+5511999990003'),
      ],
    });

    await expect(
      planDashboardBroadcast(mock.db, {
        accountId: ACCOUNT,
        userId: USER,
        input: BASE_INPUT,
        quotaRemaining: 2,
      })
    ).rejects.toMatchObject({ code: 'quota_exceeded', status: 409 });

    // Nada foi persistido: a recusa acontece antes de criar linhas.
    expect(broadcastInserts).toHaveLength(0);
  });

  it('deixa passar quando o tier é ilimitado (remaining = Infinity)', async () => {
    const mock = makeDb({ contacts: [contact('c-1', '+5511999990001')] });

    const plan = await planDashboardBroadcast(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      input: BASE_INPUT,
      quotaRemaining: Number.POSITIVE_INFINITY,
    });

    expect(plan.planned).toHaveLength(1);
  });

  it('não conta telefones inválidos contra a cota', async () => {
    // Um número inválido nunca vira conversa na Meta, então bloquear um
    // disparo que caberia por causa dele seria cobrar por nada.
    const mock = makeDb({
      contacts: [
        contact('c-1', '+5511999990001'),
        contact('c-2', 'não é telefone'),
        contact('c-3', ''),
      ],
    });

    const plan = await planDashboardBroadcast(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      input: BASE_INPUT,
      quotaRemaining: 1,
    });

    expect(plan.planned).toHaveLength(1);
    expect(plan.rejected).toBe(2);
  });
});

describe('planDashboardBroadcast — persistência', () => {
  it('cria uma linha de destinatário para TODO contato e marca as inválidas', async () => {
    const mock = makeDb({
      contacts: [contact('c-1', '+5511999990001'), contact('c-2', 'lixo')],
    });

    const plan = await planDashboardBroadcast(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      input: BASE_INPUT,
      quotaRemaining: 100,
    });

    // `total_recipients` inclui as inválidas: elas aparecem na tela de
    // detalhe como `failed` com o motivo, em vez de sumirem.
    expect(plan.totalRecipients).toBe(2);
    expect(broadcastInserts[0]).toMatchObject({
      account_id: ACCOUNT,
      user_id: USER,
      status: 'sending',
      total_recipients: 2,
    });

    // Contadores por status são do trigger agregador (migrações
    // 003/005); semeá-los aqui seria sobrescrito na primeira mudança.
    expect(broadcastInserts[0]).not.toHaveProperty('sent_count');

    expect(recipientUpdates).toEqual([
      {
        ids: ['row-c-2'],
        patch: {
          status: 'failed',
          error_message: 'Invalid phone number format',
        },
      },
    ]);
    expect(plan.planned.map((p) => p.recipientRowId)).toEqual(['row-c-1']);
  });

  it('marca o disparo como falho e aborta se o insert de destinatários falhar', async () => {
    // Rodar com um conjunto incompleto é pior do que não rodar: os
    // webhooks de status não achariam as linhas faltantes e os
    // contadores agregados ficariam à deriva.
    const mock = makeDb({
      contacts: [contact('c-1', '+5511999990001')],
      recipientInsertError: { message: 'boom' },
    });

    await expect(
      planDashboardBroadcast(mock.db, {
        accountId: ACCOUNT,
        userId: USER,
        input: BASE_INPUT,
        quotaRemaining: 100,
      })
    ).rejects.toMatchObject({ code: 'internal' });

    expect(broadcastUpdates).toEqual([{ status: 'failed' }]);
  });

  it('resolve as variáveis por contato, na ordem numérica dos placeholders', async () => {
    const mock = makeDb({
      contacts: [contact('c-1', '+5511999990001', { name: 'Ana' })],
    });

    const plan = await planDashboardBroadcast(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      input: {
        ...BASE_INPUT,
        variables: {
          // Fora de ordem de propósito: {{2}} não pode virar o primeiro
          // parâmetro só por vir antes no objeto.
          '10': { type: 'static', value: 'dez' },
          '2': { type: 'static', value: 'Promo' },
          '1': { type: 'field', value: 'name' },
        },
      },
      quotaRemaining: 100,
    });

    expect(plan.planned[0].params).toEqual(['Ana', 'Promo', 'dez']);
  });
});

describe('planDashboardBroadcast — validações de entrada', () => {
  it('recusa quando o WhatsApp não está configurado', async () => {
    const mock = makeDb({ contacts: [], config: null });

    await expect(
      planDashboardBroadcast(mock.db, {
        accountId: ACCOUNT,
        userId: USER,
        input: BASE_INPUT,
        quotaRemaining: 100,
      })
    ).rejects.toMatchObject({ code: 'whatsapp_not_configured', status: 400 });
  });

  it('recusa uma audiência vazia', async () => {
    const mock = makeDb({ contacts: [] });

    await expect(
      planDashboardBroadcast(mock.db, {
        accountId: ACCOUNT,
        userId: USER,
        input: BASE_INPUT,
        quotaRemaining: 100,
      })
    ).rejects.toMatchObject({ code: 'empty_audience', status: 400 });
  });

  it('recusa uma audiência acima do teto absoluto', async () => {
    const contacts = Array.from(
      { length: MAX_DASHBOARD_RECIPIENTS + 1 },
      (_, i) => contact(`c-${i}`, `+55119999${String(i).padStart(5, '0')}`)
    );
    // A audiência vem inteira na primeira página deste mock — o teto é
    // testado, não a paginação (que tem teste próprio em resolve.test).
    const mock = makeDb({ contacts });

    await expect(
      planDashboardBroadcast(mock.db, {
        accountId: ACCOUNT,
        userId: USER,
        input: BASE_INPUT,
        quotaRemaining: Number.POSITIVE_INFINITY,
      })
    ).rejects.toMatchObject({ code: 'too_many_recipients', status: 400 });
  });

  it('recusa um template local malformado antes de criar qualquer linha', async () => {
    const mock = makeDb({
      contacts: [contact('c-1', '+5511999990001')],
      // `body_text` numérico: linha que existe, mas sem o campo que o
      // construtor de envio precisa — o guard de `template-row-guard`
      // existe para isso não virar um TypeError opaco no meio do laço.
      template: { id: 't-1', user_id: USER, name: 'promo', body_text: 42 },
    });

    await expect(
      planDashboardBroadcast(mock.db, {
        accountId: ACCOUNT,
        userId: USER,
        input: BASE_INPUT,
        quotaRemaining: 100,
      })
    ).rejects.toMatchObject({ code: 'template_malformed' });

    expect(broadcastInserts).toHaveLength(0);
  });
});

describe('planDashboardBroadcast — header de mídia', () => {
  it('injeta a URL escolhida no passo 3 como URL do template', async () => {
    // Entra como se fosse a URL guardada do template para que o
    // resolvedor do fan-out possa CACHEAR a assinatura; passá-la como
    // override por destinatário faria uma assinatura nova por pessoa.
    const mock = makeDb({
      contacts: [contact('c-1', '+5511999990001')],
      template: {
        ...TEMPLATE_ROW,
        header_type: 'image',
        header_media_url: 'https://exemplo.test/antiga.png',
      },
    });

    const plan = await planDashboardBroadcast(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      input: { ...BASE_INPUT, headerMediaUrl: 'https://exemplo.test/nova.png' },
      quotaRemaining: 100,
    });

    expect(plan.templateRow?.header_media_url).toBe(
      'https://exemplo.test/nova.png'
    );
  });

  it('ignora a URL quando o template não tem header de mídia', async () => {
    const mock = makeDb({
      contacts: [contact('c-1', '+5511999990001')],
      template: { ...TEMPLATE_ROW, header_type: 'text' },
    });

    const plan = await planDashboardBroadcast(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      input: { ...BASE_INPUT, headerMediaUrl: 'https://exemplo.test/nova.png' },
      quotaRemaining: 100,
    });

    expect(plan.templateRow?.header_media_url).toBeUndefined();
  });
});

// ============================================================
// Fase 7 — LGPD (§6.8) e agendamento (§6.3)
// ============================================================

describe('planDashboardBroadcast — opt-out (§6.8)', () => {
  it('remove os opted_out da audiência de um template de marketing', async () => {
    const mock = makeDb({
      contacts: [
        contact('c-1', '+5511999990001'),
        contact('c-2', '+5511999990002', { opt_in_status: 'opted_out' }),
        contact('c-3', '+5511999990003', { opt_in_status: 'opted_in' }),
      ],
      template: { ...TEMPLATE_ROW, category: 'Marketing' },
    });

    const plan = await planDashboardBroadcast(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      input: BASE_INPUT,
      quotaRemaining: 100,
    });

    expect(plan.excludedOptedOut).toBe(1);
    expect(plan.totalRecipients).toBe(2);
    // `sanitizePhoneForMeta` deixa só dígitos — é o formato que a Meta
    // aceita no campo `to`.
    expect(plan.planned.map((p) => p.phone)).toEqual([
      '5511999990001',
      '5511999990003',
    ]);
  });

  it('NÃO cria linha de destinatário para quem pediu para sair', async () => {
    // A diferença com telefone inválido: aquele vira `failed` visível,
    // este simplesmente não existe no disparo — guardar a tentativa
    // registraria um envio para quem pediu para não receber.
    const mock = makeDb({
      contacts: [
        contact('c-1', '+5511999990001'),
        contact('c-2', '+5511999990002', { opt_in_status: 'opted_out' }),
      ],
      template: { ...TEMPLATE_ROW, category: 'Marketing' },
    });

    await planDashboardBroadcast(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      input: BASE_INPUT,
      quotaRemaining: 100,
    });

    const inserted = mock
      .callsFor('broadcast_recipients')
      .flatMap(
        (c) => (opArgs(c.ops, 'insert')?.[0] as { contact_id: string }[]) ?? []
      )
      .map((r) => r.contact_id);
    expect(inserted).toEqual(['c-1']);
  });

  it('opt-out não consome cota', async () => {
    // Dois contatos, um em opt-out, cota de 1: tem que passar. Se o
    // filtro rodasse DEPOIS da cota, o disparo seria recusado por causa
    // de alguém que nem vai receber.
    const mock = makeDb({
      contacts: [
        contact('c-1', '+5511999990001'),
        contact('c-2', '+5511999990002', { opt_in_status: 'opted_out' }),
      ],
      template: { ...TEMPLATE_ROW, category: 'Marketing' },
    });

    const plan = await planDashboardBroadcast(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      input: BASE_INPUT,
      quotaRemaining: 1,
    });

    expect(plan.planned).toHaveLength(1);
  });

  it('template Utility alcança quem optou por sair de marketing', async () => {
    const mock = makeDb({
      contacts: [
        contact('c-1', '+5511999990001'),
        contact('c-2', '+5511999990002', { opt_in_status: 'opted_out' }),
      ],
      template: { ...TEMPLATE_ROW, category: 'Utility' },
    });

    const plan = await planDashboardBroadcast(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      input: BASE_INPUT,
      quotaRemaining: 100,
    });

    expect(plan.excludedOptedOut).toBe(0);
    expect(plan.planned).toHaveLength(2);
  });

  it('sem linha de template local, aplica a regra conservadora', async () => {
    // Categoria desconhecida → trata como marketing. A dúvida sobre
    // "posso mandar propaganda para quem pediu para sair?" só tem uma
    // resposta segura.
    const mock = makeDb({
      contacts: [
        contact('c-1', '+5511999990001'),
        contact('c-2', '+5511999990002', { opt_in_status: 'opted_out' }),
      ],
      template: null,
    });

    const plan = await planDashboardBroadcast(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      input: BASE_INPUT,
      quotaRemaining: 100,
    });

    expect(plan.excludedOptedOut).toBe(1);
  });

  it('audiência inteira em opt-out tem código próprio', async () => {
    const mock = makeDb({
      contacts: [
        contact('c-1', '+5511999990001', { opt_in_status: 'opted_out' }),
      ],
      template: { ...TEMPLATE_ROW, category: 'Marketing' },
    });

    await expect(
      planDashboardBroadcast(mock.db, {
        accountId: ACCOUNT,
        userId: USER,
        input: BASE_INPUT,
        quotaRemaining: 100,
      })
    ).rejects.toMatchObject({ code: 'all_opted_out' });

    expect(broadcastInserts).toHaveLength(0);
  });
});

describe('planDashboardBroadcast — número morto (§6.4)', () => {
  it('remove os whatsapp_status=invalid da audiência', async () => {
    const mock = makeDb({
      contacts: [
        contact('c-1', '+5511999990001'),
        contact('c-2', '+5511999990002', { whatsapp_status: 'invalid' }),
        contact('c-3', '+5511999990003'),
      ],
      template: { ...TEMPLATE_ROW, category: 'Marketing' },
    });

    const plan = await planDashboardBroadcast(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      input: BASE_INPUT,
      quotaRemaining: 100,
    });

    expect(plan.excludedInvalidWhatsapp).toBe(1);
    expect(plan.totalRecipients).toBe(2);
    expect(plan.planned.map((p) => p.phone)).toEqual([
      '5511999990001',
      '5511999990003',
    ]);
  });

  it('vale para QUALQUER categoria de template, ao contrário do opt-out', async () => {
    // Diferença deliberada com o opt-out (§6.8): um número morto nunca
    // vale a pena tentar de novo, mesmo para um template Utility.
    const mock = makeDb({
      contacts: [
        contact('c-1', '+5511999990001'),
        contact('c-2', '+5511999990002', { whatsapp_status: 'invalid' }),
      ],
      template: { ...TEMPLATE_ROW, category: 'Utility' },
    });

    const plan = await planDashboardBroadcast(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      input: BASE_INPUT,
      quotaRemaining: 100,
    });

    expect(plan.excludedInvalidWhatsapp).toBe(1);
    expect(plan.planned).toHaveLength(1);
  });

  it('NÃO cria linha de destinatário para número morto', async () => {
    const mock = makeDb({
      contacts: [
        contact('c-1', '+5511999990001'),
        contact('c-2', '+5511999990002', { whatsapp_status: 'invalid' }),
      ],
      template: { ...TEMPLATE_ROW, category: 'Marketing' },
    });

    await planDashboardBroadcast(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      input: BASE_INPUT,
      quotaRemaining: 100,
    });

    const inserted = mock
      .callsFor('broadcast_recipients')
      .flatMap(
        (c) => (opArgs(c.ops, 'insert')?.[0] as { contact_id: string }[]) ?? []
      )
      .map((r) => r.contact_id);
    expect(inserted).toEqual(['c-1']);
  });

  it('número morto não consome cota', async () => {
    const mock = makeDb({
      contacts: [
        contact('c-1', '+5511999990001'),
        contact('c-2', '+5511999990002', { whatsapp_status: 'invalid' }),
      ],
      template: { ...TEMPLATE_ROW, category: 'Marketing' },
    });

    const plan = await planDashboardBroadcast(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      input: BASE_INPUT,
      quotaRemaining: 1,
    });

    expect(plan.planned).toHaveLength(1);
  });

  it('audiência inteira com número morto tem código próprio', async () => {
    const mock = makeDb({
      contacts: [
        contact('c-1', '+5511999990001', { whatsapp_status: 'invalid' }),
      ],
      template: { ...TEMPLATE_ROW, category: 'Marketing' },
    });

    await expect(
      planDashboardBroadcast(mock.db, {
        accountId: ACCOUNT,
        userId: USER,
        input: BASE_INPUT,
        quotaRemaining: 100,
      })
    ).rejects.toMatchObject({ code: 'all_whatsapp_invalid' });

    expect(broadcastInserts).toHaveLength(0);
  });

  it('opt-out e número morto se somam sem contar o mesmo contato duas vezes', async () => {
    const mock = makeDb({
      contacts: [
        contact('c-1', '+5511999990001'),
        contact('c-2', '+5511999990002', { opt_in_status: 'opted_out' }),
        contact('c-3', '+5511999990003', { whatsapp_status: 'invalid' }),
      ],
      template: { ...TEMPLATE_ROW, category: 'Marketing' },
    });

    const plan = await planDashboardBroadcast(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      input: BASE_INPUT,
      quotaRemaining: 100,
    });

    expect(plan.excludedOptedOut).toBe(1);
    expect(plan.excludedInvalidWhatsapp).toBe(1);
    expect(plan.planned).toHaveLength(1);
  });
});

describe('planDashboardBroadcast — adoção pelo cron (§6.3)', () => {
  it('atualiza a linha existente em vez de inserir outra', async () => {
    const mock = makeDb({
      contacts: [contact('c-1', '+5511999990001')],
      template: TEMPLATE_ROW,
    });

    const plan = await planDashboardBroadcast(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      input: BASE_INPUT,
      quotaRemaining: 100,
      adoptBroadcastId: 'bc-1',
    });

    expect(plan.broadcastId).toBe('bc-1');
    expect(broadcastInserts).toHaveLength(0);
    expect(broadcastUpdates[0]).toMatchObject({ status: 'sending' });
  });

  it('não exige status draft ao adotar — o claim do cron já travou', async () => {
    // Repetir `status = 'draft'` aqui faria o UPDATE não casar linha
    // nenhuma (o cron já pôs em `sending`) e o disparo agendado
    // "desapareceria" com um draft_not_found.
    const mock = makeDb({
      contacts: [contact('c-1', '+5511999990001')],
      template: TEMPLATE_ROW,
    });

    await planDashboardBroadcast(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      input: BASE_INPUT,
      quotaRemaining: 100,
      adoptBroadcastId: 'bc-1',
    });

    const filters = broadcastUpdateFilters[0].map((args) => args[0]);
    expect(filters).toContain('id');
    expect(filters).not.toContain('status');
  });

  it('o ramo staged continua exigindo status draft', async () => {
    const mock = makeDb({
      contacts: [contact('c-1', '+5511999990001')],
      template: TEMPLATE_ROW,
      stagingRows: [
        { phone: '+5511999990001', name: null, existing_contact_id: 'c-1' },
      ],
    });

    await planDashboardBroadcast(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      input: {
        ...BASE_INPUT,
        audience: { type: 'staged' as const, draftId: 'bc-1' },
      },
      quotaRemaining: 100,
    });

    const filters = broadcastUpdateFilters[0].map((args) => args[0]);
    expect(filters).toContain('status');
  });
});

describe('scheduleDashboardBroadcast (§6.3)', () => {
  const AT = new Date('2026-08-10T12:00:00.000Z');

  it('grava a INTENÇÃO: status scheduled, sem destinatário nem cota', async () => {
    // Resolver a audiência agora congelaria a lista — quem entrar na
    // etiqueta amanhã ficaria de fora e quem pedir opt-out hoje à noite
    // receberia de manhã. Quem resolve é o cron, na hora do envio.
    const mock = makeDb({
      contacts: [contact('c-1', '+5511999990001')],
      template: TEMPLATE_ROW,
    });

    const result = await scheduleDashboardBroadcast(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      input: BASE_INPUT,
      scheduledAt: AT,
      timeZone: 'America/Sao_Paulo',
      windowOverride: false,
    });

    expect(result.broadcastId).toBe('bc-1');
    expect(broadcastInserts[0]).toMatchObject({
      status: 'scheduled',
      scheduled_at: AT.toISOString(),
      scheduled_timezone: 'America/Sao_Paulo',
      window_override: false,
    });
    expect(mock.callsFor('broadcast_recipients')).toHaveLength(0);
  });

  it('persiste a URL de mídia do header', async () => {
    // Sem esta coluna (048) um agendamento com header de imagem perderia
    // a mídia escolhida no passo 3 entre o agendamento e o envio.
    const mock = makeDb({
      contacts: [contact('c-1', '+5511999990001')],
      template: TEMPLATE_ROW,
    });

    await scheduleDashboardBroadcast(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      input: { ...BASE_INPUT, headerMediaUrl: 'https://exemplo.test/x.png' },
      scheduledAt: AT,
      timeZone: 'America/Sao_Paulo',
      windowOverride: true,
    });

    expect(broadcastInserts[0]).toMatchObject({
      header_media_url: 'https://exemplo.test/x.png',
      window_override: true,
    });
  });

  it('guarda o filtro inteiro, inclusive as linhas importadas', async () => {
    const mock = makeDb({
      contacts: [contact('c-1', '+5511999990001')],
      template: TEMPLATE_ROW,
    });

    await scheduleDashboardBroadcast(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      input: {
        ...BASE_INPUT,
        audience: {
          type: 'csv' as const,
          csvContacts: [{ phone: '+5511999990002', name: 'Ana' }],
        },
      },
      scheduledAt: AT,
      timeZone: 'America/Sao_Paulo',
      windowOverride: false,
    });

    expect(broadcastInserts[0].audience_filter).toMatchObject({
      type: 'csv',
      csvContacts: [{ phone: '+5511999990002', name: 'Ana' }],
    });
  });

  it('falha AGORA se o template não existe', async () => {
    // Falhar no agendamento é infinitamente melhor do que falhar às 9h
    // de segunda, sem ninguém olhando.
    const mock = makeDb({
      contacts: [contact('c-1', '+5511999990001')],
      template: null,
    });

    await expect(
      scheduleDashboardBroadcast(mock.db, {
        accountId: ACCOUNT,
        userId: USER,
        input: BASE_INPUT,
        scheduledAt: AT,
        timeZone: 'America/Sao_Paulo',
        windowOverride: false,
      })
    ).rejects.toMatchObject({ code: 'template_not_found' });

    expect(broadcastInserts).toHaveLength(0);
  });

  it('falha AGORA se o WhatsApp não está configurado', async () => {
    const mock = makeDb({
      contacts: [contact('c-1', '+5511999990001')],
      template: TEMPLATE_ROW,
      config: null,
    });

    await expect(
      scheduleDashboardBroadcast(mock.db, {
        accountId: ACCOUNT,
        userId: USER,
        input: BASE_INPUT,
        scheduledAt: AT,
        timeZone: 'America/Sao_Paulo',
        windowOverride: false,
      })
    ).rejects.toMatchObject({ code: 'whatsapp_not_configured' });
  });

  it('audiência staged adota o rascunho e NÃO apaga as linhas staged', async () => {
    // São elas que o cron vai ler na hora do envio; apagá-las agora
    // deixaria o agendamento com audiência vazia.
    const mock = makeDb({
      contacts: [contact('c-1', '+5511999990001')],
      template: TEMPLATE_ROW,
    });

    const result = await scheduleDashboardBroadcast(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      input: {
        ...BASE_INPUT,
        audience: { type: 'staged' as const, draftId: 'bc-1' },
      },
      scheduledAt: AT,
      timeZone: 'America/Sao_Paulo',
      windowOverride: false,
    });

    expect(result.broadcastId).toBe('bc-1');
    expect(broadcastInserts).toHaveLength(0);
    expect(broadcastUpdates[0]).toMatchObject({ status: 'scheduled' });
    const stagingDeletes = mock
      .callsFor('broadcast_audience_staging')
      .filter((c) => opArgs(c.ops, 'delete'));
    expect(stagingDeletes).toHaveLength(0);
  });
});

// ============================================================
// Teste A/B (§6.6)
// ============================================================

const TEMPLATE_A = { ...TEMPLATE_ROW, name: 'promo-a', category: 'Marketing' };
const TEMPLATE_B = {
  ...TEMPLATE_ROW,
  id: 't-2',
  name: 'promo-b',
  category: 'Marketing',
};

const AB_TEMPLATES = { 'promo-a': TEMPLATE_A, 'promo-b': TEMPLATE_B };

const AB_INPUT = { ...BASE_INPUT, templateName: 'promo-a' };

const AB_VARIANT = {
  templateName: 'promo-b',
  templateLanguage: 'pt_BR',
  variables: {},
};

/** RNG fixo: o sorteio não pode fazer o teste piscar. */
const fixedRng = () => 0.42;

function abContacts(n: number) {
  return Array.from({ length: n }, (_, i) =>
    contact(`c-${i}`, `+55119999${String(i).padStart(5, '0')}`)
  );
}

describe('planAbTestBroadcast — divisão', () => {
  it('cria DOIS broadcasts, com a variante B apontando para a A', async () => {
    const mock = makeDb({
      contacts: abContacts(10),
      templatesByName: AB_TEMPLATES,
    });

    const ab = await planAbTestBroadcast(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      input: AB_INPUT,
      variant: AB_VARIANT,
      quotaRemaining: 100,
      rng: fixedRng,
    });

    expect(broadcastInserts).toHaveLength(2);
    expect(broadcastInserts[0]).toMatchObject({
      template_name: 'promo-a',
      variant_label: 'A',
      parent_broadcast_id: null,
      ab_split_percent: 50,
    });
    expect(broadcastInserts[1]).toMatchObject({
      template_name: 'promo-b',
      variant_label: 'B',
      parent_broadcast_id: 'bc-1',
    });
    expect(ab.variantA.broadcastId).toBe('bc-1');
    expect(ab.variantB.broadcastId).toBe('bc-2');
  });

  it('divide a audiência em braços exatos, sem repetir ninguém', async () => {
    const mock = makeDb({
      contacts: abContacts(10),
      templatesByName: AB_TEMPLATES,
    });

    const ab = await planAbTestBroadcast(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      input: AB_INPUT,
      variant: AB_VARIANT,
      quotaRemaining: 100,
      rng: fixedRng,
    });

    expect(ab.variantA.planned).toHaveLength(5);
    expect(ab.variantB.planned).toHaveLength(5);
    expect(ab.totalRecipients).toBe(10);

    const idsA = ab.variantA.planned.map((p) => p.contactId);
    const idsB = ab.variantB.planned.map((p) => p.contactId);
    expect(new Set([...idsA, ...idsB]).size).toBe(10);
  });

  it('respeita um percentual configurado', async () => {
    const mock = makeDb({
      contacts: abContacts(10),
      templatesByName: AB_TEMPLATES,
    });

    const ab = await planAbTestBroadcast(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      input: AB_INPUT,
      variant: AB_VARIANT,
      splitPercent: 80,
      quotaRemaining: 100,
      rng: fixedRng,
    });

    expect(ab.variantA.planned).toHaveLength(8);
    expect(ab.variantB.planned).toHaveLength(2);
    expect(ab.splitPercent).toBe(80);
  });

  it('cada braço grava destinatários no PRÓPRIO broadcast', async () => {
    // O erro que este teste existe para pegar: os dois braços apontando
    // para a mesma campanha fariam o funil de B somar dentro do de A.
    const mock = makeDb({
      contacts: abContacts(4),
      templatesByName: AB_TEMPLATES,
    });

    await planAbTestBroadcast(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      input: AB_INPUT,
      variant: AB_VARIANT,
      quotaRemaining: 100,
      rng: fixedRng,
    });

    const broadcastIds = new Set(
      mock
        .callsFor('broadcast_recipients')
        .flatMap(
          (c) =>
            (opArgs(c.ops, 'insert')?.[0] as { broadcast_id: string }[]) ?? []
        )
        .map((r) => r.broadcast_id)
    );
    expect([...broadcastIds].sort()).toEqual(['bc-1', 'bc-2']);
  });
});

describe('planAbTestBroadcast — recusas', () => {
  it('recusa dois braços com o mesmo template', async () => {
    const mock = makeDb({
      contacts: abContacts(10),
      templatesByName: AB_TEMPLATES,
    });

    await expect(
      planAbTestBroadcast(mock.db, {
        accountId: ACCOUNT,
        userId: USER,
        input: AB_INPUT,
        variant: { ...AB_VARIANT, templateName: 'promo-a' },
        quotaRemaining: 100,
      })
    ).rejects.toMatchObject({ code: 'ab_same_template' });

    expect(broadcastInserts).toHaveLength(0);
  });

  it('recusa categorias diferentes entre os braços', async () => {
    // Marketing exclui quem pediu opt-out e Utility não: o teste
    // compararia dois públicos, não dois textos.
    const mock = makeDb({
      contacts: abContacts(10),
      templatesByName: {
        'promo-a': TEMPLATE_A,
        'promo-b': { ...TEMPLATE_B, category: 'Utility' },
      },
    });

    await expect(
      planAbTestBroadcast(mock.db, {
        accountId: ACCOUNT,
        userId: USER,
        input: AB_INPUT,
        variant: AB_VARIANT,
        quotaRemaining: 100,
      })
    ).rejects.toMatchObject({ code: 'ab_category_mismatch' });

    expect(broadcastInserts).toHaveLength(0);
  });

  it('recusa audiência pequena demais para dois braços', async () => {
    const mock = makeDb({
      contacts: abContacts(1),
      templatesByName: AB_TEMPLATES,
    });

    await expect(
      planAbTestBroadcast(mock.db, {
        accountId: ACCOUNT,
        userId: USER,
        input: AB_INPUT,
        variant: AB_VARIANT,
        quotaRemaining: 100,
      })
    ).rejects.toMatchObject({ code: 'ab_audience_too_small' });

    expect(broadcastInserts).toHaveLength(0);
  });

  it('confere a cota sobre a SOMA dos dois braços', async () => {
    // Conferir por braço deixaria passar um teste que estoura a cota da
    // conta no total — os dois saem na mesma janela de 24 h.
    const mock = makeDb({
      contacts: abContacts(10),
      templatesByName: AB_TEMPLATES,
    });

    await expect(
      planAbTestBroadcast(mock.db, {
        accountId: ACCOUNT,
        userId: USER,
        input: AB_INPUT,
        variant: AB_VARIANT,
        quotaRemaining: 6,
      })
    ).rejects.toMatchObject({ code: 'quota_exceeded' });

    expect(broadcastInserts).toHaveLength(0);
  });

  it('aplica opt-out UMA vez, antes do sorteio', async () => {
    const mock = makeDb({
      contacts: [
        ...abContacts(4),
        contact('c-out', '+5511988887777', { opt_in_status: 'opted_out' }),
      ],
      templatesByName: AB_TEMPLATES,
    });

    const ab = await planAbTestBroadcast(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      input: AB_INPUT,
      variant: AB_VARIANT,
      quotaRemaining: 100,
      rng: fixedRng,
    });

    expect(ab.excludedOptedOut).toBe(1);
    expect(ab.totalRecipients).toBe(4);
    const all = [...ab.variantA.planned, ...ab.variantB.planned].map(
      (p) => p.contactId
    );
    expect(all).not.toContain('c-out');
  });
});

describe('scheduleDashboardBroadcast — teste A/B (§6.6)', () => {
  it('agenda as duas variantes, com a B em scheduled e ligada à A', async () => {
    const mock = makeDb({
      contacts: abContacts(10),
      templatesByName: AB_TEMPLATES,
    });

    const result = await scheduleDashboardBroadcast(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      input: AB_INPUT,
      scheduledAt: new Date(Date.now() + 3_600_000),
      timeZone: 'America/Sao_Paulo',
      windowOverride: false,
      variant: AB_VARIANT,
      splitPercent: 70,
    });

    expect(result.broadcastId).toBe('bc-1');
    expect(result.variantBroadcastId).toBe('bc-2');
    expect(broadcastInserts[0]).toMatchObject({
      status: 'scheduled',
      variant_label: 'A',
      ab_split_percent: 70,
    });
    expect(broadcastInserts[1]).toMatchObject({
      status: 'scheduled',
      variant_label: 'B',
      parent_broadcast_id: 'bc-1',
      template_name: 'promo-b',
    });
  });
});
