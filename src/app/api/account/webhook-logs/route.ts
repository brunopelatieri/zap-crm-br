// ============================================================
// /api/account/webhook-logs
//
//   GET    — list this account's webhook_ingest_logs (SPEC 055 D-11),
//            paginated. Any member can view (RLS `..._select` allows
//            viewer+, mirroring `webhook_endpoints`/`api_keys`).
//   DELETE — clear the account's log. admin+ only (settings-class,
//            RLS `..._delete` already requires it).
//
// Dashboard-facing route: cookie session auth via `getCurrentAccount`
// / `requireRole`, RLS-scoped client — NOT the public-API envelope
// used by `/api/v1/**` (see `src/lib/api/v1/respond.ts`'s header
// comment on why the two shapes stay separate).
// ============================================================

import { NextResponse } from 'next/server';

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import {
  parseListParams,
  keysetFilter,
  buildPage,
} from '@/lib/api/v1/pagination';

const SAFE_COLUMNS =
  'id, webhook_id, webhook_name, level, code, message, phone, contact_id, broadcast_id, payload, created_at';

/**
 * Distinct `webhook_id`/`webhook_name` pairs seen in the account's
 * recent log — feeds the filter dropdown (SPEC 055 §8.1). Scans the
 * 500 most recent rows rather than the whole table: this is a
 * debugging aid, not an audit report, and the account-scoped
 * `(account_id, created_at desc)` index keeps it cheap either way.
 */
async function loadDistinctWebhooks(
  supabase: Awaited<ReturnType<typeof getCurrentAccount>>['supabase'],
  accountId: string
): Promise<{ webhook_id: string; webhook_name: string | null }[]> {
  const { data } = await supabase
    .from('webhook_ingest_logs')
    .select('webhook_id, webhook_name, created_at')
    .eq('account_id', accountId)
    .not('webhook_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(500);

  const seen = new Set<string>();
  const webhooks: { webhook_id: string; webhook_name: string | null }[] = [];
  for (const row of data ?? []) {
    const id = row.webhook_id as string;
    if (seen.has(id)) continue;
    seen.add(id);
    webhooks.push({
      webhook_id: id,
      webhook_name: (row.webhook_name as string | null) ?? null,
    });
    if (webhooks.length >= 50) break;
  }
  return webhooks;
}

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);
    const webhookId = url.searchParams.get('webhook_id');
    const level = url.searchParams.get('level');
    // O dropdown de filtro não muda com paginação nem com o próprio
    // filtro de level/webhook_id — só o cliente sabe quando de fato
    // precisa dele (a carga inicial), então o scan de até 500 linhas só
    // roda quando pedido explicitamente (code-review: antes rodava em
    // TODO GET, inclusive "carregar mais" e troca de filtro).
    const includeWebhooks = url.searchParams.get('include_webhooks') === '1';

    let query = ctx.supabase
      .from('webhook_ingest_logs')
      .select(SAFE_COLUMNS)
      .eq('account_id', ctx.accountId);

    if (webhookId) query = query.eq('webhook_id', webhookId);
    if (level === 'error' || level === 'warning') {
      query = query.eq('level', level);
    }

    query = query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    const kf = keysetFilter(cursor);
    if (kf) query = query.or(kf);

    const [{ data, error }, webhooks] = await Promise.all([
      query,
      includeWebhooks
        ? loadDistinctWebhooks(ctx.supabase, ctx.accountId)
        : Promise.resolve(null),
    ]);

    if (error) {
      console.error('[GET /api/account/webhook-logs] fetch error:', error);
      return NextResponse.json(
        { error: 'Failed to load webhook logs' },
        { status: 500 }
      );
    }

    const { items, nextCursor } = buildPage(
      (data ?? []) as unknown as Array<{ created_at: string; id: string }>,
      limit
    );

    return NextResponse.json({
      logs: items,
      next_cursor: nextCursor,
      // `null` quando não pedido — o cliente mantém a lista que já tem
      // em vez de sobrescrever com um valor que nunca foi calculado.
      webhooks,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE() {
  try {
    const ctx = await requireRole('admin');

    const { error } = await ctx.supabase
      .from('webhook_ingest_logs')
      .delete()
      .eq('account_id', ctx.accountId);

    if (error) {
      console.error('[DELETE /api/account/webhook-logs] delete error:', error);
      return NextResponse.json(
        { error: 'Failed to clear webhook logs' },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
