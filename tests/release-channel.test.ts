import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { releaseManifestSigningPayload } from '../packages/shared/src/release.js';
import {
  adoptLive,
  cancel,
  describeStatus,
  promote,
  recordNextPublication,
  rollback,
  status
} from '../scripts/lib/release-channel/operations.mjs';
import { readHistory, readState } from '../scripts/lib/release-channel/state.mjs';
import { removeTemporaryDirectory } from './support/temp-dir.js';

/**
 * Feature 051: the owner tests a candidate on `next`, then production gets
 * those exact bytes; a rollback returns the previous promoted bytes. These
 * tests drive the operations against a fake Pages project that serves whatever
 * was last uploaded to each branch, so "is the live site what we recorded" is
 * answered by the same reads the real command makes.
 */

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

function manifestBytes(version: string) {
  const unsigned = {
    schemaVersion: 1,
    channel: 'stable',
    version,
    buildNumber: version.replaceAll('.', ''),
    buildId: `${version}+1`
  };
  const signature = sign('sha256', Buffer.from(releaseManifestSigningPayload(unsigned)), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363'
  }).toString('base64url');
  return Buffer.from(`${JSON.stringify({ ...unsigned, signature })}\n`);
}

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTemporaryDirectory));
});

async function world() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soty-channel-'));
  directories.push(root);
  const served = new Map<string, { index: Buffer; manifest: Buffer }>();
  const uploads: { branch: string; directory: string }[] = [];
  let failNextUpload = false;
  const fakeUpload = async ({ directory, branch }: { directory: string; branch: string }) => {
    uploads.push({ branch, directory });
    if (failNextUpload) {
      failNextUpload = false;
      return { status: 1 };
    }
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
    const body = url.pathname === '/' ? site.index : site.manifest;
    return new Response(new Uint8Array(body), { status: 200 });
  }) as typeof fetch;
  const smokes: string[] = [];
  const options = {
    root,
    dir: path.join(root, 'channel'),
    binding,
    upload: fakeUpload,
    fetcher,
    publicKeySpki,
    sleep: async () => undefined,
    liveAttempts: 2,
    liveDelayMs: 0,
    smoke: ({ channel }: { channel: string }) => {
      smokes.push(channel);
      return { ok: true };
    }
  };
  async function bundle(version: string, marker = version) {
    const directory = path.join(root, `bundle-${marker}`);
    await mkdir(path.join(directory, '.well-known/wishly'), { recursive: true });
    await writeFile(
      path.join(directory, 'index.html'),
      `<!doctype html><script src="/assets/${marker}.js"></script>`
    );
    await mkdir(path.join(directory, 'assets'), { recursive: true });
    await writeFile(
      path.join(directory, `assets/${marker}.js`),
      `console.log(${JSON.stringify(marker)})`
    );
    await writeFile(path.join(directory, '.well-known/wishly/stable.json'), manifestBytes(version));
    return directory;
  }
  /** What deploy-web does: upload to next, then record. */
  async function publish(version: string, marker = version) {
    const directory = await bundle(version, marker);
    await fakeUpload({ directory, branch: 'next' });
    return recordNextPublication(options, {
      directory,
      sourceSha: 'a'.repeat(40),
      manifestSha: 'b'.repeat(40),
      kind: 'full'
    });
  }
  return {
    root,
    served,
    uploads,
    smokes,
    options,
    bundle,
    publish,
    failUpload: () => {
      failNextUpload = true;
    }
  };
}

describe('release channel (051)', () => {
  it('records each rebuild of one candidate at the same address and counts it', async () => {
    const w = await world();
    await w.publish('1.5.0', 'first');
    const state = await w.publish('1.5.0', 'second');
    expect(state.next).toMatchObject({ status: 'testing', builds: 2 });
    expect(state.next?.build.version).toBe('1.5.0');
    expect(state.production).toBeNull();
    expect(w.served.has(PROD)).toBe(false);
  });

  it('promotes exactly the last build seen on next, without touching anything until confirmed', async () => {
    const w = await world();
    const before = await w.bundle('1.4.0', 'live');
    await w.options.upload({ directory: before, branch: 'main' });
    await adoptLive(w.options, { confirm: true, search: [before] });
    await w.publish('1.5.0', 'candidate');

    const dry = await promote(w.options);
    expect(dry.confirmed).toBe(false);
    expect(w.uploads.filter(u => u.branch === 'main')).toHaveLength(1);

    const done = await promote(w.options, { confirm: true });
    expect(done.confirmed).toBe(true);
    expect(w.served.get(PROD)?.index.equals(w.served.get(NEXT)!.index)).toBe(true);
    const state = await readState(w.options.dir);
    expect(state.production?.version).toBe('1.5.0');
    expect(state.previous[0]?.version).toBe('1.4.0');
    expect(state.next?.status).toBe('promoted');
    expect(w.smokes).toEqual(['production']);
    expect((await readHistory(w.options.dir)).map(entry => entry.op)).toEqual([
      'adopt',
      'publish',
      'promote'
    ]);
  });

  it('refuses to promote when next no longer serves the recorded candidate', async () => {
    const w = await world();
    await w.publish('1.5.0', 'candidate');
    const other = await w.bundle('1.5.0', 'someone-else');
    await w.options.upload({ directory: other, branch: 'next' });
    await expect(promote(w.options, { confirm: true })).rejects.toThrow('CHANNEL_NEXT_DRIFTED');
    expect(w.served.has(PROD)).toBe(false);
  });

  it('refuses to promote without a candidate, and records a failed upload without moving state', async () => {
    const w = await world();
    await expect(promote(w.options, { confirm: true })).rejects.toThrow('CHANNEL_NO_CANDIDATE');
    await w.publish('1.5.0');
    w.failUpload();
    await expect(promote(w.options, { confirm: true })).rejects.toThrow('CHANNEL_DEPLOY_FAILED');
    const state = await readState(w.options.dir);
    expect(state.next?.status).toBe('testing');
    expect(state.production).toBeNull();
    expect((await readHistory(w.options.dir)).at(-1)).toMatchObject({
      op: 'promote',
      result: 'failed'
    });
  });

  it('rolls production back to the previous promoted build, then refuses when nothing is left', async () => {
    const w = await world();
    const live = await w.bundle('1.4.0', 'live');
    await w.options.upload({ directory: live, branch: 'main' });
    await adoptLive(w.options, { confirm: true, search: [live] });
    await w.publish('1.5.0', 'candidate');
    await promote(w.options, { confirm: true });

    const back = await rollback(w.options, { confirm: true });
    expect(back.to.version).toBe('1.4.0');
    const served = JSON.parse(w.served.get(PROD)!.manifest.toString());
    expect(served.version).toBe('1.4.0');
    const state = await readState(w.options.dir);
    expect(state.production?.version).toBe('1.4.0');
    expect(state.previous).toHaveLength(0);
    await expect(rollback(w.options, { confirm: true })).rejects.toThrow('CHANNEL_NO_PREVIOUS');
  });

  it('cancels a candidate by showing production on next again', async () => {
    const w = await world();
    const live = await w.bundle('1.4.0', 'live');
    await w.options.upload({ directory: live, branch: 'main' });
    await adoptLive(w.options, { confirm: true, search: [live] });
    await w.publish('1.5.0', 'candidate');
    await cancel(w.options, { confirm: true });
    expect(w.served.get(NEXT)!.index.equals(w.served.get(PROD)!.index)).toBe(true);
    expect((await readState(w.options.dir)).next?.status).toBe('cancelled');
    await expect(promote(w.options, { confirm: true })).rejects.toThrow('CHANNEL_NO_CANDIDATE');
    // A new build after a cancel starts a new candidate, not build №2 of the old one.
    const fresh = await w.publish('1.5.1', 'fresh');
    expect(fresh.next).toMatchObject({ status: 'testing', builds: 1 });
  });

  it('refuses to adopt a bundle production is not serving', async () => {
    const w = await world();
    const live = await w.bundle('1.4.0', 'live');
    const stale = await w.bundle('1.3.0', 'stale');
    await w.options.upload({ directory: live, branch: 'main' });
    await expect(adoptLive(w.options, { confirm: true, search: [stale] })).rejects.toThrow(
      'CHANNEL_LIVE_UNMATCHED'
    );
  });

  it('refuses a bundle whose manifest is not signed by the release key', async () => {
    const w = await world();
    const directory = await w.bundle('1.5.0', 'forged');
    await writeFile(
      path.join(directory, '.well-known/wishly/stable.json'),
      manifestBytes('1.5.0').toString().replace('1.5.0+1', '1.5.0+2')
    );
    await expect(
      recordNextPublication(w.options, {
        directory,
        sourceSha: 'a'.repeat(40),
        kind: 'full'
      })
    ).rejects.toThrow('CHANNEL_MANIFEST_INVALID');
  });

  it('says where everything stands in plain words', async () => {
    const w = await world();
    const live = await w.bundle('1.4.0', 'live');
    await w.options.upload({ directory: live, branch: 'main' });
    await adoptLive(w.options, { confirm: true, search: [live] });
    await w.publish('1.5.0', 'candidate');
    const report = await status(w.options);
    expect(report.live).toEqual({ next: true, production: true });
    const text = describeStatus(report);
    expect(text).toContain('Прод https://soty.test: 1.4.0');
    expect(text).toContain('Тест https://next.soty.test: 1.5.0');
    expect(text).toContain('збірка №1');
    expect(text).toContain('Відкат: немає попередньої версії');
  });

  it('refuses targets without a preview address', async () => {
    const w = await world();
    await expect(
      status({ ...w.options, binding: { ...binding, previewSiteOrigin: undefined } })
    ).rejects.toThrow('CHANNEL_UNSUPPORTED_TARGET');
  });
});
