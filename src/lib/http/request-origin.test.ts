import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { resolveRequestOrigin } from './request-origin';

describe('resolveRequestOrigin', () => {
  const originalSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;

  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
  });

  afterEach(() => {
    if (originalSiteUrl === undefined) {
      delete process.env.NEXT_PUBLIC_SITE_URL;
    } else {
      process.env.NEXT_PUBLIC_SITE_URL = originalSiteUrl;
    }
    vi.unstubAllEnvs();
  });

  it('prefers NEXT_PUBLIC_SITE_URL when set, trailing slash stripped', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://crm.example.com/';
    const request = new Request('http://0.0.0.0:3000/auth/callback', {
      headers: { host: '0.0.0.0:3000' },
    });
    expect(resolveRequestOrigin(request, 'http://fallback')).toBe(
      'https://crm.example.com'
    );
  });

  it('uses X-Forwarded-Host/Proto over the raw Host header (Hostinger case)', () => {
    const request = new Request('http://0.0.0.0:3000/auth/callback', {
      headers: {
        host: '0.0.0.0:3000',
        'x-forwarded-host': 'vn.local.ia.br',
        'x-forwarded-proto': 'https',
      },
    });
    expect(resolveRequestOrigin(request, 'http://fallback')).toBe(
      'https://vn.local.ia.br'
    );
  });

  it('defaults forwarded proto to https when X-Forwarded-Proto is absent', () => {
    const request = new Request('http://0.0.0.0:3000/auth/callback', {
      headers: { 'x-forwarded-host': 'vn.local.ia.br' },
    });
    expect(resolveRequestOrigin(request, 'http://fallback')).toBe(
      'https://vn.local.ia.br'
    );
  });

  it('falls back to the Host header + request protocol when no forwarded headers exist', () => {
    const request = new Request('https://vn.local.ia.br/auth/callback', {
      headers: { host: 'vn.local.ia.br' },
    });
    expect(resolveRequestOrigin(request, 'http://fallback')).toBe(
      'https://vn.local.ia.br'
    );
  });

  it('uses the provided fallback when no Host header is present', () => {
    const request = new Request('http://0.0.0.0:3000/auth/callback');
    request.headers.delete('host');
    expect(resolveRequestOrigin(request, 'http://last-resort')).toBe(
      'http://last-resort'
    );
  });
});
