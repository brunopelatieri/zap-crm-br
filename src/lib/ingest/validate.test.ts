import { describe, expect, it } from 'vitest';

import { parseIngestPayload } from './validate';

const BASE = {
  webhook_id: '1234567890123456',
  webhook_name: 'Landing page — Black Friday',
  phone: '19992496598', // celular BR válido, sem DDI
};

describe('parseIngestPayload — bad_request', () => {
  it('rejects a non-object body', () => {
    expect(parseIngestPayload('nope')).toMatchObject({
      ok: false,
      code: 'bad_request',
    });
    expect(parseIngestPayload(null)).toMatchObject({
      ok: false,
      code: 'bad_request',
    });
    expect(parseIngestPayload([1, 2, 3])).toMatchObject({
      ok: false,
      code: 'bad_request',
    });
  });
});

describe('parseIngestPayload — webhook_id', () => {
  it('accepts exactly 16 digits', () => {
    const result = parseIngestPayload({
      ...BASE,
      webhook_id: '1234567890123456',
    });
    expect(result.ok).toBe(true);
  });

  it('accepts more than 16 digits', () => {
    const result = parseIngestPayload({
      ...BASE,
      webhook_id: '123456789012345678901234',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects 15 digits', () => {
    expect(
      parseIngestPayload({ ...BASE, webhook_id: '123456789012345' })
    ).toMatchObject({ ok: false, code: 'invalid_webhook_id' });
  });

  it('rejects non-numeric characters', () => {
    expect(
      parseIngestPayload({ ...BASE, webhook_id: '1234567890123abc' })
    ).toMatchObject({ ok: false, code: 'invalid_webhook_id' });
  });

  it('rejects a leading + (not "only digits")', () => {
    expect(
      parseIngestPayload({ ...BASE, webhook_id: '+551234567890123' })
    ).toMatchObject({ ok: false, code: 'invalid_webhook_id' });
  });

  it('rejects a missing webhook_id', () => {
    const { webhook_id: _drop, ...rest } = BASE;
    void _drop;
    expect(parseIngestPayload(rest)).toMatchObject({
      ok: false,
      code: 'invalid_webhook_id',
    });
  });

  it('coerces a JS number into its digit string (does not break unquoted callers)', () => {
    const result = parseIngestPayload({
      ...BASE,
      webhook_id: 1234567890123456,
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.value.webhookId).toBe('1234567890123456');
  });
});

describe('parseIngestPayload — webhook_name', () => {
  it('rejects an empty string', () => {
    expect(parseIngestPayload({ ...BASE, webhook_name: '' })).toMatchObject({
      ok: false,
      code: 'invalid_webhook_name',
    });
  });

  it('rejects a whitespace-only string', () => {
    expect(parseIngestPayload({ ...BASE, webhook_name: '   ' })).toMatchObject({
      ok: false,
      code: 'invalid_webhook_name',
    });
  });

  it('accepts exactly 120 characters unchanged', () => {
    const name = 'a'.repeat(120);
    const result = parseIngestPayload({ ...BASE, webhook_name: name });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.value.webhookName).toBe(name);
  });

  it('truncates 121 characters down to 120 rather than rejecting', () => {
    const name = 'a'.repeat(121);
    const result = parseIngestPayload({ ...BASE, webhook_name: name });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.value.webhookName).toHaveLength(120);
      expect(result.value.webhookName).toBe('a'.repeat(120));
    }
  });
});

describe('parseIngestPayload — phone (SPEC 050, ligada)', () => {
  it('rejects empty', () => {
    expect(parseIngestPayload({ ...BASE, phone: '' })).toMatchObject({
      ok: false,
      code: 'invalid_phone',
      message: expect.stringContaining('empty'),
    });
  });

  it('rejects an unknown DDD (invalid_ddd)', () => {
    // DDD 20 não existe na lista da Anatel.
    expect(parseIngestPayload({ ...BASE, phone: '20992496598' })).toMatchObject(
      {
        ok: false,
        code: 'invalid_phone',
        message: expect.stringContaining('invalid_ddd'),
      }
    );
  });

  it('rejects an 11-digit local part whose 9th digit is not 9 (mobile_invalid_ninth_digit)', () => {
    expect(parseIngestPayload({ ...BASE, phone: '19892496598' })).toMatchObject(
      {
        ok: false,
        code: 'invalid_phone',
        message: expect.stringContaining('mobile_invalid_ninth_digit'),
      }
    );
  });

  it('rejects an 8-digit local part starting with 0/1 (invalid_local_prefix)', () => {
    expect(parseIngestPayload({ ...BASE, phone: '1901234567' })).toMatchObject({
      ok: false,
      code: 'invalid_phone',
      message: expect.stringContaining('invalid_local_prefix'),
    });
  });

  it('rejects a length that matches no known shape (invalid_length)', () => {
    expect(parseIngestPayload({ ...BASE, phone: '123' })).toMatchObject({
      ok: false,
      code: 'invalid_phone',
      message: expect.stringContaining('invalid_length'),
    });
  });

  it('accepts a foreign E.164 number (SPEC 050 D-2)', () => {
    // Um número com só 1 dígito de DDI (ex.: EUA/Canadá, +1) colide em
    // comprimento com um doméstico BR de 11 dígitos — comportamento
    // documentado da própria SPEC 050, não algo que esta SPEC altera.
    // Portugal (+351) soma 12 dígitos e cai limpo no ramo "foreign".
    const result = parseIngestPayload({ ...BASE, phone: '+351 912 345 678' });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.value.phone).toBe('351912345678');
  });

  it('accepts an 8-digit legacy mobile (SPEC 050 D-6)', () => {
    // DDD 19, local de 8 dígitos começando em 9 → mobile_legacy, aceito.
    const result = parseIngestPayload({ ...BASE, phone: '1992496598' });
    expect(result).toMatchObject({ ok: true });
  });

  it('normalizes with country code, digits-only, no +', () => {
    const result = parseIngestPayload({ ...BASE, phone: '(19) 99249-6598' });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.value.phone).toBe('5519992496598');
  });

  it('coerces a JS number the same way webhook_id does (does not treat it as empty)', () => {
    // 19992496598 sem aspas — mesmo tipo de erro de chamador que o
    // teste de webhook_id já cobre; phone precisa da MESMA coerção.
    const result = parseIngestPayload({ ...BASE, phone: 19992496598 });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.value.phone).toBe('5519992496598');
  });
});

describe('parseIngestPayload — tags', () => {
  it('splits a CSV string, trims, and drops empties', () => {
    const result = parseIngestPayload({ ...BASE, tags: 'a, b ,, c' });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.value.tags).toEqual(['a', 'b', 'c']);
  });

  it('accepts an array of strings the same way', () => {
    const result = parseIngestPayload({ ...BASE, tags: ['a', ' b ', ''] });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.value.tags).toEqual(['a', 'b']);
  });

  it('empty string yields an empty list', () => {
    const result = parseIngestPayload({ ...BASE, tags: '' });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.value.tags).toEqual([]);
  });

  it('deduplicates case-insensitively', () => {
    const result = parseIngestPayload({ ...BASE, tags: 'VIP, vip, Vip' });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.value.tags).toEqual(['VIP']);
  });
});

describe('parseIngestPayload — notes', () => {
  it('orders an indexed object by NUMERIC suffix, not lexicographically', () => {
    const result = parseIngestPayload({
      ...BASE,
      notes: { nota_1: 'primeira', nota_10: 'decima', nota_2: 'segunda' },
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.value.notes).toEqual(['primeira', 'segunda', 'decima']);
    }
  });

  it('sends keys without a numeric suffix to the end, alphabetically', () => {
    const result = parseIngestPayload({
      ...BASE,
      notes: { zeta: 'z', nota_1: 'um', alpha: 'a' },
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.value.notes).toEqual(['um', 'a', 'z']);
    }
  });

  it('accepts a plain string array, preserving order', () => {
    const result = parseIngestPayload({
      ...BASE,
      notes: ['primeira', 'segunda'],
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.value.notes).toEqual(['primeira', 'segunda']);
  });

  it('skips an empty note and reports note_empty', () => {
    const result = parseIngestPayload({
      ...BASE,
      notes: { nota_1: '   ', nota_2: 'texto' },
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.value.notes).toEqual(['texto']);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({ code: 'note_empty' })
      );
    }
  });

  it('absent notes yields an empty list with no warnings', () => {
    const result = parseIngestPayload(BASE);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.value.notes).toEqual([]);
      expect(result.warnings).toEqual([]);
    }
  });
});

describe('parseIngestPayload — custom_fields', () => {
  it('normalizes a well-formed array', () => {
    const result = parseIngestPayload({
      ...BASE,
      custom_fields: [
        { field: 'CPF', value: '123.456.789-00' },
        { field: 'origem', value: 'landing_page_bf' },
      ],
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.value.customFields).toEqual([
        { field: 'CPF', value: '123.456.789-00' },
        { field: 'origem', value: 'landing_page_bf' },
      ]);
    }
  });

  it('a malformed shape (object instead of array) does not fail the request — becomes a warning', () => {
    const result = parseIngestPayload({
      ...BASE,
      custom_fields: { field: 'CPF', value: '123' },
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.value.customFields).toEqual([]);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({ code: 'custom_fields_malformed' })
      );
    }
  });

  it('drops entries missing a field name', () => {
    const result = parseIngestPayload({
      ...BASE,
      custom_fields: [{ value: 'no field name' }, { field: '  ', value: 'x' }],
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.value.customFields).toEqual([]);
  });
});

describe('parseIngestPayload — template_params', () => {
  it('coerces a non-string entry instead of dropping it, preserving position', () => {
    // {{1}} não pode virar {{2}} silenciosamente por causa de um valor
    // não-string no meio do array.
    const result = parseIngestPayload({
      ...BASE,
      template_params: [12345, 'Maria'],
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.value.templateParams).toEqual(['12345', 'Maria']);
    }
  });

  it('turns null/undefined entries into an empty string, keeping the slot', () => {
    const result = parseIngestPayload({
      ...BASE,
      template_params: ['Maria', null, 'depois'],
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.value.templateParams).toEqual(['Maria', '', 'depois']);
    }
  });
});

describe('parseIngestPayload — optional fields', () => {
  it('accepts a full payload end-to-end', () => {
    const result = parseIngestPayload({
      ...BASE,
      name: 'Maria Souza',
      email: 'maria@empresa.com.br',
      company: 'Empresa LTDA',
      tags: 'Cliente VIP, lead quente',
      notes: { nota_1: 'a', nota_2: 'b' },
      custom_fields: [{ field: 'origem', value: 'lp' }],
      template_id: '3f2b8c10-2a44-4a7e-9c1e-77c3b2a1d5e0',
      template_params: ['Maria'],
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        name: 'Maria Souza',
        email: 'maria@empresa.com.br',
        company: 'Empresa LTDA',
        templateId: '3f2b8c10-2a44-4a7e-9c1e-77c3b2a1d5e0',
        templateParams: ['Maria'],
      },
    });
  });

  it('missing name falls back to null (caller lets findOrCreateContact default to the phone)', () => {
    const result = parseIngestPayload(BASE);
    expect(result).toMatchObject({ ok: true, value: { name: null } });
  });

  it('missing template_id yields null and empty template_params', () => {
    const result = parseIngestPayload(BASE);
    expect(result).toMatchObject({
      ok: true,
      value: { templateId: null, templateParams: [] },
    });
  });
});
