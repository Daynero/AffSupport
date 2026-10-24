import { expect, it } from 'vitest';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import { execFileSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createOwnedWorktree,
  dependencyClosure,
  freezeSource,
  provisionPrivateFile,
  promoteBeta,
  remoteBetaSha
} from '../scripts/lib/release/adapters/git-worktree.mjs';
import { describeRequiring, requirePlatform } from './support/requires.js';

describeRequiring(requirePlatform('darwin', 'linux'), 'private release configuration', () => {
  it('owns a private regular file and upgrades an older runner link without changing its source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-private-config-'));
    const source = join(root, 'source.env');
    const target = join(root, 'release.env');
    try {
      await writeFile(source, 'SETTING=original\n');
      await symlink(source, target);
      expect(await provisionPrivateFile(source, target)).toBe(true);
      expect((await lstat(target)).isFile()).toBe(true);
      expect((await lstat(target)).mode & 0o777).toBe(0o600);
      expect(await readFile(source, 'utf8')).toBe('SETTING=original\n');
      await writeFile(source, 'SETTING=changed\n');
      expect(await provisionPrivateFile(source, target)).toBe(false);
      expect(await readFile(target, 'utf8')).toBe('SETTING=original\n');
      const fresh = join(root, 'fresh.env');
      expect(await provisionPrivateFile(source, fresh)).toBe(true);
      expect((await lstat(fresh)).mode & 0o777).toBe(0o600);
    } finally {
      await removeTemporaryDirectory(root);
    }
  });

  it('refuses a link the runner did not create', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-private-config-'));
    try {
      const source = join(root, 'source.env');
      const other = join(root, 'other.env');
      const target = join(root, 'release.env');
      await writeFile(source, 'source');
      await writeFile(other, 'other');
      await symlink(other, target);
      await expect(provisionPrivateFile(source, target)).rejects.toThrow(
        'RELEASE_WORKTREE_CONFIGURATION_UNSAFE'
      );
      expect(await readFile(other, 'utf8')).toBe('other');
    } finally {
      await removeTemporaryDirectory(root);
    }
  });
});

it('freezes an exact source commit without checking out main', async () => {
  const result = await freezeSource({ cwd: process.cwd(), sourceSha: 'HEAD' });
  expect(result.sourceSha).toMatch(/^[a-f0-9]{40}$/);
});

it('uses an owned detached checkout and allowlisted environment without switching the source checkout', async () => {
  const before = await freezeSource({ cwd: process.cwd(), sourceSha: 'HEAD' });
  const worktree = await createOwnedWorktree({
    cwd: process.cwd(),
    sourceSha: before.sourceSha,
    env: { PATH: process.env.PATH, SECRET_SHOULD_NOT_PASS: 'nope' }
  });
  try {
    expect(worktree.directory).not.toBe(process.cwd());
    expect(worktree.env).not.toHaveProperty('SECRET_SHOULD_NOT_PASS');
    expect(await stat(join(worktree.directory, '.release-runner', 'dependencies'))).toBeTruthy();
    expect(await stat(join(worktree.directory, '.release-runner', 'dist'))).toBeTruthy();
    expect(await freezeSource({ cwd: worktree.directory, sourceSha: 'HEAD' })).toEqual(before);
    expect(await freezeSource({ cwd: process.cwd(), sourceSha: 'HEAD' })).toEqual(before);
  } finally {
    await worktree.remove();
  }
}, 30_000);

it('promotes origin/beta only as a fast-forward from the commit it expected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'release-git-promote-'));
  const remote = join(root, 'remote.git');
  const local = join(root, 'local');
  const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  try {
    execFileSync('git', ['init', '--bare', '--initial-branch=main', remote], { stdio: 'pipe' });
    execFileSync('git', ['clone', remote, local], { stdio: 'pipe' });
    git(local, ['config', 'user.email', 'release@example.invalid']);
    git(local, ['config', 'user.name', 'Release Runner']);
    await writeFile(join(local, 'first'), 'one');
    git(local, ['add', '.']);
    git(local, ['commit', '-m', 'first']);
    git(local, ['push', 'origin', 'main']);
    git(local, ['push', 'origin', 'main:beta']);
    git(local, ['fetch', 'origin']);
    const base = await remoteBetaSha({ cwd: local });

    await writeFile(join(local, 'second'), 'two');
    git(local, ['add', '.']);
    git(local, ['commit', '-m', 'second']);
    const head = (await freezeSource({ cwd: local, sourceSha: 'HEAD' })).sourceSha;

    // A stale expectation is refused before anything is pushed.
    expect(await promoteBeta({ cwd: local, sourceSha: head, expectedBetaSha: head })).toMatchObject(
      { ok: true, promoted: false }
    );
    expect(await promoteBeta({ cwd: local, sourceSha: base, expectedBetaSha: head })).toMatchObject(
      { ok: false, code: 'REMOTE_NOT_FAST_FORWARD' }
    );

    expect(await promoteBeta({ cwd: local, sourceSha: head, expectedBetaSha: base })).toMatchObject(
      { ok: true, promoted: true, sourceSha: head }
    );
    expect(
      execFileSync('git', ['rev-parse', 'refs/heads/beta'], {
        cwd: remote,
        encoding: 'utf8'
      }).trim()
    ).toBe(head);
  } finally {
    await removeTemporaryDirectory(root);
  }
}, 60_000);

it('lets a version bump borrow the closure, and refuses a changed dependency', () => {
  const lockfile = (version: string, closure: Record<string, unknown>) =>
    JSON.stringify({
      name: 'soty',
      version,
      packages: {
        '': { name: 'soty', version, dependencies: { '@video-compressor/shared': version } },
        'packages/shared': { version },
        ...closure
      }
    });
  const closure = { 'node_modules/vite': { version: '5.4.0', resolved: 'https://example/vite' } };
  // Every release bumps the product version, and byte equality called that a
  // different dependency tree. It is the same tree; nothing was installed.
  expect(dependencyClosure(lockfile('1.1.0', closure))).toBe(
    dependencyClosure(lockfile('1.1.1', closure))
  );
  // A dependency that actually moved still has to be installed, not borrowed.
  expect(dependencyClosure(lockfile('1.1.0', closure))).not.toBe(
    dependencyClosure(
      lockfile('1.1.0', {
        'node_modules/vite': { version: '5.5.0', resolved: 'https://example/vite' }
      })
    )
  );
});
