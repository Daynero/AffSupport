import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PREVIEW_SITE_ORIGIN,
  PRODUCTION_SITE_ORIGIN,
  RELEASE_ARTIFACT_ORIGIN,
  RELEASE_ARTIFACT_PATH_PREFIX,
  releaseManifestSigningPayload
} from '../packages/shared/src/release.js';
import { isNativeUpdateManifestUrl } from '../apps/agent/src/update/service';
import {
  adoptLive,
  promote,
  recordNextPublication
} from '../scripts/lib/release-channel/operations.mjs';
import { readHistory, readState } from '../scripts/lib/release-channel/state.mjs';
import { NATIVE_UPDATE_QUALIFICATION_CASES } from '../scripts/lib/native-update-qualification.mjs';
import { SPARKLE } from '../scripts/lib/native-update-sdk.mjs';
import { nativeCandidate } from './support/native-app-updates';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import { itRequiring, requirePlatform } from './support/requires.js';

/**
 * Owner decision 2026-11-16: next ships the native macOS updater with its
 * qualification record deferred; promote is where the record is required. And a
 * Mac opts into next's manifest at runtime, never through the build.
 */

const itPosix = itRequiring.bind(null, requirePlatform('darwin', 'linux'));
const PROD = 'https://soty.test';
const NEXT = 'https://next.soty.test';
const binding = {
  bindingId: 'production',
  siteOrigin: PROD,
  previewSiteOrigin: NEXT,
  previewBranch: 'next',
  cloudflareProject: 'pages-test'
};
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKeySpki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const BUILT = 'c'.repeat(40);

function manifestBytes(version: string, nativeSource: string | null) {
  const buildNumber = version.replaceAll('.', '');
  const unsigned: Record<string, unknown> = {
    schemaVersion: 1,
    channel: 'stable',
    version,
    buildNumber,
    buildId: `${version}+${buildNumber}`
  };
  if (nativeSource) {
    const descriptor = (target: 'macos-arm64' | 'macos-x64') => ({
      ...nativeCandidate(),
      target,
      version,
      buildNumber,
      buildId: `${version}+${buildNumber}`,
      sourceRevision: nativeSource,
      archive: {
        ...nativeCandidate().archive,
        url: `${RELEASE_ARTIFACT_ORIGIN}${RELEASE_ARTIFACT_PATH_PREFIX}v${version}/Soty-v${version}-macOS-${target === 'macos-arm64' ? 'arm64' : 'x64'}.zip`
      }
    });
    unsigned.nativeUpdates = {
      'macos-arm64': descriptor('macos-arm64'),
      'macos-x64': descriptor('macos-x64')
    };
  }
  const signature = sign('sha256', Buffer.from(releaseManifestSigningPayload(unsigned)), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363'
  }).toString('base64url');
  return Buffer.from(`${JSON.stringify({ ...unsigned, signature })}\n`);
}

function qualification(sourceSha: string) {
  return {
    schemaVersion: 1,
    kind: 'native-update-qualification',
    sourceSha,
    sdkSha256: SPARKLE.sha256,
    targets: ['macos-arm64', 'macos-x64'],
    intelEvidence: 'static-intel-user-feedback-v1',
    cases: NATIVE_UPDATE_QUALIFICATION_CASES.map(name => ({
      name,
      status: 'passed',
      evidenceSha256: 'b'.repeat(64)
    })),
    trust: ['macos-arm64', 'macos-x64'].map(target => ({
      target,
      developerId: true,
      notarized: true,
      stapled: true,
      packageSha256: 'c'.repeat(64)
    })),
    latencySamples: Array.from({ length: 20 }, () => ({
      readyMs: 1000,
      workMs: 5000,
      osConsentMs: 2000,
      downloadMs: 10000
    }))
  };
}

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTemporaryDirectory));
});

async function world() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soty-native-promote-'));
  directories.push(root);
  const served = new Map<string, { index: Buffer; manifest: Buffer }>();
  const upload = async ({ directory, branch }: { directory: string; branch: string }) => {
    served.set(branch === 'next' ? NEXT : PROD, {
      index: await readFile(path.join(directory, 'index.html')),
      manifest: await readFile(path.join(directory, '.well-known/wishly/stable.json'))
    });
    return { status: 0 };
  };
  const fetcher = (async (input: URL | string) => {
    const url = new URL(String(input));
    const site = served.get(url.origin);
    if (!site) return new Response('nope', { status: 404 });
    return new Response(new Uint8Array(url.pathname === '/' ? site.index : site.manifest));
  }) as typeof fetch;
  const options = {
    root,
    dir: path.join(root, 'channel'),
    binding,
    upload,
    fetcher,
    publicKeySpki,
    sleep: async () => undefined,
    liveAttempts: 2,
    liveDelayMs: 0,
    smoke: () => ({ ok: true })
  };
  async function bundle(version: string, marker: string, nativeSource: string | null) {
    const directory = path.join(root, `bundle-${marker}`);
    await mkdir(path.join(directory, '.well-known/wishly'), { recursive: true });
    await writeFile(path.join(directory, 'index.html'), `<!doctype html><!-- ${marker} -->`);
    await writeFile(
      path.join(directory, '.well-known/wishly/stable.json'),
      manifestBytes(version, nativeSource)
    );
    return directory;
  }
  const live = await bundle('1.4.4', 'live', null);
  await upload({ directory: live, branch: 'main' });
  await adoptLive(options, { confirm: true, search: [live] });
  async function publish(version: string, nativeSource: string | null) {
    const directory = await bundle(version, `candidate-${version}`, nativeSource);
    await upload({ directory, branch: 'next' });
    await recordNextPublication(options, {
      directory,
      // A later web-only build on top: the web source moved, the Mac binaries did not.
      sourceSha: 'd'.repeat(40),
      kind: 'full'
    });
  }
  async function record(value: unknown) {
    const file = path.join(root, `qualification-${Math.random()}.json`);
    await writeFile(file, JSON.stringify(value));
    return file;
  }
  return { root, served, options, publish, record };
}

describe('promote with a native updater enabled under the deferred qualification', () => {
  itPosix('refuses, before and with --confirm, without a qualification record', async () => {
    const w = await world();
    await w.publish('1.5.4', BUILT);
    await expect(promote(w.options)).rejects.toThrow(
      'CHANNEL_NATIVE_UPDATE_QUALIFICATION_REQUIRED'
    );
    await expect(promote(w.options, { confirm: true })).rejects.toThrow(
      'CHANNEL_NATIVE_UPDATE_QUALIFICATION_REQUIRED'
    );
    expect(JSON.parse(w.served.get(PROD)!.manifest.toString()).version).toBe('1.4.4');
    expect((await readState(w.options.dir)).next?.status).toBe('testing');
  });

  itPosix(
    'refuses a record for another source, a typo-level incomplete record, or junk',
    async () => {
      const w = await world();
      await w.publish('1.5.4', BUILT);
      const incomplete = qualification(BUILT);
      incomplete.cases.pop();
      for (const file of [
        await w.record(qualification('e'.repeat(40))),
        await w.record(incomplete),
        await w.record('not a record'),
        path.join(w.root, 'missing.json')
      ])
        await expect(
          promote({ ...w.options, nativeUpdateQualification: file }, { confirm: true })
        ).rejects.toThrow('CHANNEL_NATIVE_UPDATE_QUALIFICATION_REQUIRED');
      expect(JSON.parse(w.served.get(PROD)!.manifest.toString()).version).toBe('1.4.4');
    }
  );

  itPosix(
    'promotes with the record for the exact source the Mac binaries were built from',
    async () => {
      const w = await world();
      await w.publish('1.5.4', BUILT);
      const file = await w.record(qualification(BUILT));
      const dry = await promote({ ...w.options, nativeUpdateQualification: file });
      expect(dry.nativeUpdates?.sourceSha).toBe(BUILT);
      const done = await promote(
        { ...w.options, nativeUpdateQualification: file },
        { confirm: true }
      );
      expect(done.confirmed).toBe(true);
      expect(JSON.parse(w.served.get(PROD)!.manifest.toString()).version).toBe('1.5.4');
      const entry = (await readHistory(w.options.dir)).at(-1);
      expect(entry).toMatchObject({
        op: 'promote',
        result: 'ok',
        nativeUpdateQualification: { sourceSha: BUILT }
      });
      expect(entry.nativeUpdateQualification.recordSha256).toMatch(/^[a-f0-9]{64}$/u);
    }
  );

  itPosix('leaves a build without a native updater exactly as before', async () => {
    const w = await world();
    await w.publish('1.5.4', null);
    const done = await promote(w.options, { confirm: true });
    expect(done.confirmed).toBe(true);
    expect(done.nativeUpdates).toBeNull();
  });
});

describe('the manifest a native host may hand the agent', () => {
  const manifest = (origin: string) => `${origin}/.well-known/wishly/stable.json`;
  it('accepts production by default and next for a Mac that opted in, nothing else', () => {
    expect(isNativeUpdateManifestUrl('stable', manifest(PRODUCTION_SITE_ORIGIN))).toBe(true);
    expect(isNativeUpdateManifestUrl('stable', manifest(PREVIEW_SITE_ORIGIN))).toBe(true);
    for (const other of [
      manifest('https://evil.example'),
      manifest('http://next.soty.pp.ua'),
      `${manifest(PREVIEW_SITE_ORIGIN)}?x=1`,
      `${PREVIEW_SITE_ORIGIN}/stable.json`,
      manifest('http://127.0.0.1:43141'),
      'not a url'
    ])
      expect(isNativeUpdateManifestUrl('stable', other)).toBe(false);
  });
  it('keeps a beta host on its loopback fixture', () => {
    expect(isNativeUpdateManifestUrl('beta', 'http://127.0.0.1:43141/stable.json')).toBe(true);
    expect(isNativeUpdateManifestUrl('beta', manifest(PREVIEW_SITE_ORIGIN))).toBe(false);
    expect(isNativeUpdateManifestUrl('development', manifest(PRODUCTION_SITE_ORIGIN))).toBe(false);
  });
});
