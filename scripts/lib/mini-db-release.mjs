import { rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import pg from 'pg';
import { atomicRecord } from './release/task-store.mjs';
import { acquireWebReleaseLock, webReleaseStateFile } from './web-only-lock.mjs';
import {
  MINI_DB_DIRECTORY,
  miniDbConnectionString,
  readMiniDbDocument,
  validateMiniDbDraft,
  readMiniDbTargetSnapshot,
  sameMiniDbSnapshot,
  loadVerifiedMiniDbPlan,
  saveVerifiedMiniDbPlan
} from './mini-db-plan.mjs';
import {
  dbValueDigest,
  applyMiniDbPlan,
  readMiniDbSnapshot,
  reconcileMiniDbPlan
} from './mini-db-transaction.mjs';
import { assertMiniDbSafety, assertMiniDbTransition } from './mini-db-policy.mjs';
const exec = promisify(execFile);
const SHA = /^[a-f0-9]{64}$/u;

const descriptor = snapshot => ({
  historyDigest: snapshot.historyDigest,
  catalogDigest: snapshot.catalogDigest
});
const stateFile = (cwd, name) => webReleaseStateFile(cwd, name);
async function removePending(cwd) {
  await rm(await stateFile(cwd, 'mini-db-pending.json'), { force: true });
}
async function writeDbState(cwd, plan, outcome, snapshot) {
  await atomicRecord(await stateFile(cwd, 'mini-db-state.json'), {
    schemaVersion: 1,
    kind: 'mini-db',
    sourceSha: plan.sourceSha,
    planDigest: plan.planDigest,
    bindingDigest: plan.bindingDigest,
    dbOutcome: outcome,
    snapshot: descriptor(snapshot),
    observedAt: new Date().toISOString()
  });
}

async function loadEvidence(cwd, planDigest, expectedDigest) {
  const evidence = await readMiniDbDocument(
    path.join(cwd, MINI_DB_DIRECTORY, 'plans', `${planDigest}.evidence.json`)
  );
  if (
    dbValueDigest(evidence) !== expectedDigest ||
    evidence.planDigest !== planDigest ||
    evidence.checks?.baseline !== 'matched' ||
    !['matched', 'not_needed'].includes(evidence.checks?.miniVendor) ||
    !['verified', 'not_needed'].includes(evidence.checks?.nextFullCli)
  )
    throw new Error('DB_REHEARSAL_EVIDENCE_UNPROVEN');
  return evidence;
}

/** A prepared browser proof is never sufficient for an upload before DB activation. */
export async function verifyMiniDbBackendProof({
  cwd,
  binding,
  backend,
  sourceSha,
  allowPrepared = false
}) {
  if (
    !backend ||
    backend.schemaVersion !== 1 ||
    backend.kind !== 'mini-db' ||
    !SHA.test(backend.planDigest ?? '') ||
    !SHA.test(backend.rehearsalDigest ?? '') ||
    backend.sourceSha !== sourceSha ||
    backend.betaSchemaVerified !== true ||
    !['prepared', 'applied'].includes(backend.state) ||
    (!allowPrepared && backend.state !== 'applied')
  )
    throw new Error('DB_WEB_PROOF_UNPROVEN');
  const plan = await loadVerifiedMiniDbPlan(cwd, backend.planDigest, binding);
  if (
    plan.sourceSha !== sourceSha ||
    dbValueDigest(plan.backendPaths) !== dbValueDigest(backend.backendPaths) ||
    dbValueDigest(descriptor(plan.before)) !== dbValueDigest(backend.before) ||
    dbValueDigest(descriptor(plan.after)) !== dbValueDigest(backend.after)
  )
    throw new Error('DB_WEB_PROOF_MISMATCH');
  const evidence = await loadEvidence(cwd, plan.planDigest, backend.rehearsalDigest);
  assertMiniDbSafety(plan.before, plan.migrations);
  assertMiniDbTransition(plan.before, plan.after, plan.migrations);
  if (
    !sameMiniDbSnapshot(evidence.before, plan.before) ||
    !sameMiniDbSnapshot(evidence.after, plan.after)
  )
    throw new Error('DB_REHEARSAL_EVIDENCE_UNPROVEN');
  const actual = await readMiniDbTargetSnapshot({
    binding,
    connectionString: miniDbConnectionString()
  });
  const matches =
    backend.state === 'applied'
      ? sameMiniDbSnapshot(actual, plan.after)
      : sameMiniDbSnapshot(actual, plan.before) || sameMiniDbSnapshot(actual, plan.after);
  if (!matches) throw new Error('DB_LIVE_STATE_CHANGED');
  return { plan, actual, backendPaths: plan.backendPaths };
}

/** Existing beta is observed only; this command never resets another local stack. */
async function assertBetaSchema(cwd, plan, beta) {
  let client;
  try {
    const cli =
      process.env.SOTY_MINI_SUPABASE_CLI ||
      path.join(cwd, 'release/automation/mini-db-tools/node_modules/.bin/supabase');
    const { stdout } = await exec(cli, ['status', '-o', 'json'], {
      cwd,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, SOTY_MINI_DATABASE_URL: '' }
    });
    const status = JSON.parse(stdout);
    if (status.API_URL !== beta.VITE_SUPABASE_URL) throw new Error('mismatch');
    const url = new URL(status.DB_URL);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.pathname !== '/postgres' ||
      decodeURIComponent(url.username) !== 'postgres'
    )
      throw new Error('target');
    client = new pg.Client({
      connectionString: url.toString(),
      ssl: false,
      connectionTimeoutMillis: 5000,
      query_timeout: 20_000,
      statement_timeout: 15_000,
      options: '-c default_transaction_read_only=on -c search_path=pg_catalog,public'
    });
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const actual = await readMiniDbSnapshot(client);
    await client.query('ROLLBACK');
    if (!sameMiniDbSnapshot(actual, plan.after)) throw new Error('schema');
    return descriptor(actual);
  } catch {
    throw new Error(
      'DB_BETA_SCHEMA_UNPROVEN: prepare the local beta at this exact candidate schema; the mini command never resets it'
    );
  } finally {
    client?.connection?.stream?.destroy();
    await client?.end().catch(() => {});
  }
}

export async function createMiniDbContext({ cwd, documentPath }) {
  const draft = validateMiniDbDraft(await readMiniDbDocument(path.resolve(cwd, documentPath)));
  let plan = null;
  let evidenceDigest = null;
  let betaVerified = false;
  let binding = null;
  const pointer = path.join(cwd, MINI_DB_DIRECTORY, 'drafts', `${draft.draftDigest}.verified.json`);
  return {
    backendPaths: draft.backendPaths,
    sourceSha: draft.sourceSha,
    draftDigest: draft.draftDigest,
    async prepare({ binding: actualBinding, gate }) {
      binding = actualBinding;
      validateMiniDbDraft(draft, binding);
      const cached = await readMiniDbDocument(pointer).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (cached) {
        plan = await loadVerifiedMiniDbPlan(cwd, cached.planDigest, binding);
        evidenceDigest = cached.rehearsalDigest;
        await loadEvidence(cwd, plan.planDigest, evidenceDigest);
      } else {
        const actual = await readMiniDbTargetSnapshot({
          binding,
          connectionString: miniDbConnectionString()
        });
        if (!sameMiniDbSnapshot(actual, draft.before))
          throw new Error('DB_BASELINE_CHANGED: generate a fresh read-only DB plan');
        const directory = path.join(cwd, MINI_DB_DIRECTORY, 'rehearsals', draft.draftDigest);
        const draftPath = path.join(directory, 'draft.json');
        const bindingPath = path.join(directory, 'binding.json');
        const resultPath = path.join(directory, 'result.json');
        await atomicRecord(draftPath, draft);
        await atomicRecord(bindingPath, binding);
        await rm(resultPath, { force: true });
        await gate(
          'db-rehearsal',
          [
            process.execPath,
            'scripts/test-mini-db-isolated.mjs',
            `--plan=${draftPath}`,
            `--binding=${bindingPath}`,
            `--artifact-directory=${directory}`,
            `--result=${resultPath}`
          ],
          { SOTY_MINI_DATABASE_URL: '', SUPABASE_ACCESS_TOKEN: '' },
          900_000
        );
        const result = await readMiniDbDocument(resultPath);
        plan = result.plan;
        if (
          plan.sourceSha !== draft.sourceSha ||
          plan.bindingDigest !== draft.bindingDigest ||
          dbValueDigest(plan.backendPaths) !== dbValueDigest(draft.backendPaths)
        )
          throw new Error('DB_REHEARSAL_SOURCE_CHANGED');
        assertMiniDbSafety(plan.before, plan.migrations);
        assertMiniDbTransition(plan.before, plan.after, plan.migrations);
        await saveVerifiedMiniDbPlan(cwd, plan, binding);
        evidenceDigest = dbValueDigest(result.evidence);
        await atomicRecord(
          path.join(cwd, MINI_DB_DIRECTORY, 'plans', `${plan.planDigest}.evidence.json`),
          result.evidence
        );
        await atomicRecord(pointer, {
          schemaVersion: 1,
          sourceSha: draft.sourceSha,
          planDigest: plan.planDigest,
          rehearsalDigest: evidenceDigest
        });
      }
      if (plan.sourceSha !== draft.sourceSha || plan.agentSha !== draft.agentSha)
        throw new Error('DB_PLAN_SOURCE_CHANGED');
      assertMiniDbSafety(plan.before, plan.migrations);
      assertMiniDbTransition(plan.before, plan.after, plan.migrations);
      const actual = await readMiniDbTargetSnapshot({
        binding,
        connectionString: miniDbConnectionString()
      });
      if (!sameMiniDbSnapshot(actual, plan.before) && !sameMiniDbSnapshot(actual, plan.after))
        throw new Error('DB_BASELINE_CHANGED');
      return {
        state: 'planned',
        planDigest: plan.planDigest,
        rehearsalDigest: evidenceDigest,
        before: descriptor(plan.before),
        after: descriptor(plan.after),
        pending: plan.migrations.map(item => item.version)
      };
    },
    async verifyBeta(beta) {
      if (!plan) throw new Error('DB_PLAN_UNPREPARED');
      await assertBetaSchema(cwd, plan, beta);
      betaVerified = true;
    },
    proof(state = 'prepared') {
      if (!plan || !evidenceDigest || !betaVerified) throw new Error('DB_PROOF_UNPREPARED');
      return {
        schemaVersion: 1,
        kind: 'mini-db',
        state,
        sourceSha: plan.sourceSha,
        planDigest: plan.planDigest,
        draftDigest: draft.draftDigest,
        rehearsalDigest: evidenceDigest,
        backendPaths: draft.backendPaths,
        before: descriptor(plan.before),
        after: descriptor(plan.after),
        betaSchemaVerified: true
      };
    },
    async adoptProof(backend) {
      if (
        !plan ||
        backend.planDigest !== plan.planDigest ||
        backend.draftDigest !== draft.draftDigest
      )
        throw new Error('DB_PROOF_PLAN_MISMATCH');
      await verifyMiniDbBackendProof({
        cwd,
        binding,
        backend,
        sourceSha: draft.sourceSha,
        allowPrepared: true
      });
      betaVerified = backend.betaSchemaVerified;
    },
    async activate() {
      if (!plan || !betaVerified) throw new Error('DB_ACTIVATION_UNPREPARED');
      const connectionString = miniDbConnectionString();
      const actual = await readMiniDbTargetSnapshot({ binding, connectionString });
      if (sameMiniDbSnapshot(actual, plan.after)) {
        await writeDbState(cwd, plan, 'adopted', actual);
        return this.proof('applied');
      }
      if (!plan.migrations.length || !sameMiniDbSnapshot(actual, plan.before))
        throw new Error('DB_BEFORE_MISMATCH');
      const marker = {
        schemaVersion: 1,
        kind: 'mini-db',
        ownerRoot: cwd,
        ownerPid: process.pid,
        sourceSha: plan.sourceSha,
        bindingDigest: binding.digest,
        planDigest: plan.planDigest,
        phase: 'intent',
        session: null,
        preparedAt: new Date().toISOString()
      };
      await atomicRecord(await stateFile(cwd, 'mini-db-pending.json'), marker, true);
      let prepared = false;
      try {
        const result = await applyMiniDbPlan({
          plan,
          binding,
          connectionString,
          journal: async receipt => {
            await atomicRecord(await stateFile(cwd, 'mini-db-pending.json'), {
              ...marker,
              ...receipt,
              kind: 'mini-db'
            });
            prepared = true;
          }
        });
        await writeDbState(cwd, plan, result.dbOutcome, result.snapshot);
        await removePending(cwd);
        return this.proof('applied');
      } catch (error) {
        if (
          !prepared ||
          (error instanceof Error && 'dbOutcome' in error && error.dbOutcome === 'aborted')
        )
          await removePending(cwd);
        throw error;
      }
    }
  };
}

export async function reconcileMiniDbRelease({ cwd, binding }) {
  const lock = await acquireWebReleaseLock({
    root: cwd,
    owner: 'mini-db:reconcile',
    allowPending: true
  });
  try {
    const marker = await readMiniDbDocument(await stateFile(cwd, 'mini-db-pending.json')).catch(
      error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    );
    if (!marker) return { ok: true, mode: 'reconcile-db', state: 'nothing_pending' };
    if (
      marker.kind !== 'mini-db' ||
      marker.bindingDigest !== binding.digest ||
      !path.isAbsolute(marker.ownerRoot ?? '') ||
      !SHA.test(marker.planDigest ?? '')
    )
      throw new Error(
        'DB_RECONCILIATION_MANUAL: inspect the original full/backend journal; no mini replay'
      );
    const plan = await loadVerifiedMiniDbPlan(marker.ownerRoot, marker.planDigest, binding);
    if (plan.sourceSha !== marker.sourceSha) throw new Error('DB_RECONCILIATION_SOURCE_MISMATCH');
    let result;
    if (!marker.session) {
      try {
        process.kill(marker.ownerPid, 0);
        throw new Error('DB_OWNER_STILL_RUNNING');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
      }
      const snapshot = await readMiniDbTargetSnapshot({
        binding,
        connectionString: miniDbConnectionString()
      });
      if (!sameMiniDbSnapshot(snapshot, plan.before)) throw new Error('DB_RECONCILIATION_UNKNOWN');
      result = { dbOutcome: 'aborted', snapshot };
    } else
      result = await reconcileMiniDbPlan({
        plan,
        binding,
        connectionString: miniDbConnectionString(),
        session: marker.session
      });
    if (!['committed', 'aborted'].includes(result.dbOutcome))
      throw new Error('DB_RECONCILIATION_UNKNOWN');
    if (result.dbOutcome === 'committed') await writeDbState(cwd, plan, 'adopted', result.snapshot);
    await removePending(cwd);
    return {
      ok: true,
      mode: 'reconcile-db',
      state: result.dbOutcome,
      planDigest: plan.planDigest,
      databaseWrites: 0
    };
  } finally {
    await lock.release();
  }
}
