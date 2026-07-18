import { describe, expect, it } from 'vitest';
import {
  API_KEY_PREFIX,
  generateApiKey,
  hashApiKey,
  looksLikeApiKey,
  timingSafeHexEqual,
} from './keys';

describe('generateApiKey', () => {
  it('returns a prefixed plaintext, a hash, and a display prefix', () => {
    const { plaintext, hash, prefix } = generateApiKey();
    expect(plaintext.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(plaintext.length).toBeGreaterThan(API_KEY_PREFIX.length + 20);
    // SHA-256 hex is 64 chars.
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Display prefix is the literal prefix + 8 body chars.
    expect(prefix.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(prefix.length).toBe(API_KEY_PREFIX.length + 8);
    // The display prefix is a true prefix of the plaintext.
    expect(plaintext.startsWith(prefix)).toBe(true);
  });

  it('never repeats a key (entropy sanity check)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateApiKey().plaintext);
    expect(seen.size).toBe(200);
  });

  it('hash matches an independent hashApiKey of the plaintext', () => {
    const { plaintext, hash } = generateApiKey();
    expect(hashApiKey(plaintext)).toBe(hash);
  });
});

describe('hashApiKey', () => {
  it('is deterministic', () => {
    expect(hashApiKey('wacrm_live_abc')).toBe(hashApiKey('wacrm_live_abc'));
  });

  it('differs for different inputs', () => {
    expect(hashApiKey('wacrm_live_abc')).not.toBe(hashApiKey('wacrm_live_abd'));
  });
});

describe('looksLikeApiKey', () => {
  it('accepts a well-formed key', () => {
    expect(looksLikeApiKey(generateApiKey().plaintext)).toBe(true);
  });

  it('rejects the bare prefix, empty, and foreign tokens', () => {
    expect(looksLikeApiKey(API_KEY_PREFIX)).toBe(false);
    expect(looksLikeApiKey('')).toBe(false);
    expect(looksLikeApiKey('some-invite-token')).toBe(false);
  });
});

describe('timingSafeHexEqual', () => {
  it('is true for identical digests', () => {
    const h = hashApiKey('wacrm_live_xyz');
    expect(timingSafeHexEqual(h, h)).toBe(true);
  });

  it('is false for different digests', () => {
    expect(timingSafeHexEqual(hashApiKey('a'), hashApiKey('b'))).toBe(false);
  });

  it('is false (not throwing) on length mismatch', () => {
    expect(timingSafeHexEqual('ab', 'abcd')).toBe(false);
  });
});
