import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { validTaskId } from './task-store.mjs';
import { refreshReleaseRefs, remoteBetaSha, promoteBeta } from './adapters/git-worktree.mjs';
const execute = promisify(execFile);
// Repair checkout/import commands share admission and use the runbook's priority.
/** @param {string} file @param {string[]} args @param {import('node:child_process').ExecFileOptions} options */
const exec = (file, args, options) => execute('/usr/bin/nice', ['-n', '15', file, ...args], { ...options, encoding: 'utf8' });
const forbidden = /(^|\/)(?:\.git|\.codex|\.env[^/]*|release|node_modules|config\/keys)(\/|$)|\.(?:env|pem|key)$/;
export function validateRepairPaths(paths) {
  if (!paths.length || paths.length > 100 || paths.some((p) => typeof p !== 'string' || !/^(?:apps|packages)\//.test(p) || path.isAbsolute(p) || p.split('/').some((part) => part === '..' || part.startsWith('.')) || forbidden.test(p) || /(?:^|\/)(?:package(?:-lock)?\.json|[^/]*\.test\.[^/]+)$/.test(p) || /[\r\n\0]/.test(p))) throw new Error('REPAIR_PATH_SCOPE_DENIED');
  return paths;
}
export async function createRepairCheckout({ root, repositoryRoot, sourceSha, executionId }) {
  validTaskId(executionId);
  const directory = path.join(root, 'repairs', executionId, 'checkout');
  await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  await exec('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--no-hardlinks', '--no-checkout', repositoryRoot, directory], { timeout: 60000, maxBuffer: 16384 });
  await exec('git', ['-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', sourceSha], { cwd: directory, timeout: 60000 });
  await exec('git', ['remote', 'remove', 'origin'], { cwd: directory, timeout: 10000 });
  return directory;
}
export async function applyRepairCandidate({ checkout, repositoryRoot, intent, binding, taskId, isCurrent }) {
  const fence = async () => { if (!await isCurrent()) throw new Error('REPAIR_GENERATION_STALE'); };
  await fence();
  const git = (args) => exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: checkout, timeout: 60000, maxBuffer: 1048576 });
  if ((await git(['rev-parse', 'HEAD'])).stdout.trim() !== intent.sourceSha) throw new Error('REPAIR_APPLICATION_AMBIGUOUS');
  const tracked = (await git(['diff', '--name-only', '-z'])).stdout.split('\0').filter(Boolean);
  const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z'])).stdout.split('\0').filter(Boolean);
  const paths = validateRepairPaths([...new Set([...tracked, ...untracked])]);
  const version = JSON.parse(await readFile(path.join(checkout, 'package.json'), 'utf8')).version;
  if (version !== intent.version) throw new Error('FROZEN_VERSION_CHANGED');
  await git(['add', '--', ...paths]);
  const patch = (await git(['diff', '--cached', '--binary'])).stdout;
  if (Buffer.byteLength(patch) > 1048576) throw new Error('REPAIR_PATCH_TOO_LARGE');
  const patchDigest = createHash('sha256').update(patch).digest('hex');
  await fence();
  await git(['-c', 'user.name=Soty Release Repair', '-c', 'user.email=release-repair@localhost', 'commit', '-m', `release: prepare ${intent.version}`]);
  const sourceSha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  await fence();
  await exec('git', ['fetch', '--no-tags', checkout, `${sourceSha}:refs/soty-release/tasks/${validTaskId(taskId)}/candidate`], { cwd: repositoryRoot, timeout: 60000, maxBuffer: 16384 });
  // Only the canonical fast-forward/lease implementation changes beta. No tag,
  // assets, version or user's checkout is altered here.
  await git(['remote', 'add', 'origin', `https://github.com/${binding.repository}.git`]);
  await refreshReleaseRefs({ cwd: checkout, sourceSha });
  const expectedBetaSha = await remoteBetaSha({ cwd: checkout });
  await fence();
  const promoted = await promoteBeta({ cwd: checkout, sourceSha, expectedBetaSha });
  if (!promoted.ok) throw new Error(promoted.code);
  return { sourceSha, patchDigest, paths };
}
