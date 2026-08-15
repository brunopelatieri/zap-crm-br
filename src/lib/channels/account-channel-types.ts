import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChannelType } from './types';

/**
 * Distinct channel types configured for an account (SPEC 049 §5.1.2 /
 * §5.1.3) — not which one a specific conversation resolves to
 * (`conversation-channel.ts`), just which capabilities are reachable at
 * all, for save-time validation to warn or block on.
 *
 * Falls back to `['whatsapp_cloud']` when the account has no `channels`
 * row: migration 055 backfills one per account on rollout, so an empty
 * result means "not backfilled yet", not "no channel is possible" — the
 * same conservative default `lib/automations/validate.ts` already
 * assumes for a caller that skips this lookup entirely.
 */
export async function loadAccountChannelTypes(
  db: SupabaseClient,
  accountId: string
): Promise<ChannelType[]> {
  const { data } = await db
    .from('channels')
    .select('type')
    .eq('account_id', accountId);
  const types = Array.from(
    new Set(
      ((data ?? []) as { type: string }[]).map((r) => r.type as ChannelType)
    )
  );
  return types.length > 0 ? types : ['whatsapp_cloud'];
}
