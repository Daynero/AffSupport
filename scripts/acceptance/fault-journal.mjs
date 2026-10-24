import {
  parseFaultRequest,
  armFaultDescriptor,
  validateFaultDescriptor,
  transitionFault,
  faultPhase
} from './fault-model.mjs';
import { ensureFaultSchema } from './fault-schema.mjs';
import { validateFixtureState, assertFixtureProvisionable } from './fixtures.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) =>
  object(value) &&
  Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));
const queues = new WeakMap();
const projection = `namespace,fault_id::text as "faultId",kind,resource_kind as "resourceKind",actor_id::text as "actorId",team_id::text as "teamId",operation_id::text as "operationId",flow_id::text as "flowId",ttl_ms as "ttlMs",delay_ms as "delayMs",state,created_at_ms as "createdAtMs",expires_at_ms as "expiresAtMs",changed_at_ms as "changedAtMs"`;

export function validateFaultCommand(command, namespace) {
  if (!object(command)) return false;
  if (command.action === 'arm')
    return (
      exact(command, ['action', 'request']) && parseFaultRequest(command.request, namespace).ok
    );
  if (['status', 'clear'].includes(command.action))
    return (
      exact(command, ['action']) ||
      (exact(command, ['action', 'faultId']) &&
        typeof command.faultId === 'string' &&
        uuid.test(command.faultId))
    );
  if (command.action === 'teardown') return exact(command, ['action']);
  return (
    exact(command, ['action', 'faultId', 'context', 'transition']) &&
    command.action === 'transition' &&
    typeof command.faultId === 'string' &&
    uuid.test(command.faultId) &&
    ['claim', 'effect-start', 'observe'].includes(command.transition) &&
    exact(command.context, ['namespace', 'actorId', 'teamId', 'operationId', 'flowId', 'phase'])
  );
}

function rowDescriptor(row) {
  const result = {
    ...row,
    ttlMs: Number(row.ttlMs),
    createdAtMs: Number(row.createdAtMs),
    expiresAtMs: Number(row.expiresAtMs),
    changedAtMs: Number(row.changedAtMs)
  };
  if (result.delayMs === null) delete result.delayMs;
  else result.delayMs = Number(result.delayMs);
  if (!validateFaultDescriptor(result)) throw Error('ACCEPTANCE_FAULT_FOREIGN_STATE');
  return result;
}
function context(entry) {
  return {
    namespace: entry.namespace,
    actorId: entry.actorId,
    teamId: entry.teamId,
    operationId: entry.operationId,
    flowId: entry.flowId,
    phase: faultPhase(entry.kind)
  };
}
async function assertFaultScope(db, namespace, fixture, entry) {
  const actor = Object.entries(fixture.actors).find(([, value]) => value.id === entry.actorId);
  const team = Object.entries(fixture.teams).find(([, value]) => value === entry.teamId);
  if (!actor || !team) throw Error('ACCEPTANCE_FAULT_SCOPE_MISMATCH');
  const valid = (
    await db.query(
      `select exists(select 1 from public.teams t cross join auth.users u
    where t.id=$1 and u.id=$2 and t.name=$3 and u.email=$4
    and u.raw_user_meta_data->>'acceptance_namespace'=$5) valid`,
      [
        entry.teamId,
        entry.actorId,
        `${namespace} ${team[0]}`,
        `${namespace}-${actor[0].toLowerCase()}@soty.invalid`,
        namespace
      ]
    )
  ).rows[0]?.valid;
  if (valid !== true) throw Error('ACCEPTANCE_FAULT_OPERATION_UNOWNED');
}
async function assertOperation(db, namespace, fixture, entry, requireAbsent = false) {
  await assertFaultScope(db, namespace, fixture, entry);
  const rows = (
    await db.query(
      entry.resourceKind === 'catalog_sync_request'
        ? `select r.id::text id,r.job_id::text "jobId" from private.catalog_sync_requests r
           join public.team_drive_connections c on c.id=r.connection_id and c.team_id=r.team_id
           join private.catalog_sync_jobs j on j.id=r.job_id and j.connection_id=r.connection_id
           where r.team_id=$1 and r.requested_by=$2 and r.request_key=$3
           and ($4::uuid is null or r.id=$4) order by r.id limit 2`
        : `select id::text id from public.team_operations where team_id=$1 and actor_id=$2
           and idempotency_key=$3 and ($4::uuid is null or id=$4) order by id limit 2`,
      [entry.teamId, entry.actorId, `${namespace}:fault:${entry.flowId}`, entry.operationId]
    )
  ).rows;
  if (requireAbsent) {
    if (rows.length) throw Error('ACCEPTANCE_FAULT_ALREADY_ACCEPTED');
    return null;
  }
  if (rows.length > 1) throw Error('ACCEPTANCE_FAULT_OPERATION_AMBIGUOUS');
  if (rows.length !== 1) throw Error('ACCEPTANCE_FAULT_OPERATION_UNOWNED');
  return rows[0];
}
async function writeTransition(db, previous, next) {
  const result = await db.query(
    `update private.acceptance_scoped_faults set state=$3,changed_at_ms=$4
    where namespace=$1 and fault_id=$2 and state=$5 and changed_at_ms=$6 returning fault_id`,
    [
      previous.namespace,
      previous.faultId,
      next.state,
      next.changedAtMs,
      previous.state,
      previous.changedAtMs
    ]
  );
  if (result.rows.length !== 1) throw Error('ACCEPTANCE_FAULT_STATE_CHANGED');
}

/** Core SQL journal only. Caller must independently verify the physical local
 * acceptance target/profile and load private fixture ownership. This helper owns
 * its transaction; it does not inject a response, notification or worker crash.
 * Passing a database client is an internal capability, never a CLI JSON field.
 */
export async function mutateFaultJournal(db, namespace, fixture, command) {
  if (!validateFixtureState(fixture, namespace).ok || !validateFaultCommand(command, namespace))
    throw Error('ACCEPTANCE_FAULT_INVALID');
  return queueMutation(db, namespace, fixture, command);
}

/** Internal cleanup seam: inspect application references while only this
 * namespace's validated journal rows are removed inside the same transaction.
 * A dry run or blocked graph rolls that removal back. No scan exemption exists.
 */
export async function inspectFaultCleanupGraph(db, namespace, fixture, inspect, dryRun = false) {
  if (!validateFixtureState(fixture, namespace).ok || typeof inspect !== 'function')
    throw Error('ACCEPTANCE_FAULT_INVALID');
  return queueMutation(db, namespace, fixture, { action: 'teardown' }, { inspect, dryRun });
}

/** @param {any} cleanup Internal transaction-scoped graph inspector, never JSON input. */
async function queueMutation(db, namespace, fixture, command, cleanup = null) {
  const previous = queues.get(db) ?? Promise.resolve();
  const running = previous
    .catch(() => undefined)
    .then(() => mutate(db, namespace, fixture, command, cleanup));
  queues.set(db, running);
  try {
    return await running;
  } finally {
    if (queues.get(db) === running) queues.delete(db);
  }
}

async function mutate(db, namespace, fixture, command, cleanup) {
  let committing = false;
  try {
    await db.query('begin');
    await db.query(
      "set local statement_timeout='5s'; set local lock_timeout='1s'; set local idle_in_transaction_session_timeout='10s'"
    );
    const locked = (
      await db.query('select pg_try_advisory_xact_lock(hashtextextended($1,0)) held', [
        `acceptance-fixtures:${namespace}`
      ])
    ).rows[0]?.held;
    if (locked !== true) throw Error('ACCEPTANCE_FAULT_BUSY');
    if (
      command.action === 'arm' ||
      (command.action === 'transition' && command.transition !== 'observe')
    )
      await assertFixtureProvisionable(namespace);
    let parsed;
    if (command.action === 'arm') {
      parsed = parseFaultRequest(command.request, namespace);
      if (!parsed.ok) throw Error(parsed.code);
      await assertFaultScope(db, namespace, fixture, parsed.value);
    }
    const schema = await ensureFaultSchema(db, { create: command.action === 'arm' });
    if (schema === 'absent') {
      if (command.action === 'transition') throw Error('ACCEPTANCE_FAULT_NOT_FOUND');
      const cleanupGraph = cleanup ? await cleanup.inspect() : undefined;
      committing = true;
      await db.query('commit');
      return {
        journalOnly: true,
        state: 'absent',
        entries: [],
        ...(cleanup ? { cleanupGraph } : {})
      };
    }
    const entries = (
      await db.query(
        `select ${projection} from private.acceptance_scoped_faults where namespace=$1 order by fault_id limit 65 for update`,
        [namespace]
      )
    ).rows.map(rowDescriptor);
    const actors = new Set(Object.values(fixture.actors).map(actor => actor.id));
    const teams = new Set(Object.values(fixture.teams));
    if (
      entries.length > 64 ||
      entries.some(entry => !actors.has(entry.actorId) || !teams.has(entry.teamId))
    )
      throw Error('ACCEPTANCE_FAULT_FOREIGN_STATE');
    const now = Number(
      (
        await db.query(
          'select floor(extract(epoch from pg_catalog.clock_timestamp())*1000)::bigint stamp'
        )
      ).rows[0].stamp
    );
    let result;
    if (command.action === 'arm') {
      if (!parsed?.ok) throw Error('ACCEPTANCE_FAULT_INVALID');
      const request = parsed.value;
      const existing = entries.find(entry => entry.faultId === request.faultId);
      if (existing) {
        const fields = [
          'faultId',
          'kind',
          'resourceKind',
          'actorId',
          'teamId',
          'operationId',
          'flowId',
          'ttlMs',
          'delayMs'
        ];
        if (fields.some(key => existing[key] !== request[key]))
          throw Error('ACCEPTANCE_FAULT_CONFLICT');
        result = { journalOnly: true, changed: false, entry: existing };
      } else {
        await assertOperation(db, namespace, fixture, request, request.operationId === null);
        const total = Number(
          (await db.query('select count(*)::int n from private.acceptance_scoped_faults')).rows[0].n
        );
        if (entries.length >= 64 || total >= 256) throw Error('ACCEPTANCE_FAULT_LIMIT');
        const entry = armFaultDescriptor(command.request, namespace, now);
        await db.query(
          `insert into private.acceptance_scoped_faults(namespace,fault_id,kind,actor_id,team_id,operation_id,flow_id,ttl_ms,delay_ms,state,created_at_ms,expires_at_ms,changed_at_ms,resource_kind)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            namespace,
            entry.faultId,
            entry.kind,
            entry.actorId,
            entry.teamId,
            entry.operationId,
            entry.flowId,
            entry.ttlMs,
            entry.delayMs ?? null,
            entry.state,
            entry.createdAtMs,
            entry.expiresAtMs,
            entry.changedAtMs,
            entry.resourceKind
          ]
        );
        result = { journalOnly: true, changed: true, entry };
      }
    } else if (command.action === 'transition') {
      const entry = entries.find(value => value.faultId === command.faultId);
      if (!entry) throw Error('ACCEPTANCE_FAULT_NOT_FOUND');
      const next = transitionFault(entry, command.context, command.transition, now);
      if (!next.ok) throw Error(next.code);
      const resolved = await assertOperation(
        db,
        namespace,
        fixture,
        entry,
        entry.operationId === null && command.transition === 'claim'
      );
      if (next.changed) await writeTransition(db, entry, next.entry);
      result = {
        journalOnly: true,
        ...next,
        resolvedResourceId: resolved?.id ?? null,
        ...(entry.resourceKind === 'catalog_sync_request'
          ? { resolvedRequestId: resolved?.id ?? null, resolvedJobId: resolved?.jobId ?? null }
          : { resolvedOperationId: resolved?.id ?? null })
      };
    } else if (command.action === 'clear') {
      const selected = command.faultId
        ? entries.filter(entry => entry.faultId === command.faultId)
        : entries;
      let changed = 0;
      for (const entry of selected) {
        const next = transitionFault(entry, context(entry), 'clear', now);
        if (!next.ok) throw Error(next.code);
        if (next.changed) {
          await writeTransition(db, entry, next.entry);
          changed++;
        }
      }
      result = { journalOnly: true, state: 'cleared', changed };
    } else if (command.action === 'teardown') {
      await db.query('lock table private.acceptance_scoped_faults in access exclusive mode');
      await db.query('delete from private.acceptance_scoped_faults where namespace=$1', [
        namespace
      ]);
      const remaining = Number(
        (await db.query('select count(*)::int n from private.acceptance_scoped_faults')).rows[0].n
      );
      if (remaining === 0) await db.query('drop table private.acceptance_scoped_faults');
      result = {
        journalOnly: true,
        state: remaining === 0 ? 'absent' : 'other_namespaces_retained',
        removed: entries.length
      };
    } else {
      const selected = command.faultId
        ? entries.filter(entry => entry.faultId === command.faultId)
        : entries;
      result = {
        journalOnly: true,
        state: 'present',
        entries: selected.map(entry => ({ ...entry, expired: now >= entry.expiresAtMs }))
      };
    }
    if (cleanup) {
      const cleanupGraph = await cleanup.inspect();
      const restored = cleanup.dryRun || !cleanupGraph.ok;
      if (restored) {
        await db.query('rollback');
        return { ...result, cleanupGraph, restored: true, dryRun: cleanup.dryRun };
      }
      result = { ...result, cleanupGraph, restored: false };
    }
    committing = true;
    await db.query('commit');
    return result;
  } catch (error) {
    await db.query('rollback').catch(() => undefined);
    if (committing) throw Error('ACCEPTANCE_FAULT_UNCONFIRMED', { cause: error });
    throw error;
  }
}
