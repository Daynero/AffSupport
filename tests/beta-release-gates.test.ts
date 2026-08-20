import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BETA_MARKERS,
  BETA_PROFILE,
  BETA_SITE_ORIGIN
} from '../packages/shared/src/environment.js';

/**
 * The release gate calls process.exit on failure, so — following the pattern in
 * tests/release-gates-windows.test.ts — its rules are re-expressed here as pure
 * predicates the tests can drive, and the script itself is asserted to still
 * contain the checks.
 */
const GATE = readFileSync('scripts/verify-release.mjs', 'utf8');
const PUBLISHED_GATE = readFileSync('scripts/verify-published-release.mjs', 'utf8');

const PRODUCTION_FEEDING_PATHS = [
  '.env',
  '.env.production',
  'apps/web/.env.production',
  'config/production.env',
  'packages/shared/src/release.ts',
  'apps/web/public/.well-known/wishly/stable.json',
  'packaging'
];

function betaMarkerIn(contents: string): string | null {
  for (const marker of BETA_MARKERS) {
    const needle = marker === String(BETA_PROFILE.agentPort) ? `127.0.0.1:${marker}` : marker;
    if (contents.includes(needle)) return needle;
  }
  return null;
}

describe('Guard B — production must not carry beta', () => {
  it('scans every production-feeding path', () => {
    for (const target of PRODUCTION_FEEDING_PATHS) {
      expect(GATE).toContain(`'${target}'`);
    }
  });

  it.each(BETA_MARKERS)('rejects the beta marker %s in a production-feeding file', marker => {
    // Markers overlap on purpose — the bare agent port is a substring of both
    // beta origins — so the assertion is that the content is rejected, not
    // which of the overlapping markers happened to match first.
    const needle = marker === String(BETA_PROFILE.agentPort) ? `127.0.0.1:${marker}` : marker;
    expect(betaMarkerIn(`SOME_KEY=value\n${needle}\n`)).toBeTruthy();
  });

  it('accepts a production-feeding file with no beta value', () => {
    expect(betaMarkerIn(readFileSync('config/production.env', 'utf8'))).toBeNull();
    expect(betaMarkerIn(readFileSync('apps/web/.env.production', 'utf8'))).toBeNull();
  });

  it('exempts supabase/config.toml even though it names beta origins', () => {
    // The file allowlists the loopback redirect URLs that real sign-in against
    // the local stack needs. It is read only by a locally-run stack and never
    // travels into a production artifact. Scanning it would fail every release
    // for a setting that cannot reach production.
    const config = readFileSync('supabase/config.toml', 'utf8');
    expect(config).toContain(BETA_SITE_ORIGIN);
    expect(PRODUCTION_FEEDING_PATHS).not.toContain('supabase/config.toml');
    expect(GATE).not.toContain("'supabase/config.toml'");
    expect(GATE).toContain('supabase/config.toml is deliberately absent');
  });

  it('rejects a beta release identity', () => {
    expect(GATE).toContain('RELEASE_BETA_IDENTITY');
    expect(GATE).toContain('releaseChannel');
  });

  it('scans the built web bundle as well as the sources', () => {
    expect(GATE).toContain("'apps/web/dist'");
  });

  it('keeps a beta artifact out of the published update channel', () => {
    expect(PUBLISHED_GATE).toContain('RELEASE_BETA_IDENTITY');
    expect(PUBLISHED_GATE).toContain('BETA_MARKERS');
  });
});
