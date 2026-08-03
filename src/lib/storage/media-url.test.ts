import { describe, it, expect } from 'vitest';
import {
  parseStorageUrl,
  parseProxyMediaUrl,
  proxyMediaUrl,
  resolveMediaRef,
  isPrivateMediaBucket,
} from './media-url';

const PROJECT = 'https://abcdefgh.supabase.co';

describe('proxyMediaUrl / parseProxyMediaUrl', () => {
  it('round-trips a media id', () => {
    expect(parseProxyMediaUrl(proxyMediaUrl('1234567890'))).toBe('1234567890');
  });

  it('ignores query string and fragment', () => {
    expect(parseProxyMediaUrl('/api/whatsapp/media/abc?x=1')).toBe('abc');
    expect(parseProxyMediaUrl('/api/whatsapp/media/abc#frag')).toBe('abc');
  });

  it('returns null for anything that is not the proxy route', () => {
    expect(parseProxyMediaUrl('https://example.com/file.png')).toBeNull();
    // Prefixo sem id: não há mídia a autorizar, então não é uma
    // referência válida — devolver '' faria a rota consultar o banco
    // por string vazia.
    expect(parseProxyMediaUrl('/api/whatsapp/media/')).toBeNull();
  });
});

describe('parseStorageUrl', () => {
  it('extracts bucket and path from a public URL', () => {
    const url = `${PROJECT}/storage/v1/object/public/chat-media/account-11111111-2222-3333-4444-555555555555/1700000000000-foto.png`;
    expect(parseStorageUrl(url)).toEqual({
      bucket: 'chat-media',
      path: 'account-11111111-2222-3333-4444-555555555555/1700000000000-foto.png',
    });
  });

  it('extracts from an already-signed URL, dropping the token', () => {
    const url = `${PROJECT}/storage/v1/object/sign/chat-media/account-abc/1-a.pdf?token=eyJhbGciOi`;
    expect(parseStorageUrl(url)).toEqual({
      bucket: 'chat-media',
      path: 'account-abc/1-a.pdf',
    });
  });

  it('handles flow-media too', () => {
    const url = `${PROJECT}/storage/v1/object/public/flow-media/account-abc/1-v.mp4`;
    expect(parseStorageUrl(url)?.bucket).toBe('flow-media');
  });

  it('percent-decodes the path', () => {
    // Sem o decode, o SDK do Storage procuraria por um objeto cujo nome
    // literal contém "%20" e não encontraria nada.
    const url = `${PROJECT}/storage/v1/object/public/chat-media/account-abc/1-nota%20fiscal.pdf`;
    expect(parseStorageUrl(url)?.path).toBe('account-abc/1-nota fiscal.pdf');
  });

  it('returns null for a bucket we do not manage', () => {
    // `avatars` (migração 008) continua público e não passa por
    // assinatura — reescrevê-lo quebraria as fotos de perfil.
    const url = `${PROJECT}/storage/v1/object/public/avatars/user.png`;
    expect(parseStorageUrl(url)).toBeNull();
  });

  it('returns null for an external URL', () => {
    expect(parseStorageUrl('https://cdn.terceiro.com/banner.jpg')).toBeNull();
    expect(parseStorageUrl('')).toBeNull();
  });
});

describe('isPrivateMediaBucket', () => {
  it('recognises only the two managed buckets', () => {
    expect(isPrivateMediaBucket('chat-media')).toBe(true);
    expect(isPrivateMediaBucket('flow-media')).toBe(true);
    expect(isPrivateMediaBucket('avatars')).toBe(false);
  });
});

describe('resolveMediaRef', () => {
  it('prefers the stored path over the URL', () => {
    // Precedência importa: a URL gravada pode ser a pública histórica,
    // que deixou de funcionar quando o bucket fechou.
    const ref = resolveMediaRef(
      `${PROJECT}/storage/v1/object/public/chat-media/account-abc/velha.png`,
      'account-abc/nova.png'
    );
    expect(ref).toEqual({
      kind: 'storage',
      bucket: 'chat-media',
      path: 'account-abc/nova.png',
    });
  });

  it('classifies inbound proxy media', () => {
    const ref = resolveMediaRef('/api/whatsapp/media/999');
    expect(ref).toEqual({
      kind: 'proxy',
      url: '/api/whatsapp/media/999',
      mediaId: '999',
    });
  });

  it('derives storage from a legacy public URL when no path is stored', () => {
    const ref = resolveMediaRef(
      `${PROJECT}/storage/v1/object/public/chat-media/account-abc/1-a.png`
    );
    expect(ref).toEqual({
      kind: 'storage',
      bucket: 'chat-media',
      path: 'account-abc/1-a.png',
    });
  });

  it('leaves a user-pasted external URL alone', () => {
    // Caso legítimo: header de template e nó de flow aceitam link de
    // terceiro. Assinar (ou reescrever) quebraria o recurso.
    const ref = resolveMediaRef('https://cdn.terceiro.com/banner.jpg');
    expect(ref).toEqual({
      kind: 'external',
      url: 'https://cdn.terceiro.com/banner.jpg',
    });
  });

  it('reports absence for null/empty input', () => {
    expect(resolveMediaRef(null)).toEqual({ kind: 'none' });
    expect(resolveMediaRef(undefined, null)).toEqual({ kind: 'none' });
    expect(resolveMediaRef('')).toEqual({ kind: 'none' });
  });
});
