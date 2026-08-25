// Resolves the public origin (scheme + host, no trailing slash) a browser
// used to reach this request, honoring reverse-proxy headers before
// trusting whatever Next.js parsed from the raw `Host` header.
//
// Why this exists: on Hostinger Managed Node.js (and other proxied
// deploys), `request.nextUrl.origin` can end up reflecting the app's own
// internal bind address (e.g. `http://0.0.0.0:3000`) instead of the public
// domain — the reverse proxy sets `X-Forwarded-Host`/`X-Forwarded-Proto`
// with the real hostname, but doesn't always rewrite the raw `Host` header
// the Node process sees. This mirrors the resolution order already proven
// in `/api/account/invitations` (see that route for the security rationale
// behind preferring forwarded headers).
export function resolveRequestOrigin(request: Request, fallback: string) {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const forwardedHost = request.headers
    .get('x-forwarded-host')
    ?.split(',')[0]
    ?.trim();
  const forwardedProto = request.headers
    .get('x-forwarded-proto')
    ?.split(',')[0]
    ?.trim();
  if (forwardedHost) {
    return `${forwardedProto || 'https'}://${forwardedHost}`;
  }

  const host = request.headers.get('host')?.trim();
  if (host) {
    const reqProto = new URL(request.url).protocol.replace(':', '');
    return `${reqProto}://${host}`;
  }

  return fallback;
}
