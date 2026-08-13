import { afterEach, describe, expect, it } from 'vitest';
import { getDeploymentLocale, isBrDeployment } from './deployment-locale';

const ENV_KEY = 'NEXT_PUBLIC_APP_LOCALE';
const original = process.env[ENV_KEY];

afterEach(() => {
  if (original === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = original;
});

describe('getDeploymentLocale', () => {
  it('reads NEXT_PUBLIC_APP_LOCALE when it is a supported locale', () => {
    process.env[ENV_KEY] = 'en';
    expect(getDeploymentLocale()).toBe('en');
  });

  it('falls back to pt-BR when the env var is absent', () => {
    delete process.env[ENV_KEY];
    expect(getDeploymentLocale()).toBe('pt-BR');
  });

  it('falls back to pt-BR when the env var is not a supported locale', () => {
    process.env[ENV_KEY] = 'es';
    expect(getDeploymentLocale()).toBe('pt-BR');
  });
});

describe('isBrDeployment', () => {
  it('is true for pt-BR (explicit or default)', () => {
    process.env[ENV_KEY] = 'pt-BR';
    expect(isBrDeployment()).toBe(true);

    delete process.env[ENV_KEY];
    expect(isBrDeployment()).toBe(true);
  });

  it('is false for any other supported locale', () => {
    process.env[ENV_KEY] = 'en';
    expect(isBrDeployment()).toBe(false);
  });
});
