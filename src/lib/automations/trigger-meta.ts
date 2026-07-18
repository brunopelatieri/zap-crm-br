import type { AutomationTriggerType } from '@/types';

export interface TriggerMeta {
  /** English fallback label. Prefer `Automations.builder.triggers.<type>.label` in UI. */
  label: string;
  /** Tailwind classes for the Badge pill on the list row. */
  pillClass: string;
}

export const TRIGGER_META: Record<AutomationTriggerType, TriggerMeta> = {
  new_message_received: {
    label: 'New Message',
    pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
  },
  first_inbound_message: {
    label: 'First Message from Contact',
    pillClass: 'border-teal-500/30 bg-teal-500/10 text-teal-300',
  },
  keyword_match: {
    label: 'Keyword Match',
    pillClass: 'border-purple-500/30 bg-purple-500/10 text-purple-300',
  },
  new_contact_created: {
    label: 'New Contact',
    pillClass: 'border-primary/30 bg-primary/10 text-primary',
  },
  conversation_assigned: {
    label: 'Conversation Assigned',
    pillClass: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300',
  },
  tag_added: {
    label: 'Tag Added',
    pillClass: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  },
  time_based: {
    label: 'Time-Based',
    pillClass: 'border-slate-500/30 bg-slate-500/10 text-muted-foreground',
  },
  interactive_reply: {
    label: 'Button / List Reply',
    pillClass: 'border-pink-500/30 bg-pink-500/10 text-pink-300',
  },
};

export function triggerMeta(t: AutomationTriggerType | string): TriggerMeta {
  return (
    TRIGGER_META[t as AutomationTriggerType] ?? {
      label: t,
      pillClass: 'border-slate-500/30 bg-slate-500/10 text-muted-foreground',
    }
  );
}

/** Optional translator for `Automations.relative` keys. */
export type RelativeTranslate = (
  key: 'never' | 'justNow' | 'minutesAgo' | 'hoursAgo' | 'daysAgo',
  values?: { count: number }
) => string;

export function formatRelative(
  iso: string | null | undefined,
  t?: RelativeTranslate
): string {
  const tr =
    t ??
    ((key, values) => {
      switch (key) {
        case 'never':
          return 'never';
        case 'justNow':
          return 'just now';
        case 'minutesAgo':
          return `${values?.count ?? 0}m ago`;
        case 'hoursAgo':
          return `${values?.count ?? 0}h ago`;
        case 'daysAgo':
          return `${values?.count ?? 0}d ago`;
      }
    });

  if (!iso) return tr('never');
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return tr('never');
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 60) return tr('justNow');
  if (diffSec < 3600)
    return tr('minutesAgo', { count: Math.floor(diffSec / 60) });
  if (diffSec < 86400)
    return tr('hoursAgo', { count: Math.floor(diffSec / 3600) });
  if (diffSec < 2_592_000)
    return tr('daysAgo', { count: Math.floor(diffSec / 86400) });
  return new Date(iso).toLocaleDateString();
}
