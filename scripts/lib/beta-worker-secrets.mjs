/**
 * The named Vault secrets the scheduled workers read.
 *
 * `private.invoke_catalog_sync_worker()` looks up an endpoint and a shared secret in the
 * Vault and, finding neither, **returns null and does nothing** — by design, so that a
 * machine without them does not fire requests into the void. In production those rows are
 * created once by hand (docs/SUPABASE_SETUP.md § 9). Locally nothing created them, and they
 * live in the database, so every `supabase db reset` — including `npm run beta:reset`, a
 * documented command — silently removed them for good.
 *
 * What that looks like from the outside is the worst kind of failure. Cron keeps reporting
 * success every minute, because the function did run; it simply chose to do nothing. The scan
 * job sits at `pending` with no error recorded anywhere. Fifteen minutes later the workspace
 * says "the last sync failed" — and rescanning changes nothing, because the new job is queued
 * for a worker that is never called.
 *
 * So both halves are written from the same file the edge runtime is handed, which is what
 * keeps a shared secret from drifting apart between the two sides that must agree on it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { parseEnvFile } from './env-file.mjs';

/** Shorter than this and the functions refuse the call, so seeding it would only hide a 401. */
const MINIMUM_SECRET_LENGTH = 32;

const WORKERS = [
  { fn: 'catalog-sync', name: 'wishly_catalog_sync', key: 'CATALOG_SYNC_SECRET' },
  { fn: 'preview-warm', name: 'wishly_preview_warm', key: 'PREVIEW_WARM_SECRET' }
];

/**
 * Reachable from inside the database container, which is where `pg_net` runs.
 *
 * `kong` is the gateway's name on the stack's own network; `127.0.0.1` there would be the
 * database itself, and the host's port mapping does not exist from in there at all.
 */
function endpoint(fn) {
  return `http://kong:8000/functions/v1/${fn}`;
}

/** One secret, created or replaced. */
function upsert(name, value) {
  const quoted = `'${value.replaceAll("'", "''")}'`;
  return (
    `do $$ begin ` +
    `perform vault.update_secret(id, ${quoted}) from vault.secrets where name = '${name}'; ` +
    `if not found then perform vault.create_secret(${quoted}, '${name}', 'beta worker'); end if; ` +
    `end $$;`
  );
}

/**
 * The statements that make the local workers runnable, or an empty list when this machine has
 * no secrets to give them — in which case the scheduled work stays the deliberate no-op it is.
 */
export function workerSecretStatements(functionsEnvPath = 'supabase/functions/.env') {
  if (!existsSync(functionsEnvPath)) return [];
  const env = parseEnvFile(readFileSync(functionsEnvPath, 'utf8'));
  const statements = [];
  for (const worker of WORKERS) {
    const secret = env[worker.key];
    if (!secret || secret.length < MINIMUM_SECRET_LENGTH) continue;
    statements.push(upsert(`${worker.name}_url`, endpoint(worker.fn)));
    statements.push(upsert(`${worker.name}_secret`, secret));
  }
  return statements;
}
