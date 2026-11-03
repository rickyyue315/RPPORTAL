import { describe, expect, it, vi } from 'vitest';
import { assertProductionSecrets, isWeakPortalSecret } from '../src/config.js';

const STRONG_SHARED = 'Ndrf-Test-Only-Shared-Pass-2026!';
const STRONG_OM = 'Ndrf-Test-Only-OM-Pass-2026!';

function productionEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    PORTAL_STORE_SHARED_PASSWORD_ENABLED: 'false',
    PORTAL_OM_SHARED_PASSWORD_ENABLED: 'false',
    ...overrides,
  };
}

describe('portal secret fail-closed policy', () => {
  it('treats missing, short and known-default values as weak', () => {
    for (const value of ['', '   ', 'short', 'SASA1234', 'SASAOM178', 'change-me', 'test-password']) {
      expect(isWeakPortalSecret(value), value).toBe(true);
    }
    expect(isWeakPortalSecret(STRONG_SHARED)).toBe(false);
  });

  it('allows production to start with Store/OM shared login disabled and no shared secrets', () => {
    expect(() => assertProductionSecrets(productionEnv())).not.toThrow();
  });

  it('never requires or accepts a shared secret when shared login is disabled', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() => assertProductionSecrets(productionEnv({
        PORTAL_SHARED_PASSWORD: 'SASA1234',
      }))).not.toThrow();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses to enable Store shared login without a strong PORTAL_SHARED_PASSWORD', () => {
    expect(() => assertProductionSecrets(productionEnv({
      PORTAL_STORE_SHARED_PASSWORD_ENABLED: 'true',
    }))).toThrow(/PORTAL_SHARED_PASSWORD/);

    expect(() => assertProductionSecrets(productionEnv({
      PORTAL_STORE_SHARED_PASSWORD_ENABLED: 'true',
      PORTAL_SHARED_PASSWORD: 'SASA1234',
    }))).toThrow(/PORTAL_SHARED_PASSWORD/);

    expect(() => assertProductionSecrets(productionEnv({
      PORTAL_STORE_SHARED_PASSWORD_ENABLED: 'true',
      PORTAL_SHARED_PASSWORD: STRONG_SHARED,
    }))).not.toThrow();
  });

  it('refuses to enable OM shared login without a strong PORTAL_OM_PASSWORD', () => {
    expect(() => assertProductionSecrets(productionEnv({
      PORTAL_OM_SHARED_PASSWORD_ENABLED: 'true',
    }))).toThrow(/PORTAL_OM_PASSWORD/);

    expect(() => assertProductionSecrets(productionEnv({
      PORTAL_OM_SHARED_PASSWORD_ENABLED: 'true',
      PORTAL_OM_PASSWORD: 'SASAOM178',
    }))).toThrow(/PORTAL_OM_PASSWORD/);

    expect(() => assertProductionSecrets(productionEnv({
      PORTAL_OM_SHARED_PASSWORD_ENABLED: 'true',
      PORTAL_OM_PASSWORD: STRONG_OM,
    }))).not.toThrow();
  });

  it('does not enforce production policy outside production', () => {
    expect(() => assertProductionSecrets({
      NODE_ENV: 'development',
      PORTAL_STORE_SHARED_PASSWORD_ENABLED: 'true',
    })).not.toThrow();
  });
});
