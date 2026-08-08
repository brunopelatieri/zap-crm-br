import { describe, expect, it } from 'vitest';
import {
  FALLBACK_TIER,
  computeQuota,
  isCacheFresh,
  parseTier,
  serializeQuota,
  tierCap,
  tierFromResponse,
} from './messaging-limit';

describe('parseTier', () => {
  it('reconhece cada tier documentado', () => {
    for (const tier of [
      'TIER_50',
      'TIER_250',
      'TIER_1K',
      'TIER_10K',
      'TIER_100K',
      'TIER_UNLIMITED',
    ]) {
      expect(parseTier(tier)).toBe(tier);
    }
  });

  it('normaliza caixa e separadores', () => {
    expect(parseTier('tier_1k')).toBe('TIER_1K');
    expect(parseTier('Tier 1K')).toBe('TIER_1K');
    expect(parseTier('tier-10k')).toBe('TIER_10K');
  });

  it('aceita o valor sem o prefixo TIER_', () => {
    expect(parseTier('1K')).toBe('TIER_1K');
  });

  it('aceita a forma escrita por extenso', () => {
    expect(parseTier('TIER_1000')).toBe('TIER_1K');
    expect(parseTier('TIER_100000')).toBe('TIER_100K');
  });

  // ---- falhar fechado -------------------------------------------------

  it('cai no tier mais restritivo para valor desconhecido', () => {
    // Tratar desconhecido como ilimitado autorizaria justamente o
    // disparo que a Meta vai rejeitar no meio.
    expect(parseTier('TIER_BANANA')).toBe(FALLBACK_TIER);
  });

  it('cai no fallback para campo ausente, vazio ou não-string', () => {
    expect(parseTier(undefined)).toBe(FALLBACK_TIER);
    expect(parseTier(null)).toBe(FALLBACK_TIER);
    expect(parseTier('')).toBe(FALLBACK_TIER);
    expect(parseTier('   ')).toBe(FALLBACK_TIER);
    expect(parseTier(1000)).toBe(FALLBACK_TIER);
  });

  it('trata NOT_APPLICABLE como restritivo, não como ilimitado', () => {
    expect(parseTier('TIER_NOT_APPLICABLE')).toBe(FALLBACK_TIER);
  });
});

describe('tierFromResponse', () => {
  it('lê o campo do nó de número de telefone', () => {
    expect(tierFromResponse({ messaging_limit_tier: 'TIER_1K' })).toBe(
      'TIER_1K'
    );
  });

  it('lê o campo do nó de Business Manager', () => {
    expect(
      tierFromResponse({
        whatsapp_business_manager_messaging_limit: 'TIER_10K',
      })
    ).toBe('TIER_10K');
  });

  it('prefere messaging_limit_tier quando os dois vêm', () => {
    expect(
      tierFromResponse({
        messaging_limit_tier: 'TIER_1K',
        whatsapp_business_manager_messaging_limit: 'TIER_100K',
      })
    ).toBe('TIER_1K');
  });

  it('cai no fallback quando nenhum dos dois campos veio', () => {
    expect(tierFromResponse({ id: '123' })).toBe(FALLBACK_TIER);
  });
});

describe('tierCap', () => {
  it('mapeia tier para teto', () => {
    expect(tierCap('TIER_1K')).toBe(1000);
    expect(tierCap('TIER_UNLIMITED')).toBe(Number.POSITIVE_INFINITY);
  });

  it('usa o teto do fallback para tier desconhecido', () => {
    expect(tierCap('TIER_QUALQUER')).toBe(250);
  });
});

describe('computeQuota', () => {
  it('desconta o que já foi enviado na janela de 24 h', () => {
    const q = computeQuota({
      tier: 'TIER_1K',
      usedLast24h: 340,
      source: 'meta',
    });

    // 1000 − 5% = 950 efetivo; 950 − 340 = 610.
    expect(q.effectiveCap).toBe(950);
    expect(q.remaining).toBe(610);
  });

  it('aplica a margem de segurança sobre o teto bruto', () => {
    const q = computeQuota({
      tier: 'TIER_250',
      usedLast24h: 0,
      source: 'meta',
    });

    expect(q.tierCap).toBe(250);
    expect(q.effectiveCap).toBe(237); // floor(250 * 0.95)
  });

  it('permite desativar a margem', () => {
    const q = computeQuota({
      tier: 'TIER_250',
      usedLast24h: 0,
      source: 'meta',
      safetyMargin: 0,
    });

    expect(q.effectiveCap).toBe(250);
  });

  it('limita remaining em zero quando a conta já passou do teto', () => {
    // Acontece de verdade: a contagem da Meta diverge da nossa, ou
    // alguém disparou fora do CRM. "-120 disponíveis" não é exibível.
    const q = computeQuota({
      tier: 'TIER_250',
      usedLast24h: 400,
      source: 'meta',
    });

    expect(q.remaining).toBe(0);
  });

  it('trata TIER_UNLIMITED como sem teto', () => {
    const q = computeQuota({
      tier: 'TIER_UNLIMITED',
      usedLast24h: 999_999,
      source: 'meta',
    });

    expect(q.remaining).toBe(Number.POSITIVE_INFINITY);
    expect(q.effectiveCap).toBe(Number.POSITIVE_INFINITY);
  });

  it('marca stale quando a origem não é a Meta', () => {
    expect(
      computeQuota({ tier: 'TIER_1K', usedLast24h: 0, source: 'meta' }).stale
    ).toBe(false);
    expect(
      computeQuota({ tier: 'TIER_1K', usedLast24h: 0, source: 'cache' }).stale
    ).toBe(true);
    expect(
      computeQuota({ tier: 'TIER_1K', usedLast24h: 0, source: 'fallback' })
        .stale
    ).toBe(true);
  });

  it('sanitiza contagem negativa ou não numérica', () => {
    expect(
      computeQuota({ tier: 'TIER_1K', usedLast24h: -5, source: 'meta' })
        .usedLast24h
    ).toBe(0);
    expect(
      computeQuota({
        tier: 'TIER_1K',
        usedLast24h: Number.NaN,
        source: 'meta',
      }).usedLast24h
    ).toBe(0);
  });
});

describe('isCacheFresh', () => {
  const now = new Date('2026-08-07T12:00:00Z');

  it('aceita leitura recente', () => {
    expect(isCacheFresh('2026-08-07T11:50:00Z', now)).toBe(true);
  });

  it('rejeita leitura além do TTL de 15 min', () => {
    expect(isCacheFresh('2026-08-07T11:40:00Z', now)).toBe(false);
  });

  it('rejeita ausência de leitura', () => {
    expect(isCacheFresh(null, now)).toBe(false);
    expect(isCacheFresh(undefined, now)).toBe(false);
  });

  it('rejeita timestamp inválido', () => {
    expect(isCacheFresh('não é data', now)).toBe(false);
  });

  it('rejeita timestamp no futuro', () => {
    // Relógio torto entre app e banco não pode virar cache eterno.
    expect(isCacheFresh('2026-08-07T13:00:00Z', now)).toBe(false);
  });
});

describe('serializeQuota', () => {
  it('converte Infinity em null para sobreviver ao JSON', () => {
    const payload = serializeQuota(
      computeQuota({
        tier: 'TIER_UNLIMITED',
        usedLast24h: 10,
        source: 'meta',
      })
    );

    expect(payload.remaining).toBeNull();
    expect(payload.tierCap).toBeNull();
    expect(JSON.parse(JSON.stringify(payload)).remaining).toBeNull();
  });

  it('mantém números finitos intactos', () => {
    const payload = serializeQuota(
      computeQuota({ tier: 'TIER_1K', usedLast24h: 100, source: 'cache' })
    );

    expect(payload).toMatchObject({
      tier: 'TIER_1K',
      tierCap: 1000,
      effectiveCap: 950,
      usedLast24h: 100,
      remaining: 850,
      source: 'cache',
      stale: true,
    });
  });
});
