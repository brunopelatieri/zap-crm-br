/**
 * Shared display config for message_templates.status.
 *
 * The DB stores Meta's raw enum (DRAFT / APPROVED / PENDING / REJECTED /
 * PAUSED / DISABLED / IN_APPEAL / PENDING_DELETION) — the UI maps it to
 * badge classes + a translation key here so the template manager,
 * inbox picker, and broadcast picker stay aligned.
 *
 * `label` is a key under the `Settings.templates.status` namespace in
 * `messages/*.json` (same convention as broadcast-status.ts, whose
 * labels are keys under `Broadcasts.status`). Components render it via
 * `useTranslations('Settings.templates.status')`.
 */

import type { MessageTemplateStatus } from '@/types';

export interface TemplateStatusDisplay {
  /** Translation key under `Settings.templates.status`. */
  label: string;
  classes: string;
}

export const templateStatusConfig: Record<
  MessageTemplateStatus,
  TemplateStatusDisplay
> = {
  DRAFT: {
    label: 'draft',
    classes: 'bg-slate-600/20 text-muted-foreground border-slate-600/30',
  },
  PENDING: {
    label: 'pending',
    classes: 'bg-yellow-600/20 text-yellow-400 border-yellow-600/30',
  },
  APPROVED: {
    label: 'approved',
    classes: 'bg-primary/20 text-primary border-primary/30',
  },
  REJECTED: {
    label: 'rejected',
    classes: 'bg-red-600/20 text-red-400 border-red-600/30',
  },
  PAUSED: {
    label: 'paused',
    classes: 'bg-orange-600/20 text-orange-400 border-orange-600/30',
  },
  DISABLED: {
    label: 'disabled',
    classes: 'bg-red-900/30 text-red-500 border-red-900/40',
  },
  IN_APPEAL: {
    label: 'inAppeal',
    classes: 'bg-blue-600/20 text-blue-400 border-blue-600/30',
  },
  PENDING_DELETION: {
    label: 'pendingDeletion',
    classes: 'bg-slate-700/30 text-muted-foreground border-slate-700/40',
  },
};
