#!/usr/bin/env node
/**
 * Fast iteration on next (owner decision 2026-11-16).
 *
 * next exists so the owner can try fixes on real data in his own space, minutes after
 * they are made. The full release runner (Windows CI, Intel, notarised installers,
 * packaged-beta proof) is the gate in front of production and stays exactly that; it is
 * not the loop for every fix on next.
 *
 *   npm run next:quick              # what changed since the last next publication, what would happen
 *   npm run next:quick -- --confirm # check, apply the server part, publish the site on next
 *
 * What it does with --confirm, in order, stopping at the first failure:
 *   1. refuses a dirty tree, and any change the installed app would have to carry
 *      (apps/agent, packaging, packages/shared beyond the release identity): those go
 *      through the full runner, because the Mac app on next would not have them;
 *   2. lint of the changed files, typecheck of web, the tests vitest relates to the change
 *      (one worker, nice 15);
 *   3. server part through the reviewed backend plan path (`plan-backend-release` +
 *      `apply-backend-plan --confirm`): the same compatibility gates as the runner. The
 *      server is shared with production — the plan refuses what the released app cannot
 *      survive;
 *   4. the delivery Worker, when it changed;
 *   5. the site: production env build, uploaded to the `next` branch alias only.
 *
 * A quick publication is deliberately NOT recorded in the release channel, so
 * `release:channel -- promote` answers CHANNEL_NEXT_DRIFTED until a full release
 * publishes on next again: nothing reaches production without the full gates.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { activeBinding } from './lib/release/bindings.mjs';
import { acquireWebReleaseLock, assertWebReleaseUnlocked } from './lib/web-only-lock.mjs';

const WRANGLER = 'wrangler@4.112.0';
const LOG = 'release/automation/next-quick.jsonl';
const confirm = process.argv.includes('--confirm');
const root = process.cwd();

const git = (...args) =>
  execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { encoding: 'utf8' }).trim();

function step(title, command, args, options = {}) {
  process.stdout.write(`\n→ ${title}\n`);
  const result = spawnSync('nice', ['-n', '15', command, ...args], {
    stdio: 'inherit',
    shell: false,
    ...options
  });
  if (result.status !== 0) {
    process.stderr.write(`✗ ${title} failed; nothing further was published.\n`);
    process.exit(result.status ?? 1);
  }
}

/** The last thing next was given: a quick publication, else the last full release tag. */
function lastPublishedSha() {
  if (existsSync(LOG)) {
    const lines = readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean);
    const tail = lines.at(-1);
    const last = tail ? JSON.parse(tail) : null;
    if (last?.sourceSha) {
      // A full release after it supersedes the quick log.
      const tag = git('describe', '--tags', '--abbrev=0', '--match', 'v*');
      const tagSha = git('rev-list', '-n', '1', tag);
      const quickIsNewer =
        spawnSync('git', ['merge-base', '--is-ancestor', tagSha, last.sourceSha]).status === 0;
      return quickIsNewer ? last.sourceSha : tagSha;
    }
  }
  return git('rev-list', '-n', '1', git('describe', '--tags', '--abbrev=0', '--match', 'v*'));
}

/** The newest quick app build, if no full release has superseded it. */
function quickAppOnNext() {
  if (!existsSync(LOG)) return null;
  const app = readFileSync(LOG, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(entry => entry.kind === 'app')
    .at(-1);
  if (!app) return null;
  const tagSha = git(
    'rev-list',
    '-n',
    '1',
    git('describe', '--tags', '--abbrev=0', '--match', 'v*')
  );
  return spawnSync('git', ['merge-base', '--is-ancestor', tagSha, app.sourceSha]).status === 0
    ? app
    : null;
}

const RELEASE_IDENTITY = new Set([
  'packages/shared/src/release.ts',
  'packages/shared/package.json',
  'package.json',
  'package-lock.json',
  'apps/web/package.json',
  'apps/agent/package.json'
]);
const isAgent = file =>
  !RELEASE_IDENTITY.has(file) &&
  (file.startsWith('apps/agent/') ||
    file.startsWith('packaging/') ||
    file.startsWith('packages/shared/'));
const isBackend = file =>
  file.startsWith('supabase/functions/') || file.startsWith('supabase/migrations/');
const isWorker = file => file.startsWith('apps/catalog-image-delivery/');
const isWeb = file => file.startsWith('apps/web/') || file.startsWith('packages/shared/');

const head = git('rev-parse', 'HEAD');
const base = lastPublishedSha();
const changed = git('diff', '--name-only', `${base}..${head}`).split('\n').filter(Boolean);
const agent = changed.filter(isAgent);
const backend = changed.filter(isBackend);
const worker = changed.filter(isWorker);
const web = changed.filter(isWeb);

process.stdout.write(
  `next:quick ${base.slice(0, 10)} → ${head.slice(0, 10)}: ${changed.length} file(s) changed\n` +
    `  site: ${web.length ? 'rebuild and publish on next' : 'unchanged'}\n` +
    `  server (shared with production): ${backend.length ? `${backend.length} file(s) through the backend plan` : 'unchanged'}\n` +
    `  delivery Worker: ${worker.length ? 'redeploy' : 'unchanged'}\n`
);
if (agent.length) {
  process.stderr.write(
    `\nThe installed app would have to carry these, and next:quick does not build it:\n` +
      agent.map(file => `  ${file}`).join('\n') +
      '\nUse the full release runner for this change.\n'
  );
  process.exit(1);
}
// Only what the build reads must be committed; notes in specs/docs may be in progress.
if (
  /^.. (?:apps|packages|supabase|config|scripts)\//mu.test(
    git('status', '--porcelain', '--untracked-files=no')
  )
) {
  process.stderr.write('\nCommit first: next:quick publishes committed source only.\n');
  process.exit(1);
}
// A prepared-but-unpublished release carries zero digests; serving it would offer an
// installer that does not exist. Only a manifest a full release recorded may ride along.
if (
  /"sha256": "0{64}"/u.test(readFileSync('apps/web/public/.well-known/wishly/stable.json', 'utf8'))
) {
  process.stderr.write(
    '\nstable.json is a prepared release, not a published one; finish or revert it first.\n'
  );
  process.exit(1);
}
if (!web.length && !backend.length && !worker.length) {
  process.stdout.write('\nNothing for next.\n');
  process.exit(0);
}
if (!confirm) {
  process.stdout.write('\nDry run. Publish with: npm run next:quick -- --confirm\n');
  process.exit(0);
}

await assertWebReleaseUnlocked(root);
const lock = await acquireWebReleaseLock({ root, owner: 'next-quick' });
try {
  const lintable = changed.filter(
    file => /\.(?:[cm]?[jt]sx?)$/u.test(file) && existsSync(file) && !file.startsWith('supabase/')
  );
  if (lintable.length) step('lint changed files', 'npx', ['eslint', ...lintable]);
  step('build shared', 'npm', ['run', '--silent', 'build', '-w', '@video-compressor/shared']);
  if (web.length) step('typecheck web', 'npx', ['tsc', '-b', 'apps/web']);
  // Tests that import what changed — not `--changed`, which would count a version bump
  // (every module reads the release identity) and run the whole suite.
  const related = changed.filter(
    file =>
      /\.(?:[cm]?[jt]sx?)$/u.test(file) &&
      existsSync(file) &&
      !file.startsWith('supabase/migrations/') &&
      file !== 'packages/shared/src/release.ts'
  );
  if (related.length)
    step('tests related to the change', 'npx', [
      'vitest',
      'related',
      '--run',
      '--passWithNoTests',
      '--pool=forks',
      '--poolOptions.forks.singleFork=true',
      ...related
    ]);

  if (backend.length) {
    mkdirSync('release/automation', { recursive: true, mode: 0o700 });
    const plan = path.resolve(`release/automation/backend-plan-quick-${head.slice(0, 12)}.json`);
    step('backend plan', 'node', [
      'scripts/plan-backend-release.mjs',
      `--since=${base}`,
      `--out=${plan}`
    ]);
    step('backend apply (shared with production)', 'node', [
      'scripts/apply-backend-plan.mjs',
      `--plan=${plan}`,
      '--confirm'
    ]);
  }

  if (worker.length) {
    step('build delivery Worker', 'npm', [
      'run',
      '--silent',
      'build',
      '-w',
      '@video-compressor/catalog-image-delivery'
    ]);
    step('deploy delivery Worker', 'npx', ['--yes', WRANGLER, 'deploy'], {
      cwd: path.join(root, 'apps/catalog-image-delivery')
    });
  }

  if (web.length) {
    const binding = activeBinding();
    if (!binding.previewBranch)
      throw new Error('next:quick publishes only to a binding with a next preview branch');
    step('verify production web env', 'node', ['scripts/verify-web-env.mjs']);
    // A quick app build on next newer than the last full release keeps being offered:
    // its signed manifest rides along instead of the release line's.
    const app = quickAppOnNext();
    const manifestPath = 'apps/web/public/.well-known/wishly/stable.json';
    const releaseManifest = readFileSync(manifestPath);
    if (app) {
      step('fetch the quick app build', 'git', ['fetch', '-q', 'origin', app.branch]);
      writeFileSync(manifestPath, git('show', `${app.buildSha}:${manifestPath}`) + '\n');
      process.stdout.write(`  keeping the app build ${app.version} offered on next\n`);
    }
    try {
      step('build site', 'npm', ['run', '--silent', 'build:web']);
    } finally {
      writeFileSync(manifestPath, releaseManifest);
    }
    step(`publish on ${binding.previewSiteOrigin}`, 'npx', [
      '--yes',
      WRANGLER,
      'pages',
      'deploy',
      'apps/web/dist',
      '--project-name',
      binding.cloudflareProject,
      '--branch',
      binding.previewBranch,
      '--commit-hash',
      head
    ]);
  }

  appendFileSync(
    LOG,
    `${JSON.stringify({ sourceSha: head, base, web: web.length > 0, backend: backend.length > 0, worker: worker.length > 0, at: new Date().toISOString() })}\n`,
    { mode: 0o600 }
  );
  process.stdout.write(
    `\n✓ next has ${head.slice(0, 10)}. Production is untouched except the shared server part;` +
      ' promote stays closed until a full release.\n'
  );
} finally {
  await lock.release();
}
