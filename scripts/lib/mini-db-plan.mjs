import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { atomicRecord } from './release/task-store.mjs';
import { validateMiniDbInventory, analyseMiniDbSql } from './mini-db-policy.mjs';
import {
  dbValueDigest,
  readMiniDbSnapshot,
  validateMiniDbTarget,
  validateMiniDbPlan
} from './mini-db-transaction.mjs';

const exec = promisify(execFile);
const SHA = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
export const MINI_DB_DIRECTORY = 'release/automation/mini-db';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function miniDbConnectionString(environment = process.env) {
  const url = environment.SOTY_MINI_DATABASE_URL;
  if (!url || typeof url !== 'string')
    throw new Error(
      'DB_RELEASE_CREDENTIAL_MISSING: configure SOTY_MINI_DATABASE_URL; analytics credentials are never used'
    );
  return url;
}

/** Credentials are never serialized; this socket can perform reads only. */
export async function readMiniDbTargetSnapshot({
  binding,
  connectionString,
  clientFactory = config => new pg.Client(config)
}) {
  const config = validateMiniDbTarget(binding, connectionString);
  const client = clientFactory({
    ...config,
    options: `${config.options} -c default_transaction_read_only=on`,
    query_timeout: 20_000,
    statement_timeout: 15_000
  });
  let timer;
  try {
    const work = async () => {
      await client.connect();
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const snapshot = await readMiniDbSnapshot(client);
      await client.query('ROLLBACK');
      return snapshot;
    };
    return await Promise.race([
      work(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          client.connection?.stream?.destroy();
          reject(new Error('DB_READ_DEADLINE'));
        }, 25_000);
      })
    ]);
  } catch {
    throw new Error('DB_TARGET_SNAPSHOT_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
    client.connection?.stream?.destroy();
    await client.end().catch(() => {});
  }
}

export async function readMiniDbDocument(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32 * 1024 * 1024)
    throw new Error('DB_PLAN_FILE_UNSAFE');
  return JSON.parse(await readFile(file, 'utf8'));
}

/** Git objects, never mutable working files, are the source of the rehearsal. */
export async function miniDbInventory(cwd, sourceSha) {
  if (!COMMIT.test(sourceSha ?? '')) throw new Error('DB_SOURCE_INVALID');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  );
  const git = async args =>
    (
      await exec('git', ['-c', 'core.fsmonitor=false', ...args], {
        cwd,
        env,
        timeout: 15_000,
        maxBuffer: 32 * 1024 * 1024
      })
    ).stdout;
  const entries = (await git(['ls-tree', '-r', '-z', sourceSha, '--', 'supabase/migrations']))
    .split('\0')
    .filter(Boolean);
  const inventory = [];
  for (const entry of entries) {
    const split = entry.indexOf('\t');
    const [mode, kind] = entry.slice(0, split).split(' ');
    const name = entry.slice(split + 1);
    if (!name.endsWith('.sql')) continue;
    const match = /^supabase\/migrations\/([0-9]{14})_([a-z][a-z0-9_]*)\.sql$/u.exec(name);
    if (!match || kind !== 'blob' || !['100644', '100755'].includes(mode))
      throw new Error('DB_MIGRATION_FILE_UNSUPPORTED');
    const sql = await git(['show', `${sourceSha}:${name}`]);
    if (Buffer.byteLength(sql) > 2 * 1024 * 1024) throw new Error('DB_MIGRATION_TOO_LARGE');
    inventory.push({
      path: name,
      version: match[1],
      name: match[2],
      sourceDigest: digest(sql),
      sql
    });
  }
  inventory.sort((a, b) => a.version.localeCompare(b.version));
  if (new Set(inventory.map(item => item.version)).size !== inventory.length)
    throw new Error('DB_MIGRATION_DUPLICATE');
  return inventory;
}

export function validateMiniDbDraft(draft, binding) {
  if (
    !draft ||
    draft.schemaVersion !== 1 ||
    draft.kind !== 'mini-db-draft' ||
    !COMMIT.test(draft.sourceSha ?? '') ||
    !COMMIT.test(draft.agentSha ?? '') ||
    !SHA.test(draft.bindingDigest ?? '') ||
    !Array.isArray(draft.backendPaths) ||
    !Array.isArray(draft.inventory) ||
    !Array.isArray(draft.migrations) ||
    !draft.before
  )
    throw new Error('DB_DRAFT_INVALID');
  const { draftDigest, ...content } = draft;
  if (!SHA.test(draftDigest ?? '') || dbValueDigest(content) !== draftDigest)
    throw new Error('DB_DRAFT_DIGEST_MISMATCH');
  if (
    binding &&
    (binding.digest !== draft.bindingDigest ||
      binding.bindingId !== draft.targetId ||
      binding.supabaseProject !== draft.projectRef)
  )
    throw new Error('DB_BINDING_MISMATCH');
  const inventoryIds = draft.inventory.map(item => item.version);
  if (
    new Set(inventoryIds).size !== inventoryIds.length ||
    inventoryIds.some(
      (id, index) => !/^[0-9]{14}$/u.test(id) || (index > 0 && id <= inventoryIds[index - 1])
    )
  )
    throw new Error('DB_INVENTORY_INVALID');
  for (const item of draft.inventory) {
    if (
      !/^supabase\/migrations\/[0-9]{14}_[a-z][a-z0-9_]*\.sql$/u.test(item.path ?? '') ||
      typeof item.sql !== 'string' ||
      digest(item.sql) !== item.sourceDigest
    )
      throw new Error('DB_INVENTORY_CONTENT_MISMATCH');
  }
  const history = draft.before.history;
  if (
    !Array.isArray(history) ||
    history.length > inventoryIds.length ||
    history.some((row, index) => row.version !== inventoryIds[index])
  )
    throw new Error('DB_HISTORY_NOT_PREFIX');
  const expectedPending = draft.inventory.slice(history.length);
  if (dbValueDigest(expectedPending) !== dbValueDigest(draft.migrations))
    throw new Error('DB_PENDING_MISMATCH');
  validateMiniDbInventory(draft.migrations);
  for (const migration of draft.migrations)
    if (!analyseMiniDbSql(migration.sql).ok)
      throw new Error(`DB_SQL_NOT_ADDITIVE: ${migration.version}`);
  const names = new Set(draft.inventory.map(item => item.path));
  if (draft.backendPaths.some(name => !names.has(name))) throw new Error('DB_BACKEND_PATH_INVALID');
  return draft;
}

export async function createMiniDbDraft({ cwd, binding, source, backendPaths, connectionString }) {
  const inventory = await miniDbInventory(cwd, source.sourceSha);
  const before = await readMiniDbTargetSnapshot({ binding, connectionString });
  const migrations = inventory.slice(before.history.length);
  const draft = {
    schemaVersion: 1,
    kind: 'mini-db-draft',
    sourceSha: source.sourceSha,
    agentSha: source.agentSha,
    bindingDigest: binding.digest,
    targetId: binding.bindingId,
    projectRef: binding.supabaseProject,
    backendPaths: [...backendPaths].sort(),
    createdAt: new Date().toISOString(),
    inventory,
    migrations,
    before
  };
  const result = { ...draft, draftDigest: dbValueDigest(draft) };
  validateMiniDbDraft(result, binding);
  const file = path.join(cwd, MINI_DB_DIRECTORY, 'drafts', `${result.draftDigest}.json`);
  await atomicRecord(file, result);
  return { draft: result, file };
}

export async function saveVerifiedMiniDbPlan(cwd, plan, binding) {
  const pinned = validateMiniDbPlan(plan, binding);
  const file = path.join(cwd, MINI_DB_DIRECTORY, 'plans', `${pinned.planDigest}.json`);
  await atomicRecord(file, pinned);
  return file;
}

export async function loadVerifiedMiniDbPlan(cwd, planDigest, binding) {
  if (!SHA.test(planDigest ?? '')) throw new Error('DB_PLAN_DIGEST_INVALID');
  const plan = validateMiniDbPlan(
    await readMiniDbDocument(path.join(cwd, MINI_DB_DIRECTORY, 'plans', `${planDigest}.json`)),
    binding
  );
  if (plan.planDigest !== planDigest) throw new Error('DB_PLAN_DIGEST_MISMATCH');
  return plan;
}

export function sameMiniDbSnapshot(actual, expected) {
  return (
    actual.historyDigest === expected.historyDigest &&
    actual.catalogDigest === expected.catalogDigest
  );
}
