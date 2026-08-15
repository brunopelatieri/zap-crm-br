import type {
  Automation,
  AutomationLogStepResult,
  AutomationStep,
  AutomationTriggerType,
  ConditionStepConfig,
  KeywordMatchTriggerConfig,
  InteractiveReplyTriggerConfig,
  SendMessageStepConfig,
  SendButtonsStepConfig,
  SendListStepConfig,
  SendTemplateStepConfig,
  SendWebhookStepConfig,
  TagStepConfig,
  UpdateContactFieldStepConfig,
  WaitStepConfig,
  CreateDealStepConfig,
  AssignConversationStepConfig,
  WindowGuardConfig,
} from '@/types';
import { resolveWindowRoute, type FallbackChannel } from './window-fallback';
import { supabaseAdmin } from './admin-client';
import {
  engineSendText,
  engineSendTemplate,
  engineSendInteractive,
} from './meta-send';
import { validateInteractivePayload } from '@/lib/whatsapp/interactive';
import { resolveSessionWindow } from '@/lib/channels/session-window';
import { sendAndPersistOutbound } from '@/lib/channels/send';
import { ColdSendLimitError } from '@/lib/channels/cold-send-wiring';
import type { ChannelType } from '@/lib/channels/types';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';
import { ASSIGNABLE_ACCOUNT_ROLES } from '@/lib/auth/roles';
import { isAssignableMember } from '@/lib/inbox/assignment';
import { excludesOptedOut, isOptedOut } from '@/lib/contacts/consent';

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

export interface AutomationContext {
  /** Raw message text, for keyword_match + message_content conditions. */
  message_text?: string;
  /** Conversation the event belongs to, if any. */
  conversation_id?: string;
  /** Arbitrary variables accumulated during execution. */
  vars?: Record<string, unknown>;
  /** The tag id that was added, for tag_added trigger. */
  tag_id?: string;
  /** Agent the conversation was assigned to, for conversation_assigned. */
  agent_id?: string;
  /** Button / list-row id the customer tapped, for interactive_reply. */
  interactive_reply_id?: string;
}

export interface DispatchInput {
  /** Account-level tenancy key. Drives the lookup of which active
   *  automations to fire — `automations.account_id` is the tenant
   *  isolation after migration 017. Replaces the previous `userId`
   *  field; the per-automation user_id is read off each row when
   *  needed (sender identity for outbound messages, log audit). */
  accountId: string;
  triggerType: AutomationTriggerType;
  contactId?: string | null;
  context?: AutomationContext;
}

/**
 * Fire all active automations matching the given trigger for an
 * account.
 *
 * Must never throw — callers use fire-and-forget from the webhook.
 * All errors are caught and logged; per-automation failures are
 * recorded into automation_logs with status='failed'.
 */
export async function runAutomationsForTrigger(
  input: DispatchInput
): Promise<void> {
  try {
    const db = supabaseAdmin();

    // Tenant isolation. `contactId` can be caller-supplied (the manual
    // POST /api/automations/engine entrypoint reads it straight from the
    // request body), and every step below runs through the service-role
    // client, which bypasses RLS. So before any step can touch the
    // contact, verify it actually belongs to this account. A foreign or
    // forged id is refused silently — callers are fire-and-forget, and a
    // distinct error would leak whether a given contact UUID exists.
    if (input.contactId) {
      const { data: owned, error: ownErr } = await db
        .from('contacts')
        .select('id')
        .eq('id', input.contactId)
        .eq('account_id', input.accountId)
        .maybeSingle();
      if (ownErr) {
        console.error('[automations] contact ownership check failed:', ownErr);
        return;
      }
      if (!owned) {
        console.warn(
          '[automations] contact not in account, refusing dispatch',
          input.contactId
        );
        return;
      }
    }

    const { data: automations, error } = await db
      .from('automations')
      .select('*')
      .eq('account_id', input.accountId)
      .eq('trigger_type', input.triggerType)
      .eq('is_active', true);

    if (error) {
      console.error('[automations] fetch failed:', error);
      return;
    }
    if (!automations || automations.length === 0) return;

    for (const automation of automations as Automation[]) {
      if (!triggerMatches(automation, input.context)) continue;
      try {
        await executeAutomation(automation, input);
      } catch (err) {
        console.error('[automations] execute failed:', automation.id, err);
      }
    }
  } catch (err) {
    console.error('[automations] dispatch failed:', err);
  }
}

/**
 * Execute ONE already-resolved automation. Exists for the session-window
 * scan (SPEC 045 §5.5.3), which enumerates the automations itself and
 * claims per (automation × conversation × window anchor).
 *
 * ⚠️ Do NOT "simplify" this back into `runAutomationsForTrigger`. That
 * function fetches and runs EVERY active automation of the trigger in
 * the account — the right contract for a webhook event, and the wrong
 * one for the scan. With two automations of this trigger in an account,
 * a per-automation claim loop calling it would run both on each claim:
 * 4 executions for 2 intended, 2 duplicate messages to the customer,
 * and a claims table showing exactly 2 rows — i.e. an audit trail that
 * says everything is fine. The regression is invisible in the claims
 * table, invisible in EXPLAIN, and only shows up in an account that has
 * a second automation.
 *
 * Tenancy is the CALLER's responsibility — there's no ownership check
 * here because the scan's contact and conversation both come out of a
 * query already scoped by `account_id`. Any other caller must provide
 * the same guarantee.
 *
 * Unlike `runAutomationsForTrigger`, this THROWS on failure: the caller
 * records the outcome on the claim row (`sent_at` / `failed_at`, §5.5.5)
 * and has nothing to record if failures are swallowed here.
 */
export async function runSingleAutomation(
  automation: Automation,
  input: DispatchInput
): Promise<void> {
  // Falls through to the final `return true` for this trigger today,
  // but calling it keeps the new path equivalent to the old one if the
  // trigger ever grows a filterable trigger_config.
  if (!triggerMatches(automation, input.context)) return;
  await executeAutomation(automation, input);
}

/**
 * Resume a run that was parked at a wait step. Called from the cron
 * endpoint after it grabs a due `automation_pending_executions` row.
 */
export async function resumePendingExecution(pending: {
  id: string;
  automation_id: string;
  /** Audit-only; the automation row carries account_id for tenancy. */
  user_id: string;
  /** Account-scoped lookups read from the automation row, so this
   *  field is just here to mirror the row shape and keep the cron's
   *  pass-through self-documenting. */
  account_id: string;
  contact_id: string | null;
  log_id: string | null;
  parent_step_id: string | null;
  branch: 'yes' | 'no' | null;
  next_step_position: number;
  context: AutomationContext;
}): Promise<void> {
  const db = supabaseAdmin();
  const { data: automation, error } = await db
    .from('automations')
    .select('*')
    .eq('id', pending.automation_id)
    .single();

  if (error || !automation) {
    console.error(
      '[automations] resume: missing automation',
      pending.automation_id,
      error
    );
    await markPending(pending.id, 'failed');
    return;
  }

  try {
    await executeStepsFrom({
      automation: automation as Automation,
      contactId: pending.contact_id,
      context: pending.context ?? {},
      parentStepId: pending.parent_step_id,
      branch: pending.branch,
      startPosition: pending.next_step_position,
      logId: pending.log_id,
      triggerEvent: 'resumed_wait',
    });
    await markPending(pending.id, 'done');
  } catch (err) {
    console.error('[automations] resume failed:', err);
    await markPending(pending.id, 'failed');
  }
}

// ------------------------------------------------------------
// Internal execution
// ------------------------------------------------------------

async function executeAutomation(automation: Automation, input: DispatchInput) {
  const db = supabaseAdmin();

  const { data: log, error: logErr } = await db
    .from('automation_logs')
    .insert({
      automation_id: automation.id,
      // Tenancy: matches automation.account_id (NOT NULL post-017).
      account_id: automation.account_id,
      // Audit: keeps the historical "author of this automation"
      // pointer so logs still attribute to the right user even
      // after teammates join the account.
      user_id: automation.user_id,
      contact_id: input.contactId ?? null,
      trigger_event: input.triggerType,
      steps_executed: [],
      status: 'success',
    })
    .select()
    .single();

  if (logErr || !log) {
    console.error('[automations] cannot create log:', logErr);
    return;
  }

  await executeStepsFrom({
    automation,
    contactId: input.contactId ?? null,
    context: input.context ?? {},
    parentStepId: null,
    branch: null,
    startPosition: 0,
    logId: log.id,
    triggerEvent: input.triggerType,
  });

  // Atomic counter update via the SQL function from migration 007.
  // Doing this with a client-side read-modify-write raced when the
  // same automation fired for two contacts simultaneously — both
  // would read N and both write N+1, losing one count permanently.
  const { error: rpcErr } = await db.rpc(
    'increment_automation_execution_count',
    {
      p_automation_id: automation.id,
    }
  );
  if (rpcErr) {
    console.error('[automations] increment counter failed:', rpcErr);
  }
}

interface ExecuteArgs {
  automation: Automation;
  contactId: string | null;
  context: AutomationContext;
  parentStepId: string | null;
  branch: 'yes' | 'no' | null;
  startPosition: number;
  logId: string | null;
  triggerEvent: string;
}

async function executeStepsFrom(args: ExecuteArgs): Promise<void> {
  const db = supabaseAdmin();

  const baseQuery = db
    .from('automation_steps')
    .select('*')
    .eq('automation_id', args.automation.id)
    .gte('position', args.startPosition)
    .order('position', { ascending: true });

  const scoped =
    args.parentStepId === null
      ? baseQuery.is('parent_step_id', null)
      : baseQuery
          .eq('parent_step_id', args.parentStepId)
          .eq('branch', args.branch ?? 'yes');

  const { data: steps, error: stepsErr } = await scoped;

  if (stepsErr) {
    await finalizeLog(args.logId, 'failed', stepsErr.message);
    return;
  }
  if (!steps || steps.length === 0) {
    if (args.parentStepId === null && args.logId) {
      await finalizeLog(args.logId, 'success', null);
    }
    return;
  }

  const results: AutomationLogStepResult[] = [];
  let status: 'success' | 'partial' | 'failed' = 'success';
  let errorMessage: string | null = null;

  for (const step of steps as AutomationStep[]) {
    // `wait` is the suspension point: enqueue and stop processing this
    // scope. The cron endpoint will pick it up later.
    if (step.step_type === 'wait') {
      const cfg = step.step_config as WaitStepConfig;
      const ms = waitMs(cfg);
      await db.from('automation_pending_executions').insert({
        automation_id: args.automation.id,
        // Tenancy: account_id required NOT NULL post-017.
        account_id: args.automation.account_id,
        user_id: args.automation.user_id,
        contact_id: args.contactId,
        log_id: args.logId,
        parent_step_id: args.parentStepId,
        branch: args.branch,
        next_step_position: step.position + 1,
        context: args.context,
        run_at: new Date(Date.now() + ms).toISOString(),
        status: 'pending',
      });
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail: `waiting ${cfg.amount} ${cfg.unit}`,
      });
      status = 'partial';
      await appendResults(args.logId, results, status, errorMessage);
      return;
    }

    try {
      if (step.step_type === 'condition') {
        const cfg = step.step_config as ConditionStepConfig;
        const taken = await evaluateCondition(cfg, args);
        results.push({
          step_id: step.id,
          step_type: 'condition',
          status: 'success',
          detail: `branch=${taken ? 'yes' : 'no'}`,
        });
        // Recurse into the chosen branch at position 0 (children use their
        // own ordering within the branch scope).
        await executeStepsFrom({
          ...args,
          parentStepId: step.id,
          branch: taken ? 'yes' : 'no',
          startPosition: 0,
          logId: args.logId,
        });
        continue;
      }

      const stepResult = await runStep(step, args);
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: stepResult.status,
        detail: stepResult.detail,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'failed',
        detail: msg,
      });
      status = 'failed';
      errorMessage = msg;
      break;
    }
  }

  if (args.parentStepId === null) {
    await appendResults(args.logId, results, status, errorMessage);
  } else {
    // Nested branch — just append results; parent scope decides final status.
    await appendResults(args.logId, results, null, errorMessage);
  }
}

interface StepResult {
  status: 'success' | 'skipped';
  detail: string;
}
function success(detail: string): StepResult {
  return { status: 'success', detail };
}
function skipped(detail: string): StepResult {
  return { status: 'skipped', detail };
}

async function runStep(
  step: AutomationStep,
  args: ExecuteArgs
): Promise<StepResult> {
  const db = supabaseAdmin();

  switch (step.step_type) {
    case 'send_message': {
      const cfg = step.step_config as SendMessageStepConfig;
      if (!args.contactId) throw new Error('send_message needs a contact');
      const text = interpolate(cfg.text, args);
      if (!text.trim()) throw new Error('send_message has empty text');
      const conversationId = await resolveConversationId(args);
      const guard = await checkWindowGuard(cfg, conversationId, args);
      if (guard.kind === 'skip') return skipped(guard.detail);
      if (guard.kind === 'fallback') {
        return success(
          await sendFallbackTemplate(guard.template, conversationId, args)
        );
      }
      if (guard.kind === 'fallback_channel') {
        return sendViaFallbackChannel(guard, text, conversationId, args);
      }
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: args.automation.account_id,
          userId: args.automation.user_id,
          conversationId,
          contactId: args.contactId,
          text,
        });
        return success(`sent via Meta (${whatsapp_message_id})`);
      } catch (err) {
        // Teto de envio frio estourado (SPEC 049 §6.2, D-1): cota é
        // ADIAMENTO, não defeito (PRD §10.3) — igual à recusa da janela
        // logo acima, e pelo mesmo motivo.
        if (err instanceof ColdSendLimitError) return skipped(err.message);
        throw err;
      }
    }

    case 'send_buttons':
    case 'send_list': {
      const payload = step.step_config as
        SendButtonsStepConfig | SendListStepConfig;
      if (!args.contactId) throw new Error(`${step.step_type} needs a contact`);
      // Validate against Meta's limits before the network call so a bad
      // payload surfaces as a clear failed-step detail rather than a raw
      // Meta 400 mid-conversation.
      const check = validateInteractivePayload(payload);
      if (!check.ok) throw new Error(check.error);
      const conversationId = await resolveConversationId(args);
      const guard = await checkWindowGuard(payload, conversationId, args);
      if (guard.kind === 'skip') return skipped(guard.detail);
      if (guard.kind === 'fallback') {
        return success(
          await sendFallbackTemplate(guard.template, conversationId, args)
        );
      }
      if (guard.kind === 'fallback_channel') {
        // `validate.ts` já barra esta combinação na ativação; isto cobre
        // um step_config escrito à mão direto no banco. Falhar é o certo:
        // entregar um menu sem as opções é pior que não entregar.
        throw new Error(
          `"fallback_channel" is not available for ${step.step_type} — a QR code instance cannot render buttons or lists`
        );
      }
      const { whatsapp_message_id } = await engineSendInteractive({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        payload,
      });
      return success(`interactive sent via Meta (${whatsapp_message_id})`);
    }

    case 'send_template': {
      const cfg = step.step_config as SendTemplateStepConfig;
      const conversationId = await resolveConversationId(args);
      return success(await sendTemplateStep(cfg, conversationId, args));
    }

    case 'add_tag': {
      // contact_tags has no account_id column; cross-tenant protection for
      // the attacker-supplied contactId comes from the ownership guard in
      // runAutomationsForTrigger.
      const cfg = step.step_config as TagStepConfig;
      if (!args.contactId || !cfg.tag_id)
        throw new Error('add_tag needs contact + tag_id');
      await db
        .from('contact_tags')
        .upsert(
          { contact_id: args.contactId, tag_id: cfg.tag_id },
          { onConflict: 'contact_id,tag_id', ignoreDuplicates: true }
        );
      return success(`tag ${cfg.tag_id} added`);
    }

    case 'remove_tag': {
      // See add_tag: tenant scoping relies on the runAutomationsForTrigger
      // ownership guard, since contact_tags carries no account_id.
      const cfg = step.step_config as TagStepConfig;
      if (!args.contactId || !cfg.tag_id)
        throw new Error('remove_tag needs contact + tag_id');
      await db
        .from('contact_tags')
        .delete()
        .eq('contact_id', args.contactId)
        .eq('tag_id', cfg.tag_id);
      return success(`tag ${cfg.tag_id} removed`);
    }

    case 'assign_conversation': {
      // ⚠️ Defense in depth (SPEC 041, F-41-A). `db` é o cliente de
      // service role: a RLS não opina, e nenhuma das travas que a 039
      // criou se aplica aqui — nem a policy `conversations_update` com
      // `WITH CHECK`, nem o RPC `reassign_conversation`.
      //
      // O `.eq('account_id', …)` do UPDATE protege a CONVERSA (não dá
      // para atribuir a de outro inquilino). Não protege o DESTINO:
      // `agent_id` vem de `step_config`, um JSON gravado quando a
      // automação foi criada, e nada o revalida na hora de executar.
      //
      // Sem a checagem abaixo, três cenários — todos plausíveis sem
      // má-fé — deixam a conversa INVISÍVEL PARA TODOS: ela ganha dono
      // (some da fila) mas o dono não é ninguém que a conta enxergue
      // (some da aba "Chat" de todo mundo). Nenhum erro é logado.
      //   1. agente desligado, mas ainda no `step_config`;
      //   2. `round_robin` sorteando um `viewer`, que não pode responder
      //      nem devolver a conversa à fila;
      //   3. uuid de outra conta — a FK da 039 aponta para `auth.users`,
      //      não para `profiles`, então ela passa.
      const cfg = step.step_config as AssignConversationStepConfig;
      if (!args.contactId)
        throw new Error('assign_conversation needs a contact');
      let agentId = cfg.agent_id;
      if (cfg.mode === 'round_robin') {
        // Pick any ELIGIBLE member of the account. The existing
        // implementation only ever returned the automation's author;
        // preserving that shape until a real round-robin algorithm
        // replaces it — mas o filtro de papel não é adiável, senão o
        // sorteio pode cair num `viewer` e travar a conversa.
        const { data: profiles } = await db
          .from('profiles')
          .select('user_id')
          .eq('account_id', args.automation.account_id)
          .in('account_role', ASSIGNABLE_ACCOUNT_ROLES)
          .limit(1);
        agentId = profiles?.[0]?.user_id;
      }
      if (!agentId) return success('no agent resolved');

      // O destino tem de ser membro DESTA conta com papel que possa
      // atender. Mesmo predicado que a 039 usa no backfill (seção 12),
      // compartilhado com os outros escritores de service role.
      const eligible = await isAssignableMember(
        db,
        args.automation.account_id,
        agentId
      );

      if (!eligible) {
        // Retorno de passo, não exceção: a automação continua e o log da
        // execução registra o motivo — mesmo tratamento que
        // `update_contact_field` dá a um custom field de outra conta.
        // Uma automação configurada com um agente que saiu da conta
        // passa a aparecer no log em vez de sumir com a conversa.
        return success(
          `agent ${agentId} is not an eligible member of this account`
        );
      }

      await db
        .from('conversations')
        .update({ assigned_agent_id: agentId })
        .eq('account_id', args.automation.account_id)
        .eq('contact_id', args.contactId);
      return success(`assigned to ${agentId}`);
    }

    case 'update_contact_field': {
      const cfg = step.step_config as UpdateContactFieldStepConfig;
      if (!args.contactId)
        throw new Error('update_contact_field needs a contact');
      // Resolve workflow variables ({{ vars.* }}, {{ message.text }}) so custom
      // values can be populated dynamically from the triggering context.
      const value = interpolate(cfg.value, args);

      // Custom fields are encoded as `custom:<custom_field_id>`; anything else
      // is a built-in contact column.
      if (cfg.field.startsWith('custom:')) {
        const customFieldId = cfg.field.slice('custom:'.length);
        if (!customFieldId) {
          return success(`field ${cfg.field} not writable from automations`);
        }
        // Defense in depth: the service-role client bypasses RLS, so confirm
        // the field definition belongs to this account before writing.
        const { data: field } = await db
          .from('custom_fields')
          .select('id')
          .eq('id', customFieldId)
          .eq('account_id', args.automation.account_id)
          .maybeSingle();
        if (!field) {
          return success(`field ${cfg.field} not writable from automations`);
        }
        // Upsert on the table's UNIQUE(contact_id, custom_field_id) so repeated
        // runs overwrite rather than duplicate. Tenancy is enforced above and,
        // for the contact side, by the entry-point ownership guard.
        await db.from('contact_custom_values').upsert(
          {
            contact_id: args.contactId,
            custom_field_id: customFieldId,
            value,
          },
          { onConflict: 'contact_id,custom_field_id' }
        );
        return success(`custom field updated`);
      }

      const allowed = new Set(['name', 'email', 'company']);
      if (!allowed.has(cfg.field)) {
        return success(`field ${cfg.field} not writable from automations`);
      }
      // Defense in depth: scope the service-role write to the account so
      // a future caller that skips the entry-point ownership guard still
      // cannot write across tenants.
      await db
        .from('contacts')
        .update({ [cfg.field]: value, updated_at: new Date().toISOString() })
        .eq('id', args.contactId)
        .eq('account_id', args.automation.account_id);
      return success(`${cfg.field} updated`);
    }

    case 'create_deal': {
      const cfg = step.step_config as CreateDealStepConfig;
      if (!cfg.pipeline_id || !cfg.stage_id)
        throw new Error('create_deal needs pipeline + stage');
      // Match the account's configured default currency rather than
      // the static `deals.currency` DB default — keeps automation-
      // created deals consistent with the one-currency-per-account
      // rule (issue #218). Fall back to USD if the row is somehow
      // missing the value (pre-021 forks).
      const { data: acct } = await db
        .from('accounts')
        .select('default_currency')
        .eq('id', args.automation.account_id)
        .maybeSingle();
      await db.from('deals').insert({
        // Tenancy + audit, same split as automation_logs above.
        account_id: args.automation.account_id,
        user_id: args.automation.user_id,
        pipeline_id: cfg.pipeline_id,
        stage_id: cfg.stage_id,
        contact_id: args.contactId,
        title: interpolate(cfg.title, args),
        value: cfg.value ?? 0,
        currency: acct?.default_currency ?? 'USD',
        status: 'open',
      });
      return success('deal created');
    }

    case 'send_webhook': {
      const cfg = step.step_config as SendWebhookStepConfig;
      if (!cfg.url) throw new Error('send_webhook needs url');
      // SSRF guard: the URL and headers are account-controlled and the
      // server makes the request, so refuse any destination that resolves
      // to a private / loopback / link-local / reserved address. Mirrors
      // the webhook_endpoints delivery path (see lib/webhooks/deliver.ts).
      if (!(await isDeliverableUrl(cfg.url))) {
        throw new Error('send_webhook: destination not allowed');
      }
      const body = cfg.body_template
        ? interpolate(cfg.body_template, args)
        : JSON.stringify(args.context);
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.headers ?? {}) },
        body,
        // Do NOT follow redirects — a public URL could 3xx-bounce to an
        // internal address, defeating the guard above. Bound the request
        // so a hung/slow internal host can't tie up the runner.
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`webhook returned ${res.status}`);
      return success(`webhook ${res.status}`);
    }

    case 'close_conversation': {
      if (!args.contactId)
        throw new Error('close_conversation needs a contact');
      await db
        .from('conversations')
        .update({ status: 'closed', updated_at: new Date().toISOString() })
        .eq('account_id', args.automation.account_id)
        .eq('contact_id', args.contactId);
      return success('conversation closed');
    }

    default:
      return success(`unknown step: ${step.step_type}`);
  }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/**
 * Pick the conversation a send-type step should use. Prefer the id the
 * webhook handed us (it's the one that just got the inbound message);
 * fall back to the contact's conversation for resumed/wait paths and
 * manual engine POSTs. Throws if none exists — send steps have
 * no meaningful target without a conversation.
 */
async function resolveConversationId(args: ExecuteArgs): Promise<string> {
  const fromCtx = args.context.conversation_id;
  if (fromCtx) return fromCtx;
  if (!args.contactId)
    throw new Error('cannot resolve conversation: no contact');
  const { data, error } = await supabaseAdmin()
    .from('conversations')
    .select('id')
    .eq('account_id', args.automation.account_id)
    .eq('contact_id', args.contactId)
    .maybeSingle();
  if (error) throw new Error(`conversation lookup failed: ${error.message}`);
  if (!data?.id) throw new Error('no conversation for contact');
  return data.id as string;
}

type WindowGuardOutcome =
  | { kind: 'send' }
  | { kind: 'skip'; detail: string }
  | { kind: 'fallback'; template: SendTemplateStepConfig }
  | { kind: 'fallback_channel'; channelId: string; channelName: string };

/**
 * The guard SPEC 045 §5.3 requires before any session-message send
 * (`send_message` / `send_buttons` / `send_list` — never
 * `send_template`, which is already the correct path outside the
 * window). Recomputes the window AT SEND TIME, not at the time a
 * `wait` step was enqueued — that's what fixes the
 * `follow_up_reminder` bug (§2.4): a `wait` can sit for a day, during
 * which the customer may have written again and moved the anchor.
 *
 * A DECISÃO em si vive em `window-fallback.ts` (módulo puro, testado
 * sem banco). Esta função só reúne os fatos e executa o veredito — o
 * que mantém as doze combinações de rota cobertas por teste unitário e
 * esta camada com uma responsabilidade só.
 */
async function checkWindowGuard(
  cfg: WindowGuardConfig,
  conversationId: string,
  args: ExecuteArgs
): Promise<WindowGuardOutcome> {
  const db = supabaseAdmin();
  const { data: conv } = await db
    .from('conversations')
    .select('last_customer_message_at')
    .eq('id', conversationId)
    .eq('account_id', args.automation.account_id)
    .maybeSingle();

  // PRD 047 §7.1.1: a janela é uma restrição da META. Num canal sem
  // essa regra, `resolveSessionWindow` devolve `applicable:false` e o
  // envio segue livre — sem isto, a âncora nula de uma conversa de
  // canal QRCode reprovaria TODO envio (o default de leitura é 'fail').
  //
  // `channelForConversation` devolve 'whatsapp_cloud' enquanto a 057 não
  // popular `conversations.channel_id` — comportamento idêntico ao de
  // hoje até lá.
  const { isOpen } = resolveSessionWindow(
    await channelForConversation(conversationId, args.automation.account_id),
    conv?.last_customer_message_at
      ? new Date(conv.last_customer_message_at)
      : null
  );

  const action = cfg.on_window_closed ?? 'fail';

  // As duas consultas abaixo custam caro e só importam para o desvio
  // por canal com a janela JÁ fechada — o caminho raro. Mantê-las atrás
  // desta condição preserva o custo atual do guard (uma query) para
  // todos os outros envios.
  const needsChannelFacts = !isOpen && action === 'fallback_channel';
  const [contactOptedOut, availableChannels] = needsChannelFacts
    ? await Promise.all([
        isContactOptedOut(args),
        loadFallbackChannels(args.automation.account_id),
      ])
    : [false, [] as FallbackChannel[]];

  const route = resolveWindowRoute({
    action: cfg.on_window_closed,
    // PRD 047 §7.1.1: enquanto só existe canal Cloud, toda conversa tem
    // janela. Na F1 isto passa a vir de
    // `capabilities(channel.type).sessionWindow24h` — é o único ponto
    // desta função que muda.
    windowApplicable: true,
    windowOpen: isOpen,
    fallbackTemplate: cfg.fallback_template,
    fallbackChannelId: cfg.fallback_channel_id,
    availableChannels,
    contactOptedOut,
  });

  switch (route.kind) {
    case 'send':
      return { kind: 'send' };
    case 'skip':
      return { kind: 'skip', detail: route.detail };
    case 'fallback_template':
      return { kind: 'fallback', template: route.template };
    case 'fallback_channel':
      return {
        kind: 'fallback_channel',
        channelId: route.channelId,
        channelName: route.channelName,
      };
    case 'fail':
      // Lançar (em vez de devolver) preserva o contrato que a SPEC 045
      // já tinha: o step vira `failed` com esta mensagem em
      // `automation_logs`, e a automação para. As mensagens de 'fail'
      // são as mesmas de antes, palavra por palavra.
      throw new Error(route.reason);
  }
}

/**
 * Tipo do canal de uma conversa (PRD 047 §7.1.1).
 *
 * Enquanto a migração 057 não popular `conversations.channel_id`, a
 * coluna não existe e a query erra — caímos em `'whatsapp_cloud'`, que
 * é a verdade de hoje: só existe canal oficial. Isso mantém o
 * comportamento atual byte a byte até a 057 rodar, e faz o roteamento
 * por canal ligar sozinho depois, sem mudança de código aqui.
 */
async function channelForConversation(
  conversationId: string,
  accountId: string
): Promise<ChannelType> {
  const { data, error } = await supabaseAdmin()
    .from('conversations')
    .select('channels(type)')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (error || !data) return 'whatsapp_cloud';

  const rel = (data as { channels?: { type?: string } | { type?: string }[] })
    .channels;
  const type = Array.isArray(rel) ? rel[0]?.type : rel?.type;

  return type === 'whatsapp_qr' ? 'whatsapp_qr' : 'whatsapp_cloud';
}

/**
 * Contato pediu para não receber contato automatizado?
 *
 * Sem contato resolvido, responde `false` — o passo falharia adiante por
 * outro motivo, e inventar um opt-out aqui esconderia a causa real.
 */
async function isContactOptedOut(args: ExecuteArgs): Promise<boolean> {
  if (!args.contactId) return false;
  const { data: contact } = await supabaseAdmin()
    .from('contacts')
    .select('opt_in_status')
    .eq('id', args.contactId)
    .eq('account_id', args.automation.account_id)
    .maybeSingle();
  return contact ? isOptedOut(contact) : false;
}

/**
 * Canais que a conta pode usar como desvio quando a janela fecha
 * (PRD 047 §10.2).
 *
 * Enquanto a migração 055 não roda, a tabela `channels` não existe e a
 * query erra — devolvemos lista vazia, e `resolveWindowRoute` recusa o
 * desvio com "not found", que é exatamente a verdade: não há canal
 * algum para desviar. Nenhum envio de hoje muda de comportamento.
 *
 * Assim que a 055 for aplicada, esta função passa a devolver dados sem
 * alteração de código. A derivação de `freeformOutsideWindow` a partir
 * do `type` migra para `capabilities()` na F1 — é o único ponto que
 * duplica a matriz, e de propósito: um import de `@/lib/channels` aqui
 * quebraria o build antes de a camada existir.
 */
async function loadFallbackChannels(
  accountId: string
): Promise<FallbackChannel[]> {
  const { data, error } = await supabaseAdmin()
    .from('channels')
    .select('id, name, type, status')
    .eq('account_id', accountId);

  if (error || !data) return [];

  return (
    data as { id: string; name: string; type: string; status: string }[]
  ).map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status as FallbackChannel['status'],
    freeformOutsideWindow: row.type === 'whatsapp_qr',
  }));
}

/**
 * `fallback_template` is the one send this guard introduces that's
 * paid AND categorized (§5.3.4) — unlike a manually-configured
 * `send_template` step, which no path in the engine checks consent
 * for today. This is the only opt-out check on the fallback path,
 * deliberately asymmetric with manual `send_template` (out of scope
 * per §4 item 2): utility/authentication templates still reach an
 * opted-out contact, same rule `excludesOptedOut` already applies to
 * broadcasts.
 */
async function fallbackTemplateAllowed(
  templateName: string,
  language: string | undefined,
  args: ExecuteArgs
): Promise<boolean> {
  if (!args.contactId) return true;
  const db = supabaseAdmin();
  const { data: contact } = await db
    .from('contacts')
    .select('opt_in_status')
    .eq('id', args.contactId)
    .eq('account_id', args.automation.account_id)
    .maybeSingle();
  if (!contact || !isOptedOut(contact)) return true;

  let query = db
    .from('message_templates')
    .select('category')
    .eq('account_id', args.automation.account_id)
    .eq('name', templateName);
  if (language) query = query.eq('language', language);
  const { data } = await query.limit(1);
  return !excludesOptedOut(data?.[0]?.category ?? null);
}

/**
 * Executa o desvio por canal (PRD 047 §10.2, SPEC 049 §6.1): a MESMA
 * mensagem, pelo canal escolhido, sem template e sem custo de Meta.
 *
 * É o ÚNICO ponto do sistema que manda mensagem por um canal diferente
 * do da conversa. Daí os quatro pontos abaixo, que a decisão de rota
 * (`window-fallback.ts`) não cobre porque não fala com o banco:
 *
 * 1. O canal é explícito, não o da conversa. Sair pelo canal da thread
 *    seria justamente o errado — é a janela DELE que fechou. `type` e
 *    `id` viajam juntos: `resolveChannelContext` recusa `whatsapp_qr`
 *    sem id (uma conta pode ter várias instâncias). Como consequência,
 *    este caminho nunca toca `whatsapp_config`.
 *
 * 2. A bolha é persistida na conversa ORIGINAL (a do canal oficial onde
 *    a janela fechou), não numa thread nova do canal de desvio: a
 *    automação foi disparada por aquela thread e o log tem de estar
 *    lá; e abrir thread sem o cliente ter escrito poluiria a lista.
 *    ⚠️ O agente vê a bolha na thread do oficial embora o cliente tenha
 *    recebido de OUTRO número — o selo de canal na bolha (F5) é o que
 *    fecha essa lacuna de leitura.
 *
 * 3. Teto de envio frio negado é `skip`, não falha (PRD §10.3: cota
 *    estourada é adiamento). `sendAndPersistOutbound` já verifica antes
 *    de entregar e registra o consumo DEPOIS — contar antes faria uma
 *    falha de rede consumir cota que nunca saiu.
 *
 * 4. Qualquer OUTRO erro é falha do passo, com motivo. Em especial
 *    `channel_unavailable`: a rota foi decidida com
 *    `channels.status === 'connected'` lido da tabela, e entre a decisão
 *    e o envio a instância pode ter caído. Canal que caiu é problema a
 *    resolver, não cota a esperar — pular em silêncio esconderia uma
 *    instância desconectada de quem precisa reconectá-la.
 */
async function sendViaFallbackChannel(
  guard: { channelId: string; channelName: string },
  text: string,
  conversationId: string,
  args: ExecuteArgs
): Promise<StepResult> {
  if (!args.contactId) throw new Error('fallback_channel needs a contact');

  try {
    const { whatsapp_message_id } = await sendAndPersistOutbound({
      db: supabaseAdmin(),
      accountId: args.automation.account_id,
      channel: { type: 'whatsapp_qr', id: guard.channelId },
      conversationId,
      contactId: args.contactId,
      content: { kind: 'text', text },
      persist: {
        senderType: 'bot',
        contentType: 'text',
        contentText: text,
        previewText: text,
      },
    });
    return success(
      `sent via fallback channel "${guard.channelName}" (${whatsapp_message_id})`
    );
  } catch (err) {
    if (err instanceof ColdSendLimitError) return skipped(err.message);
    // O nome do canal entra no motivo porque a thread onde este log
    // será lido é a do canal oficial: sem ele, "instance unavailable"
    // aponta para o número errado.
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`fallback channel "${guard.channelName}": ${reason}`);
  }
}

async function sendFallbackTemplate(
  template: SendTemplateStepConfig,
  conversationId: string,
  args: ExecuteArgs
): Promise<string> {
  const allowed = await fallbackTemplateAllowed(
    template.template_name,
    template.language,
    args
  );
  if (!allowed) {
    return 'opted out — template fallback suppressed';
  }
  return sendTemplateStep(template, conversationId, args);
}

async function sendTemplateStep(
  cfg: SendTemplateStepConfig,
  conversationId: string,
  args: ExecuteArgs
): Promise<string> {
  if (!args.contactId) throw new Error('send_template needs a contact');
  if (!cfg.template_name) throw new Error('send_template needs template_name');
  // Meta templates use positional {{1}}, {{2}}, … placeholders, so
  // we MUST emit params in strict numeric order. Lexicographic sort
  // of "1", "2", …, "10" yields "1", "10", "2", … which silently
  // scrambles every template with ≥10 variables.
  const params = cfg.variables
    ? Object.keys(cfg.variables)
        .sort((a, b) => {
          const na = Number(a);
          const nb = Number(b);
          const aNum = Number.isFinite(na);
          const bNum = Number.isFinite(nb);
          if (aNum && bNum) return na - nb;
          if (aNum) return -1;
          if (bNum) return 1;
          return a.localeCompare(b);
        })
        .map((k) => String(cfg.variables![k]))
    : [];
  const { whatsapp_message_id } = await engineSendTemplate({
    accountId: args.automation.account_id,
    userId: args.automation.user_id,
    conversationId,
    contactId: args.contactId,
    templateName: cfg.template_name,
    language: cfg.language,
    params,
  });
  return `template sent via Meta (${whatsapp_message_id})`;
}

export function triggerMatches(
  automation: Automation,
  ctx: AutomationContext | undefined
): boolean {
  if (automation.trigger_type === 'keyword_match') {
    const cfg = automation.trigger_config as KeywordMatchTriggerConfig;
    if (!cfg?.keywords || cfg.keywords.length === 0) return false;
    const text = (ctx?.message_text ?? '').toString();
    if (!text) return false;
    const haystack = cfg.case_sensitive ? text : text.toLowerCase();
    return cfg.keywords.some((raw) => {
      const k = cfg.case_sensitive ? raw : raw.toLowerCase();
      return cfg.match_type === 'exact' ? haystack === k : haystack.includes(k);
    });
  }

  // Match on the tapped button / list-row id (exact). Lets multi-step
  // menus be chained: automation A sends buttons, automation B fires on
  // the reply id and sends the next step.
  if (automation.trigger_type === 'interactive_reply') {
    const cfg = automation.trigger_config as InteractiveReplyTriggerConfig;
    const replyId = ctx?.interactive_reply_id;
    if (
      !replyId ||
      !Array.isArray(cfg?.reply_ids) ||
      cfg.reply_ids.length === 0
    ) {
      return false;
    }
    return cfg.reply_ids.includes(replyId);
  }

  return true;
}

async function evaluateCondition(
  cfg: ConditionStepConfig,
  args: ExecuteArgs
): Promise<boolean> {
  const db = supabaseAdmin();
  switch (cfg.subject) {
    case 'tag_presence': {
      if (!args.contactId || !cfg.operand) return false;
      // contact_tags has no account_id column (its RLS keys off the parent
      // contact), so tenant scoping here relies on the contact-ownership
      // guard in runAutomationsForTrigger.
      const { count } = await db
        .from('contact_tags')
        .select('id', { count: 'exact', head: true })
        .eq('contact_id', args.contactId)
        .eq('tag_id', cfg.operand);
      return (count ?? 0) > 0;
    }
    case 'contact_field': {
      if (!args.contactId || !cfg.operand) return false;
      // Scope to the account so the condition can't be turned into a
      // cross-tenant read oracle via the service-role client.
      const { data } = await db
        .from('contacts')
        .select(cfg.operand)
        .eq('id', args.contactId)
        .eq('account_id', args.automation.account_id)
        .maybeSingle();
      const v = (data as Record<string, unknown> | null)?.[cfg.operand];
      return v != null && String(v) === String(cfg.value ?? '');
    }
    case 'message_content': {
      const text = (args.context.message_text ?? '').toString();
      return text.toLowerCase().includes((cfg.value ?? '').toLowerCase());
    }
    case 'time_of_day': {
      // operand form "HH:mm-HH:mm" — true if now is within that window
      // (supports over-midnight ranges like "18:00-09:00").
      const [from, to] = (cfg.operand ?? '').split('-');
      if (!from || !to) return false;
      const now = new Date();
      const mins = now.getHours() * 60 + now.getMinutes();
      const parse = (s: string) => {
        const [h, m] = s.split(':').map(Number);
        return (h || 0) * 60 + (m || 0);
      };
      const f = parse(from);
      const t = parse(to);
      return f <= t ? mins >= f && mins < t : mins >= f || mins < t;
    }
    case 'session_window': {
      // resolveConversationId THROWS when there's no conversation, and
      // an exception here would abort the whole automation instead of
      // taking the "no" branch (engine.ts, the `break` in
      // executeStepsFrom's catch). A condition must answer yes/no,
      // never blow up: contact with no conversation → window not open
      // → false (SPEC 045 §5.4).
      if (!args.contactId) return false;
      let conversationId: string;
      try {
        conversationId = await resolveConversationId(args);
      } catch {
        return false;
      }
      const { data: conv } = await db
        .from('conversations')
        .select('last_customer_message_at')
        .eq('id', conversationId)
        .eq('account_id', args.automation.account_id)
        .maybeSingle();
      // Mesma razão do `checkWindowGuard` (PRD 047 §7.1.1): num canal
      // sem janela, "aberta" é a resposta correta — não há restrição a
      // violar. Responder "fechada" faria a automação tomar o ramo
      // errado em silêncio.
      const { isOpen, minutesRemaining } = resolveSessionWindow(
        await channelForConversation(
          conversationId,
          args.automation.account_id
        ),
        conv?.last_customer_message_at
          ? new Date(conv.last_customer_message_at)
          : null
      );
      switch (cfg.operand) {
        case 'closed':
          return !isOpen;
        case 'closing_soon':
          return isOpen && minutesRemaining <= Number(cfg.value ?? 240);
        case 'open':
        default:
          return isOpen;
      }
    }
    default:
      return false;
  }
}

function waitMs(cfg: WaitStepConfig): number {
  const unitMs =
    cfg.unit === 'days'
      ? 86_400_000
      : cfg.unit === 'hours'
        ? 3_600_000
        : 60_000;
  return Math.max(1_000, cfg.amount * unitMs);
}

function interpolate(s: string, args: ExecuteArgs): string {
  return s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const [ns, prop] = String(key).split('.');
    if (ns === 'message' && prop === 'text')
      return String(args.context.message_text ?? '');
    if (ns === 'vars' && prop) return String(args.context.vars?.[prop] ?? '');
    return '';
  });
}

async function appendResults(
  logId: string | null,
  newItems: AutomationLogStepResult[],
  status: 'success' | 'partial' | 'failed' | null,
  errorMessage: string | null
) {
  if (!logId) return;
  const db = supabaseAdmin();
  const { data: existing } = await db
    .from('automation_logs')
    .select('steps_executed, status')
    .eq('id', logId)
    .single();
  const merged = [
    ...((existing?.steps_executed as AutomationLogStepResult[] | undefined) ??
      []),
    ...newItems,
  ];
  const update: Record<string, unknown> = { steps_executed: merged };
  // Only overwrite status on the outermost scope — nested branches pass null.
  if (status !== null) {
    update.status = status;
  }
  if (errorMessage) update.error_message = errorMessage;
  await db.from('automation_logs').update(update).eq('id', logId);
}

async function finalizeLog(
  logId: string | null,
  status: 'success' | 'partial' | 'failed',
  errorMessage: string | null
) {
  if (!logId) return;
  await supabaseAdmin()
    .from('automation_logs')
    .update({ status, error_message: errorMessage })
    .eq('id', logId);
}

async function markPending(id: string, status: 'done' | 'failed') {
  await supabaseAdmin()
    .from('automation_pending_executions')
    .update({ status })
    .eq('id', id);
}
