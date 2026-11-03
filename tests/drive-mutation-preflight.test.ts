import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { acceptMutationPreflight } from '../supabase/functions/drive-ops/mutation-preflight';
import { validateLiveMutationTarget } from '../supabase/functions/drive-ops/handler';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';
import { type OperationAuthority } from '../supabase/functions/_shared/operations';
import { launchDriveMetadata } from './fixtures/launches';
import { deferred } from './fixtures/catalog-sync';

const TEAM = randomUUID(),
  ACTOR = randomUUID();
let db: PGlite;
beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(`create schema private;
    create role anon;create role authenticated;create role service_role;create role wishly_analytics_ro;
    create function private.can(uuid,text,uuid) returns boolean language sql as 'select $3=''${ACTOR}''::uuid';
    create table private.team_bulk_trash_groups(id uuid,team_id uuid,actor_id uuid);
    create table private.team_bulk_trash_items(group_id uuid,material_id uuid,idempotency_key text,requested_at timestamptz,error_code text);
    create table public.team_materials(id uuid,team_id uuid);
    create table private.team_transfer_grants(operation_id uuid,revoked_at timestamptz);
    create table private.team_material_group_intents(operation_id uuid);
    create table public.team_operations(id uuid,team_id uuid,actor_id uuid,kind text,idempotency_key text,state text,error_code text,
      stage text,progress integer default 0,result_material_id uuid,retryable boolean,
      reservation_released_at timestamptz,finished_at timestamptz,updated_at timestamptz default now());`);
  const source = readFileSync('supabase/migrations/20261205121000_bulk_trash_receipts.sql', 'utf8');
  const snapshot = source.match(
    /create function private\.bulk_trash_snapshot\([\s\S]*?\n\$\$;/u
  )?.[0];
  if (!snapshot) throw new Error('Canonical bulk snapshot missing');
  await db.exec(snapshot);
  const operations = readFileSync(
    'supabase/migrations/20260801102000_team_transfer_operations.sql',
    'utf8'
  );
  const transition = operations.match(
    /create or replace function public\.service_transition_team_operation\([\s\S]*?\n\$\$;/u
  )?.[0];
  if (!transition) throw new Error('Canonical operation transition missing');
  await db.exec(transition);
  await db.exec(
    readFileSync('supabase/migrations/20261207120000_drive_mutation_preflight_receipts.sql', 'utf8')
  );
}, 30_000);
afterAll(async () => {
  await db.close();
});

async function group(count: number) {
  const id = randomUUID();
  await db.query('insert into private.team_bulk_trash_groups values($1,$2,$3)', [id, TEAM, ACTOR]);
  const items = Array.from({ length: count }, () => ({
    materialId: randomUUID(),
    key: randomUUID()
  }));
  for (const item of items)
    await db.query(
      `insert into private.team_bulk_trash_items values($1,$2,$3,now(),'PERMISSION_DENIED')`,
      [id, item.materialId, item.key]
    );
  return { id, items };
}
async function snapshot(id: string) {
  return (
    await db.query<{ r: { items: Array<{ state: string; errorCode: string | null }> } }>(
      'select private.bulk_trash_snapshot($1) r',
      [id]
    )
  ).rows[0].r;
}
function operation(key: string) {
  const accept = vi.fn(async (): Promise<OperationAuthority> => {
    const existing = (
      await db.query<{ id: string; state: OperationAuthority['state'] }>(
        'select id,state from public.team_operations where idempotency_key=$1',
        [key]
      )
    ).rows[0];
    if (existing) return { operationId: existing.id, state: existing.state, reused: true };
    const id = randomUUID();
    await db.query(
      "insert into public.team_operations(id,team_id,actor_id,kind,idempotency_key,state,error_code) values($1,$2,$3,'trash',$4,'pending',null)",
      [id, TEAM, ACTOR, key]
    );
    return { operationId: id, state: 'pending', reused: false };
  });
  const fail = vi.fn(async (authority: OperationAuthority, error: TeamFunctionError) => {
    await db.query('select public.service_fail_drive_mutation_preflight($1,$2,$3,$4)', [
      authority.operationId,
      ACTOR,
      error.code,
      error.retryable
    ]);
  });
  return { accept, fail };
}
function denied() {
  const file = launchDriveMetadata();
  return validateLiveMutationTarget({
    action: 'trash',
    rootFolderId: 'root',
    ancestryProven: true,
    target: {
      id: 'provider-file',
      name: 'private.mp4',
      mimeType: 'video/mp4',
      parents: ['root'],
      trashed: false,
      shortcutTargetId: null,
      sizeBytes: 1,
      driveVersion: '1',
      checksum: null,
      capabilities: { ...file.capabilities, canTrash: false }
    }
  });
}

it('turns ten fresh pre-write Drive refusals into ten authoritative failed receipts', async () => {
  const g = await group(10);
  for (const item of g.items) {
    const ops = operation(item.key);
    await expect(
      acceptMutationPreflight({ ...ops, preflight: async () => denied() })
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  }
  const receipts = await snapshot(g.id);
  expect(receipts.items).toHaveLength(10);
  expect(
    receipts.items.every(item => item.state === 'failed' && item.errorCode === 'PERMISSION_DENIED')
  ).toBe(true);
});

it.each(['pending', 'running'] as const)(
  'retains a reused %s attempt when permissions later refuse a retry',
  async state => {
    const g = await group(1),
      item = g.items[0];
    await db.query(
      "insert into public.team_operations(id,team_id,actor_id,kind,idempotency_key,state,error_code) values($1,$2,$3,'trash',$4,$5,null)",
      [randomUUID(), TEAM, ACTOR, item.key, state]
    );
    const ops = operation(item.key);
    await expect(
      acceptMutationPreflight({ ...ops, preflight: async () => denied() })
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(ops.fail).not.toHaveBeenCalled();
    expect((await snapshot(g.id)).items[0].state).toBe('running');
  }
);

it('replays a confirmed receipt without repeating provider permission checks', async () => {
  const g = await group(1),
    item = g.items[0];
  await db.query(
    "insert into public.team_operations(id,team_id,actor_id,kind,idempotency_key,state,error_code) values($1,$2,$3,'trash',$4,'succeeded',null)",
    [randomUUID(), TEAM, ACTOR, item.key]
  );
  const ops = operation(item.key),
    preflight = vi.fn(async () => denied());
  expect(await acceptMutationPreflight({ ...ops, preflight })).toMatchObject({ replayed: true });
  expect(preflight).not.toHaveBeenCalled();
  expect(ops.fail).not.toHaveBeenCalled();
});

it('leaves a successful metadata preflight nonterminal for the existing provider saga', async () => {
  const g = await group(1),
    item = g.items[0],
    ops = operation(item.key);
  const result = await acceptMutationPreflight({ ...ops, preflight: async () => 'ready' });
  expect(result.replayed).toBe(false);
  // Provider/saga execution occurs after this boundary and remains owned by
  // its existing reconciliation path, never by the preflight failure handler.
  expect(ops.fail).not.toHaveBeenCalled();
  expect((await snapshot(g.id)).items[0].state).toBe('running');
});

it('does not fail a concurrent same-key replay that advanced to running while fresh preflight awaited', async () => {
  const g = await group(1),
    key = g.items[0].key;
  const entered = deferred<void>(),
    denial = deferred<void>(),
    fresh = operation(key);
  const first = acceptMutationPreflight({
    ...fresh,
    preflight: async () => {
      entered.resolve();
      await denial.promise;
    }
  });
  await entered.promise;
  const replay = await acceptMutationPreflight({
    ...operation(key),
    preflight: async () => 'ready'
  });
  await db.query(
    "select public.service_transition_team_operation($1,'running','trashing',25,null,null,false)",
    [replay.authority.operationId]
  );
  const refusal = expect(first).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  denial.reject(new TeamFunctionError('PERMISSION_DENIED'));
  await refusal;
  expect(fresh.fail).toHaveBeenCalledTimes(1);
  const row = (
    await db.query<{ state: string; error_code: string | null }>(
      'select state,error_code from public.team_operations where id=$1',
      [replay.authority.operationId]
    )
  ).rows[0];
  expect(row).toEqual({ state: 'running', error_code: null });
});

it('blocks a pending replay before provider writes if fresh refusal won the operation row first', async () => {
  const g = await group(1),
    key = g.items[0].key;
  const entered = deferred<void>(),
    denial = deferred<void>(),
    secondEntered = deferred<void>(),
    secondReady = deferred<void>();
  const first = acceptMutationPreflight({
    ...operation(key),
    preflight: async () => {
      entered.resolve();
      await denial.promise;
    }
  });
  await entered.promise;
  const second = acceptMutationPreflight({
    ...operation(key),
    preflight: async () => {
      secondEntered.resolve();
      await secondReady.promise;
    }
  });
  await secondEntered.promise;
  const refusal = expect(first).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  denial.reject(new TeamFunctionError('PERMISSION_DENIED'));
  await refusal;
  secondReady.resolve();
  const replay = await second;
  await expect(
    db.query(
      "select public.service_transition_team_operation($1,'running','trashing',25,null,null,false)",
      [replay.authority.operationId]
    )
  ).rejects.toThrow('WRONG_STATE');
  expect((await snapshot(g.id)).items[0].state).toBe('failed');
});

it('refuses to fail a pending operation with an existing lifecycle intent', async () => {
  const g = await group(1),
    authority = await operation(g.items[0].key).accept();
  await db.query('insert into private.team_material_group_intents values($1)', [
    authority.operationId
  ]);
  const result = await db.query<{ changed: boolean }>(
    "select public.service_fail_drive_mutation_preflight($1,$2,'PERMISSION_DENIED',false) changed",
    [authority.operationId, ACTOR]
  );
  expect(result.rows[0].changed).toBe(false);
  expect((await snapshot(g.id)).items[0].state).toBe('running');
});

it('leaves a receipt nonterminal when refusal persistence itself is unavailable', async () => {
  const g = await group(1),
    ops = operation(g.items[0].key);
  const fail = vi.fn(async () => {
    throw new Error('Synthetic response loss');
  });
  await expect(
    acceptMutationPreflight({ ...ops, fail, preflight: async () => denied() })
  ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  expect(fail).toHaveBeenCalledTimes(1);
  expect((await snapshot(g.id)).items[0].state).toBe('running');
});

it('permits only service execution and retains actor authorization and closed failure codes', async () => {
  for (const role of ['anon', 'authenticated', 'wishly_analytics_ro', 'service_role']) {
    const result = await db.query<{ allowed: boolean }>(
      "select has_function_privilege($1,'public.service_fail_drive_mutation_preflight(uuid,uuid,text,boolean)','execute') allowed",
      [role]
    );
    expect(result.rows[0].allowed).toBe(role === 'service_role');
  }
  const g = await group(1),
    authority = await operation(g.items[0].key).accept();
  await expect(
    db.query(
      "select public.service_fail_drive_mutation_preflight($1,$2,'PERMISSION_DENIED',false)",
      [authority.operationId, randomUUID()]
    )
  ).rejects.toThrow('PERMISSION_DENIED');
  await expect(
    db.query("select public.service_fail_drive_mutation_preflight($1,$2,'private-message',false)", [
      authority.operationId,
      ACTOR
    ])
  ).rejects.toThrow('INVALID_INPUT');
  expect((await snapshot(g.id)).items[0].state).toBe('running');
});
