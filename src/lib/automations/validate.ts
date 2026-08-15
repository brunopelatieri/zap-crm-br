import type { AutomationTriggerType } from '@/types';
import { validateInteractivePayload } from '@/lib/whatsapp/interactive';
import {
  MAX_MARGIN_MINUTES,
  MIN_MARGIN_MINUTES,
  isValidMarginMinutes,
} from './window-trigger';
import { firesAtLeastOnce, validateSchedule } from './schedule';
import { resolveTimeZone } from '@/lib/broadcasts/send-window';
import {
  accountCapabilityCoverage,
  type ChannelCapabilityKey,
} from '@/lib/channels/capabilities';
import type { ChannelType } from '@/lib/channels/types';

// ------------------------------------------------------------
// Pre-flight config validation for automations about to be activated.
//
// Activating a broken automation (e.g. an add_tag step with tag_id="")
// used to succeed silently — every trigger then produced a failed log
// row with a cryptic "add_tag needs contact + tag_id" message, and
// users often didn't notice until reviewing logs. This module lets
// the API refuse activation with a useful 400 response instead.
//
// The rules here mirror the runtime checks in engine.ts's runStep;
// they're the same invariants, enforced one step earlier so failures
// surface at save time.
// ------------------------------------------------------------

export interface ValidationIssue {
  /** Dot-path for the UI to highlight; stable enough to build a table. */
  path: string;
  message: string;
  /**
   * Absent = blocking (the historical behaviour: every issue in this
   * file used to stop activation). `'warning'` is the only value that
   * changes that — SPEC 049 §5.1.2/§5.1.3, where a step is legitimate on
   * SOME of the account's channels and only fails on others at runtime,
   * with the reason already logged. Filter with `severity !== 'warning'`
   * to get the blocking subset, the same convention `lib/flows/validate.ts`
   * already uses (there `severity` is required; here it stays optional
   * so every issue pushed before this field existed keeps compiling and
   * keeps blocking, byte for byte).
   */
  severity?: 'warning';
}

interface StepLike {
  step_type: string;
  step_config: Record<string, unknown>;
  branches?: { yes?: StepLike[]; no?: StepLike[] };
}

/**
 * SPEC 049 §5.1.2: the historical default of `['whatsapp_cloud']` is not
 * a guess — it's the account shape that existed before the channel layer
 * (PRD 047 F1), and it makes every capability check below a no-op for a
 * caller that doesn't pass real channel types, which is what keeps every
 * pre-existing call site (and its tests) byte-for-byte unchanged.
 */
const CLOUD_ONLY: ChannelType[] = ['whatsapp_cloud'];

export function validateStepsForActivation(
  steps: StepLike[],
  accountChannelTypes: ChannelType[] = CLOUD_ONLY
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!Array.isArray(steps) || steps.length === 0) {
    issues.push({
      path: 'steps',
      message: 'active automations need at least one step',
    });
    return issues;
  }
  walk(steps, '', issues, accountChannelTypes);
  return issues;
}

function walk(
  steps: StepLike[],
  prefix: string,
  issues: ValidationIssue[],
  accountChannelTypes: ChannelType[]
): void {
  steps.forEach((s, i) => {
    const path = `${prefix}steps[${i}]`;
    validateOne(s, path, issues, accountChannelTypes);
    if (s.step_type === 'condition' && s.branches) {
      if (s.branches.yes)
        walk(s.branches.yes, `${path}.yes.`, issues, accountChannelTypes);
      if (s.branches.no)
        walk(s.branches.no, `${path}.no.`, issues, accountChannelTypes);
    }
  });
}

/**
 * SPEC 049 §5.1.2 — `send_template` / `send_buttons` / `send_list` on an
 * account whose channels don't all support the underlying capability.
 * Mirrors the runtime: a step that hits a channel without the capability
 * fails with `ChannelCapabilityError`, and the message here matches what
 * ends up in `automation_logs` so the warning and the eventual failure
 * point at the same fact.
 */
function validateChannelCapability(
  path: string,
  issues: ValidationIssue[],
  accountChannelTypes: ChannelType[],
  capability: ChannelCapabilityKey,
  stepLabel: string
): void {
  const coverage = accountCapabilityCoverage(accountChannelTypes, capability);
  if (coverage === 'all') return;
  const message =
    coverage === 'none'
      ? `${stepLabel} needs a channel that supports it, and no channel in this account does — this step will fail on every run`
      : `${stepLabel} only works on channels that support it — if this automation runs on a conversation from a channel without it, this step will fail with the reason logged`;
  issues.push(
    coverage === 'none'
      ? { path: `${path}.channel_capability`, message }
      : { path: `${path}.channel_capability`, message, severity: 'warning' }
  );
}

function validateOne(
  step: StepLike,
  path: string,
  issues: ValidationIssue[],
  accountChannelTypes: ChannelType[]
): void {
  const c = step.step_config ?? {};
  switch (step.step_type) {
    case 'send_message':
      if (!nonEmpty(c.text)) {
        issues.push({
          path: `${path}.text`,
          message: 'message text is required',
        });
      }
      validateWindowGuard(c, path, issues, 'send_message');
      break;
    case 'send_buttons':
    case 'send_list': {
      // The whole step_config IS the interactive payload; validate it
      // against Meta's limits (same check the engine runs before send).
      const result = validateInteractivePayload(c);
      if (!result.ok) {
        issues.push({ path: `${path}.interactive`, message: result.error });
      }
      validateWindowGuard(c, path, issues, step.step_type);
      validateChannelCapability(
        path,
        issues,
        accountChannelTypes,
        step.step_type === 'send_buttons'
          ? 'interactiveButtons'
          : 'interactiveList',
        step.step_type
      );
      break;
    }
    case 'send_template':
      if (!nonEmpty(c.template_name)) {
        issues.push({
          path: `${path}.template_name`,
          message: 'template name is required',
        });
      }
      validateChannelCapability(
        path,
        issues,
        accountChannelTypes,
        'templates',
        'send_template'
      );
      break;
    case 'add_tag':
    case 'remove_tag':
      if (!nonEmpty(c.tag_id)) {
        issues.push({ path: `${path}.tag_id`, message: 'tag is required' });
      }
      break;
    case 'assign_conversation':
      if (c.mode === 'specific' && !nonEmpty(c.agent_id)) {
        issues.push({
          path: `${path}.agent_id`,
          message: 'agent is required when mode is "specific"',
        });
      }
      break;
    case 'update_contact_field':
      if (!nonEmpty(c.field)) {
        issues.push({
          path: `${path}.field`,
          message: 'field name is required',
        });
      }
      if (c.value === undefined || c.value === null || c.value === '') {
        issues.push({
          path: `${path}.value`,
          message: 'field value is required',
        });
      }
      break;
    case 'create_deal':
      if (!nonEmpty(c.pipeline_id)) {
        issues.push({
          path: `${path}.pipeline_id`,
          message: 'pipeline is required',
        });
      }
      if (!nonEmpty(c.stage_id)) {
        issues.push({ path: `${path}.stage_id`, message: 'stage is required' });
      }
      if (!nonEmpty(c.title)) {
        issues.push({ path: `${path}.title`, message: 'title is required' });
      }
      break;
    case 'wait':
      if (
        typeof c.amount !== 'number' ||
        !Number.isFinite(c.amount) ||
        c.amount <= 0
      ) {
        issues.push({
          path: `${path}.amount`,
          message: 'wait amount must be greater than 0',
        });
      }
      if (!['minutes', 'hours', 'days'].includes(String(c.unit))) {
        issues.push({
          path: `${path}.unit`,
          message: 'wait unit must be minutes, hours, or days',
        });
      }
      break;
    case 'condition':
      if (!nonEmpty(c.subject)) {
        issues.push({
          path: `${path}.subject`,
          message: 'condition subject is required',
        });
      }
      if (!nonEmpty(c.operand)) {
        issues.push({
          path: `${path}.operand`,
          message: 'condition operand is required',
        });
      }
      break;
    case 'send_webhook':
      if (!nonEmpty(c.url)) {
        issues.push({
          path: `${path}.url`,
          message: 'webhook URL is required',
        });
        break;
      }
      try {
        const u = new URL(String(c.url));
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          issues.push({
            path: `${path}.url`,
            message: 'webhook URL must use http or https',
          });
        }
      } catch {
        issues.push({
          path: `${path}.url`,
          message: 'webhook URL is not a valid URL',
        });
      }
      break;
    case 'close_conversation':
      // No config required.
      break;
    default:
      issues.push({ path, message: `unknown step type: ${step.step_type}` });
  }
}

export function validateTriggerForActivation(
  triggerType: AutomationTriggerType | string,
  triggerConfig: unknown,
  accountChannelTypes: ChannelType[] = CLOUD_ONLY
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const cfg = (triggerConfig ?? {}) as Record<string, unknown>;

  if (triggerType === 'keyword_match') {
    const k = cfg.keywords;
    if (!Array.isArray(k) || k.length === 0) {
      issues.push({
        path: 'trigger.keywords',
        message: 'at least one keyword is required',
      });
    } else if (k.some((v) => typeof v !== 'string' || v.trim() === '')) {
      issues.push({
        path: 'trigger.keywords',
        message: 'keywords cannot be empty strings',
      });
    }
    // A missing match_type defaults to "contains" at runtime (see
    // automations/engine.ts and flows/engine.ts, which both read
    // `match_type ?? "contains"`), so only an explicit, unrecognised
    // value is invalid here. This keeps activation validation in step
    // with the engine and with the builder's "Contains" default — an
    // automation that shows the default in the UI must not be rejected.
    if (
      cfg.match_type != null &&
      cfg.match_type !== 'exact' &&
      cfg.match_type !== 'contains'
    ) {
      issues.push({
        path: 'trigger.match_type',
        message: 'match type must be "exact" or "contains"',
      });
    }
  } else if (triggerType === 'time_based') {
    // SPEC 046 §6.5: sobe de "não vazio" para "faz parse e é
    // executável" — a mesma porta (`validateSchedule`) que a UI usa
    // para validar o modo avançado ao vivo, para as duas nunca
    // divergirem sobre o que é um cron válido.
    if (!nonEmpty(cfg.schedule)) {
      issues.push({
        path: 'trigger.schedule',
        message: 'schedule is required',
      });
    } else {
      const scheduleError = validateSchedule(cfg.schedule as string);
      if (scheduleError) {
        issues.push({ path: 'trigger.schedule', message: scheduleError });
      } else if (
        !firesAtLeastOnce(cfg.schedule as string, resolveTimeZone(cfg.timezone))
      ) {
        // Sintaticamente válido e mesmo assim inerte: a janela de
        // horário permitido (dias úteis, 09h–20h) engole TODAS as
        // ocorrências. Sábado às 10h e qualquer dia às 22h caem aqui.
        // Sem esta checagem a automação salva, ativa e nunca roda —
        // o modo de falha que esta SPEC existe para eliminar.
        issues.push({
          path: 'trigger.schedule',
          message:
            'this schedule never runs: every occurrence falls outside the allowed send window (weekdays, 09:00-20:00 in the schedule timezone)',
        });
      }
    }
    // Um gatilho agendado não tem contato vindo de evento — a
    // automação roda uma vez por contato do segmento (§3.6), então a
    // etiqueta não é opcional como em `tag_added`.
    if (!nonEmpty(cfg.audience_tag_id)) {
      issues.push({
        path: 'trigger.audience_tag_id',
        message: 'audience tag is required',
      });
    }
  } else if (triggerType === 'tag_added') {
    if (!nonEmpty(cfg.tag_id)) {
      issues.push({ path: 'trigger.tag_id', message: 'tag is required' });
    }
  } else if (triggerType === 'session_window_expiring') {
    // Ausente é válido: cai no default de 240 min na varredura. Presente
    // tem de estar na faixa útil — ver window-trigger.ts para por que o
    // piso é 15 e não 1 (uma margem menor que 3 ticks de cron produz uma
    // automação que dispara "às vezes", sem o autor descobrir por quê).
    if (
      cfg.margin_minutes != null &&
      !isValidMarginMinutes(cfg.margin_minutes)
    ) {
      issues.push({
        path: 'trigger.margin_minutes',
        message: `margin must be a whole number of minutes between ${MIN_MARGIN_MINUTES} and ${MAX_MARGIN_MINUTES}`,
      });
    }
    // SPEC 049 §5.1.3: this trigger exists to catch a session window
    // BEFORE it closes. An account with no channel that has a session
    // window (only QR channels) can never produce that condition — the
    // trigger is configured, saved, activated, and simply never fires,
    // which is exactly the silent-no-op the AGENTS.md armadilhas table
    // warns about. A warning, not a block: the automation may still be
    // useful once a Cloud channel is added later.
    if (
      accountCapabilityCoverage(accountChannelTypes, 'sessionWindow24h') ===
      'none'
    ) {
      issues.push({
        path: 'trigger.margin_minutes',
        message:
          'this trigger never fires — no channel in this account has a 24h session window to expire',
        severity: 'warning',
      });
    }
  } else if (triggerType === 'interactive_reply') {
    const ids = cfg.reply_ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      issues.push({
        path: 'trigger.reply_ids',
        message: 'at least one reply id is required',
      });
    } else if (ids.some((v) => typeof v !== 'string' || v.trim() === '')) {
      issues.push({
        path: 'trigger.reply_ids',
        message: 'reply ids cannot be empty strings',
      });
    }
  }

  return issues;
}

function nonEmpty(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * SPEC 045 §5.3.4: activating a step configured to fall back to a
 * template when the session window closes, without actually naming a
 * template, would only fail at runtime — at the exact moment the
 * fallback was supposed to save the send. Mirrors the `send_template`
 * check above, applied to the nested `fallback_template` config.
 */
function validateWindowGuard(
  c: Record<string, unknown>,
  path: string,
  issues: ValidationIssue[],
  stepType: 'send_message' | 'send_buttons' | 'send_list'
): void {
  // PRD 047 §10.2: mesmo argumento do template, aplicado ao desvio por
  // canal. Um desvio sem canal escolhido só falharia no runtime — no
  // exato momento em que ele deveria salvar o envio.
  if (c.on_window_closed === 'fallback_channel') {
    // Um canal QRCode não renderiza botões nem listas (restrição do
    // protocolo Multi-Device — PRD 047 §6.2). Desviar um step
    // interativo para lá entregaria uma mensagem sem as opções, ou
    // nenhuma. Barrar na ATIVAÇÃO é o que evita descobrir isso no meio
    // de um atendimento.
    if (stepType !== 'send_message') {
      issues.push({
        path: `${path}.on_window_closed`,
        message: `"fallback_channel" is not available for ${stepType} — a QR code instance cannot render buttons or lists`,
      });
      return;
    }
    if (!nonEmpty(c.fallback_channel_id)) {
      issues.push({
        path: `${path}.fallback_channel_id`,
        message:
          'a fallback channel is required when on_window_closed is "fallback_channel"',
      });
    }
    return;
  }

  if (c.on_window_closed !== 'fallback_template') return;
  const fallback = (c.fallback_template ?? {}) as Record<string, unknown>;
  if (!nonEmpty(fallback.template_name)) {
    issues.push({
      path: `${path}.fallback_template.template_name`,
      message:
        'fallback template name is required when on_window_closed is "fallback_template"',
    });
  }
}
