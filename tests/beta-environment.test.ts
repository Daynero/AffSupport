import { describe, expect, it } from 'vitest';
import {
  BETA_AGENT_ORIGIN,
  BETA_PROFILE,
  BETA_SITE_ORIGIN,
  DEV_PROFILE,
  ENVIRONMENT_PROFILES,
  PRODUCTION_PROFILE,
  appEnvironmentOrProduction,
  isLoopbackOrigin,
  isProductionEndpoint,
  parseAppEnvironment
} from '@video-compressor/shared';

describe('parseAppEnvironment', () => {
  it('treats absent and empty values as production', () => {
    for (const value of [undefined, null, '', '   ']) {
      expect(parseAppEnvironment(value)).toEqual({ ok: true, value: 'production' });
    }
  });

  it('accepts the two known environments', () => {
    expect(parseAppEnvironment('production')).toEqual({ ok: true, value: 'production' });
    expect(parseAppEnvironment('beta')).toEqual({ ok: true, value: 'beta' });
    expect(parseAppEnvironment('  beta  ')).toEqual({ ok: true, value: 'beta' });
  });

  it('rejects a near-miss instead of coercing it', () => {
    // A silent fallback here would disable every beta guard while the
    // environment still looked configured.
    for (const value of ['Beta', 'BETA', 'staging', 'prod']) {
      const parsed = parseAppEnvironment(value);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain(value);
    }
  });

  it('rejects non-string values', () => {
    for (const value of [1, true, {}, []]) {
      expect(parseAppEnvironment(value).ok).toBe(false);
    }
  });

  it('fails closed to production through the convenience helper', () => {
    expect(appEnvironmentOrProduction('nonsense')).toBe('production');
    expect(appEnvironmentOrProduction('beta')).toBe('beta');
  });
});

describe('environment profiles', () => {
  const slots = ['agentPort', 'bundleId', 'supportDirectoryName', 'instanceLockName'] as const;

  it.each(slots)('gives every profile a distinct %s', slot => {
    // Production, dev, and beta must be able to run at once on one machine; a
    // shared slot is a collision waiting to happen, and a fourth profile added
    // later must not silently reuse one.
    const values = ENVIRONMENT_PROFILES.map(profile => profile[slot]);
    expect(new Set(values).size).toBe(values.length);
  });

  it('separates the beta web port from the ordinary dev server', () => {
    expect(BETA_PROFILE.webPort).not.toBe(DEV_PROFILE.webPort);
  });

  it('marks only the beta profile as the beta environment', () => {
    expect(BETA_PROFILE.environment).toBe('beta');
    expect(PRODUCTION_PROFILE.environment).toBe('production');
    expect(DEV_PROFILE.environment).toBe('production');
  });

  it('derives the beta origins from the beta profile', () => {
    expect(BETA_SITE_ORIGIN).toBe(`http://127.0.0.1:${BETA_PROFILE.webPort}`);
    expect(BETA_AGENT_ORIGIN).toBe(`http://127.0.0.1:${BETA_PROFILE.agentPort}`);
  });
});

describe('origin classification', () => {
  it('recognises loopback origins', () => {
    for (const value of [BETA_SITE_ORIGIN, BETA_AGENT_ORIGIN, 'http://localhost:5175']) {
      expect(isLoopbackOrigin(value)).toBe(true);
      expect(isProductionEndpoint(value)).toBe(false);
    }
  });

  it('treats anything off this machine as a production endpoint', () => {
    for (const value of ['https://soty.pp.ua', 'https://example.supabase.co']) {
      expect(isProductionEndpoint(value)).toBe(true);
    }
  });

  it('treats an unparseable value as a production endpoint', () => {
    // A guard that cannot prove a value is local must not assume it is.
    expect(isProductionEndpoint('not a url')).toBe(true);
  });

  it('ignores an empty value so a missing key is reported as missing, not as production', () => {
    expect(isProductionEndpoint('')).toBe(false);
  });
});
