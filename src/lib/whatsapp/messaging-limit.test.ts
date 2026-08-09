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
      'TIER_2K',
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
    expect(parseTier('TIER_2000')).toBe('TIER_2K');
    expect(parseTier('TIER_100000')).toBe('TIER_100K');
  });

  it('reconhece TIER_2K — o valor que a conta de produção devolve', () => {
    // Regressão: sem TIER_2K na tabela, este era o caminho pelo qual
    // uma conta de 2 000 contatos por disparo era tratada como 250.
    expect(parseTier('TIER_2K')).toBe('TIER_2K');
    expect(tierCap(parseTier('TIER_2K'))).toBe(2000);
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
  it('usa o teto cheio do tier, sem margem de segurança', () => {
    const q = computeQuota({
      tier: 'TIER_2K',
      usedLast24h: 0,
      source: 'meta',
    });

    expect(q.batchLimit).toBe(2000);
  });

  it('NÃO desconta o que já foi enviado nas últimas 24 h', () => {
    // O invariante central deste ajuste. O tier é o teto de UM disparo,
    // não um saldo diário: quem já alcançou 900 contatos hoje continua
    // podendo montar uma audiência de 1 000.
    const q = computeQuota({
      tier: 'TIER_1K',
      usedLast24h: 900,
      source: 'meta',
    });

    expect(q.batchLimit).toBe(1000);
    expect(q.usedLast24h).toBe(900);
  });

  it('mantém o limite mesmo com uso acima do teto na janela', () => {
    // Três disparos de 400 num TIER_250 são possíveis; o que não é
    // possível é um único disparo de 400.
    const q = computeQuota({
      tier: 'TIER_250',
      usedLast24h: 1200,
      source: 'meta',
    });

    expect(q.batchLimit).toBe(250);
  });

  it('trata TIER_UNLIMITED como sem teto', () => {
    const q = computeQuota({
      tier: 'TIER_UNLIMITED',
      usedLast24h: 999_999,
      source: 'meta',
    });

    expect(q.batchLimit).toBe(Number.POSITIVE_INFINITY);
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

    expect(payload.batchLimit).toBeNull();
    expect(JSON.parse(JSON.stringify(payload)).batchLimit).toBeNull();
  });

  it('mantém números finitos intactos', () => {
    const payload = serializeQuota(
      computeQuota({ tier: 'TIER_2K', usedLast24h: 100, source: 'cache' })
    );

    expect(payload).toMatchObject({
      tier: 'TIER_2K',
      batchLimit: 2000,
      usedLast24h: 100,
      source: 'cache',
      stale: true,
    });
  });
});
