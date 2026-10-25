import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  symlink,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { releaseManifestSigningPayload } from '../packages/shared/src/release.js';
import { assertRollbackManifest } from '../scripts/lib/web-rollback.mjs';
import { outputDigest, readWebFile } from '../scripts/release-web-meta.mjs';
import { rollbackWeb } from '../scripts/rollback-web.mjs';
import { acquireWebReleaseLock } from '../scripts/lib/web-only-lock.mjs';
import { removeTemporaryDirectory } from './support/temp-dir.js';

const directories: string[] = [];
async function temporaryBundle() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soty-rollback-safety-'));
  directories.push(root);
  const directory = path.join(root, 'bundle');
  await mkdir(directory);
  return { root, directory };
}

function signedManifest() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const unsigned = { schemaVersion: 1, channel: 'stable', version: '1.2.7', buildNumber: '72' };
  const signature = sign('sha256', Buffer.from(releaseManifestSigningPayload(unsigned)), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363'
  }).toString('base64url');
  return {
    bytes: Buffer.from(JSON.stringify({ ...unsigned, signature }) + '\n'),
    publicKeySpki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTemporaryDirectory));
});

describe('preserving the current signed agent channel during web rollback', () => {
  it('requires byte equality and a valid signature even when all three copies agree', () => {
    const { bytes, publicKeySpki } = signedManifest();
    expect(
      assertRollbackManifest({ local: bytes, archived: bytes, live: bytes, publicKeySpki })
    ).toMatchObject({ channel: 'stable', version: '1.2.7' });

    const invalid = Buffer.from(bytes.toString().replace('1.2.7', '1.2.8'));
    expect(() =>
      assertRollbackManifest({
        local: invalid,
        archived: invalid,
        live: invalid,
        publicKeySpki
      })
    ).toThrow('ROLLBACK_MANIFEST_INVALID');
  });

  it('refuses either an older archived channel or a different live channel', () => {
    const { bytes, publicKeySpki } = signedManifest();
    const changed = Buffer.from(bytes.toString().replace('1.2.7', '1.2.6'));
    expect(() =>
      assertRollbackManifest({ local: bytes, archived: changed, live: bytes, publicKeySpki })
    ).toThrow('ROLLBACK_CHANNEL_CHANGED');
    expect(() =>
      assertRollbackManifest({ local: bytes, archived: bytes, live: changed, publicKeySpki })
    ).toThrow('ROLLBACK_CHANNEL_CHANGED');
    // Even a whitespace-only rewrite changes the exact signed-channel artifact.
    expect(() =>
      assertRollbackManifest({
        local: bytes,
        archived: Buffer.from(bytes.toString().trim()),
        live: bytes,
        publicKeySpki
      })
    ).toThrow('ROLLBACK_CHANNEL_CHANGED');
  });
});

describe('archived bundle hashing', () => {
  it('streams large contents without changing the original canonical digest format', async () => {
    const { directory } = await temporaryBundle();
    const content = Buffer.alloc(3 * 1024 * 1024, 81);
    await mkdir(path.join(directory, 'assets'));
    await writeFile(path.join(directory, 'index.html'), '<h1>Soty</h1>');
    await writeFile(path.join(directory, 'assets', 'app.js'), content);
    const expected = createHash('sha256')
      .update(path.join('assets', 'app.js'))
      .update('\0')
      .update(content)
      .update('\0')
      .update('index.html')
      .update('\0')
      .update('<h1>Soty</h1>')
      .update('\0')
      .digest('hex');
    expect(await outputDigest(directory)).toBe(expected);
    expect(await readWebFile(directory, 'index.html')).toEqual(Buffer.from('<h1>Soty</h1>'));
  });

  it('refuses a file hardlink even if its bytes match an expected bundle', async () => {
    const { root, directory } = await temporaryBundle();
    const external = path.join(root, 'external.js');
    await writeFile(external, 'outside');
    await link(external, path.join(directory, 'app.js'));
    await expect(outputDigest(directory)).rejects.toThrow('WEB_ARTIFACT_UNSAFE');
    await expect(readWebFile(directory, 'app.js')).rejects.toThrow('WEB_ARTIFACT_UNSAFE');
  });

  it('refuses a directory link and an aliased bundle root', async () => {
    const { root, directory } = await temporaryBundle();
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.js'), 'outside');
    await symlink(outside, path.join(directory, 'assets'), 'junction');
    await expect(outputDigest(directory)).rejects.toThrow('WEB_ARTIFACT_UNSAFE');
    await symlink(directory, path.join(root, 'alias'), 'junction');
    await expect(outputDigest(path.join(root, 'alias'))).rejects.toThrow('WEB_ARTIFACT_UNSAFE');
  });

  it('refuses traversal and oversized manifest reads', async () => {
    const { root, directory } = await temporaryBundle();
    await writeFile(path.join(root, 'outside.json'), '{}');
    await writeFile(path.join(directory, 'large.json'), '0123456789');
    await expect(readWebFile(directory, '../outside.json')).rejects.toThrow('WEB_ARTIFACT_UNSAFE');
    await expect(readWebFile(directory, 'large.json', 5)).rejects.toThrow('WEB_ARTIFACT_UNSAFE');
  });
});

async function rollbackFixture() {
  const { root } = await temporaryBundle();
  const { bytes, publicKeySpki } = signedManifest();
  const local = path.join(root, 'apps/web/public/.well-known/wishly');
  const archiveRoot = path.join(root, 'release/automation/bundles');
  const staging = path.join(archiveRoot, 'staging');
  await mkdir(local, { recursive: true });
  await mkdir(path.join(staging, '.well-known/wishly'), { recursive: true });
  await writeFile(path.join(local, 'stable.json'), bytes);
  await writeFile(path.join(staging, '.well-known/wishly/stable.json'), bytes);
  await writeFile(path.join(staging, 'index.html'), '<h1>Previous web</h1>');
  const archivedDigest = await outputDigest(staging);
  const archived = path.join(archiveRoot, archivedDigest);
  await rename(staging, archived);
  const previous = {
    bindingId: 'production',
    sourceSha: 'a'.repeat(40),
    outputDigest: archivedDigest,
    deployedAt: '2026-10-20T12:00:00.000Z'
  };
  const current = {
    bindingId: 'production',
    sourceSha: 'b'.repeat(40),
    outputDigest: 'c'.repeat(64),
    deployedAt: '2026-10-25T12:00:00.000Z'
  };
  const historyFile = path.join(root, 'release/automation/web-deployments.jsonl');
  const history = `${JSON.stringify(previous)}\n${JSON.stringify(current)}\n`;
  await writeFile(historyFile, history);
  const fetcher = vi.fn(async () => new Response(bytes.toString()));
  const deploy = vi.fn(() => ({ status: 0 }));
  return {
    root,
    bytes,
    publicKeySpki,
    archived,
    historyFile,
    history,
    previous,
    current,
    fetcher,
    deploy,
    binding: {
      bindingId: 'production',
      siteOrigin: 'https://soty.invalid',
      cloudflareProject: 'test-web'
    }
  };
}

describe('explicit rollback orchestration', () => {
  it('does not upload or change deployment history during a dry run', async () => {
    const fixture = await rollbackFixture();
    const result = await rollbackWeb(fixture);
    expect(result.confirmed).toBe(false);
    expect(fixture.deploy).not.toHaveBeenCalled();
    expect(await readFile(fixture.historyFile, 'utf8')).toBe(fixture.history);
    await expect(
      access(path.join(fixture.root, 'release/automation/web-release.lock'))
    ).rejects.toThrow();
  });

  it('holds the common lock and appends history only after successful deployment', async () => {
    const fixture = await rollbackFixture();
    const deployedAt = '2026-10-25T13:00:00.000Z';
    const deploy = vi.fn(async () => {
      expect(await readFile(fixture.historyFile, 'utf8')).toBe(fixture.history);
      const owner = JSON.parse(
        await readFile(path.join(fixture.root, 'release/automation/web-release.lock'), 'utf8')
      );
      expect(owner.owner).toBe('rollback-web');
      return { status: 0 };
    });
    const result = await rollbackWeb({
      ...fixture,
      deploy,
      args: ['--confirm'],
      now: () => deployedAt
    });
    expect(result.confirmed).toBe(true);
    expect(deploy).toHaveBeenCalledOnce();
    const records = (await readFile(fixture.historyFile, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(records).toHaveLength(3);
    expect(records[2]).toMatchObject({
      bindingId: 'production',
      outputDigest: fixture.previous.outputDigest,
      deployedAt,
      rolledBackFrom: {
        outputDigest: fixture.current.outputDigest,
        sourceSha: fixture.current.sourceSha
      }
    });
    await expect(
      access(path.join(fixture.root, 'release/automation/web-release.lock'))
    ).rejects.toThrow();
  });

  it.each(['nonzero', 'throws'])(
    'retains the writer fence after an ambiguous %s upload',
    async kind => {
      const fixture = await rollbackFixture();
      const deploy = () => {
        if (kind === 'throws') throw new Error('response lost');
        return { status: 1 };
      };
      await expect(rollbackWeb({ ...fixture, args: ['--confirm'], deploy })).rejects.toThrow();
      expect(await readFile(fixture.historyFile, 'utf8')).toBe(fixture.history);
      await expect(
        access(path.join(fixture.root, 'release/automation/web-release.lock'))
      ).resolves.toBeUndefined();
      await expect(
        acquireWebReleaseLock({ root: fixture.root, owner: 'another-deploy' })
      ).rejects.toThrow('WEB_RELEASE_BUSY');
    }
  );

  it('refuses a flat marker from another binding before fetching or uploading', async () => {
    const fixture = await rollbackFixture();
    await writeFile(
      fixture.historyFile,
      `${JSON.stringify({ ...fixture.previous, bindingId: 'sandbox' })}\n${JSON.stringify(fixture.current)}\n`
    );
    await expect(rollbackWeb({ ...fixture, args: ['--confirm'] })).rejects.toThrow(
      'ROLLBACK_BINDING_MISMATCH'
    );
    expect(fixture.fetcher).not.toHaveBeenCalled();
    expect(fixture.deploy).not.toHaveBeenCalled();
  });

  it('refuses a changed live channel before upload and records no successful rollback', async () => {
    const fixture = await rollbackFixture();
    const fetcher = vi
      .fn()
      .mockImplementationOnce(async () => new Response(fixture.bytes.toString()))
      .mockImplementationOnce(async () => new Response('{}'));
    await expect(rollbackWeb({ ...fixture, fetcher, args: ['--confirm'] })).rejects.toThrow(
      'ROLLBACK_CHANNEL_CHANGED'
    );
    expect(fixture.deploy).not.toHaveBeenCalled();
    expect(await readFile(fixture.historyFile, 'utf8')).toBe(fixture.history);
  });

  it('cancels an oversized live manifest stream before collecting a full response', async () => {
    const fixture = await rollbackFixture();
    const cancelled = vi.fn();
    let chunks = 0;
    const fetcher = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              chunks += 1;
              controller.enqueue(new Uint8Array(256 * 1024));
            },
            cancel: cancelled
          })
        )
    );
    await expect(rollbackWeb({ ...fixture, fetcher, args: ['--confirm'] })).rejects.toThrow(
      'ROLLBACK_LIVE_UNPROVEN'
    );
    expect(cancelled).toHaveBeenCalled();
    expect(chunks).toBeLessThanOrEqual(7);
    expect(fixture.deploy).not.toHaveBeenCalled();
    expect(await readFile(fixture.historyFile, 'utf8')).toBe(fixture.history);
  });

  it('refuses modified archive bytes and an active release lock', async () => {
    const fixture = await rollbackFixture();
    await writeFile(path.join(fixture.archived, 'index.html'), 'changed');
    await expect(rollbackWeb({ ...fixture, args: ['--confirm'] })).rejects.toThrow(
      'ROLLBACK_ARTIFACT_CHANGED'
    );
    const lock = await acquireWebReleaseLock({ root: fixture.root, owner: 'web-only-release' });
    try {
      await expect(rollbackWeb({ ...fixture, args: ['--confirm'] })).rejects.toThrow(
        'WEB_RELEASE_BUSY'
      );
    } finally {
      await lock.release();
    }
    expect(fixture.deploy).not.toHaveBeenCalled();
  });
});
