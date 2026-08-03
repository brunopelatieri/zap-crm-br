import { describe, it, expect, vi } from 'vitest';
import {
  withSignedHeaderMedia,
  isMediaHeaderTemplate,
  createHeaderMediaResolver,
} from './header-media';
import type { MessageTemplate } from '@/types';
import type { SupabaseClient } from '@supabase/supabase-js';

const PROJECT = 'https://abcdefgh.supabase.co';
const OURS = `${PROJECT}/storage/v1/object/public/chat-media/account-abc/1-header.png`;
const EXTERNAL = 'https://cdn.terceiro.com/banner.jpg';

/**
 * Cliente falso que só entende `storage.from().createSignedUrl()`.
 * `signed` a `null` simula objeto inexistente / sem permissão.
 */
function fakeSupabase(signed: string | null = 'https://signed.example/x?token=t') {
  const createSignedUrl = vi.fn(async () =>
    signed
      ? { data: { signedUrl: signed }, error: null }
      : { data: null, error: { message: 'Object not found' } }
  );
  return {
    client: { storage: { from: () => ({ createSignedUrl }) } } as unknown as SupabaseClient,
    createSignedUrl,
  };
}

function template(over: Partial<MessageTemplate> = {}): MessageTemplate {
  return {
    id: 't1',
    name: 'promo',
    language: 'pt_BR',
    header_type: 'image',
    header_media_url: OURS,
    body_text: 'oi',
    ...over,
  } as MessageTemplate;
}

describe('isMediaHeaderTemplate', () => {
  it('is true only for image/video/document headers', () => {
    expect(isMediaHeaderTemplate(template({ header_type: 'image' }))).toBe(true);
    expect(isMediaHeaderTemplate(template({ header_type: 'video' }))).toBe(true);
    expect(isMediaHeaderTemplate(template({ header_type: 'document' }))).toBe(
      true
    );
    expect(isMediaHeaderTemplate(template({ header_type: 'text' }))).toBe(false);
    expect(isMediaHeaderTemplate(null)).toBe(false);
  });
});

describe('withSignedHeaderMedia', () => {
  it('signs a header stored in our own bucket', async () => {
    const { client, createSignedUrl } = fakeSupabase();
    const out = await withSignedHeaderMedia(client, template());

    expect(createSignedUrl).toHaveBeenCalledOnce();
    expect(out?.headerMediaUrl).toBe('https://signed.example/x?token=t');
  });

  it('leaves an externally-hosted header URL untouched', async () => {
    // Caso legítimo: o usuário cola um link de terceiro no template.
    // Assinar não faria sentido e reescrever quebraria o envio.
    const { client, createSignedUrl } = fakeSupabase();
    const out = await withSignedHeaderMedia(
      client,
      template({ header_media_url: EXTERNAL })
    );

    expect(createSignedUrl).not.toHaveBeenCalled();
    expect(out?.headerMediaUrl).toBe(EXTERNAL);
  });

  it('does nothing for a text header', async () => {
    const { client, createSignedUrl } = fakeSupabase();
    const existing = { body: ['x'] };
    const out = await withSignedHeaderMedia(
      client,
      template({ header_type: 'text', header_media_url: undefined }),
      existing
    );

    expect(createSignedUrl).not.toHaveBeenCalled();
    expect(out).toBe(existing);
  });

  it('respects an explicit headerMediaId and skips signing', async () => {
    // `headerMediaId` é um id real de /media na Meta e tem precedência
    // no builder — não há URL a assinar nesse caminho.
    const { client, createSignedUrl } = fakeSupabase();
    const existing = { headerMediaId: '9876' };
    const out = await withSignedHeaderMedia(client, template(), existing);

    expect(createSignedUrl).not.toHaveBeenCalled();
    expect(out).toBe(existing);
  });

  it('prefers a send-time URL override over the stored one', async () => {
    const { client, createSignedUrl } = fakeSupabase();
    const out = await withSignedHeaderMedia(client, template(), {
      headerMediaUrl: EXTERNAL,
    });

    expect(createSignedUrl).not.toHaveBeenCalled();
    expect(out?.headerMediaUrl).toBe(EXTERNAL);
  });

  it('preserves the other send-time params', async () => {
    const { client } = fakeSupabase();
    const out = await withSignedHeaderMedia(client, template(), {
      body: ['Ana'],
      buttonParams: { 0: 'promo10' },
    });

    expect(out?.body).toEqual(['Ana']);
    expect(out?.buttonParams).toEqual({ 0: 'promo10' });
    expect(out?.headerMediaUrl).toBe('https://signed.example/x?token=t');
  });

  it('throws when our own object cannot be resolved', async () => {
    // Falhar aqui é melhor do que mandar à Meta um link que ela não abre
    // e receber de volta um erro genérico de template.
    const { client } = fakeSupabase(null);
    await expect(withSignedHeaderMedia(client, template())).rejects.toThrow(
      /Could not resolve the template header media/
    );
  });

  it('returns the input untouched when there is no template', async () => {
    const { client, createSignedUrl } = fakeSupabase();
    const existing = { body: ['x'] };
    expect(await withSignedHeaderMedia(client, null, existing)).toBe(existing);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });
});

describe('createHeaderMediaResolver', () => {
  it('signs once and reuses across recipients', async () => {
    // O ponto do resolvedor: um disparo de mil contatos não pode virar
    // mil chamadas de assinatura.
    const { client, createSignedUrl } = fakeSupabase();
    const resolve = createHeaderMediaResolver(client, template());

    const a = await resolve({ body: ['Ana'] });
    const b = await resolve({ body: ['Bruno'] });

    expect(createSignedUrl).toHaveBeenCalledOnce();
    expect(a?.headerMediaUrl).toBe(b?.headerMediaUrl);
    // …sem misturar as variáveis de um destinatário com as do outro.
    expect(a?.body).toEqual(['Ana']);
    expect(b?.body).toEqual(['Bruno']);
  });

  it('passes params through untouched for a text-header template', async () => {
    const { client, createSignedUrl } = fakeSupabase();
    const resolve = createHeaderMediaResolver(
      client,
      template({ header_type: 'text', header_media_url: undefined })
    );
    const params = { body: ['Ana'] };

    expect(await resolve(params)).toBe(params);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it('does not cache a per-recipient override', async () => {
    // Um override é daquele destinatário; guardá-lo no cache o
    // vazaria para todos os seguintes.
    const { client } = fakeSupabase();
    const resolve = createHeaderMediaResolver(client, template());

    const overridden = await resolve({ headerMediaUrl: EXTERNAL });
    const normal = await resolve({ body: ['Ana'] });

    expect(overridden?.headerMediaUrl).toBe(EXTERNAL);
    expect(normal?.headerMediaUrl).toBe('https://signed.example/x?token=t');
  });
});
