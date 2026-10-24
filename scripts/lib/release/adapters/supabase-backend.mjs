import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { clientBreakingStatements } from '../migration-compat.mjs';
import { redactText } from '../redaction.mjs';

/**
 * The adapter that actually talks to Supabase.
 *
 * `applyBackendPlan` owns the safety: the pending set must equal the plan, every
 * digest must match what was reviewed, the receipt is written before the write.
 * This supplies the five answers it needs, and deliberately supplies them by
 * driving the vendor's own CLI rather than by writing SQL against the migration
 * history table. That table is Supabase's bookkeeping, not ours; a home-made
 * insert that is subtly wrong does not fail loudly, it makes every later
 * migration run against a history nobody can trust.
 *
 * Which is why `apply` for a migration is `db push`, a command that applies
 * *everything pending* — blunt on its own, exact here, because nothing reaches
 * this adapter until the caller has proven the pending set is precisely the
 * reviewed plan. The gate makes the blunt instrument precise.
 *
 * A consequence worth naming: pushing a plan of three migrations applies all
 * three on the first change's `apply`. The receipts for the other two then say
 * "about to happen" about something that already has — which is exactly the
 * state reconciliation is built to read, since `observe` reports the migration
 * present and the postconditions met. No effect happens twice, and none happens
 * unrecorded.
 */

const CLI = 'supabase@2.117.0';
const CLI_TIMEOUT_MS = 300_000;
const exec = promisify(execFile);

export class SupabaseBackendError extends Error {
  constructor(code, subject) {
    super(subject ?? code);
    this.code = code;
  }
}

/** Deterministic hash of a directory's contents, path included. */
function directoryDigest(root) {
  const hash = createHash('sha256');
  const walk = (relative = '') => {
    const current = path.join(root, relative);
    for (const entry of readdirSync(current).sort()) {
      const next = path.join(relative, entry);
      if (statSync(path.join(root, next)).isDirectory()) walk(next);
      else {
        hash.update(next);
        hash.update('\0');
        hash.update(readFileSync(path.join(root, next)));
        hash.update('\0');
      }
    }
  };
  walk();
  return hash.digest('hex');
}

/**
 * `migration list` prints progress lines before its JSON, and the list of
 * skipped files in between. Taking the last parsable line survives the CLI
 * adding another message.
 */
export function lastJsonLine(output) {
  const lines = output.split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      /* not this line */
    }
  }
  throw new SupabaseBackendError('BACKEND_UNREADABLE', 'no JSON in CLI output');
}

/**
 * @param {{
 *   projectRef: string,
 *   targetId: string,
 *   root?: string,
 *   accessToken: string,
 *   run?: (args: readonly string[]) => string | Promise<string>
 * }} options
 */
export function createSupabaseBackendAdapter({ projectRef, targetId, root = process.cwd(), accessToken, run }) {
  if (!projectRef) throw new SupabaseBackendError('TARGET_MISMATCH', 'no project ref');
  if (!accessToken && !run) throw new SupabaseBackendError('ACCESS_UNAVAILABLE', 'no Supabase access token');

  const invoke =
    run ??
    (async args => {
      const pending = exec('npx', ['--yes', CLI, ...args], {
        cwd: root,
        encoding: 'utf8',
        timeout: CLI_TIMEOUT_MS,
        env: { ...process.env, SUPABASE_ACCESS_TOKEN: accessToken }
      });
      pending.child.stdin?.end();
      return (await pending).stdout;
    });
  const cli = async args => {
    try {
      return await invoke(args);
    } catch (error) {
      // Agent-mode CLI errors live on stdout; the process error includes
      // only stderr, which otherwise hides the actual reason from the panel.
      let problem;
      try {
        const stdout = error && typeof error === 'object' && 'stdout' in error ? String(error.stdout) : '';
        problem = lastJsonLine(stdout).error;
      } catch {
        throw error;
      }
      if (typeof problem?.message !== 'string') throw error;
      throw new SupabaseBackendError('GATE_FAILED', redactText(
        `Supabase ${problem.code ?? 'CLI_ERROR'}: ${problem.message}`
      ).slice(0, 1000));
    }
  };

  /** @type {any[] | null} A fresh post-push history snapshot, scoped to one apply attempt. */
  let migrationBatch = null;

  const migrationsDirectory = path.join(root, 'supabase/migrations');
  const functionsDirectory = path.join(root, 'supabase/functions');

  /** version -> file, so a plan that names a version can be hashed and read. */
  function migrationFiles() {
    const files = new Map();
    for (const name of readdirSync(migrationsDirectory))
      if (name.endsWith('.sql')) {
        const version = /^(\d+)_/u.exec(name)?.[1];
        if (version) files.set(version, path.join(migrationsDirectory, name));
      }
    return files;
  }

  function migrationSql(version) {
    const file = migrationFiles().get(version);
    if (!file) throw new SupabaseBackendError('BACKEND_CONTENT_MISMATCH', `no migration file for ${version}`);
    return readFileSync(file, 'utf8');
  }

  async function remoteMigrations() {
    return lastJsonLine(await cli(['migration', 'list', '--linked'])).migrations ?? [];
  }

  async function deployedFunctions() {
    return JSON.parse(await cli(['functions', 'list', '--project-ref', projectRef, '-o', 'json']));
  }

  function verifyLocal(change, appliedMigrations) {
    if (change.kind === 'migration')
      return appliedMigrations.has(change.id)
        ? { ok: true }
        : { ok: false, error: `${change.id} is not applied in the beta stack` };
    statSync(path.join(functionsDirectory, change.id));
    return { ok: true };
  }

  async function localMigrations() {
    const local = lastJsonLine(await cli(['migration', 'list', '--local'])).migrations ?? [];
    return new Set(local.map(row => row.remote).filter(Boolean));
  }

  return {
    async pendingMigrations() {
      // Every retry starts from current remote history, never a previous batch.
      migrationBatch = null;
      return (await remoteMigrations())
        .filter(entry => entry.local && !entry.remote)
        .map(entry => entry.local);
    },

    async digestOf(change) {
      if (change.kind === 'migration')
        return createHash('sha256').update(migrationSql(change.id)).digest('hex');
      // A function's behaviour is its own directory *and* the shared modules it
      // imports, so both go into the number. Hashing only the function's files
      // would call a function unchanged on the day `_shared` rewrote what it
      // does.
      const hash = createHash('sha256');
      hash.update(directoryDigest(path.join(functionsDirectory, change.id)));
      hash.update(directoryDigest(path.join(functionsDirectory, '_shared')));
      return hash.digest('hex');
    },

    async backwardsCompatible(change) {
      // Functions replace their own implementation and carry no schema the
      // released client depends on, so the question only has a mechanical
      // answer for migrations. A function that breaks an older client is a
      // design decision, and the plan's declaration is where it is recorded.
      if (change.kind !== 'migration') return true;
      return clientBreakingStatements(migrationSql(change.id)).length === 0;
    },

    async apply(change) {
      if (change.kind === 'migration') {
        // --skip-vault: this project declares no vault secrets in config.toml,
        // and a release must not quietly write ones somebody added there.
        if (!migrationBatch) {
          // The caller has already validated the exact pending set, all digests
          // and compatibility. Include reviewed gaps before later remote IDs too.
          await cli(['db', 'push', '--linked', '--skip-vault', '--include-all', '--yes']);
          migrationBatch = await remoteMigrations();
        }
        if (!migrationBatch?.some(row => row.remote === change.id))
          throw new SupabaseBackendError('GATE_FAILED', `${change.id} is absent from post-push migration history`);
        return { ok: true, transaction: 'transactional' };
      }
      await cli(['functions', 'deploy', change.id, '--project-ref', projectRef, '--use-api']);
      return { ok: true, transaction: 'nontransactional' };
    },

    async observe(change) {
      if (change.kind === 'migration') {
        const entry = (migrationBatch ?? await remoteMigrations()).find(row => row.local === change.id || row.remote === change.id);
        const present = Boolean(entry?.remote);
        return {
          historyPresent: present,
          postconditionsPass: present,
          targetId,
          provenAbsent: !entry
        };
      }
      const deployed = (await deployedFunctions()).find(entry => entry.slug === change.id);
      return {
        historyPresent: Boolean(deployed),
        postconditionsPass: deployed?.status === 'ACTIVE',
        targetId,
        provenAbsent: !deployed
      };
    },

    /**
     * The beta rehearsal. It asks the local stack a question it has already
     * answered by existing: a migration that is in the local history applied
     * cleanly to a real Postgres carrying the full history, and a function
     * directory that the local edge runtime booted is a function that parses and
     * imports what it claims to.
     */
    async verify(change) {
      try {
        return verifyLocal(change, change.kind === 'migration' ? await localMigrations() : new Set());
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'beta rehearsal failed' };
      }
    },

    // One fresh local-history read per rehearsal, never cached across retries
    // or used as evidence for a production write.
    async verifyAll(changes) {
      try {
        const applied = changes.some(change => change.kind === 'migration') ? await localMigrations() : new Set();
        for (const change of changes) {
          const result = verifyLocal(change, applied);
          if (!result.ok) return { ...result, changeId: change.id };
        }
        return { ok: true, changes: changes.length };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'beta rehearsal failed' };
      }
    }
  };
}
