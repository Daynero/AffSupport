/**
 * Promotion gate.
 *
 * Nothing reaches production without having been exercised on a packaged beta
 * build. Two independent facts are required, and both are checked rather than
 * trusted from a note:
 *
 *   1. The release commit is contained in the `beta` branch, asked of git
 *      itself.
 *   2. A verification record exists for exactly this commit, written only after
 *      the packaged-beta smoke passed, so a stale pass cannot be reused.
 *
 * Before returning a verdict it prints the divergence between the two lines, so
 * a decision that needs a human is visible before anything is published.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const RECORD_PATH = 'release/beta/verification.json';
const BETA_BRANCH = process.env.BETA_BRANCH?.trim() || 'beta';

function fail(message) {
  process.stderr.write(`RELEASE_BETA_UNVERIFIED: ${message}\n`);
  process.exit(1);
}

function git(args, fallback = null) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return fallback;
  }
}

function branchRef() {
  for (const ref of [BETA_BRANCH, `origin/${BETA_BRANCH}`]) {
    if (git(['rev-parse', '--verify', '--quiet', ref])) return ref;
  }
  return null;
}

const head = git(['rev-parse', 'HEAD']);
if (!head)
  fail('this is not a git worktree, so containment in the beta line cannot be established.');

const ref = branchRef();
if (!ref) {
  fail(
    `no \`${BETA_BRANCH}\` branch was found locally or on origin. ` +
      'Feature work must land on the beta line and be verified there before release.'
  );
}

// Report the divergence first: the maintainer needs to see what differs even
// when the gate is about to pass, and especially when it is about to fail.
const ahead = git(['rev-list', '--count', `${ref}..HEAD`], '0');
const behind = git(['rev-list', '--count', `HEAD..${ref}`], '0');
process.stdout.write(
  `Promotion check against ${ref}:\n` +
    `  On HEAD but not on ${ref}: ${ahead} commit(s)\n` +
    `  On ${ref} but not on HEAD: ${behind} commit(s)\n`
);
if (Number(behind) > 0) {
  const pending = git(['log', '--oneline', '--max-count=10', `HEAD..${ref}`], '');
  if (pending) process.stdout.write(`  Not yet promoted:\n${pending.replace(/^/gm, '    ')}\n`);
}

let contained = true;
try {
  execFileSync('git', ['merge-base', '--is-ancestor', 'HEAD', ref], { stdio: 'ignore' });
} catch {
  contained = false;
}
if (!contained) {
  const unverified = git(['log', '--oneline', '--max-count=10', `${ref}..HEAD`], '');
  fail(
    `the release commit is not contained in ${ref}, so it was never verified in beta.\n` +
      (unverified ? `  Unverified commits:\n${unverified.replace(/^/gm, '    ')}\n` : '') +
      '  Merge the work into the beta line, verify it there, then promote.'
  );
}

if (!existsSync(RECORD_PATH)) {
  fail(
    `no beta verification record at ${RECORD_PATH}. ` +
      'Run `npm run beta:package` then `npm run beta:verify` before releasing.'
  );
}

let record;
try {
  record = JSON.parse(readFileSync(RECORD_PATH, 'utf8'));
} catch {
  fail(`the beta verification record at ${RECORD_PATH} is not readable JSON.`);
}

if (typeof record?.sourceRevision !== 'string' || !record.sourceRevision) {
  fail('the beta verification record does not name a source revision.');
}
if (record.sourceRevision !== head) {
  fail(
    `the beta verification record is for ${record.sourceRevision.slice(0, 12)}, ` +
      `but the release commit is ${head.slice(0, 12)}. A pass on other code proves nothing about this one.`
  );
}
if (record.dirty === true) {
  fail(
    'the packaged beta was built from a dirty worktree, so it does not correspond to any commit.'
  );
}
if (typeof record.verifiedAt !== 'string' || !record.verifiedAt) {
  fail('the beta verification record has no verification timestamp.');
}

process.stdout.write(
  `Beta verification confirmed: ${head.slice(0, 12)} was exercised on packaged build ` +
    `${record.buildId ?? 'unknown'} at ${record.verifiedAt}.\n`
);
