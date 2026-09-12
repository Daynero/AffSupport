import { describe, expect, it } from 'vitest';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import { preflight } from '../scripts/lib/release/preflight.mjs';
import { resolveTargetBinding } from '../scripts/lib/release/targets.mjs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeBinding, productionBinding } from '../scripts/lib/release/bindings.mjs';
import { PRODUCTION_SITE_ORIGIN, RELEASE_DOWNLOAD_URL } from '../packages/shared/dist/release.js';
import { sandboxIntent } from './support/release-runner/fixtures';

const bindings = {
  production: {
    kind: 'production',
    bindingId: 'production',
    repository: 'daynero/AffSupport',
    releaseRepository: 'daynero/AffSupport',
    siteOrigin: 'https://soty.app',
    cloudflareProject: 'wishly-app',
    supabaseProject: 'prod',
    signingKeyFingerprint: 'public',
    artifactUrlBase: 'https://example.test/prod'
  },
  'sandbox-local': {
    kind: 'sandbox',
    bindingId: 'sandbox-local',
    repository: 'example/soty-sandbox',
    releaseRepository: 'example/soty-release-sandbox',
    siteOrigin: 'https://sandbox.example.test',
    cloudflareProject: 'sandbox-pages',
    supabaseProject: 'sandbox-db',
    signingKeyFingerprint: 'sandbox-public',
    artifactUrlBase: 'https://example.test/sandbox'
  }
};

describe('release target binding', () => {
  it('requires an explicitly disjoint sandbox target', () => {
    expect(resolveTargetBinding(sandboxIntent, bindings).kind).toBe('sandbox');
    expect(() =>
      resolveTargetBinding(sandboxIntent, {
        ...bindings,
        'sandbox-local': { ...bindings['sandbox-local'], supabaseProject: 'prod' }
      })
    ).toThrow('intersects');
  });
  it('does light dependency checks without starting heavy work', async () => {
    const result = await preflight(sandboxIntent, {
      bindings,
      probe: { inspect: async () => ({ ok: true }) },
      bridge: { inspect: async () => ({ ok: true }) }
    });
    expect(result.ok).toBe(true);
  });
  it('rejects production destinations when a sandbox intent is used', () => {
    expect(() =>
      resolveTargetBinding(sandboxIntent, {
        ...bindings,
        'sandbox-local': {
          ...bindings['sandbox-local'],
          artifactUrlBase: bindings.production.artifactUrlBase
        }
      })
    ).toThrow('intersects');
  });
});

describe('binding resolution for verifiers and deployment', () => {
  it('pins production by default and derives it from the tracked release contract', () => {
    const production = productionBinding();
    expect(production).toMatchObject({
      kind: 'production',
      siteOrigin: PRODUCTION_SITE_ORIGIN,
      cloudflareProject: 'wishly-app'
    });
    expect(RELEASE_DOWNLOAD_URL.startsWith(`${production.artifactUrlBase}/`)).toBe(true);
    expect(production.signingKeyFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(activeBinding({})).toMatchObject({ bindingId: 'production' });
  });

  it('refuses to let configuration redirect production and only accepts a disjoint sandbox', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-binding-'));
    try {
      const production = productionBinding();
      const impostor = join(root, 'impostor.json');
      await writeFile(
        impostor,
        JSON.stringify({
          ...production,
          bindingId: 'not-production',
          siteOrigin: 'https://evil.test'
        })
      );
      expect(() => activeBinding({ SOTY_RELEASE_BINDING: impostor })).toThrow('pinned');

      const overlapping = join(root, 'overlapping.json');
      await writeFile(
        overlapping,
        JSON.stringify({
          ...bindings['sandbox-local'],
          cloudflareProject: production.cloudflareProject
        })
      );
      expect(() => activeBinding({ SOTY_RELEASE_BINDING: overlapping })).toThrow('intersects');

      const sandbox = join(root, 'sandbox.json');
      await writeFile(sandbox, JSON.stringify(bindings['sandbox-local']));
      expect(activeBinding({ SOTY_RELEASE_BINDING: sandbox })).toMatchObject({
        kind: 'sandbox',
        bindingId: 'sandbox-local'
      });
    } finally {
      await removeTemporaryDirectory(root);
    }
  });
});
