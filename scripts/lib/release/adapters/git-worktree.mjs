import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const exec = promisify(execFile);

const ALLOWED_ENV = Object.freeze(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'CI']);

export async function assertFastForward({ cwd, baseRef, candidateSha }) {
  try { await exec('git', ['merge-base', '--is-ancestor', baseRef, candidateSha], { cwd }); return { ok: true }; }
  catch { return { ok: false, code: 'REMOTE_NOT_FAST_FORWARD' }; }
}

export async function freezeSource({ cwd, sourceSha }) {
  const { stdout } = await exec('git', ['rev-parse', '--verify', `${sourceSha}^{commit}`], { cwd });
  return Object.freeze({ sourceSha: stdout.trim() });
}

/** Create an isolated detached checkout without ever changing the caller's branch. */
export async function createOwnedWorktree({ cwd, sourceSha, root = tmpdir(), env = process.env }) {
  const frozen = await freezeSource({ cwd, sourceSha });
  const directory = await mkdtemp(path.join(root, 'soty-release-worktree-'));
  const worktreeEnv = Object.fromEntries(ALLOWED_ENV.flatMap(key => (env[key] ? [[key, env[key]]] : [])));
  try {
    await exec('git', ['worktree', 'add', '--detach', directory, frozen.sourceSha], { cwd, env: worktreeEnv });
    await mkdir(path.join(directory, '.release-runner', 'dependencies'), { recursive: true, mode: 0o700 });
    await mkdir(path.join(directory, '.release-runner', 'dist'), { recursive: true, mode: 0o700 });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return Object.freeze({
    directory,
    sourceSha: frozen.sourceSha,
    env: Object.freeze(worktreeEnv),
    async remove() {
      await exec('git', ['worktree', 'remove', '--force', directory], { cwd, env: worktreeEnv });
    }
  });
}

export async function refreshReleaseRefs({ cwd, sourceSha, env = process.env }) {
  const worktreeEnv = Object.fromEntries(ALLOWED_ENV.flatMap(key => (env[key] ? [[key, env[key]]] : [])));
  await exec('git', ['fetch', '--no-tags', 'origin', 'main:refs/remotes/origin/main', 'beta:refs/remotes/origin/beta'], { cwd, env: worktreeEnv });
  const frozen = await freezeSource({ cwd, sourceSha });
  const [main, beta] = await Promise.all([
    assertFastForward({ cwd, baseRef: 'refs/remotes/origin/main', candidateSha: frozen.sourceSha }),
    assertFastForward({ cwd, baseRef: 'refs/remotes/origin/beta', candidateSha: frozen.sourceSha })
  ]);
  if (!main.ok || !beta.ok) throw new Error('RELEASE_SOURCE_NOT_ON_MAIN_AND_BETA');
  return Object.freeze({ sourceSha: frozen.sourceSha, main, beta });
}

export async function commitKnownFiles({ cwd, files, message, env = process.env }) {
  if (!Array.isArray(files) || files.length === 0 || files.some(file => !/^(?:packages\/shared\/src\/release\.ts|apps\/web\/public\/\.well-known\/wishly\/stable\.json|release\/[^/]+)$/u.test(file))) {
    throw new Error('RELEASE_COMMIT_PATH_INVALID');
  }
  const worktreeEnv = Object.fromEntries(ALLOWED_ENV.flatMap(key => (env[key] ? [[key, env[key]]] : [])));
  await exec('git', ['add', '--', ...files], { cwd, env: worktreeEnv });
  try { await exec('git', ['diff', '--cached', '--quiet'], { cwd, env: worktreeEnv }); return { committed: false }; }
  catch { /* staged known files are expected */ }
  await exec('git', ['commit', '--no-verify', '--only', '-m', message, '--', ...files], { cwd, env: worktreeEnv });
  return Object.freeze({ committed: true, sourceSha: (await freezeSource({ cwd, sourceSha: 'HEAD' })).sourceSha });
}

/**
 * Moves `origin/beta` forward to the frozen commit, and only forward.
 *
 * Two independent guards, because the one thing worse than a refused promotion
 * is a beta branch that quietly lost commits somebody else had pushed. The
 * ancestry check refuses anything that is not a fast-forward, and the lease
 * names the exact commit beta is expected to be at, so a push that raced with
 * another one fails instead of overwriting it.
 */
export async function promoteBeta({ cwd, sourceSha, expectedBetaSha, env = process.env }) {
  const worktreeEnv = Object.fromEntries(ALLOWED_ENV.flatMap(key => (env[key] ? [[key, env[key]]] : [])));
  const frozen = await freezeSource({ cwd, sourceSha });
  const ancestry = await assertFastForward({ cwd, baseRef: expectedBetaSha, candidateSha: frozen.sourceSha });
  if (!ancestry.ok) return Object.freeze({ ok: false, code: 'REMOTE_NOT_FAST_FORWARD' });
  if (frozen.sourceSha === expectedBetaSha) return Object.freeze({ ok: true, promoted: false, sourceSha: frozen.sourceSha });
  try {
    await exec(
      'git',
      ['push', '--no-verify', `--force-with-lease=refs/heads/beta:${expectedBetaSha}`, 'origin', `${frozen.sourceSha}:refs/heads/beta`],
      { cwd, env: worktreeEnv }
    );
  } catch (error) {
    return Object.freeze({ ok: false, code: 'REMOTE_PROMOTION_REJECTED', subject: error instanceof Error ? error.message : String(error) });
  }
  return Object.freeze({ ok: true, promoted: true, sourceSha: frozen.sourceSha });
}

/** The commit `origin/beta` currently points at, as the runner last fetched it. */
export async function remoteBetaSha({ cwd, env = process.env }) {
  const worktreeEnv = Object.fromEntries(ALLOWED_ENV.flatMap(key => (env[key] ? [[key, env[key]]] : [])));
  const { stdout } = await exec('git', ['rev-parse', '--verify', 'refs/remotes/origin/beta'], { cwd, env: worktreeEnv });
  return stdout.trim();
}
