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
import { writeWebMarker } from './release-web-meta.mjs';
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
  return execFileSync('git', args, { encoding: 'utf8', shell: false }).trim();
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
  if (!existsSync(BUNDLE)) {
    process.stderr.write(`Nothing to deploy: ${BUNDLE} does not exist. Build the web app first.\n`);
    process.exit(1);
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
      BUNDLE,
      '--project-name',
      binding.cloudflareProject,
      '--branch',
      'main'
    ],
    { shell: false, stdio: 'inherit' }
  );

  // Archived only after the upload succeeded, and keyed by the digest of what
  // was uploaded. Rolling back then means redeploying bytes this project has
  // actually served, rather than rebuilding from source and shipping something
  // nobody has ever run — which would be a second unverified deploy calling
  // itself a rollback.
  if (result.status === 0) {
    const destination = path.join(ARCHIVE, marker.outputDigest);
    mkdirSync(ARCHIVE, { recursive: true, mode: 0o700 });
    if (!existsSync(destination)) cpSync(BUNDLE, destination, { recursive: true });
    appendFileSync(
      HISTORY,
      `${JSON.stringify({ ...marker, deployedAt: new Date().toISOString() })}\n`,
      {
        mode: 0o600
      }
    );
    const keep = new Set(bundlesToKeep(parseHistory(readFileSync(HISTORY, 'utf8')), KEEP_BUNDLES));
    for (const entry of readdirSync(ARCHIVE))
      if (!keep.has(entry)) rmSync(path.join(ARCHIVE, entry), { recursive: true, force: true });
  }

  process.exit(result.status ?? 1);
}
