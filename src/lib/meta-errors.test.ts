import { describe, it, expect } from 'vitest';
import {
  getMetaErrorTranslationKey,
  matchMetaError,
  META_ERROR_CATALOG,
} from './meta-errors';

describe('meta-errors — code prefix (webhook + fixed sync format)', () => {
  it('matches every canonical code via the "(#N)" prefix', () => {
    for (const entry of META_ERROR_CATALOG) {
      expect(
        getMetaErrorTranslationKey(`(#${entry.code}) Some Meta message here`)
      ).toBe(entry.code);
    }
  });

  it('matches alias codes via the "(#N)" prefix', () => {
    expect(getMetaErrorTranslationKey('(#0) AuthException')).toBe('190');
    expect(getMetaErrorTranslationKey('(#10) Permission denied')).toBe(
      '131005'
    );
    expect(getMetaErrorTranslationKey('(#4) Too many calls')).toBe('80007');
    expect(getMetaErrorTranslationKey('(#368) Business blocked')).toBe(
      '130403'
    );
  });

  it('matches the whole 132000-132016 template error range', () => {
    expect(
      getMetaErrorTranslationKey('(#132000) Template param count mismatch')
    ).toBe('132000');
    expect(getMetaErrorTranslationKey('(#132016) Template paused')).toBe(
      '132000'
    );
    // Out of range: no match on the range, and no text fallback either.
    expect(getMetaErrorTranslationKey('(#132099) Unknown')).toBe(null);
  });

  it('matches real-world webhook-formatted messages', () => {
    expect(
      getMetaErrorTranslationKey(
        "(#130472) : User's number is part of an experiment"
      )
    ).toBe('130472');
    expect(
      getMetaErrorTranslationKey('(#131026) Message Undeliverable: ')
    ).toBe('131026');
    expect(
      getMetaErrorTranslationKey(
        '(#131049) : This message was not delivered to maintain healthy ecosystem engagement.'
      )
    ).toBe('131049');
  });
});

describe('meta-errors — text fallback (pre-fix sync messages, no prefix)', () => {
  it('matches known Meta message text without a code prefix', () => {
    expect(getMetaErrorTranslationKey('Message undeliverable')).toBe('131026');
    expect(getMetaErrorTranslationKey('Invalid parameter')).toBe('100');
    expect(getMetaErrorTranslationKey('Payment issue: card declined')).toBe(
      '131042'
    );
  });

  it('resolves a code-less template error to 132000, not the generic 100 catch-all', () => {
    // "Invalid parameter" alone would match the '100' entry too — order
    // in META_ERROR_CATALOG (132000 before 100) must win here.
    expect(
      getMetaErrorTranslationKey(
        'Invalid parameter: Template name does not exist in the translation'
      )
    ).toBe('132000');
  });

  it('matches the "not a WhatsApp user/phone number" phrasing (delegated from phone-utils.ts)', () => {
    expect(getMetaErrorTranslationKey('not a WhatsApp user')).toBe('131026');
    expect(
      getMetaErrorTranslationKey(
        'The recipient phone number is not a WhatsApp phone number.'
      )
    ).toBe('131026');
  });

  it('is case-insensitive', () => {
    expect(getMetaErrorTranslationKey('MESSAGE UNDELIVERABLE')).toBe('131026');
  });
});

describe('meta-errors — known-but-uncataloged code prefix', () => {
  it('does NOT fall back to text matching when the (#N) code is present but unrecognized', () => {
    // A real, explicit code the Meta reported that just isn't in our
    // catalog must stay "unrecognized" — falling back to fuzzy text
    // matching here could mislabel it as some unrelated known error.
    expect(
      getMetaErrorTranslationKey(
        '(#133010) Some brand-new Meta error mentioning invalid parameter in passing'
      )
    ).toBe(null);
  });
});

describe('meta-errors — no match', () => {
  it('returns null for unknown or empty errors', () => {
    expect(getMetaErrorTranslationKey('Some random error')).toBe(null);
    expect(getMetaErrorTranslationKey('')).toBe(null);
    expect(getMetaErrorTranslationKey(null)).toBe(null);
    expect(getMetaErrorTranslationKey(undefined)).toBe(null);
  });
});

describe('matchMetaError', () => {
  it('returns the full entry (including category) for a known code', () => {
    const entry = matchMetaError('(#131026) Message Undeliverable');
    expect(entry?.code).toBe('131026');
    expect(entry?.category).toBe('delivery_restriction');
  });

  it('every catalog entry has a unique code', () => {
    const codes = META_ERROR_CATALOG.map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
