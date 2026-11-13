import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchNativeUpdateManifest } from '../apps/agent/src/update/preparation';
import { releaseManifestSigningPayload } from '../packages/shared/src/release';
import { nativeCandidate } from './support/native-app-updates';
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
function envelope() {
  const value = {
    schemaVersion: 1,
    channel: 'stable',
    version: '9.0.0',
    buildNumber: '999',
    buildId: '9.0.0+999',
    nativeUpdates: { 'macos-arm64': nativeCandidate() },
    signature: ''
  };
  value.signature = sign('sha256', Buffer.from(releaseManifestSigningPayload(value)), {
    key: keys.privateKey,
    dsaEncoding: 'ieee-p1363'
  }).toString('base64url');
  return value;
}
const input = () => ({
  url: 'https://fixed.invalid/stable.json',
  publicKey,
  channel: 'stable',
  target: 'macos-arm64',
  signal: new AbortController().signal
});
afterEach(() => vi.unstubAllGlobals());
describe('dual-bound native archive descriptor', () => {
  it('returns the exact canonical signed bytes for native independent verification', async () => {
    const manifest = envelope();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(manifest)))
    );
    const result = await fetchNativeUpdateManifest(input());
    expect(Buffer.from(result.payload, 'base64').toString()).toBe(
      releaseManifestSigningPayload(manifest)
    );
    expect(result.candidate.archive.edSignature).toBe(nativeCandidate().archive.edSignature);
  });
  it.each(['length', 'sha256', 'edSignature', 'url'] as const)(
    'refuses a changed archive %s after signing',
    async key => {
      const manifest = envelope();
      if (key === 'length') manifest.nativeUpdates['macos-arm64'].archive.length = 6;
      else if (key === 'sha256')
        manifest.nativeUpdates['macos-arm64'].archive.sha256 = 'b'.repeat(64);
      else if (key === 'edSignature')
        manifest.nativeUpdates['macos-arm64'].archive.edSignature = Buffer.alloc(64, 1).toString(
          'base64'
        );
      else manifest.nativeUpdates['macos-arm64'].archive.url += '?other';
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify(manifest)))
      );
      await expect(fetchNativeUpdateManifest(input())).rejects.toThrow(
        'APP_UPDATE_MANIFEST_INVALID'
      );
    }
  );
  it('does not substitute another architecture or a legacy manifest', async () => {
    const manifest = envelope();
    delete (manifest.nativeUpdates as Partial<typeof manifest.nativeUpdates>)['macos-arm64'];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(manifest)))
    );
    await expect(fetchNativeUpdateManifest(input())).rejects.toThrow('APP_UPDATE_MANIFEST_INVALID');
  });
});
