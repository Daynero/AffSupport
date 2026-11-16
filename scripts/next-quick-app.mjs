#!/usr/bin/env node
/**
 * A Mac app build for next in about twenty minutes (owner decision 2026-11-16).
 *
 * next is the owner's own test bench: one Apple-silicon Mac, one space. The full release
 * runner (Windows CI, Intel, packaged beta, release candidate tests) stays the gate in
 * front of production; this is the loop for trying an app change on real data.
 *
 *   npm run next:quick:app              # what it would build
 *   npm run next:quick:app -- --confirm # build, sign, notarise, publish on next
 *
 * With --confirm, from a clean committed HEAD:
 *   1. picks the identity `<next patch>-next.<N>` (e.g. 1.5.6-next.91): a prerelease of the
 *      coming version, so the next full release still counts as newer; N is a build
 *      number above every build so far, so the native updater offers it;
 *   2. commits that identity on a throwaway `next-quick/<version>` branch in its own
 *      worktree (dependencies cloned copy-on-write), pushes the branch;
 *   3. lint, typecheck and the tests related to the change since the last publication;
 *   4. builds, packages, signs and notarises macOS arm64 only (the same package-mac.sh
 *      and package-dmg.sh as the runner), checks the trust chain;
 *   5. publishes a GitHub *prerelease* v<version> with the DMG, ZIP and update archive;
 *   6. applies the server part of the change (backend plan, delivery Worker) like the runner;
 *   7. signs stable.json for that build — arm64 artifact and native update; the other
 *      platforms keep the last full release's installers — and uploads the site to the
 *      `next` branch alias only.
 *
 * Nothing is recorded in the release channel, so `release:channel -- promote` refuses
 * (CHANNEL_NEXT_DRIFTED) until a full release publishes on next again. The server part
 * still goes through `npm run next:quick` (shared with production).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { activeBinding } from './lib/release/bindings.mjs';
import { acquireWebReleaseLock, assertWebReleaseUnlocked } from './lib/web-only-lock.mjs';
import { createOwnedWorktree, provisionWorktree } from './lib/release/adapters/git-worktree.mjs';

const WRANGLER = 'wrangler@4.112.0';
const LOG = path.resolve('release/automation/next-quick.jsonl');
const MANIFEST = 'apps/web/public/.well-known/wishly/stable.json';
const confirm = process.argv.includes('--confirm');
const root = process.cwd();

const git = (args, cwd = root) =>
  execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8' }).trim();

function step(title, command, args, options = {}) {
  process.stdout.write(`\n→ ${title}\n`);
  const result = spawnSync('nice', ['-n', '15', command, ...args], {
    stdio: 'inherit',
    shell: false,
    ...options
  });
  if (result.status !== 0) {
    process.stderr.write(`✗ ${title} failed; nothing further was published.\n`);
    // Thrown, not process.exit: the lock and the worktree are released in finally.
    process.exitCode = result.status ?? 1;
    throw new Error(`NEXT_QUICK_STEP_FAILED ${title}`);
  }
}

const quickLog = () =>
  existsSync(LOG)
    ? readFileSync(LOG, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
    : [];

const releaseSource = readFileSync('packages/shared/src/release.ts', 'utf8');
const constant = name =>
  new RegExp(`export const ${name} = '([^']+)';`, 'u').exec(releaseSource)?.[1] ?? '';
const tag = git([
  'describe',
  '--tags',
  '--abbrev=0',
  '--match',
  'v[0-9]*.[0-9]*.[0-9]*',
  '--exclude',
  '*-*'
]);
const tagSha = git(['rev-list', '-n', '1', tag]);
const released = tag.slice(1);
const [major, minor, patch] = released.split('.').map(Number);
const upcoming = `${major}.${minor}.${patch + 1}`;
// Every number a quick build ever took, including one that stopped after pushing its
// branch: a branch name is never reused (no force-push).
const pushedBuilds = git(['ls-remote', '--heads', 'origin', 'refs/heads/next-quick/*'])
  .split('\n')
  .map(line => Number(/-next\.(\d+)$/u.exec(line)?.[1] ?? 0));
const buildNumber =
  Math.max(
    Number(constant('BUILD_NUMBER')),
    ...quickLog().map(entry => Number(entry.buildNumber ?? 0)),
    ...pushedBuilds
  ) + 1;
const version = `${upcoming}-next.${buildNumber}`;
const head = git(['rev-parse', 'HEAD']);
const lastApp = quickLog()
  .filter(entry => entry.kind === 'app')
  .at(-1);
const base =
  lastApp &&
  spawnSync('git', ['merge-base', '--is-ancestor', tagSha, lastApp.sourceSha]).status === 0
    ? lastApp.sourceSha
    : tagSha;

process.stdout.write(
  `next:quick:app ${version} (build ${buildNumber}) from ${head.slice(0, 10)}; ` +
    `last full release ${released}; tests related to ${base.slice(0, 10)}..HEAD\n`
);
// Only what the build reads must be committed; notes in specs/docs may be in progress.
if (
  /^.. (?:apps|packages|supabase|config|scripts)\//mu.test(
    git(['status', '--porcelain', '--untracked-files=no'])
  )
) {
  process.stderr.write('\nCommit first: next:quick:app builds committed source only.\n');
  process.exit(1);
}
if (/"sha256": "0{64}"/u.test(readFileSync(MANIFEST, 'utf8'))) {
  process.stderr.write(
    '\nstable.json is a prepared release, not a published one; finish or revert it first.\n'
  );
  process.exit(1);
}
for (const volume of ['/Volumes/Soty'])
  if (existsSync(volume)) {
    process.stderr.write(`\n${volume} is mounted (an installer image); eject it first.\n`);
    process.exit(1);
  }
if (!confirm) {
  process.stdout.write('\nDry run. Build and publish with: npm run next:quick:app -- --confirm\n');
  process.exit(0);
}
for (const name of ['SOTY_SIGNING_IDENTITY', 'NODE_BINARY', 'FFMPEG_BINARY', 'WHISPER_BINARY'])
  if (!process.env[name]) {
    process.stderr.write(`\n${name} is not set; run through \`npm run next:quick:app\`.\n`);
    process.exit(1);
  }

await assertWebReleaseUnlocked(root);
let lock = await acquireWebReleaseLock({ root, owner: 'next-quick-app' });
/** apply-backend-plan takes the same lock itself, so it runs between two holdings. */
async function withoutLock(work) {
  await lock.release();
  try {
    work();
  } finally {
    lock = await acquireWebReleaseLock({ root, owner: 'next-quick-app' });
  }
}
const worktree = await createOwnedWorktree({ cwd: root, sourceSha: head, root: tmpdir() });
const cwd = worktree.directory;
let keepWorktree = true;
try {
  await provisionWorktree({ cwd: root, directory: cwd });

  // 1–2. Identity, committed on its own branch so the tag names exactly what was built.
  const source = readFileSync(path.join(cwd, 'packages/shared/src/release.ts'), 'utf8')
    .replace(
      /export const PRODUCT_VERSION = '[^']+';/u,
      `export const PRODUCT_VERSION = '${version}';`
    )
    .replace(
      /export const BUNDLE_VERSION = '[^']+';/u,
      `export const BUNDLE_VERSION = '${upcoming}';`
    )
    .replace(
      /export const BUILD_NUMBER = '[^']+';/u,
      `export const BUILD_NUMBER = '${buildNumber}';`
    );
  writeFileSync(path.join(cwd, 'packages/shared/src/release.ts'), source);
  const workspaces = ['', 'apps/agent', 'apps/web', 'packages/shared'];
  for (const workspace of workspaces) {
    const file = path.join(cwd, workspace, 'package.json');
    const json = JSON.parse(readFileSync(file, 'utf8'));
    json.version = version;
    writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  }
  const lockFile = path.join(cwd, 'package-lock.json');
  const lockJson = JSON.parse(readFileSync(lockFile, 'utf8'));
  lockJson.version = version;
  for (const workspace of workspaces)
    if (lockJson.packages?.[workspace]) lockJson.packages[workspace].version = version;
  writeFileSync(lockFile, `${JSON.stringify(lockJson, null, 2)}\n`);
  const manifestFile = path.join(cwd, MANIFEST);
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const arm64Name = `Soty-v${version}-macOS-arm64.dmg`;
  Object.assign(manifest, {
    version,
    buildNumber: String(buildNumber),
    buildId: `${version}+${buildNumber}`,
    publishedAt: new Date().toISOString(),
    summary: {
      uk: `Тестова збірка для next (${version}) — лише macOS на Apple silicon.`,
      en: `Test build for next (${version}) — macOS on Apple silicon only.`
    }
  });
  manifest.artifacts['macos-arm64'] = {
    url: `https://github.com/Daynero/AffSupport/releases/download/v${version}/${arm64Name}`,
    sha256: '0'.repeat(64)
  };
  // Only the arm64 updater is offered; an Intel descriptor would name another version.
  delete manifest.nativeUpdates;
  delete manifest.signature;
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  git(
    [
      'add',
      '-A',
      'packages/shared/src/release.ts',
      'package-lock.json',
      MANIFEST,
      ...workspaces.map(w => path.join(w, 'package.json'))
    ],
    cwd
  );
  git(
    ['commit', '-q', '-m', `next-quick: ${version} (test build for next, not for production)`],
    cwd
  );
  const sourceSha = git(['rev-parse', 'HEAD'], cwd);
  const branch = `next-quick/${version}`;
  step('push the build branch', 'git', ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], {
    cwd
  });

  // 3. Fast gates.
  const changed = git(['diff', '--name-only', `${base}..${head}`])
    .split('\n')
    .filter(Boolean);
  const lintable = changed.filter(
    file =>
      /\.(?:[cm]?[jt]sx?)$/u.test(file) &&
      existsSync(path.join(cwd, file)) &&
      !file.startsWith('supabase/')
  );
  if (lintable.length) step('lint changed files', 'npx', ['eslint', ...lintable], { cwd });
  step('build shared, web and agent', 'npm', ['run', '--silent', 'build'], { cwd });
  step('typecheck agent and web', 'npx', ['tsc', '-p', 'apps/agent/tsconfig.json', '--noEmit'], {
    cwd
  });
  step('typecheck web', 'npx', ['tsc', '-b', 'apps/web'], { cwd });
  // Tests that import what changed — not `--changed`, which would count the version
  // bump (every module reads the release identity) and run the whole suite.
  const related = changed.filter(
    file =>
      /\.(?:[cm]?[jt]sx?)$/u.test(file) &&
      existsSync(path.join(cwd, file)) &&
      !file.startsWith('supabase/migrations/') &&
      file !== 'packages/shared/src/release.ts'
  );
  if (related.length)
    step(
      'tests related to the change',
      'npx',
      [
        'vitest',
        'related',
        '--run',
        '--passWithNoTests',
        '--pool=forks',
        '--poolOptions.forks.singleFork=true',
        ...related
      ],
      { cwd }
    );

  if (changed.some(file => file.startsWith('packaging/NativeUpdates/')))
    step(
      'native update checks (Swift)',
      process.execPath,
      ['scripts/verify-native-update-probe.mjs', '--native-boundaries'],
      {
        cwd
      }
    );

  // 4. macOS arm64 only.
  step(
    'package, sign and notarise macOS arm64',
    'zsh',
    ['scripts/package-mac.sh', '--arch=arm64'],
    { cwd }
  );
  step('disk image', 'zsh', ['scripts/package-dmg.sh', '--arch=arm64'], { cwd });
  const out = path.join(cwd, 'release');
  const dmg = path.join(out, arm64Name);
  const zip = dmg.replace(/\.dmg$/u, '.zip');
  for (const file of [dmg, zip, `${zip}.native-update.json`])
    if (!existsSync(file)) throw new Error(`NEXT_QUICK_ARTIFACT_MISSING ${path.basename(file)}`);
  step(
    'trust chain',
    process.execPath,
    ['scripts/verify-macos-release-trust.mjs', dmg, '--arch=arm64'],
    {
      cwd,
      env: { ...process.env, TMPDIR: '/tmp' }
    }
  );

  // 5. A prerelease: never "latest", never what production links to.
  step(
    'publish GitHub prerelease',
    'gh',
    [
      'release',
      'create',
      `v${version}`,
      dmg,
      zip,
      '--target',
      sourceSha,
      '--prerelease',
      '--title',
      `Soty v${version} (next test build)`,
      '--notes',
      `Test build for next.soty.pp.ua only (macOS arm64). Not a production release. Source ${sourceSha}.`
    ],
    { cwd }
  );

  // 6. Signed manifest and the site, on next only.
  step(
    'sign stable.json',
    process.execPath,
    [
      'scripts/sign-release-manifest.mjs',
      '--dmg',
      dmg,
      '--platform',
      'macos-arm64',
      '--native-update',
      `${zip}.native-update.json`
    ],
    { cwd }
  );
  // sign-release-manifest checks the descriptor against HEAD; the digests it records are
  // part of this build's identity, so they join its branch.
  git(['add', MANIFEST], cwd);
  git(['commit', '-q', '-m', `next-quick: record ${version} artifact digests`], cwd);
  step('push the recorded digests', 'git', ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], {
    cwd
  });
  // Server part of the same change, before the site that may call it: the reviewed
  // backend plan path, shared with production and gated on released-client
  // compatibility exactly as in the runner.
  if (changed.some(file => /^supabase\/(?:functions|migrations)\//u.test(file))) {
    const plan = path.resolve(
      root,
      `release/automation/backend-plan-quick-${head.slice(0, 12)}.json`
    );
    step(
      'backend plan',
      'node',
      ['scripts/plan-backend-release.mjs', `--since=${base}`, `--out=${plan}`],
      {
        cwd: root
      }
    );
    await withoutLock(() =>
      step(
        'backend apply (shared with production)',
        'node',
        ['scripts/apply-backend-plan.mjs', `--plan=${plan}`, '--confirm'],
        { cwd: root }
      )
    );
  }
  if (changed.some(file => file.startsWith('apps/catalog-image-delivery/'))) {
    step(
      'build delivery Worker',
      'npm',
      ['run', '--silent', 'build', '-w', '@video-compressor/catalog-image-delivery'],
      { cwd }
    );
    step('deploy delivery Worker', 'npx', ['--yes', WRANGLER, 'deploy'], {
      cwd: path.join(cwd, 'apps/catalog-image-delivery')
    });
  }
  const binding = activeBinding();
  if (!binding.previewBranch)
    throw new Error('next:quick:app publishes only to a binding with a next preview branch');
  step('build site with this manifest', 'npm', ['run', '--silent', 'build:web'], { cwd });
  step(
    `publish on ${binding.previewSiteOrigin}`,
    'npx',
    [
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
      git(['rev-parse', 'HEAD'], cwd)
    ],
    { cwd }
  );

  appendFileSync(
    LOG,
    `${JSON.stringify({ kind: 'app', version, buildNumber: String(buildNumber), sourceSha: head, buildSha: git(['rev-parse', 'HEAD'], cwd), branch, base, web: true, at: new Date().toISOString() })}\n`,
    { mode: 0o600 }
  );
  keepWorktree = false;
  process.stdout.write(
    `\n✓ next offers ${version} to Macs on the next update channel ` +
      '(defaults write local.video.compressor.test SotyUpdateChannel next).\n' +
      'Production is untouched; promote stays closed until a full release.\n'
  );
} finally {
  if (!keepWorktree) await worktree.remove().catch(() => {});
  else process.stderr.write(`\nWorktree kept for inspection: ${cwd}\n`);
  await lock.release();
}
