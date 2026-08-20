import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RELEASE_MANIFEST_PUBLIC_KEY_SPKI_B64 } from '../packages/shared/src/release.js';

/**
 * The gate calls process.exit, so its rules are re-expressed here as pure
 * predicates and the script is asserted to still carry the checks — the same
 * approach tests/release-gates-windows.test.ts takes with verify-release.mjs.
 */
const GATE = readFileSync('scripts/verify-beta-promotion.mjs', 'utf8');
const PACKAGING = readFileSync('scripts/package-beta-mac.sh', 'utf8');
const SMOKE = readFileSync('scripts/verify-beta-package.sh', 'utf8');
const ROOT_PACKAGE = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts: Record<string, string>;
};

type Record_ = { sourceRevision?: unknown; dirty?: unknown; verifiedAt?: unknown } | null;

/** Mirrors the record rules in verify-beta-promotion.mjs. */
function recordRejection(head: string, contained: boolean, record: Record_): string | null {
  if (!contained) return 'not contained in the beta line';
  if (!record) return 'no verification record';
  if (typeof record.sourceRevision !== 'string' || !record.sourceRevision) {
    return 'record names no source revision';
  }
  if (record.sourceRevision !== head) return 'record is for a different revision';
  if (record.dirty === true) return 'record is from a dirty worktree';
  if (typeof record.verifiedAt !== 'string' || !record.verifiedAt) return 'record has no timestamp';
  return null;
}

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const GOOD = { sourceRevision: HEAD, dirty: false, verifiedAt: '2026-08-20T00:00:00Z' };

describe('promotion gate', () => {
  it('accepts a commit contained in beta with a matching, clean record', () => {
    expect(recordRejection(HEAD, true, GOOD)).toBeNull();
  });

  it('refuses a commit that is not contained in the beta line', () => {
    expect(recordRejection(HEAD, false, GOOD)).toBe('not contained in the beta line');
  });

  it('refuses when no verification record exists', () => {
    expect(recordRejection(HEAD, true, null)).toBe('no verification record');
  });

  it('refuses a record from a different revision', () => {
    // A pass on other code proves nothing about this one, so a stale record
    // must not be reusable.
    expect(recordRejection(HEAD, true, { ...GOOD, sourceRevision: OTHER })).toBe(
      'record is for a different revision'
    );
  });

  it('refuses a record built from a dirty worktree', () => {
    expect(recordRejection(HEAD, true, { ...GOOD, dirty: true })).toBe(
      'record is from a dirty worktree'
    );
  });

  it('refuses a record with no verification timestamp', () => {
    expect(recordRejection(HEAD, true, { ...GOOD, verifiedAt: '' })).toBe(
      'record has no timestamp'
    );
  });

  it('asks git for containment rather than trusting a note', () => {
    expect(GATE).toContain('merge-base');
    expect(GATE).toContain('--is-ancestor');
  });

  it('reports the divergence between the lines before returning a verdict', () => {
    expect(GATE).toContain('On HEAD but not on');
    expect(GATE).toContain('Not yet promoted');
  });

  it('is chained into every command that publishes', () => {
    for (const command of [
      'deploy:web',
      'deploy:web:identity',
      'deploy:web:member-pilot',
      'package:mac'
    ]) {
      expect(ROOT_PACKAGE.scripts[command]).toContain('verify-beta-promotion.mjs');
    }
  });
});

describe('packaged beta build', () => {
  it('authenticates for real, unlike the dev package', () => {
    // scripts/package-dev-mac.sh sets this to true; copying that line would
    // silently gut the feature by faking sign-in.
    expect(PACKAGING).toContain('VITE_LOCAL_DEV_AUTH=false');
    expect(PACKAGING).not.toContain('VITE_LOCAL_DEV_AUTH=true');
    expect(SMOKE).toContain('VITE_LOCAL_DEV_AUTH=false');
  });

  it('enforces the entitlement gate with a beta key that is not the production key', () => {
    expect(PACKAGING).toContain('The beta entitlement key is the production key');
    expect(SMOKE).toContain('beta_key" != "$production_key');
  });

  it('carries a beta identity in every slot', () => {
    for (const marker of [
      'com.wishly.beta',
      'Soty Beta',
      'wishly-beta-agent.lock',
      'RELEASE_CHANNEL=beta',
      '43140'
    ]) {
      expect(PACKAGING).toContain(marker);
    }
  });

  it('derives its version from PRODUCT_VERSION rather than forking release identity', () => {
    expect(PACKAGING).toContain('$base_version-beta.');
    expect(PACKAGING).toContain('release-meta.mjs product-version');
  });

  it('refuses to touch production release identity, migrations, or tags', () => {
    for (const guarded of [
      'packages/shared/src/release.ts',
      'apps/web/public/.well-known/wishly/stable.json',
      'config/production.env',
      'supabase/migrations'
    ]) {
      expect(PACKAGING).toContain(guarded);
    }
    expect(PACKAGING).toContain('created or removed a git tag');
  });

  it('is never signed by, or reachable from, the production release-manifest key', () => {
    // That key signs stable.json and nothing else, and beta never writes it.
    expect(PACKAGING).not.toContain(RELEASE_MANIFEST_PUBLIC_KEY_SPKI_B64);
    expect(PACKAGING).not.toContain('sign-release-manifest');
    expect(SMOKE).toContain('sign-release-manifest');
  });

  it('writes the verification record only after every assertion passes', () => {
    const recordIndex = SMOKE.indexOf('cat > "$record"');
    const lastAssertion = SMOKE.lastIndexOf('[[ "$beta_key" != "$production_key" ]]');
    expect(recordIndex).toBeGreaterThan(lastAssertion);
  });
});
