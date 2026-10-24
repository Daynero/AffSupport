import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import {
  mutateFaultJournal,
  inspectFaultCleanupGraph
} from '../scripts/acceptance/fault-journal.mjs';
const namespace = 'acceptance-fault-journal';
const fixture = {
  namespace,
  actors: Object.fromEntries(
    ['A', 'B', 'C', 'X', 'S'].map(alias => [
      alias,
      {
        id: randomUUID(),
        email: `${namespace}-${alias.toLowerCase()}@soty.invalid`,
        password: 'a'.repeat(32),
        provisioned: true
      }
    ])
  ),
  teams: { W1: randomUUID() }
};
const request = {
  faultId: randomUUID(),
  kind: 'lost_acceptance_response',
  actorId: fixture.actors.A.id,
  teamId: fixture.teams.W1,
  operationId: randomUUID(),
  flowId: randomUUID(),
  ttlMs: 300000
};
const context = {
  namespace,
  actorId: request.actorId,
  teamId: request.teamId,
  operationId: request.operationId,
  flowId: request.flowId,
  phase: 'acceptance'
};
let db: PGlite;
const client = {
  query: async (sql: string, params?: unknown[]) =>
    params ? db.query(sql, params) : ((await db.exec(sql)).at(-1) ?? { rows: [] })
};
const run = (command: unknown) => mutateFaultJournal(client, namespace, fixture, command);
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create schema private; create schema auth; create role anon; create role authenticated; create role service_role;
 create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb);
 create table public.teams(id uuid primary key,name text);
 create table public.team_operations(id uuid primary key,team_id uuid,actor_id uuid,idempotency_key text);`);
  await db.query('insert into auth.users values($1,$2,$3)', [
    request.actorId,
    fixture.actors.A.email,
    JSON.stringify({ acceptance_namespace: namespace })
  ]);
  await db.query('insert into public.teams values($1,$2)', [request.teamId, `${namespace} W1`]);
  await db.query('insert into public.team_operations values($1,$2,$3,$4)', [
    request.operationId,
    request.teamId,
    request.actorId,
    `${namespace}:fault:${request.flowId}`
  ]);
}, 30000);
beforeEach(async () => {
  await db.exec('rollback; drop table if exists private.acceptance_scoped_faults cascade');
});
afterAll(async () => {
  await db?.close();
});
it('does not install the journal for status or clear before arming', async () => {
  expect(await run({ action: 'status' })).toMatchObject({ journalOnly: true, state: 'absent' });
  expect(await run({ action: 'clear' })).toMatchObject({ state: 'absent' });
});
it('arms once without extending expiry, and persists only actual ordered transitions', async () => {
  const first = await run({ action: 'arm', request });
  expect(first).toMatchObject({ journalOnly: true, changed: true, entry: { state: 'armed' } });
  expect(await run({ action: 'arm', request })).toMatchObject({
    changed: false,
    entry: first.entry
  });
  await expect(
    run({ action: 'transition', faultId: request.faultId, context, transition: 'observe' })
  ).rejects.toThrow('ACCEPTANCE_FAULT_TRANSITION_INVALID');
  for (const [transition, state] of [
    ['claim', 'claimed'],
    ['effect-start', 'effect_started'],
    ['observe', 'observed']
  ]) {
    expect(
      await run({ action: 'transition', faultId: request.faultId, context, transition })
    ).toMatchObject({ changed: true, entry: { state } });
  }
  expect(
    await run({ action: 'transition', faultId: request.faultId, context, transition: 'observe' })
  ).toMatchObject({ changed: false });
});
it('serializes concurrent same-client claims so precisely one succeeds', async () => {
  await run({ action: 'arm', request });
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      run({ action: 'transition', faultId: request.faultId, context, transition: 'claim' })
    )
  );
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
});
it('rejects a foreign operation before installing any schema', async () => {
  await expect(
    run({ action: 'arm', request: { ...request, operationId: randomUUID() } })
  ).rejects.toThrow('ACCEPTANCE_FAULT_OPERATION_UNOWNED');
  expect(await run({ action: 'status' })).toMatchObject({ state: 'absent' });
});
it('rejects mismatched scope without advancing the row and makes clear idempotent', async () => {
  await run({ action: 'arm', request });
  await expect(
    run({
      action: 'transition',
      faultId: request.faultId,
      context: { ...context, actorId: fixture.actors.B.id },
      transition: 'claim'
    })
  ).rejects.toThrow('ACCEPTANCE_FAULT_SCOPE_MISMATCH');
  expect(await run({ action: 'status' })).toMatchObject({ entries: [{ state: 'armed' }] });
  expect(await run({ action: 'clear' })).toMatchObject({ changed: 1 });
  expect(await run({ action: 'clear' })).toMatchObject({ changed: 0 });
  await expect(
    run({ action: 'transition', faultId: request.faultId, context, transition: 'claim' })
  ).rejects.toThrow('ACCEPTANCE_FAULT_NOT_ACTIVE');
});
it('refuses same-id changed configuration rather than replacing it', async () => {
  await run({ action: 'arm', request });
  await expect(run({ action: 'arm', request: { ...request, ttlMs: 5000 } })).rejects.toThrow(
    'ACCEPTANCE_FAULT_CONFLICT'
  );
  expect(await run({ action: 'status' })).toMatchObject({ entries: [{ ttlMs: 300000 }] });
});
it('tears down its own journal without changing application operation rows', async () => {
  await run({ action: 'arm', request });
  expect(await run({ action: 'teardown' })).toMatchObject({ state: 'absent', removed: 1 });
  expect((await db.query('select count(*)::int n from public.team_operations')).rows).toEqual([
    { n: 1 }
  ]);
  expect(await run({ action: 'teardown' })).toMatchObject({ state: 'absent' });
});

it('retains another namespace on teardown and refuses a foreign row in its own namespace', async () => {
  await run({ action: 'arm', request });
  await db.query(
    `insert into private.acceptance_scoped_faults select 'acceptance-other-fixture',fault_id,kind,resource_kind,actor_id,team_id,operation_id,flow_id,ttl_ms,delay_ms,state,created_at_ms,expires_at_ms,changed_at_ms from private.acceptance_scoped_faults`
  );
  expect(await run({ action: 'teardown' })).toMatchObject({
    state: 'other_namespaces_retained',
    removed: 1
  });
  expect((await db.query('select namespace from private.acceptance_scoped_faults')).rows).toEqual([
    { namespace: 'acceptance-other-fixture' }
  ]);
  await run({ action: 'arm', request });
  await db.query('update private.acceptance_scoped_faults set actor_id=$1 where namespace=$2', [
    randomUUID(),
    namespace
  ]);
  await expect(run({ action: 'teardown' })).rejects.toThrow('ACCEPTANCE_FAULT_FOREIGN_STATE');
  expect(
    (await db.query('select count(*)::int n from private.acceptance_scoped_faults')).rows
  ).toEqual([{ n: 2 }]);
});

it('checks persisted expiry against database wall time and never rearms an expired id', async () => {
  await run({ action: 'arm', request });
  await db.query(
    'update private.acceptance_scoped_faults set created_at_ms=0,changed_at_ms=0,expires_at_ms=ttl_ms'
  );
  expect(await run({ action: 'status' })).toMatchObject({ entries: [{ expired: true }] });
  expect(await run({ action: 'arm', request })).toMatchObject({
    changed: false,
    entry: { expiresAtMs: request.ttlMs }
  });
  await expect(
    run({ action: 'transition', faultId: request.faultId, context, transition: 'claim' })
  ).rejects.toThrow('ACCEPTANCE_FAULT_EXPIRED');
  expect(await run({ action: 'clear' })).toMatchObject({ changed: 1 });
});

it('reports a lost commit acknowledgement as uncertain even when the transaction committed', async () => {
  const uncertainClient = {
    query: async (sql: string, params?: unknown[]) => {
      const result = await client.query(sql, params);
      if (sql === 'commit') throw Error('synthetic lost commit reply');
      return result;
    }
  };
  await expect(
    mutateFaultJournal(uncertainClient, namespace, fixture, { action: 'arm', request })
  ).rejects.toThrow('ACCEPTANCE_FAULT_UNCONFIRMED');
  expect(await run({ action: 'status' })).toMatchObject({ entries: [{ state: 'armed' }] });
});

it('refuses new arms and effect starts after cleanup begins while allowing clear', async () => {
  const { writePrivateState } = await import('../scripts/acceptance/private-state.mjs');
  const { unlink } = await import('node:fs/promises');
  await run({ action: 'arm', request });
  await run({ action: 'transition', faultId: request.faultId, context, transition: 'claim' });
  await writePrivateState(namespace, 'cleanup.json', { phase: 'planned' }, { createOnly: true });
  try {
    await expect(
      run({ action: 'arm', request: { ...request, faultId: randomUUID() } })
    ).rejects.toThrow('ACCEPTANCE_FIXTURE_CLEANUP_PENDING');
    await expect(
      run({ action: 'transition', faultId: request.faultId, context, transition: 'effect-start' })
    ).rejects.toThrow('ACCEPTANCE_FIXTURE_CLEANUP_PENDING');
    expect(await run({ action: 'clear' })).toMatchObject({ changed: 1 });
  } finally {
    await unlink(`release/acceptance-private/${namespace}/cleanup.json`);
  }
});

it('restores journal rows when the complete reference graph blocks cleanup', async () => {
  await run({ action: 'arm', request });
  const result = await inspectFaultCleanupGraph(client, namespace, fixture, async () => {
    expect(
      (await db.query("select to_regclass('private.acceptance_scoped_faults') is null absent"))
        .rows[0]
    ).toEqual({ absent: true });
    return { ok: false, blockers: [{ code: 'foreign_reference' }] };
  });
  expect(result).toMatchObject({ restored: true, cleanupGraph: { ok: false } });
  expect(await run({ action: 'status' })).toMatchObject({ entries: [{ state: 'armed' }] });
});

it('rolls back a graph inspection error instead of partially removing fault state', async () => {
  await run({ action: 'arm', request });
  await expect(
    inspectFaultCleanupGraph(client, namespace, fixture, async () => {
      throw Error('scan failed');
    })
  ).rejects.toThrow('scan failed');
  expect(await run({ action: 'status' })).toMatchObject({ entries: [{ state: 'armed' }] });
});

it('arms the first-response intent before an operation exists and resolves only the real correlated acceptance', async () => {
  const initial = { ...request, faultId: randomUUID(), flowId: randomUUID(), operationId: null };
  const scope = { ...context, flowId: initial.flowId, operationId: null };
  const actualId = randomUUID();
  try {
    expect(await run({ action: 'arm', request: initial })).toMatchObject({
      entry: { operationId: null, state: 'armed' }
    });
    expect(
      (
        await db.query(
          'select count(*)::int n from public.team_operations where idempotency_key=$1',
          [`${namespace}:fault:${initial.flowId}`]
        )
      ).rows
    ).toEqual([{ n: 0 }]);
    await run({
      action: 'transition',
      faultId: initial.faultId,
      context: scope,
      transition: 'claim'
    });
    await expect(
      run({
        action: 'transition',
        faultId: initial.faultId,
        context: scope,
        transition: 'effect-start'
      })
    ).rejects.toThrow('ACCEPTANCE_FAULT_OPERATION_UNOWNED');
    await db.query('insert into public.team_operations values($1,$2,$3,$4)', [
      actualId,
      request.teamId,
      request.actorId,
      `${namespace}:fault:${initial.flowId}`
    ]);
    expect(
      await run({
        action: 'transition',
        faultId: initial.faultId,
        context: scope,
        transition: 'effect-start'
      })
    ).toMatchObject({ entry: { state: 'effect_started' }, resolvedOperationId: actualId });
    expect(await run({ action: 'arm', request: initial })).toMatchObject({ changed: false });
  } finally {
    await db.query('delete from public.team_operations where id=$1', [actualId]);
  }
});

it('does not relabel an existing operation as a new first-acceptance intent', async () => {
  await expect(run({ action: 'arm', request: { ...request, operationId: null } })).rejects.toThrow(
    'ACCEPTANCE_FAULT_ALREADY_ACCEPTED'
  );
});

it('refuses an ambiguous first-acceptance correlation rather than selecting an arbitrary operation', async () => {
  const initial = { ...request, faultId: randomUUID(), flowId: randomUUID(), operationId: null };
  const scope = { ...context, flowId: initial.flowId, operationId: null };
  const ids = [randomUUID(), randomUUID()];
  try {
    await run({ action: 'arm', request: initial });
    await run({
      action: 'transition',
      faultId: initial.faultId,
      context: scope,
      transition: 'claim'
    });
    for (const id of ids)
      await db.query('insert into public.team_operations values($1,$2,$3,$4)', [
        id,
        request.teamId,
        request.actorId,
        `${namespace}:fault:${initial.flowId}`
      ]);
    await expect(
      run({
        action: 'transition',
        faultId: initial.faultId,
        context: scope,
        transition: 'effect-start'
      })
    ).rejects.toThrow('ACCEPTANCE_FAULT_OPERATION_AMBIGUOUS');
    expect(await run({ action: 'status', faultId: initial.faultId })).toMatchObject({
      entries: [{ state: 'claimed' }]
    });
  } finally {
    await db.query('delete from public.team_operations where id=any($1::uuid[])', [ids]);
  }
});

it('binds initial scan acceptance to its real requester, connection and job without inventing a team operation', async () => {
  await db.exec(
    'create table if not exists public.team_drive_connections(id uuid primary key,team_id uuid);create table if not exists private.catalog_sync_jobs(id uuid primary key,connection_id uuid);create table if not exists private.catalog_sync_requests(id uuid primary key,team_id uuid,connection_id uuid,job_id uuid,requested_by uuid,request_key text)'
  );
  const connectionId = randomUUID(),
    jobId = randomUUID(),
    requestId = randomUUID();
  const initial = {
    ...request,
    faultId: randomUUID(),
    flowId: randomUUID(),
    operationId: null,
    resourceKind: 'catalog_sync_request'
  };
  const scope = { ...context, flowId: initial.flowId, operationId: null };
  try {
    await db.query('insert into public.team_drive_connections values($1,$2)', [
      connectionId,
      request.teamId
    ]);
    await db.query('insert into private.catalog_sync_jobs values($1,$2)', [jobId, connectionId]);
    await expect(
      run({ action: 'arm', request: { ...request, resourceKind: 'catalog_sync_request' } })
    ).rejects.toThrow('ACCEPTANCE_FAULT_OPERATION_UNOWNED');
    await run({ action: 'arm', request: initial });
    await run({
      action: 'transition',
      faultId: initial.faultId,
      context: scope,
      transition: 'claim'
    });
    await db.query('insert into private.catalog_sync_requests values($1,$2,$3,$4,$5,$6)', [
      requestId,
      request.teamId,
      connectionId,
      jobId,
      request.actorId,
      `${namespace}:fault:${initial.flowId}`
    ]);
    const result = await run({
      action: 'transition',
      faultId: initial.faultId,
      context: scope,
      transition: 'effect-start'
    });
    expect(result).toMatchObject({
      resolvedResourceId: requestId,
      resolvedRequestId: requestId,
      resolvedJobId: jobId
    });
    expect(result.resolvedOperationId).toBeUndefined();
    await db.query('update private.catalog_sync_requests set requested_by=$2 where id=$1', [
      requestId,
      fixture.actors.B.id
    ]);
    await expect(
      run({
        action: 'arm',
        request: {
          ...initial,
          faultId: randomUUID(),
          operationId: requestId,
          kind: 'lost_status_response'
        }
      })
    ).rejects.toThrow('ACCEPTANCE_FAULT_OPERATION_UNOWNED');
    await db.query(
      'update private.catalog_sync_requests set requested_by=$2,connection_id=$3 where id=$1',
      [requestId, request.actorId, randomUUID()]
    );
    await expect(
      run({
        action: 'arm',
        request: {
          ...initial,
          faultId: randomUUID(),
          operationId: requestId,
          kind: 'lost_status_response'
        }
      })
    ).rejects.toThrow('ACCEPTANCE_FAULT_OPERATION_UNOWNED');
    expect(
      (
        await db.query(
          'select count(*)::int n from public.team_operations where idempotency_key=$1',
          [`${namespace}:fault:${initial.flowId}`]
        )
      ).rows
    ).toEqual([{ n: 0 }]);
  } finally {
    await db.query('delete from private.catalog_sync_requests where id=$1', [requestId]);
    await db.query('delete from private.catalog_sync_jobs where id=$1', [jobId]);
    await db.query('delete from public.team_drive_connections where id=$1', [connectionId]);
  }
});
