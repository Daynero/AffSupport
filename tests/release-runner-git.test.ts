import { expect, it } from 'vitest';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import { execFileSync } from 'node:child_process';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createOwnedWorktree,
  freezeSource,
  promoteBeta,
  remoteBetaSha
} from '../scripts/lib/release/adapters/git-worktree.mjs';

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
});

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
