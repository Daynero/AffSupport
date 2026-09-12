#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeBinding } from './lib/release/bindings.mjs';
import { outputDigest } from './release-web-meta.mjs';
import { parseHistory, selectRollbackTarget } from './lib/web-rollback.mjs';

/**
 * Puts back the bundle that was serving before this one.
 *
 * Deliberately a command somebody runs, not something the release does on its
 * own. The project's own rule is that a published release is never unpublished
 * automatically, and the reason generalises: a deploy that failed its smoke test
 * has an unknown cause, and reverting automatically hides the cause behind a
 * green site. This makes the revert a single fast command so the decision costs
 * seconds instead of a rebuild.
 *
 * What it redeploys is the exact directory that was uploaded before, verified
 * against the digest recorded at the time. It never rebuilds: a rollback that
 * rebuilds ships bytes nobody has served, which is a second unverified deploy.
 *
 * Usage:
 *   node scripts/rollback-web.mjs            # show what a rollback would do
 *   node scripts/rollback-web.mjs --confirm  # do it
 *   node scripts/rollback-web.mjs --to=<sha|digest> --confirm
 */

const WRANGLER = 'wrangler@4.112.0';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HISTORY = path.join(root, 'release/automation/web-deployments.jsonl');
const ARCHIVE = path.join(root, 'release/automation/bundles');

const args = process.argv.slice(2);
const confirm = args.includes('--confirm');
const to = (args.find(arg => arg.startsWith('--to=')) ?? '').slice('--to='.length) || undefined;

/**
 * Reports and exits. Annotated `never` so control flow after a call narrows,
 * exactly as the other release gates in this directory do.
 *
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  process.stderr.write(`Rollback refused: ${message}\n`);
  process.exit(1);
}

if (!existsSync(HISTORY)) fail(`no deployment history at ${path.relative(root, HISTORY)}`);
const history = parseHistory(readFileSync(HISTORY, 'utf8'));
const archived = existsSync(ARCHIVE) ? readdirSync(ARCHIVE) : [];
const { target, current, problems } = selectRollbackTarget(history, { to, archived });
if (problems.length || !target || !current)
  fail(problems.join('; ') || 'there is no earlier deployment to return to');

const binding = activeBinding();
// A bundle archived under one binding must never be redeployed under another:
// the origins, keys and project differ, and the bytes carry the wrong ones.
if (target.binding?.bindingId && target.binding.bindingId !== binding.bindingId)
  fail(`that bundle was deployed to ${target.binding.bindingId}, not ${binding.bindingId}`);

const directory = path.join(ARCHIVE, target.outputDigest);
const actual = await outputDigest(directory);
// The archive is ordinary files on a disk people work on. Redeploying a bundle
// that no longer hashes to what was recorded would ship an edited copy of a
// release under the authority of the release it used to be.
if (actual !== target.outputDigest)
  fail(
    `the archived bundle no longer matches its recorded digest (${actual.slice(0, 12)} vs ${target.outputDigest.slice(0, 12)})`
  );

const summary =
  `Roll back ${binding.cloudflareProject} (${binding.siteOrigin})\n` +
  `  from source ${current.sourceSha.slice(0, 12)} bundle ${current.outputDigest.slice(0, 12)}` +
  `${current.deployedAt ? ` deployed ${current.deployedAt}` : ''}\n` +
  `  to   source ${target.sourceSha.slice(0, 12)} bundle ${target.outputDigest.slice(0, 12)}` +
  `${target.deployedAt ? ` deployed ${target.deployedAt}` : ''}\n`;

if (!confirm) {
  process.stdout.write(
    `${summary}\nNothing was changed. Add --confirm to perform it.\n` +
      'Note: the update manifest travels inside the bundle, so this also returns ' +
      'the desktop update channel to the earlier version.\n'
  );
  process.exit(0);
}

process.stdout.write(summary);
const result = spawnSync(
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
if (result.status !== 0) process.exit(result.status ?? 1);

process.stdout.write(
  `Rolled back. Run \`npm run verify:live-smoke\` to confirm the site is answering as the earlier release.\n`
);
