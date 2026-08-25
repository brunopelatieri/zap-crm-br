import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  // `/auth/callback` exchanges a one-time PKCE `code` for a session, which
  // depends on the `code-verifier` cookie set when the flow started. None
  // of the gates below apply to this route — but calling getUser() still
  // isn't harmless: when the browser also carries a stale/revoked session
  // cookie, GoTrue's AuthSessionMissingError cleanup path deletes the
  // `code-verifier` cookie as a side effect (see auth-js GoTrueClient's
  // `_getUser`), wiping it before the route handler gets to use it. Skip
  // middleware entirely here instead of risking that race.
  // `/auth/confirm` calls `verifyOtp()` client-side on a real button click
  // to consume the recovery/invite/signup token — same "don't touch
  // getUser() here" reasoning as `/auth/callback` above, and same
  // conclusion: no gate below applies to this route either.
  if (
    request.nextUrl.pathname === '/auth/callback' ||
    request.nextUrl.pathname === '/auth/confirm'
  ) {
    return NextResponse.next();
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // getUser() transparently refreshes an expired access token, which
  // ROTATES the refresh token and writes the new cookies onto
  // `supabaseResponse` via setAll() above. Any response we return in
  // place of `supabaseResponse` (every redirect / JSON branch below)
  // is a fresh object that does NOT carry those Set-Cookie headers, so
  // the rotated token never reaches the browser. The next request then
  // replays the old, now-consumed refresh token, the refresh fails, and
  // the session wedges — the user gets a broken reload after idling and
  // can only recover by manually clearing cookies (issue #288). Copy the
  // refreshed cookies onto whatever response we hand back to fix that.
  const withRefreshedCookies = <T extends NextResponse>(response: T): T => {
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      response.cookies.set(cookie);
    });
    return response;
  };

  // Auth pages - redirect to dashboard if already logged in.
  // Exception: when an invite token is in the query string we
  // send the already-signed-in user to /join/<token> instead so
  // they can accept the invitation in one click. Without this,
  // a forwarded invite link to someone who's already signed in
  // would silently drop them on /dashboard.
  if (
    user &&
    (request.nextUrl.pathname === '/login' ||
      request.nextUrl.pathname === '/signup' ||
      request.nextUrl.pathname === '/forgot-password')
  ) {
    const url = request.nextUrl.clone();
    const inviteToken = request.nextUrl.searchParams.get('invite');
    if (
      inviteToken &&
      (request.nextUrl.pathname === '/login' ||
        request.nextUrl.pathname === '/signup')
    ) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`;
      url.search = '';
    } else {
      url.pathname = '/dashboard';
      url.search = '';
    }
    return withRefreshedCookies(NextResponse.redirect(url));
  }

  // Protected pages - redirect to login if not authenticated.
  // `/reset-password` belongs here even though it's an auth page: it is
  // only reachable with the recovery session that /auth/callback just
  // established, and `updateUser({ password })` cannot work without it.
  // Gating it keeps a sessionless visitor from meeting a form that is
  // guaranteed to fail on submit.
  const protectedPaths = [
    '/reset-password',
    '/dashboard',
    '/inbox',
    '/contacts',
    '/pipelines',
    '/broadcasts',
    '/automations',
    '/settings',
  ];
  if (
    !user &&
    protectedPaths.some((path) => request.nextUrl.pathname.startsWith(path))
  ) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return withRefreshedCookies(NextResponse.redirect(url));
  }

  // API routes that need auth (not webhooks).
  // API error strings stay in English on purpose (see docs/public-api.md
  // and the i18n policy): clients/integrations consume them; UI maps
  // codes to translated copy when showing errors to end users.
  //
  // The Meta and Evolution webhooks themselves never reach this check —
  // `config.matcher` below excludes them from middleware entirely (10MB
  // body-clone cap). This `.includes('/webhook')` carve-out is defense
  // in depth for anything ELSE under `/api/whatsapp/` whose path happens
  // to contain "webhook" but isn't in the matcher's exclusion list — if
  // you add a real webhook-like route, exclude it in the matcher too;
  // this line alone does not skip the 10MB clone.
  if (
    !user &&
    request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
    !request.nextUrl.pathname.includes('/webhook')
  ) {
    return withRefreshedCookies(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    );
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    // Webhooks inbound (Meta e Evolution) ficam de fora do matcher, não
    // só com um `return NextResponse.next()` cedo dentro da função: o
    // Next.js 16 cloneia/buffera o corpo da requisição sempre que o
    // middleware RODA numa rota (mesmo sem tocar no corpo), e esse clone
    // tem teto de 10MB por padrão (`middlewareClientMaxBodySize`). O
    // webhook da Evolution manda mídia recebida em base64 dentro do
    // JSON — um vídeo facilmente estoura 10MB nesse formato — e o corpo
    // truncado silenciosamente derruba a mensagem antes mesmo do parse.
    // Nenhum dos dois precisa de cookie de sessão: a Meta assina por
    // HMAC (`webhook-signature.ts`) e a Evolution por segredo no path +
    // token da instância — o gate deste arquivo nunca se aplicava a eles.
    //
    // `(?:/|$)` depois de cada literal: sem isso a exclusão é por
    // PREFIXO — qualquer rota futura que só COMECE com o mesmo texto
    // (ex.: um endpoint de debug em `/api/whatsapp/webhook-status`)
    // também escaparia do middleware inteiro, gate de sessão incluído,
    // sem nenhuma rota assim existir hoje para acusar o erro.
    '/((?!_next/static|_next/image|favicon.ico|api/whatsapp/webhook(?:/|$)|api/channels/evolution/webhook(?:/|$)|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
