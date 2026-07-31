import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  RELEASE_MANIFEST_PUBLIC_KEY_SPKI_B64,
  releaseManifestSigningPayload,
  type StableReleaseManifest
} from '../packages/shared/src/release.js';
import { loadStableReleaseManifest } from '../apps/web/src/release-manifest.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const publicKeyBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

function baseManifest(): StableReleaseManifest {
  return {
    schemaVersion: 1,
    channel: 'stable',
    version: '0.8.4',
    buildNumber: '29',
    buildId: '0.8.4+29',
    apiVersion: 5,
    minimumSupportedVersion: '0.4.0',
    publishedAt: '2026-07-28T20:36:44.000Z',
    artifacts: { 'macos-arm64': { url: 'https://example.com/wishly.dmg', sha256: 'a'.repeat(64) } },
    toolRequirements: {
      compressor: { compressor: 3, imageEmbedding: 2 },
      landingOptimizer: { landingOptimizer: 2 },
      landingPreview: { landingPreview: 1 },
      transcription: { transcription: 4 }
    }
  };
}

function signManifest(manifest: StableReleaseManifest): StableReleaseManifest {
  const signature = signBytes(
    'sha256',
    Buffer.from(releaseManifestSigningPayload(manifest), 'utf8'),
    { key: privateKey, dsaEncoding: 'ieee-p1363' }
  ).toString('base64url');
  return { ...manifest, signature };
}

function fetcherFor(manifest: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(manifest), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })) as typeof fetch;
}

describe('release manifest signature', () => {
  it('accepts a correctly signed manifest', async () => {
    const manifest = signManifest(baseManifest());
    await expect(
      loadStableReleaseManifest(fetcherFor(manifest), publicKeyBase64)
    ).resolves.toMatchObject({ version: '0.8.4' });
  });

  it('accepts the signed manifest regardless of key order', async () => {
    const manifest = signManifest(baseManifest());
    const reordered = Object.fromEntries(Object.entries(manifest).reverse());
    await expect(
      loadStableReleaseManifest(fetcherFor(reordered), publicKeyBase64)
    ).resolves.toBeTruthy();
  });

  it('rejects an unsigned manifest', async () => {
    await expect(
      loadStableReleaseManifest(fetcherFor(baseManifest()), publicKeyBase64)
    ).rejects.toThrow('RELEASE_MANIFEST_UNSIGNED');
  });

  it('rejects a manifest altered after signing', async () => {
    const manifest = signManifest(baseManifest());
    const tampered = {
      ...manifest,
      artifacts: {
        'macos-arm64': { url: 'https://evil.example/wishly.dmg', sha256: 'b'.repeat(64) }
      }
    };
    await expect(loadStableReleaseManifest(fetcherFor(tampered), publicKeyBase64)).rejects.toThrow(
      'RELEASE_MANIFEST_UNSIGNED'
    );
  });

  it('rejects a manifest signed by a different key', async () => {
    const manifest = signManifest(baseManifest());
    await expect(loadStableReleaseManifest(fetcherFor(manifest))).rejects.toThrow(
      'RELEASE_MANIFEST_UNSIGNED'
    );
  });

  it('ships a published stable.json that verifies with the embedded key', async () => {
    const published = JSON.parse(
      readFileSync('apps/web/public/.well-known/wishly/stable.json', 'utf8')
    ) as StableReleaseManifest;
    await expect(
      loadStableReleaseManifest(fetcherFor(published), RELEASE_MANIFEST_PUBLIC_KEY_SPKI_B64)
    ).resolves.toBeTruthy();
  });
});
