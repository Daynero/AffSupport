/**
 * Returns the beta environment to a documented, fixture-seeded baseline.
 *
 * The safety check runs before the first destructive step, not alongside it: a
 * reset is the one operation in this feature that could destroy real data, so a
 * misconfigured profile must cost nothing rather than cause partial damage.
 *
 * Database state is not the whole story — the agent keeps queue state, caches,
 * and entitlement state on disk — so resettable entries in beta Application
 * Support are cleared too. Multi-gigabyte models and downloaded runtimes are
 * installation assets, not test state, and survive so reset never redownloads
 * them; resumable `.part` files survive for the same reason.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { BETA_PROFILE, evaluateResetTarget } from '../packages/shared/dist/environment.js';

function fail(problem) {
  const message =
    typeof problem === 'string'
      ? problem
      : `${problem.code} (${problem.subject}): ${problem.message}\n  Remedy: ${problem.remedy}`;
  process.stderr.write(`Beta reset refused: ${message}\n`);
  process.exit(1);
}

// Checked first, before anything is run.
const unsafe = evaluateResetTarget(process.env.SUPABASE_DB_URL);
if (unsafe) fail(unsafe);

const seed = 'supabase/fixtures/beta-seed.sql';
if (!existsSync(seed)) fail(`the fixture file ${seed} is missing.`);

const reset = spawnSync('npx', ['supabase', 'db', 'reset'], { shell: false, stdio: 'inherit' });
if (reset.status !== 0) fail('`supabase db reset` did not complete.');

/**
 * Applied explicitly rather than as config.toml's shared seed, so ordinary local
 * development keeps its own behaviour.
 *
 * Sent over a direct connection rather than through `supabase db query`, which
 * uses a prepared statement and therefore rejects a multi-statement file. The
 * `pg` client is already a root dependency, so this adds no prerequisite.
 */
const LOCAL_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const target = process.env.SUPABASE_DB_URL?.trim() || LOCAL_DB_URL;

// Checked a second time: the connection string used here must be local even if
// the earlier check passed on a different value.
const targetUnsafe = evaluateResetTarget(target);
if (targetUnsafe) fail(targetUnsafe);

const client = new pg.Client({ connectionString: target });
try {
  await client.connect();
  await client.query(readFileSync(seed, 'utf8'));
} catch (error) {
  fail(
    `the fixtures in ${seed} could not be applied; the database is migrated but not seeded. ` +
      `${error instanceof Error ? error.message : error}`
  );
} finally {
  await client.end().catch(() => {});
}

function applicationSupportRoot() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  if (process.platform === 'win32') {
    return process.env.APPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Roaming');
  }
  return process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share');
}

// Named from the shared profile so this can never point at the production or
// dev directory by a typo.
const supportDirectory = path.join(applicationSupportRoot(), BETA_PROFILE.supportDirectoryName);
const preservedSupportEntries = new Set(['models', 'runtime']);
let clearedSupportEntries = 0;
if (existsSync(supportDirectory)) {
  for (const entry of readdirSync(supportDirectory)) {
    if (preservedSupportEntries.has(entry)) continue;
    rmSync(path.join(supportDirectory, entry), { recursive: true, force: true });
    clearedSupportEntries += 1;
  }
}

process.stdout.write(
  `Beta reset complete.\n` +
    `  Database: migrations re-applied, fixtures seeded from ${seed}\n` +
    `  Baseline: account beta@soty.local (password beta-password), workspace "Beta Workspace"\n` +
    `  Local state: cleared ${clearedSupportEntries} resettable entr${clearedSupportEntries === 1 ? 'y' : 'ies'} in ${supportDirectory}\n` +
    `  Cached assets: preserved models/ and runtime/ (including resumable .part downloads)\n`
);
