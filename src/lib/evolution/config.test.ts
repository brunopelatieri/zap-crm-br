import { describe, it, expect } from 'vitest';

import { readEvolutionConfig, isEvolutionConfigured } from './config';

describe('readEvolutionConfig', () => {
  it('sem EVOLUTION_API_URL ou EVOLUTION_GLOBAL_API_KEY, devolve null', () => {
    expect(readEvolutionConfig({})).toBeNull();
    expect(
      readEvolutionConfig({ EVOLUTION_API_URL: 'https://evo.example.com' })
    ).toBeNull();
    expect(
      readEvolutionConfig({ EVOLUTION_GLOBAL_API_KEY: 'secret' })
    ).toBeNull();
  });

  it('com as duas variáveis obrigatórias, devolve config com padrões', () => {
    const config = readEvolutionConfig({
      EVOLUTION_API_URL: 'https://evo.example.com',
      EVOLUTION_GLOBAL_API_KEY: 'secret',
    });
    expect(config).toEqual({
      apiUrl: 'https://evo.example.com',
      globalApiKey: 'secret',
      maxInstancesPerAccount: 3,
      maxInstancesTotal: 20,
      instancePrefix: 'zapcrm',
      webhookPublicUrl: null,
      requestTimeoutMs: 15_000,
      mediaRequestTimeoutMs: 60_000,
    });
  });

  it('remove barra final de EVOLUTION_API_URL', () => {
    const config = readEvolutionConfig({
      EVOLUTION_API_URL: 'https://evo.example.com/',
      EVOLUTION_GLOBAL_API_KEY: 'secret',
    });
    expect(config?.apiUrl).toBe('https://evo.example.com');
  });

  it('EVOLUTION_WEBHOOK_PUBLIC_URL tem prioridade sobre NEXT_PUBLIC_SITE_URL', () => {
    const config = readEvolutionConfig({
      EVOLUTION_API_URL: 'https://evo.example.com',
      EVOLUTION_GLOBAL_API_KEY: 'secret',
      EVOLUTION_WEBHOOK_PUBLIC_URL: 'https://tunnel.example.com',
      NEXT_PUBLIC_SITE_URL: 'https://app.example.com',
    });
    expect(config?.webhookPublicUrl).toBe('https://tunnel.example.com');
  });

  it('cai em NEXT_PUBLIC_SITE_URL quando EVOLUTION_WEBHOOK_PUBLIC_URL está ausente', () => {
    const config = readEvolutionConfig({
      EVOLUTION_API_URL: 'https://evo.example.com',
      EVOLUTION_GLOBAL_API_KEY: 'secret',
      NEXT_PUBLIC_SITE_URL: 'https://app.example.com',
    });
    expect(config?.webhookPublicUrl).toBe('https://app.example.com');
  });

  it.each(['abc', '-1', '0', '3.5', ''])(
    'valor inválido (%s) para EVOLUTION_MAX_INSTANCES_PER_ACCOUNT cai no padrão',
    (raw) => {
      const config = readEvolutionConfig({
        EVOLUTION_API_URL: 'https://evo.example.com',
        EVOLUTION_GLOBAL_API_KEY: 'secret',
        EVOLUTION_MAX_INSTANCES_PER_ACCOUNT: raw,
      });
      expect(config?.maxInstancesPerAccount).toBe(3);
    }
  );

  it('lê overrides numéricos válidos', () => {
    const config = readEvolutionConfig({
      EVOLUTION_API_URL: 'https://evo.example.com',
      EVOLUTION_GLOBAL_API_KEY: 'secret',
      EVOLUTION_MAX_INSTANCES_PER_ACCOUNT: '5',
      EVOLUTION_MAX_INSTANCES_TOTAL: '50',
      EVOLUTION_INSTANCE_PREFIX: 'myapp',
      EVOLUTION_REQUEST_TIMEOUT_MS: '30000',
      EVOLUTION_MEDIA_REQUEST_TIMEOUT_MS: '90000',
    });
    expect(config).toMatchObject({
      maxInstancesPerAccount: 5,
      maxInstancesTotal: 50,
      instancePrefix: 'myapp',
      requestTimeoutMs: 30_000,
      mediaRequestTimeoutMs: 90_000,
    });
  });

  it('EVOLUTION_MEDIA_REQUEST_TIMEOUT_MS inválido cai no padrão de 60s', () => {
    const config = readEvolutionConfig({
      EVOLUTION_API_URL: 'https://evo.example.com',
      EVOLUTION_GLOBAL_API_KEY: 'secret',
      EVOLUTION_MEDIA_REQUEST_TIMEOUT_MS: 'abc',
    });
    expect(config?.mediaRequestTimeoutMs).toBe(60_000);
  });
});

describe('isEvolutionConfigured', () => {
  it('reflete a presença das variáveis obrigatórias', () => {
    expect(isEvolutionConfigured({})).toBe(false);
    expect(
      isEvolutionConfigured({
        EVOLUTION_API_URL: 'https://evo.example.com',
        EVOLUTION_GLOBAL_API_KEY: 'secret',
      })
    ).toBe(true);
  });
});
