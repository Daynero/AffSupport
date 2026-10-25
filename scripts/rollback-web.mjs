#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { open, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { activeBinding } from './lib/release/bindings.mjs';
import { outputDigest, readWebFile } from './release-web-meta.mjs';
import {
  assertRollbackBinding,
  assertRollbackManifest,
  parseHistory,
  rollbackReceipt,
  selectRollbackTarget
} from './lib/web-rollback.mjs';
import { acquireWebReleaseLock, assertWebReleaseUnlocked } from './lib/web-only-lock.mjs';

const WRANGLER = 'wrangler@4.112.0';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = '.well-known/wishly/stable.json';
const MAX_MANIFEST_BYTES = 1024 * 1024;

/** Download only the exact target's live channel, without redirects or stale cache. */
async function readLiveManifest(binding, fetcher) {
  const response = await fetcher(new URL(`/${MANIFEST}`, binding.siteOrigin), {
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache' },
    redirect: 'error',
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok || !response.body)
    throw new Error('ROLLBACK_LIVE_UNPROVEN: cannot read the live stable manifest');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_MANIFEST_BYTES)
        throw new Error('ROLLBACK_LIVE_UNPROVEN: live manifest exceeds the size limit');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

function assertDeploymentIdentity(deployment) {
  if (
    !/^[a-f0-9]{64}$/u.test(deployment?.outputDigest ?? '') ||
    !/^[a-f0-9]{40}$/u.test(deployment?.sourceSha ?? '')
  )
    throw new Error('ROLLBACK_HISTORY_INVALID: deployment has no valid immutable identity');
}

function upload({ directory, binding }) {
  return spawnSync(
    'npx',
    [
      '--yes',
      WRANGLER,
      'pages',
      'deploy',
      directory,
      '--project-name',
      binding.cloudflareProject,
      '--branch',
      'main'
    ],
    { shell: false, stdio: 'inherit' }
  );
}

/**
 * Explicit recovery only: immutable archive, unchanged signed agent channel,
 * shared release lock, and a fresh history receipt after a successful upload.
 * Importing this module never uploads anything; the injected upload is for tests.
 *
 * @param {{
 *   root?: string,
 *   args?: string[],
 *   binding?: {bindingId: string, siteOrigin: string, cloudflareProject: string},
 *   fetcher?: typeof fetch,
 *   deploy?: (input: {directory: string, binding: any}) => {status: number | null} | Promise<{status: number | null}>,
 *   now?: () => string,
 *   publicKeySpki?: string
 * }} options
 */
export async function rollbackWeb({
  root = ROOT,
  args = [],
  binding = activeBinding(),
  fetcher = fetch,
  deploy = upload,
  now = () => new Date().toISOString(),
  publicKeySpki
} = {}) {
  if (args.some(arg => arg !== '--confirm' && !arg.startsWith('--to=')))
    throw new Error('Usage: rollback:web [--to=<source-sha|output-digest>] [--confirm]');
  const confirm = args.includes('--confirm');
  const named = args.filter(arg => arg.startsWith('--to='));
  if (named.length > 1 || (named.length === 1 && !named[0].slice('--to='.length)))
    throw new Error('ROLLBACK_TARGET_INVALID: provide one nonempty --to identity');
  const to = named[0]?.slice('--to='.length);
  const historyFile = path.join(root, 'release/automation/web-deployments.jsonl');
  const archive = path.join(root, 'release/automation/bundles');
  const lock = await acquireWebReleaseLock({ root, owner: 'rollback-web' });
  let externalWriteUnresolved = false;
  try {
    let historyBytes;
    try {
      historyBytes = await readFile(historyFile, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        throw new Error(
          'ROLLBACK_HISTORY_MISSING: there is no previous deployment on this machine',
          { cause: error }
        );
      throw error;
    }
    const history = parseHistory(historyBytes);
    const archived = await readdir(archive).catch(error => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    });
    const { target, current, problems } = selectRollbackTarget(history, { to, archived });
    if (problems.length || !target || !current)
      throw new Error(problems.join('; ') || 'there is no earlier deployment to return to');
    assertDeploymentIdentity(target);
    assertDeploymentIdentity(current);
    assertRollbackBinding(target, binding.bindingId);
    assertRollbackBinding(current, binding.bindingId);
    const directory = path.join(archive, target.outputDigest);
    const local = await readWebFile(path.join(root, 'apps/web/public'), MANIFEST);
    const archivedManifest = await readWebFile(directory, MANIFEST);
    const actual = await outputDigest(directory);
    if (actual !== target.outputDigest)
      throw new Error('ROLLBACK_ARTIFACT_CHANGED: archive does not match its recorded digest');
    const checkManifest = async () => {
      const live = await readLiveManifest(binding, fetcher);
      assertRollbackManifest({ local, archived: archivedManifest, live, publicKeySpki });
      if (
        !(await readWebFile(path.join(root, 'apps/web/public'), MANIFEST)).equals(local) ||
        !(await readWebFile(directory, MANIFEST)).equals(archivedManifest)
      )
        throw new Error(
          'ROLLBACK_CHANNEL_CHANGED: local or archived channel changed during checks'
        );
    };
    await checkManifest();
    const summary =
      `Roll back ${binding.cloudflareProject} (${binding.siteOrigin})\n` +
      `  from source ${current.sourceSha.slice(0, 12)} bundle ${current.outputDigest.slice(0, 12)}\n` +
      `  to   source ${target.sourceSha.slice(0, 12)} bundle ${target.outputDigest.slice(0, 12)}\n`;
    if (!confirm) return { confirmed: false, summary, target, current, receipt: null };

    // Re-observe the channel immediately before the external write. A release
    // on this host cannot race us while we hold the shared lock.
    await assertWebReleaseUnlocked(root, lock.token);
    await checkManifest();
    if ((await readFile(historyFile, 'utf8')) !== historyBytes)
      throw new Error('ROLLBACK_HISTORY_CHANGED: another deployment changed the local history');
    if ((await outputDigest(directory)) !== target.outputDigest)
      throw new Error('ROLLBACK_ARTIFACT_CHANGED: archive changed before upload');
    externalWriteUnresolved = true;
    const result = await deploy({ directory, binding });
    if (result.status !== 0)
      throw new Error(
        'ROLLBACK_DEPLOY_FAILED: upload did not confirm success; history unchanged and writer lock retained for inspection'
      );

    const receipt = rollbackReceipt({ target, current, deployedAt: now() });
    const historyHandle = await open(historyFile, 'a', 0o600);
    try {
      const separator = historyBytes.endsWith('\n') ? '' : '\n';
      await historyHandle.writeFile(`${separator}${JSON.stringify(receipt)}\n`);
      await historyHandle.sync();
    } finally {
      await historyHandle.close();
    }
    externalWriteUnresolved = false;
    return { confirmed: true, summary, target, current, receipt };
  } catch (error) {
    if (externalWriteUnresolved)
      throw new Error(
        `ROLLBACK_PUBLICATION_UNCERTAIN: upload outcome is uncertain; writer lock retained, inspect provider and live bytes before retry. ${error instanceof Error ? error.message.slice(0, 500) : 'rollback failed'}`,
        { cause: error }
      );
    throw error;
  } finally {
    if (!externalWriteUnresolved) await lock.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await rollbackWeb({ args: process.argv.slice(2) });
    process.stdout.write(result.summary);
    process.stdout.write(
      result.confirmed
        ? 'Rolled back; agent update channel unchanged. Run `npm run verify:live-smoke` to check the site.\n'
        : 'Nothing was deployed. Add --confirm to perform this rollback; the signed agent channel will remain unchanged.\n'
    );
  } catch (error) {
    process.stderr.write(
      `Rollback refused: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}
