#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync
} from 'node:fs';
import path from 'node:path';
import { activeBinding } from './lib/release/bindings.mjs';
import { writeWebMarker, outputDigest } from './release-web-meta.mjs';
import { createHash } from 'node:crypto';
import { acquireWebReleaseLock, assertWebReleaseUnlocked } from './lib/web-only-lock.mjs';
import { bundlesToKeep, parseHistory } from './lib/web-rollback.mjs';

/**
 * Deploys the built web bundle to the destination its binding names.
 *
 * The Cloudflare project used to live in an npm script, which meant the answer
 * to "where does this deploy go" was a string nothing verified. It comes from
 * the validated binding now: production by default and pinned there, a sandbox
 * only when one has been configured and proven disjoint.
 *
 * The identity written alongside the bundle is recorded *before* upload and is
 * a description of what was built, never a patch applied to it. A sandbox's
 * different public identity comes from its own committed source, so there is
 * nothing here that could rewrite a frozen artifact on its way out.
 */

const WRANGLER = 'wrangler@4.112.0';
const BUNDLE = 'apps/web/dist';
const HISTORY = 'release/automation/web-deployments.jsonl';
const ARCHIVE = 'release/automation/bundles';
/** Five is about a month of releases at the current pace, and fifteen megabytes. */
const KEEP_BUNDLES = 5;
const MANIFEST = 'apps/web/public/.well-known/wishly/stable.json';

function gitSha(args) {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    encoding: 'utf8',
    shell: false,
    timeout: 10000,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  }).trim();
}

export function deploymentIdentity(cwd = process.cwd()) {
  return {
    sourceSha: gitSha(['-C', cwd, 'rev-parse', 'HEAD']),
    // Which commit produced the manifest this bundle will advertise. A bundle
    // and a manifest from different commits is the failure this catches.
    manifestSha: gitSha(['-C', cwd, 'log', '-1', '--format=%H', '--', MANIFEST])
  };
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const binding = activeBinding();
  const inheritedToken = process.env.SOTY_WEB_RELEASE_LOCK_TOKEN ?? null;
  await assertWebReleaseUnlocked(process.cwd(), inheritedToken);
  const ownedLock = inheritedToken
    ? null
    : await acquireWebReleaseLock({ root: process.cwd(), owner: 'deploy-web' });
  try {
    let webProof = null;
    if (process.argv.includes('--web-only')) {
      const { assertStoredWebOnlyProof } = await import('./lib/web-only-proof.mjs');
      webProof = await assertStoredWebOnlyProof({ cwd: process.cwd(), binding });
    }

    if (!existsSync(BUNDLE)) {
      process.stderr.write(
        `Nothing to deploy: ${BUNDLE} does not exist. Build the web app first.\n`
      );
      throw new Error('WEB_BUNDLE_MISSING');
    }
    const { sourceSha, manifestSha } = deploymentIdentity();
    // Deliberately outside the bundle: the digest describes exactly the bytes
    // that get uploaded, and a receipt stored among them would not be covered by
    // the number it carries.
    mkdirSync('release/automation', { recursive: true, mode: 0o700 });
    const marker = await writeWebMarker({
      directory: path.resolve(BUNDLE),
      output: path.resolve('release/automation/web-deployment.json'),
      binding,
      sourceSha,
      manifestSha
    });
    const manifestDigest = createHash('sha256').update(readFileSync(MANIFEST)).digest('hex');
    if (
      webProof &&
      (webProof.productionBundleDigest !== marker.outputDigest ||
        webProof.manifestDigest !== manifestDigest)
    )
      throw new Error('WEB_ONLY_ARTIFACT_CHANGED');
    // Freeze owned bytes before the upload, including when its response is later lost.
    const destination = path.join(ARCHIVE, marker.outputDigest);
    mkdirSync(ARCHIVE, { recursive: true, mode: 0o700 });
    if (!existsSync(destination)) cpSync(BUNDLE, destination, { recursive: true });
    if ((await outputDigest(destination)) !== marker.outputDigest)
      throw new Error('WEB_ARCHIVE_CHANGED');
    process.stdout.write(
      `Deploying ${binding.bindingId} → Cloudflare project ${binding.cloudflareProject} ` +
        `(source ${marker.sourceSha.slice(0, 12)}, bundle ${marker.outputDigest.slice(0, 12)}).\n`
    );
    const result = spawnSync(
      'npx',
      [
        '--yes',
        WRANGLER,
        'pages',
        'deploy',
        destination,
        '--project-name',
        binding.cloudflareProject,
        '--branch',
        'main'
      ],
      { shell: false, stdio: 'inherit' }
    );

    // A successful upload advances history; its exact bytes were frozen before upload. Rolling back then means redeploying bytes this project has
    // actually served, rather than rebuilding from source and shipping something
    // nobody has ever run — which would be a second unverified deploy calling
    // itself a rollback.
    if (result.status === 0) {
      appendFileSync(
        HISTORY,
        `${JSON.stringify({ ...marker, manifestDigest, bindingDigest: binding.digest, ...(webProof ? { kind: 'web-only', webBuildId: webProof.webBuildId } : {}), deployedAt: new Date().toISOString() })}\n`,
        {
          mode: 0o600,
          flush: true
        }
      );
      const keep = new Set(
        bundlesToKeep(parseHistory(readFileSync(HISTORY, 'utf8')), KEEP_BUNDLES)
      );
      for (const entry of readdirSync(ARCHIVE))
        if (!keep.has(entry)) rmSync(path.join(ARCHIVE, entry), { recursive: true, force: true });
    }

    process.exitCode = result.status ?? 1;
  } finally {
    await ownedLock?.release();
  }
}
