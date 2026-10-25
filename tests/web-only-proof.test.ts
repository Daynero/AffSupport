import { removeTemporaryDirectory } from './support/temp-dir.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { betaPackageProvenance } from '../scripts/beta-package-provenance.mjs';
import { generateKeyPairSync, sign } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { releaseManifestSigningPayload } from '../packages/shared/src/release';
import {
  assertSameUpdateChannel,
  assertProductionWebConfiguration,
  fetchLiveManifest,
  packagePayloadDigest,
  verifyLiveWebBytes
} from '../scripts/lib/web-only-proof.mjs';
import { recordReconciledPublication } from '../scripts/release-web-only.mjs';
import { selectOwnedRuntimePids } from '../scripts/verify-beta-runtime.mjs';
import { outputDigest } from '../scripts/release-web-meta.mjs';
import { candidateStaticResponse } from '../scripts/lib/web-only-runtime.mjs';
import {
  acquireWebReleaseLock,
  assertWebReleaseUnlocked,
  webReleaseStateFile
} from '../scripts/lib/web-only-lock.mjs';

const directories: string[] = [];
async function temporary() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'web-only-'));
  directories.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of directories.splice(0)) await removeTemporaryDirectory(dir);
});
function signed() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const manifest = { schemaVersion: 1, channel: 'stable', version: '1.2.7' };
  const signature = sign('sha256', Buffer.from(releaseManifestSigningPayload(manifest)), {
    key: pair.privateKey,
    dsaEncoding: 'ieee-p1363'
  }).toString('base64url');
  return {
    bytes: Buffer.from(JSON.stringify({ ...manifest, signature })),
    key: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  };
}

describe('web-only exact channel and payload', () => {
  it('verifies the real P1363 signature format and unchanged raw bytes', () => {
    const { bytes, key } = signed();
    expect(assertSameUpdateChannel(bytes, bytes, key)).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      assertSameUpdateChannel(bytes, Buffer.concat([bytes, Buffer.from('\n')]), key)
    ).toThrow('CHANNEL_CHANGED');
    expect(() => assertSameUpdateChannel(Buffer.from('{}'), Buffer.from('{}'), key)).toThrow(
      'CHANNEL_UNSIGNED'
    );
  });
  it('caps the live manifest before buffering an unbounded response', async () => {
    const binding = { siteOrigin: 'https://example.test' };
    await expect(
      fetchLiveManifest(binding, async () => new Response('a'.repeat(1024 * 1024 + 1)))
    ).rejects.toThrow('INVALID');
    await expect(
      fetchLiveManifest(binding, async () => new Response('', { status: 503 }))
    ).rejects.toThrow('UNAVAILABLE');
  });
  it('hashes package resources and internal links and detects later mutation', async () => {
    const dir = await temporary();
    await writeFile(path.join(dir, 'runtime'), 'sealed');
    await symlink('runtime', path.join(dir, 'current'));
    const first = await packagePayloadDigest(dir);
    await writeFile(path.join(dir, 'runtime'), 'changed');
    expect(await packagePayloadDigest(dir)).not.toBe(first);
  });
  it('refuses package links escaping to the host filesystem', async () => {
    const dir = await temporary();
    await symlink(os.tmpdir(), path.join(dir, 'outside'));
    await expect(packagePayloadDigest(dir)).rejects.toThrow('LINK_ESCAPE');
  });
});

describe('web-only exact beta UI and live readback', () => {
  it('fulfills only actual static bytes and leaves auth/API requests real', async () => {
    const dir = await temporary();
    await writeFile(path.join(dir, 'index.html'), '<html>candidate</html>');
    await writeFile(path.join(dir, '_headers'), '/*\n  X-Content-Type-Options: nosniff\n');
    const request = { directory: dir, origin: 'http://127.0.0.1:43140' };
    const page = await candidateStaticResponse({
      ...request,
      url: `${request.origin}/login`,
      navigation: true
    });
    expect(page?.body.toString()).toBe('<html>candidate</html>');
    expect(page?.headers['x-content-type-options']).toBe('nosniff');
    expect(
      await candidateStaticResponse({ ...request, url: `${request.origin}/api/health` })
    ).toBeNull();
    expect(
      await candidateStaticResponse({ ...request, url: 'http://127.0.0.1:54321/auth/v1/token' })
    ).toBeNull();
  });
  it('independently reads back the deployed exact files and rejects a stale asset', async () => {
    const dir = await temporary();
    await mkdir(path.join(dir, 'assets'));
    await mkdir(path.join(dir, '.well-known/wishly'), { recursive: true });
    const files: Record<string, string> = {
      'index.html': 'new page',
      'assets/app.js': 'new code',
      'logo.svg': 'new logo',
      '.well-known/wishly/stable.json': 'same channel',
      '.well-known/wishly/web-release.json': 'new identity'
    };
    for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(dir, name), bytes);
    const digest = await outputDigest(dir);
    const binding = { siteOrigin: 'https://example.test' };
    const fetcher = async (url: URL | RequestInfo) => {
      const name = new URL(String(url)).pathname.slice(1) || 'index.html';
      return new Response(files[name]);
    };
    await expect(
      verifyLiveWebBytes({ directory: dir, binding, expectedDigest: digest, fetcher })
    ).resolves.toMatchObject({ files: 5 });
    await expect(
      verifyLiveWebBytes({
        directory: dir,
        binding,
        expectedDigest: digest,
        fetcher: async url =>
          new URL(String(url)).pathname === '/logo.svg' ? new Response('old logo') : fetcher(url)
      })
    ).rejects.toThrow('MISMATCH');
    await expect(
      verifyLiveWebBytes({
        directory: dir,
        binding,
        expectedDigest: digest,
        fetcher: async () => new Response('stale')
      })
    ).rejects.toThrow('MISMATCH');
  });
});

describe('one local web release writer', () => {
  it('rejects a second writer, permits only the owning child, and releases in order', async () => {
    const dir = await temporary();
    const lock = await acquireWebReleaseLock({ root: dir, owner: 'test' });
    try {
      await expect(acquireWebReleaseLock({ root: dir, owner: 'second' })).rejects.toThrow('BUSY');
      await expect(assertWebReleaseUnlocked(dir)).rejects.toThrow('BUSY');
      await expect(assertWebReleaseUnlocked(dir, 'not-the-token')).rejects.toThrow('BUSY');
      await expect(assertWebReleaseUnlocked(dir, lock.token)).resolves.toBeUndefined();
    } finally {
      await lock.release();
    }
    await expect(assertWebReleaseUnlocked(dir)).resolves.toBeUndefined();
  });
});

describe('packaged runtime process ownership', () => {
  it('accepts only the listener spawned by the exact owned native launcher', () => {
    expect(
      selectOwnedRuntimePids(
        [123],
        122,
        '/tmp/Soty Beta.app',
        () => 122,
        () => '/tmp/Soty Beta.app/Contents/MacOS/SotyBetaAgent'
      )
    ).toEqual([122, 123]);
    expect(() =>
      selectOwnedRuntimePids(
        [123],
        122,
        '/tmp/Soty Beta.app',
        () => 999,
        () => '/tmp/Soty Beta.app/Contents/MacOS/SotyBetaAgent'
      )
    ).toThrow('OWNERSHIP_UNPROVEN');
    expect(() =>
      selectOwnedRuntimePids(
        [123],
        122,
        '/tmp/Soty Beta.app',
        () => 122,
        () => '/tmp/another-app'
      )
    ).toThrow('OWNERSHIP_UNPROVEN');
  });
});

describe('production candidate configuration', () => {
  it.each([
    { VITE_LOCAL_DEV_AUTH: 'true' },
    { VITE_MOCK_DATA: 'true' },
    { VITE_APP_ENVIRONMENT: 'beta' },
    { VITE_APP_ENVIRONMENT: 'development' }
  ])('refuses runtime authentication bypasses %j', values => {
    expect(() => assertProductionWebConfiguration(values)).toThrow('AUTH_CONFIG_UNSAFE');
  });
  it('allows real production authentication', () => {
    expect(() =>
      assertProductionWebConfiguration({
        VITE_LOCAL_DEV_AUTH: 'false',
        VITE_MOCK_DATA: 'false',
        VITE_APP_ENVIRONMENT: 'production'
      })
    ).not.toThrow();
  });
});

describe('shared unresolved-publication fence', () => {
  it('blocks full deployment and rollback writers until explicit reconciliation', async () => {
    const root = await temporary();
    const owner = await acquireWebReleaseLock({ root, owner: 'publisher' });
    await writeFile(
      await webReleaseStateFile(root, 'web-publication-pending.json'),
      JSON.stringify({ runId: 'unresolved' })
    );
    await expect(assertWebReleaseUnlocked(root, owner.token)).resolves.toBeUndefined();
    await owner.release();
    await expect(assertWebReleaseUnlocked(root)).rejects.toThrow('PUBLICATION_UNRESOLVED');
    await expect(acquireWebReleaseLock({ root, owner: 'rollback-web' })).rejects.toThrow(
      'PUBLICATION_UNRESOLVED'
    );
    const reconciler = await acquireWebReleaseLock({
      root,
      owner: 'reconcile',
      allowPending: true
    });
    await reconciler.release();
  });
});

describe('historical packaged-beta payload seal', () => {
  it('requires package-time evidence and rejects payload mutation after verification', async () => {
    const root = await temporary();
    const run = promisify(execFile);
    const git = (args: string[]) =>
      run('git', args, {
        cwd: root,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
        timeout: 5000
      });
    await git(['init', '--quiet']);
    await git(['config', 'user.name', 'Fixture']);
    await git(['config', 'user.email', 'fixture@example.test']);
    await writeFile(path.join(root, '.gitignore'), 'release/\n');
    await git(['add', '.gitignore']);
    await git(['commit', '--quiet', '-m', 'base']);
    const source = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const resources = path.join(root, 'release/beta/Soty Beta.app/Contents/Resources');
    await mkdir(resources, { recursive: true });
    await writeFile(
      path.join(resources, 'release.json'),
      JSON.stringify({ channel: 'beta', sourceRevision: source })
    );
    await writeFile(path.join(resources, 'payload'), 'original');
    await expect(betaPackageProvenance({ cwd: root, action: 'verify' })).rejects.toThrow();
    const digest = await betaPackageProvenance({ cwd: root, action: 'record' });
    expect(await betaPackageProvenance({ cwd: root, action: 'verify' })).toBe(digest);
    await writeFile(path.join(resources, 'payload'), 'tampered');
    await expect(betaPackageProvenance({ cwd: root, action: 'verify' })).rejects.toThrow(
      'PAYLOAD_CHANGED'
    );
  });
});

describe('response-lost publication history reconciliation', () => {
  it('repairs history once and preserves an independent live-smoke failure', async () => {
    const root = await temporary();
    const directory = path.join(root, 'release/automation');
    await mkdir(directory, { recursive: true });
    const deployment = {
      schemaVersion: 1,
      runId: 'owned-run',
      bindingId: 'production',
      bindingDigest: 'd'.repeat(64),
      sourceSha: 'a'.repeat(40),
      manifestSha: 'b'.repeat(40),
      outputDigest: 'c'.repeat(64)
    };
    const pending = {
      schemaVersion: 1,
      runId: deployment.runId,
      ownerRoot: root,
      archive: path.join(directory, 'bundles', deployment.outputDigest),
      outputDigest: deployment.outputDigest,
      bindingDigest: deployment.bindingDigest,
      deployment
    };
    const reportFile = path.join(directory, 'web-only-report.json');
    await writeFile(
      reportFile,
      JSON.stringify({
        runId: deployment.runId,
        sourceSha: deployment.sourceSha,
        outputDigest: deployment.outputDigest,
        state: 'blocked',
        publicationState: 'unknown',
        error: { code: 'LIVE_SMOKE_FAILED' }
      })
    );
    await recordReconciledPublication(pending, '2026-10-25T17:00:00Z');
    await recordReconciledPublication(pending, '2026-10-25T17:01:00Z');
    const history = (await readFile(path.join(directory, 'web-deployments.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ ...deployment, reconciledAt: '2026-10-25T17:00:00Z' });
    expect(JSON.parse(await readFile(reportFile, 'utf8'))).toMatchObject({
      state: 'blocked',
      publicationState: 'verified',
      error: { code: 'LIVE_SMOKE_FAILED' },
      reconciliation: { staticBytes: 'verified', liveSmoke: 'not_rechecked' }
    });
    await expect(
      recordReconciledPublication({
        ...pending,
        deployment: { ...deployment, sourceSha: 'f'.repeat(40) }
      })
    ).rejects.toThrow('REPORT_CHANGED');
  });
});
