import { NextResponse, type NextRequest } from 'next/server';
import { resolveRequestOrigin } from '@/lib/http/request-origin';
import { createClient } from '@/lib/supabase/server';

// Exchanges the one-time `code` Supabase Auth puts on password-recovery
// (and email-confirmation) links for a session cookie, then forwards the
// user to `next`. Without this route, every link generated via
// `resetPasswordForEmail`/`signUp` 404s on click — see /forgot-password.
export async function GET(request: NextRequest) {
  const { searchParams, origin: fallbackOrigin } = request.nextUrl;
  // `request.nextUrl.origin` reflects the app's internal bind address
  // (e.g. `http://0.0.0.0:3000`) on proxied deploys like Hostinger Managed
  // Node.js — see src/lib/http/request-origin.ts for why.
  const origin = resolveRequestOrigin(request, fallbackOrigin);
  const code = searchParams.get('code');
  const next = searchParams.get('next');
  const safeNext =
    next && next.startsWith('/') && !next.startsWith('//')
      ? next
      : '/dashboard';

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${safeNext}`);
    }
    // Logged (message/status only, never the code or verifier value) so a
    // failure here isn't a silent "auth_callback_failed" with no trail —
    // see docs/spec-053-validacao-deploy-reset-senha.md §2.1.
    console.error('[auth/callback] exchangeCodeForSession failed', {
      message: error.message,
      status: error.status,
      code: error.code,
    });
  } else {
    console.error('[auth/callback] no `code` search param on request', {
      next,
      cookieNames: request.cookies.getAll().map((c) => c.name),
    });
  }

  const loginUrl = new URL('/login', origin);
  loginUrl.searchParams.set('error', 'auth_callback_failed');
  return NextResponse.redirect(loginUrl);
}
