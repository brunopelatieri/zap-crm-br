// ============================================================
// API key generation + hashing — pure, server-side, no Supabase.
//
// Mirrors the invite-token utilities in `src/lib/auth/invitations.ts`:
// the DB stores only the SHA-256 hash, the plaintext is shown to the
// creator exactly once. See migration 026 for the rationale.
//
// Why SHA-256 (not bcrypt/argon2)
//   API keys are full-entropy random strings (32 CSPRNG bytes), not
//   user-chosen passwords. There is no dictionary to attack and no
//   rainbow table that helps, so a slow KDF buys nothing — it would
//   only slow the per-request auth lookup. A fast hash with a UNIQUE
//   index is the correct, indexable choice for opaque secrets.
//
// Why the `wacrm_live_` prefix
//   - Self-identifying: a leaked string is instantly recognisable as
//     a wacrm key (handy for secret-scanners like GitGuardian).
//   - Forward-compatible: leaves room for a `wacrm_test_` variant if
//     a sandbox mode is ever added, without reshaping the format.
// ============================================================

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Secret prefix on every key. Part of the plaintext, not a secret. */
export const API_KEY_PREFIX = 'wacrm_live_';

/**
 * Length of the non-secret display prefix stored in `key_prefix` and
 * shown in the dashboard: the literal prefix plus the first 8 chars
 * of the random body. Enough to tell two keys apart at a glance,
 * far too little to brute-force the remaining ~248 bits.
 */
const DISPLAY_BODY_CHARS = 8;

export interface GeneratedApiKey {
  /** Plaintext key — return to the creator ONCE, never persist. */
  plaintext: string;
  /** SHA-256 hex digest. Persist this in `api_keys.key_hash`. */
  hash: string;
  /** Non-secret display string. Persist this in `api_keys.key_prefix`. */
  prefix: string;
}

/**
 * Generate a fresh API key + its hash + its display prefix. Call
 * once per key creation; the plaintext is shown to the admin in the
 * creation modal and never again.
 */
export function generateApiKey(): GeneratedApiKey {
  // 32 bytes of CSPRNG entropy. base64url keeps it URL/header-safe
  // and shorter than hex (43 vs 64 chars).
  const body = randomBytes(32).toString('base64url');
  const plaintext = `${API_KEY_PREFIX}${body}`;
  return {
    plaintext,
    hash: hashApiKey(plaintext),
    prefix: `${API_KEY_PREFIX}${body.slice(0, DISPLAY_BODY_CHARS)}`,
  };
}

/**
 * Deterministic SHA-256 of a plaintext key. Used at auth time to
 * look up the matching `api_keys` row by `key_hash`. Pure — same
 * input always produces the same output.
 */
export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/**
 * Structural check that a string looks like one of our keys before
 * we bother hashing + hitting the DB. Cheap reject for obviously
 * malformed `Authorization` headers (e.g. a stale invite token).
 */
export function looksLikeApiKey(value: string): boolean {
  return (
    value.startsWith(API_KEY_PREFIX) && value.length > API_KEY_PREFIX.length
  );
}

/**
 * Constant-time comparison of two hex digests. The lookup is by an
 * indexed UNIQUE column so an attacker can't easily probe timing,
 * but comparing the hashes in constant time anyway costs nothing and
 * removes the question. Returns false on any length mismatch (the
 * underlying `timingSafeEqual` throws on unequal lengths).
 */
export function timingSafeHexEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
