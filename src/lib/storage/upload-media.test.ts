import { describe, expect, it } from 'vitest';
import {
  baseMimeType,
  buildMediaPath,
  MEDIA_MAX_BYTES_BY_KIND,
} from './upload-media';

/**
 * `allowed_mime_types` do bucket é comparado como STRING LITERAL pelo
 * Supabase Storage, e lista tipos puros. Qualquer parâmetro no mimetype
 * derruba o upload de uma mídia perfeitamente permitida.
 */
describe('baseMimeType', () => {
  it('descarta o parâmetro de codec do WhatsApp', () => {
    // Todo áudio de voz do WhatsApp chega assim.
    expect(baseMimeType('audio/ogg; codecs=opus')).toBe('audio/ogg');
  });

  it('descarta o parâmetro sem espaço, como o MediaRecorder produz', () => {
    // As duas grafias são válidas na RFC 2045.
    expect(baseMimeType('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(baseMimeType('video/webm;codecs=vp8,opus')).toBe('video/webm');
  });

  it('normaliza a caixa e não mexe num tipo já puro', () => {
    expect(baseMimeType('IMAGE/JPEG')).toBe('image/jpeg');
    expect(baseMimeType('application/pdf')).toBe('application/pdf');
  });

  it('ausência vira null — quem chama omite o contentType', () => {
    expect(baseMimeType(null)).toBeNull();
    expect(baseMimeType(undefined)).toBeNull();
    expect(baseMimeType('')).toBeNull();
    expect(baseMimeType('  ; charset=utf-8')).toBeNull();
  });
});

const ACCOUNT = '11111111-2222-3333-4444-555555555555';

describe('buildMediaPath', () => {
  it('namespaces under account-<id> so RLS write policies match', () => {
    const path = buildMediaPath(ACCOUNT, 'photo.png', 1700000000000);
    expect(path).toBe(`account-${ACCOUNT}/1700000000000-photo.png`);
    expect(path.split('/')[0]).toBe(`account-${ACCOUNT}`);
  });

  it('lower-cases the extension and sanitizes the basename', () => {
    const path = buildMediaPath(
      ACCOUNT,
      'My Invoice (final).PDF',
      1700000000000
    );
    expect(path).toBe(`account-${ACCOUNT}/1700000000000-My_Invoice_final_.pdf`);
  });

  it('caps the basename at 40 chars', () => {
    const long = 'a'.repeat(100) + '.png';
    const path = buildMediaPath(ACCOUNT, long, 1700000000000);
    const base = path
      .split('/')[1]
      .replace('1700000000000-', '')
      .replace('.png', '');
    expect(base.length).toBe(40);
  });

  it("falls back to 'file' / 'bin' for a nameless input", () => {
    const path = buildMediaPath(ACCOUNT, '', 1700000000000);
    expect(path).toBe(`account-${ACCOUNT}/1700000000000-file.bin`);
  });

  it('defaults the extension to bin when there is none', () => {
    const path = buildMediaPath(ACCOUNT, 'README', 1700000000000);
    expect(path).toBe(`account-${ACCOUNT}/1700000000000-README.bin`);
  });
});

describe('MEDIA_MAX_BYTES_BY_KIND', () => {
  it("caps images at Meta's tighter 5 MB limit", () => {
    expect(MEDIA_MAX_BYTES_BY_KIND.image).toBe(5 * 1024 * 1024);
  });

  it('caps video/audio/document at the 16 MB bucket limit', () => {
    expect(MEDIA_MAX_BYTES_BY_KIND.video).toBe(16 * 1024 * 1024);
    expect(MEDIA_MAX_BYTES_BY_KIND.audio).toBe(16 * 1024 * 1024);
    expect(MEDIA_MAX_BYTES_BY_KIND.document).toBe(16 * 1024 * 1024);
  });
});
