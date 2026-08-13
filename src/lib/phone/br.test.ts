import { describe, expect, it } from 'vitest';
import { normalizeContactPhone, formatPhoneForDisplay } from './br';

// `brMode` é passado explicitamente em todo teste — o default via
// `isBrDeployment()` (que lê `process.env.NEXT_PUBLIC_APP_LOCALE`) é
// coberto separadamente em `deployment-locale.test.ts`.

describe('normalizeContactPhone — modo BR', () => {
  const br = { brMode: true };

  it('normaliza um celular formatado com máscara e DDI', () => {
    const r = normalizeContactPhone('+55 (19) 9 9249-6598', br);
    expect(r).toMatchObject({
      ok: true,
      phone: '5519992496598',
      kind: 'mobile',
    });
  });

  it('adiciona o DDI quando ausente', () => {
    const r = normalizeContactPhone('19992496598', br);
    expect(r).toMatchObject({
      ok: true,
      phone: '5519992496598',
      kind: 'mobile',
    });
  });

  it('aceita fixo (10 dígitos, DDI adicionado)', () => {
    const r = normalizeContactPhone('(11) 3456-7890', br);
    expect(r).toMatchObject({
      ok: true,
      phone: '551134567890',
      kind: 'landline',
    });
  });

  it('remove o zero de tronco da discagem nacional', () => {
    const r = normalizeContactPhone('011 99999-9999', br);
    expect(r).toMatchObject({
      ok: true,
      phone: '5511999999999',
      kind: 'mobile',
    });
  });

  it('não confunde DDI+DDD 55 com DDD 55 sem DDI', () => {
    const withDdi = normalizeContactPhone('5551987654321', br);
    expect(withDdi).toMatchObject({
      ok: true,
      phone: '5551987654321',
      ddd: 51,
    });

    const dddRsNoDdi = normalizeContactPhone('55987654321', br);
    expect(dddRsNoDdi).toMatchObject({
      ok: true,
      phone: '5555987654321',
      ddd: 55,
      kind: 'mobile',
    });
  });

  it('rejeita DDD inexistente', () => {
    expect(normalizeContactPhone('10 98765-4321', br)).toEqual({
      ok: false,
      reason: 'invalid_ddd',
    });
  });

  it('rejeita comprimento inválido (nem 10 nem 11 dígitos nacionais)', () => {
    expect(normalizeContactPhone('11 9876-543', br)).toEqual({
      ok: false,
      reason: 'invalid_length',
    });
  });

  it('aceita número estrangeiro em vez de rejeitar', () => {
    const r = normalizeContactPhone('+351 912 345 678', br);
    expect(r).toMatchObject({ ok: true, kind: 'foreign' });
  });

  it('rejeita vazio e lixo', () => {
    expect(normalizeContactPhone('', br)).toEqual({
      ok: false,
      reason: 'empty',
    });
    expect(normalizeContactPhone('abc', br)).toEqual({
      ok: false,
      reason: 'empty',
    });
  });

  describe('D-6 — celular legado de 8 dígitos', () => {
    it('aceita como mobile_legacy, com a flag legacy', () => {
      const r = normalizeContactPhone('11 9876-5432', br);
      expect(r).toMatchObject({
        ok: true,
        phone: '551198765432',
        kind: 'mobile_legacy',
        legacy: true,
      });
    });

    it('aceita fixo com inicial 8 como landline (indistinguível do legado, D-6)', () => {
      const r = normalizeContactPhone('11 8765-4321', br);
      expect(r).toMatchObject({ ok: true, kind: 'landline', legacy: false });
    });

    it('rejeita local iniciado em 1 (tronco/serviço)', () => {
      expect(normalizeContactPhone('11 1234-5678', br)).toEqual({
        ok: false,
        reason: 'invalid_local_prefix',
      });
    });

    it('rejeita local iniciado em 0', () => {
      expect(normalizeContactPhone('11 0234-5678', br)).toEqual({
        ok: false,
        reason: 'invalid_local_prefix',
      });
    });

    it('rejeita celular de 11 dígitos sem o nono dígito inicial', () => {
      expect(normalizeContactPhone('11 88765-4321', br)).toEqual({
        ok: false,
        reason: 'mobile_invalid_ninth_digit',
      });
    });

    it('não fragmenta a base: o legado casa com o mesmo contato via phonesMatch', async () => {
      const { phonesMatch } = await import('@/lib/whatsapp/phone-utils');
      expect(phonesMatch('551198765432', '5511998765432')).toBe(true);
    });
  });
});

describe('normalizeContactPhone — modo não-BR', () => {
  const nonBr = { brMode: false };

  it('recusa número doméstico sem DDI em vez de adivinhar o país', () => {
    expect(normalizeContactPhone('19992496598', nonBr)).toEqual({
      ok: false,
      reason: 'missing_country_code',
    });
  });

  it('continua aceitando número com DDI explícito (BR ou estrangeiro)', () => {
    expect(normalizeContactPhone('+351 912 345 678', nonBr)).toMatchObject({
      ok: true,
      kind: 'foreign',
    });
    expect(normalizeContactPhone('+5519992496598', nonBr)).toMatchObject({
      ok: true,
      kind: 'mobile',
    });
  });
});

describe('formatPhoneForDisplay', () => {
  it('formata celular BR', () => {
    expect(formatPhoneForDisplay('5519992496598')).toBe('+55 (19) 99249-6598');
  });

  it('formata fixo BR', () => {
    expect(formatPhoneForDisplay('551134567890')).toBe('+55 (11) 3456-7890');
  });

  it('cai no fallback genérico para número estrangeiro', () => {
    expect(formatPhoneForDisplay('351912345678')).toBe('+351912345678');
  });

  it('nunca lança — string vazia devolve string vazia', () => {
    expect(formatPhoneForDisplay('')).toBe('');
  });
});
