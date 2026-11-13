import { itRequiring, requirePlatform } from './support/requires.js';
const itPosix = itRequiring.bind(null, requirePlatform('darwin', 'linux'));
import { removeTemporaryDirectory } from './support/temp-dir.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  webPublicationOrigin,
  webOnlyLiveSmokeChecks,
  packagePayloadDigest,
  verifyLiveWebBytes
} from '../scripts/lib/web-only-proof.mjs';
import { recordReconciledPublication, runWebOnly } from '../scripts/release-web-only.mjs';
import { activeBinding } from '../scripts/lib/release/bindings.mjs';
import { selectOwnedRuntimePids } from '../scripts/verify-beta-runtime.mjs';
import { outputDigest } from '../scripts/release-web-meta.mjs';
import { candidateStaticResponse } from '../scripts/lib/web-only-runtime.mjs';
import { readHistory, readState } from '../scripts/lib/release-channel/state.mjs';
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
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const dir of directories.splice(0)) await removeTemporaryDirectory(dir);
});
function signed() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const manifest = { schemaVersion: 1, channel: 'stable', version: '1.2.7', buildId: '1.2.7+1' };
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
  it('keeps the signed next agent channel when production still serves the previous release', async () => {
    const current = signed();
    const previous = signed();
    const requests: string[] = [];
    const binding = {
      siteOrigin: 'https://production.test',
      previewSiteOrigin: 'https://next.test',
      previewBranch: 'next'
    };
    const bytes = await fetchLiveManifest(binding, async url => {
      requests.push(String(url));
      return new Response(
        new Uint8Array(
          new URL(String(url)).origin === binding.previewSiteOrigin ? current.bytes : previous.bytes
        )
      );
    });
    expect(assertSameUpdateChannel(current.bytes, bytes, current.key)).toMatch(/^[a-f0-9]{64}$/);
    expect(requests).toEqual(['https://next.test/.well-known/wishly/stable.json']);
    const failedRequests: string[] = [];
    await expect(
      fetchLiveManifest(binding, async url => {
        failedRequests.push(String(url));
        return new Response(new Uint8Array(previous.bytes), {
          status: new URL(String(url)).origin === binding.previewSiteOrigin ? 503 : 200
        });
      })
    ).rejects.toThrow('UNAVAILABLE');
    expect(failedRequests).toEqual(['https://next.test/.well-known/wishly/stable.json']);
  });
  it('requires a complete preview binding and retains legacy sandbox smoke routing', () => {
    const legacy = { siteOrigin: 'https://sandbox.test' };
    const preview = { ...legacy, previewSiteOrigin: 'https://next.test', previewBranch: 'next' };
    expect(webPublicationOrigin(legacy)).toBe(legacy.siteOrigin);
    expect(webOnlyLiveSmokeChecks(legacy)).toEqual([
      { id: 'live-smoke', args: ['scripts/verify-live-smoke.mjs'] }
    ]);
    expect(webOnlyLiveSmokeChecks(preview)).toEqual([
      { id: 'live-smoke', args: ['scripts/verify-live-smoke.mjs', '--channel=next'] },
      { id: 'production-compatibility', args: ['scripts/verify-live-smoke.mjs', '--served-only'] }
    ]);
    for (const incomplete of [
      { ...legacy, previewBranch: 'next' },
      { ...legacy, previewSiteOrigin: 'https://next.test' },
      { ...legacy, previewSiteOrigin: '', previewBranch: '' }
    ]) {
      expect(() => webPublicationOrigin(incomplete)).toThrow('TARGET_INVALID');
      expect(() => webOnlyLiveSmokeChecks(incomplete)).toThrow('TARGET_INVALID');
    }
  });
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
  it('reads every published byte from next without requiring a production promotion', async () => {
    const dir = await temporary();
    await mkdir(path.join(dir, '.well-known/wishly'), { recursive: true });
    const files: Record<string, string> = {
      'index.html': 'candidate page',
      '.well-known/wishly/stable.json': 'candidate channel',
      '.well-known/wishly/web-release.json': 'candidate identity'
    };
    for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(dir, name), bytes);
    const digest = await outputDigest(dir);
    const binding = {
      siteOrigin: 'https://production.test',
      previewSiteOrigin: 'https://next.test',
      previewBranch: 'next'
    };
    const requests: string[] = [];
    const fetcher = async (url: URL | RequestInfo) => {
      const parsed = new URL(String(url));
      requests.push(parsed.origin);
      return new Response(
        parsed.origin === binding.previewSiteOrigin
          ? files[parsed.pathname.slice(1) || 'index.html']
          : 'previous production release'
      );
    };
    await expect(
      verifyLiveWebBytes({ directory: dir, binding, expectedDigest: digest, fetcher })
    ).resolves.toMatchObject({ files: 3 });
    expect(requests).toEqual(Array(3).fill(binding.previewSiteOrigin));
    await expect(
      verifyLiveWebBytes({
        directory: dir,
        binding,
        expectedDigest: digest,
        fetcher: async () => new Response('stale next')
      })
    ).rejects.toThrow('MISMATCH');
  });
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
  itPosix(
    'rejects a second writer, permits only the owning child, and releases in order',
    async () => {
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
    }
  );
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
  itPosix('blocks full deployment and rollback writers until explicit reconciliation', async () => {
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
    await writeFile(path.join(root, '.gitignore'), 'release/\n.env.beta\n');
    await git(['add', '.gitignore']);
    await git(['commit', '--quiet', '-m', 'base']);
    const source = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const resources = path.join(root, 'release/beta/Soty Beta.app/Contents/Resources');
    await mkdir(resources, { recursive: true });
    await writeFile(
      path.join(resources, 'release.json'),
      JSON.stringify({ channel: 'beta', sourceRevision: source })
    );
    await writeFile(
      path.join(root, '.env.beta'),
      'VITE_SUPABASE_URL=http://127.0.0.1:54321\nAGENT_ENTITLEMENT_PUBLIC_KEY=fixture-public\n'
    );
    await mkdir(path.join(resources, 'web/dist'), { recursive: true });
    await writeFile(path.join(resources, 'web/dist/index.html'), 'fixture');
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
  itPosix(
    'reconciles the canonical mini command against next while production stays older',
    async () => {
      const root = await temporary();
      const directory = path.join(root, 'release/automation');
      const draft = path.join(root, 'draft');
      await mkdir(path.join(draft, '.well-known/wishly'), { recursive: true });
      const files: Record<string, Buffer> = {
        'index.html': Buffer.from('candidate page'),
        '.well-known/wishly/stable.json': await readFile(
          path.join(process.cwd(), 'apps/web/public/.well-known/wishly/stable.json')
        ),
        '.well-known/wishly/web-release.json': Buffer.from('candidate web identity')
      };
      for (const [name, bytes] of Object.entries(files))
        await writeFile(path.join(draft, name), bytes);
      const digest = await outputDigest(draft);
      const archive = path.join(directory, 'bundles', digest);
      const { cp } = await import('node:fs/promises');
      await cp(draft, archive, { recursive: true });
      const binding = activeBinding({});
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ['-e', 'process.stdout.write(String(process.pid))'],
        { timeout: 5000 }
      );
      const deployment = {
        schemaVersion: 1,
        runId: 'lost-run',
        bindingId: binding.bindingId,
        bindingDigest: binding.digest,
        sourceSha: 'a'.repeat(40),
        manifestSha: 'b'.repeat(40),
        outputDigest: digest
      };
      const pending = {
        schemaVersion: 1,
        ownerRoot: root,
        archive,
        runId: deployment.runId,
        bindingDigest: binding.digest,
        outputDigest: digest,
        deployment,
        uploadProcess: { pid: Number(stdout) }
      };
      const pendingFile = await webReleaseStateFile(root, 'web-publication-pending.json');
      await writeFile(pendingFile, JSON.stringify(pending));
      await writeFile(
        path.join(directory, 'web-only-report.json'),
        JSON.stringify({
          runId: deployment.runId,
          sourceSha: deployment.sourceSha,
          outputDigest: digest,
          state: 'blocked',
          publicationState: 'unknown'
        })
      );
      const channelDir = path.join(root, 'channel');
      vi.stubEnv('SOTY_RELEASE_BINDING', '');
      vi.stubEnv('SOTY_RELEASE_CHANNEL_DIR', channelDir);
      const requests: string[] = [];
      vi.stubGlobal('fetch', async (input: URL | RequestInfo) => {
        const url = new URL(String(input));
        requests.push(url.origin);
        return url.origin === binding.previewSiteOrigin
          ? new Response(new Uint8Array(files[url.pathname.slice(1) || 'index.html']))
          : new Response('older production release');
      });
      await expect(runWebOnly({ cwd: root, mode: 'reconcile' })).resolves.toMatchObject({
        ok: true,
        state: 'publication_verified'
      });
      expect(requests).toEqual(Array(4).fill(binding.previewSiteOrigin));
      expect((await readState(channelDir)).next).toMatchObject({
        status: 'testing',
        build: { outputDigest: digest }
      });
      expect((await readState(channelDir)).production).toBeNull();
      await expect(readFile(pendingFile)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(runWebOnly({ cwd: root, mode: 'reconcile' })).resolves.toMatchObject({
        state: 'nothing_pending'
      });
      expect(await readHistory(channelDir)).toHaveLength(1);
    }
  );
  itPosix('restores the next candidate receipt once after a lost upload response', async () => {
    const root = await temporary();
    const directory = path.join(root, 'release/automation');
    const draft = path.join(root, 'draft');
    await mkdir(path.join(draft, '.well-known/wishly'), { recursive: true });
    const { bytes, key } = signed();
    await writeFile(path.join(draft, 'index.html'), 'candidate');
    await writeFile(path.join(draft, '.well-known/wishly/stable.json'), bytes);
    const digest = await outputDigest(draft);
    const archive = path.join(directory, 'bundles', digest);
    const { cp } = await import('node:fs/promises');
    await cp(draft, archive, { recursive: true });
    const deployment = {
      schemaVersion: 1,
      runId: 'owned-run',
      bindingId: 'production',
      bindingDigest: 'd'.repeat(64),
      sourceSha: 'a'.repeat(40),
      manifestSha: 'b'.repeat(40),
      outputDigest: digest
    };
    const pending = {
      schemaVersion: 1,
      runId: deployment.runId,
      ownerRoot: root,
      archive,
      outputDigest: digest,
      bindingDigest: deployment.bindingDigest,
      deployment
    };
    await writeFile(
      path.join(directory, 'web-only-report.json'),
      JSON.stringify({
        runId: deployment.runId,
        sourceSha: deployment.sourceSha,
        outputDigest: digest,
        state: 'blocked',
        publicationState: 'unknown'
      })
    );
    const channelDir = path.join(root, 'channel');
    const channel = {
      binding: {
        bindingId: 'production',
        digest: deployment.bindingDigest,
        siteOrigin: 'https://production.test',
        previewSiteOrigin: 'https://next.test',
        previewBranch: 'next'
      },
      dir: channelDir,
      publicKeySpki: key
    };
    await recordReconciledPublication(pending, '2026-11-13T12:00:00Z', channel);
    await recordReconciledPublication(pending, '2026-11-13T12:01:00Z', channel);
    const state = await readState(channelDir);
    expect(state.next).toMatchObject({
      status: 'testing',
      builds: 1,
      build: {
        outputDigest: digest,
        sourceSha: deployment.sourceSha,
        manifestSha: deployment.manifestSha,
        kind: 'web-only'
      }
    });
    expect(state.production).toBeNull();
    expect(await readHistory(channelDir)).toHaveLength(1);
    await expect(
      recordReconciledPublication(pending, '2026-11-13T12:02:00Z', {
        ...channel,
        binding: { ...channel.binding, digest: 'e'.repeat(64) }
      })
    ).rejects.toThrow('IDENTITY_INVALID');
    await writeFile(path.join(archive, 'index.html'), 'changed archive');
    await expect(
      recordReconciledPublication(pending, '2026-11-13T12:02:00Z', channel)
    ).rejects.toThrow('ARCHIVE_CHANGED');
    expect(await readHistory(channelDir)).toHaveLength(1);
  });
  itPosix('repairs history once and preserves an independent live-smoke failure', async () => {
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
