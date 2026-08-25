import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// --- Scenario knobs the mock reads -----------------------------------------
// `mockUser`         — what getUser() resolves to (a refreshed session ⇒ user,
//                      or null for the logged-out path).
// `refreshedCookies` — cookies Supabase writes via setAll() during getUser(),
//                      i.e. the freshly *rotated* auth token. The whole point
//                      of the test is that these must survive onto whatever
//                      response the middleware returns — including redirects.
let mockUser: { id: string } | null = null;
let refreshedCookies: Array<{
  name: string;
  value: string;
  options: Record<string, unknown>;
}> = [];
let getUserCallCount = 0;

vi.mock('@supabase/ssr', () => ({
  createServerClient: (
    _url: string,
    _key: string,
    opts: {
      cookies: { setAll: (c: typeof refreshedCookies) => void };
    }
  ) => ({
    auth: {
      // Mirrors real auth-js: an expired access token is transparently
      // refreshed inside getUser(), which rotates the refresh token and
      // pushes the new cookies through setAll() before resolving.
      getUser: async () => {
        getUserCallCount += 1;
        if (refreshedCookies.length) opts.cookies.setAll(refreshedCookies);
        return { data: { user: mockUser } };
      },
    },
  }),
}));

// Imported after the mock is registered.
const { middleware, config } = await import('./middleware');

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
  mockUser = null;
  refreshedCookies = [];
  getUserCallCount = 0;
});

afterEach(() => vi.clearAllMocks());

const ROTATED = {
  name: 'sb-test-auth-token',
  value: 'rotated-refresh-token',
  options: { path: '/', httpOnly: true },
};

describe('middleware — refreshed auth cookies survive redirects', () => {
  it('carries the rotated token when redirecting a signed-in user off /login', async () => {
    mockUser = { id: 'user-1' };
    refreshedCookies = [ROTATED];

    const res = await middleware(new NextRequest('https://app.test/login'));

    // Redirect to /dashboard…
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/dashboard');
    // …and the rotated cookie MUST ride along, otherwise the browser keeps
    // replaying the now-consumed refresh token and the session wedges until
    // the user manually clears cookies.
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it('carries the rotated token when redirecting an unauth user to /login', async () => {
    mockUser = null;
    // Even on the logged-out path getUser() may emit cookie writes (e.g.
    // clearing a dead session); those must not be dropped on the redirect.
    refreshedCookies = [{ ...ROTATED, value: 'cleared' }];

    const res = await middleware(new NextRequest('https://app.test/dashboard'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
    expect(res.cookies.get(ROTATED.name)?.value).toBe('cleared');
  });

  it('redirects a signed-in user with an invite token to /join/<token>', async () => {
    mockUser = { id: 'user-1' };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest('https://app.test/login?invite=abc123')
    );

    expect(res.headers.get('location')).toContain('/join/abc123');
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it('passes through (no redirect) for a signed-in user on a protected page', async () => {
    mockUser = { id: 'user-1' };
    refreshedCookies = [ROTATED];

    const res = await middleware(new NextRequest('https://app.test/dashboard'));

    // No redirect — the normal NextResponse.next() already carries cookies.
    expect(res.headers.get('location')).toBeNull();
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });
});

describe('middleware — /auth/callback skips the auth gate entirely', () => {
  it('never calls getUser(), so a stale session cannot wipe the PKCE code-verifier cookie first', async () => {
    // Regression test: auth-js's getUser() deletes the `-code-verifier`
    // cookie as a side effect when it finds a stale/revoked session
    // (AuthSessionMissingError cleanup in GoTrueClient#_getUser). None of
    // this route's gates need getUser() at all, so middleware must bail
    // out before ever constructing the Supabase client for this path —
    // see SPEC 053 §2.1.2.
    const res = await middleware(
      new NextRequest(
        'https://app.test/auth/callback?code=abc&next=/reset-password'
      )
    );

    expect(getUserCallCount).toBe(0);
    expect(res.headers.get('location')).toBeNull();
  });
});

describe('middleware — matcher exclui os webhooks inbound (Meta e Evolution)', () => {
  // Reproduz como o Next.js compila `config.matcher` — não `middleware()`
  // em si, que nunca lê essa string. Só o matcher decide se o Next roda
  // o middleware pra uma rota; e é RODAR (mesmo sem tocar o corpo) que
  // aciona o clone do corpo com teto de 10MB (`middlewareClientMaxBodySize`)
  // — o que truncava vídeo em base64 vindo do webhook da Evolution antes
  // desta exclusão existir.
  const matches = (pathname: string) =>
    new RegExp(`^${config.matcher[0]}$`).test(pathname);

  it('exclui os dois webhooks inbound, inclusive sub-rotas', () => {
    expect(matches('/api/whatsapp/webhook')).toBe(false);
    expect(matches('/api/channels/evolution/webhook/some-secret')).toBe(false);
  });

  it('não exclui rotas de API que precisam do gate de sessão', () => {
    expect(matches('/api/whatsapp/send')).toBe(true);
    // API pública de gerenciar webhooks (plural) — rota autenticada
    // nossa, não um receptor inbound; não deve ser confundida com as
    // duas exclusões acima.
    expect(matches('/api/v1/webhooks')).toBe(true);
  });

  it('exclusão é por SEGMENTO de path, não por prefixo cru', () => {
    // Sem o `(?:/|$)` depois de cada literal, isto também escaparia do
    // middleware inteiro (gate de sessão incluído) só por começar com o
    // mesmo texto — mesmo sendo uma rota hipotética completamente
    // diferente do receptor inbound que a exclusão foi escrita para.
    expect(matches('/api/whatsapp/webhook-status')).toBe(true);
    expect(matches('/api/channels/evolution/webhook-logs')).toBe(true);
  });

  it('continua excluindo assets estáticos (comportamento anterior)', () => {
    expect(matches('/_next/static/chunk.js')).toBe(false);
    expect(matches('/favicon.ico')).toBe(false);
    expect(matches('/logo.png')).toBe(false);
  });

  it('continua cobrindo páginas normais', () => {
    expect(matches('/dashboard')).toBe(true);
    expect(matches('/login')).toBe(true);
  });
});

describe('middleware — /auth/confirm skips the auth gate entirely', () => {
  it('never calls getUser(), same reasoning as /auth/callback — see SPEC 053 §2.1.3', async () => {
    const res = await middleware(
      new NextRequest(
        'https://app.test/auth/confirm?token_hash=abc&type=recovery&next=/reset-password'
      )
    );

    expect(getUserCallCount).toBe(0);
    expect(res.headers.get('location')).toBeNull();
  });
});
