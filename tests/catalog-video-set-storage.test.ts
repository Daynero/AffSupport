import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, expect, it } from 'vitest';
const id = (n: number) => '47000000-0000-4000-8000-' + String(n).padStart(12, '0');
let db: PGlite;
const payload = {
  setId: id(5),
  catalogIntentId: id(4),
  sourceMaterialId: id(3),
  sourceVersion: '1',
  settings: {},
  settingsDigest: 'a'.repeat(64),
  requestedCount: 2,
  productCount: 2,
  recipeRevision: 1,
  seed: 'b'.repeat(64)
};
const children = [
  { index: 0, requestId: id(10) },
  { index: 1, requestId: id(11) }
];
const assignments = [
  { recipeRowId: id(20), videoVariantIndex: 0 },
  { recipeRowId: id(21), videoVariantIndex: 1 }
];
const accept = async (p = payload, c = children) =>
  db.query<{ value: unknown }>(
    'select public.service_accept_catalog_video_set($1,$2,$3,$4,$5,$6) value',
    [id(1), id(2), id(6), p, c, assignments]
  );
beforeAll(async () => {
  db = new PGlite();
  await db.exec(
    `create schema private;create schema auth;create role anon;create role authenticated;create role service_role;create table auth.users(id uuid primary key);create table public.teams(id uuid primary key);create table public.team_catalog_events(team_id uuid,material_id uuid,event_kind text);create table public.team_materials(id uuid,team_id uuid,primary key(id),unique(id,team_id));create table private.catalog_generation_intents(id uuid,team_id uuid,actor_id uuid,video_material_id uuid,primary key(id),unique(id,team_id));create table public.team_catalog_update_attempts(attempt_id uuid primary key,team_id uuid,catalog_material_id uuid,result text);create table public.team_operations(id uuid primary key,team_id uuid,actor_id uuid,kind text,idempotency_key text,state text,source_material_id uuid,result_material_id uuid);create table private.team_operation_intents(operation_id uuid,team_id uuid,tool_id text,expected_source_version text);create function private.guard_task_cleanup_reference()returns trigger language plpgsql as 'begin return new;end';create function private.can(uuid,text,uuid) returns boolean language sql as 'select $3 is not null';insert into public.teams values('${id(1)}');insert into auth.users values('${id(2)}');insert into public.team_materials values('${id(3)}','${id(1)}');insert into private.catalog_generation_intents values('${id(4)}','${id(1)}','${id(2)}','${id(3)}');`
  );
  await db.exec(
    `alter table public.team_materials add column lifecycle text default 'active', add column size_bytes bigint default 100,add column connection_id uuid default '${id(8)}',add column kind text default 'file',add column drive_file_id text default 'synthetic-source',add column drive_version text default '1',add column checksum text default '${'a'.repeat(32)}',add column mime_type text default 'video/mp4',add column updated_at timestamptz default now();alter table private.catalog_generation_intents add column state text default 'reserved',add column checkpoint jsonb default '{}',add column result jsonb default '{}',add column replaces_material_id uuid;alter table public.team_operations add column destination_folder_id uuid,add column error_code text,add column progress jsonb,add column updated_at timestamptz default now();create table public.team_product_catalogs(material_id uuid,team_id uuid,video_material_id uuid);create table private.workspace_pauses(team_id uuid,epoch bigint);create table private.team_recovery_delegations(id uuid primary key,team_id uuid,actor_id uuid,installation_id uuid,version bigint);insert into private.team_recovery_delegations values('${id(7)}','${id(1)}','${id(2)}','${id(6)}',1);create table private.team_transfer_grants(id uuid primary key default gen_random_uuid(),token_hash bytea unique,operation_id uuid,team_id uuid,actor_id uuid,purpose text,material_id uuid,destination_folder_id uuid,tool_id text,max_range_bytes integer,expires_at timestamptz,revoked_at timestamptz,uses integer default 0,max_uses integer);create table private.team_recovery_execution_fences(operation_id uuid primary key references public.team_operations(id),team_id uuid,actor_id uuid,job_id uuid);create function public.service_team_recovery(text,bytea,jsonb) returns jsonb language plpgsql as $stub$ begin if $2 is distinct from decode(repeat('aa',32),'hex') then raise exception 'AUTH_REQUIRED';end if;return jsonb_build_object('teamId','${id(1)}','actorId','${id(2)}','installationId','${id(6)}','delegationId','${id(7)}');end;$stub$;`
  );
  await db.exec(
    await readFile('supabase/migrations/20261207168000_catalog_video_sets.sql', 'utf8')
  );
}, 30000);
afterAll(async () => {
  await db.close();
});
it('accepts immutable slots and balanced assignments and replays their original identity', async () => {
  const a = await accept();
  expect(a.rows[0]!.value).toMatchObject({
    setId: id(5),
    revision: 0,
    children: [{ requestId: id(10) }, { requestId: id(11) }]
  });
  expect((await accept()).rows).toEqual(a.rows);
});
it('refuses a changed request identity on same owner replay', async () => {
  await expect(accept(payload, [{ index: 0, requestId: id(12) }, children[1]!])).rejects.toThrow(
    'REQUEST_REUSE_CONFLICT'
  );
});
it('fences null execution epochs and stale revisions', async () => {
  await expect(
    db.query('select public.service_read_catalog_video_set($1,$2,$3,$4,$5)', [
      id(5),
      id(1),
      id(2),
      id(6),
      null
    ])
  ).rejects.toThrow('PERMISSION_DENIED');
  const r = await db.query<{ v: boolean }>(
    'select public.service_checkpoint_catalog_video_set($1,$2,$3,$4,$5,$6,$7) v',
    [
      id(5),
      id(1),
      id(2),
      id(6),
      1,
      99,
      children.map(c => ({ ...c, state: 'working', outputId: null }))
    ]
  );
  expect(r.rows[0]!.v).toBe(false);
});
it('rejects fabricated output registration without its original succeeded process receipt', async () => {
  await expect(
    db.query('select public.service_checkpoint_catalog_video_set($1,$2,$3,$4,$5,$6,$7)', [
      id(5),
      id(1),
      id(2),
      id(6),
      1,
      0,
      children.map(c => ({
        ...c,
        state: 'registered',
        operationId: id(10 + c.index),
        outputId: id(30 + c.index)
      }))
    ])
  ).rejects.toThrow('REQUEST_REUSE_CONFLICT');
});
it('marks ready only after distinct original restitch outputs register and retains their operation evidence', async () => {
  await db.exec(
    `insert into public.team_materials values('${id(30)}','${id(1)}'),('${id(31)}','${id(1)}');insert into public.team_operations values('${id(10)}','${id(1)}','${id(2)}','process','catalog-variant:${id(10)}','succeeded','${id(3)}','${id(30)}'),('${id(11)}','${id(1)}','${id(2)}','process','catalog-variant:${id(11)}','succeeded','${id(3)}','${id(31)}');insert into private.team_operation_intents values('${id(10)}','${id(1)}','restitch','1'),('${id(11)}','${id(1)}','restitch','1');`
  );
  const r = await db.query<{ v: boolean }>(
    'select public.service_checkpoint_catalog_video_set($1,$2,$3,$4,$5,$6,$7) v',
    [
      id(5),
      id(1),
      id(2),
      id(6),
      1,
      0,
      children.map(c => ({
        ...c,
        state: 'registered',
        operationId: id(10 + c.index),
        outputId: id(30 + c.index)
      }))
    ]
  );
  expect(r.rows[0]!.v).toBe(true);
  expect(
    (
      await db.query<{ state: string }>(
        'select state from private.catalog_video_sets where id=$1',
        [id(5)]
      )
    ).rows[0]!.state
  ).toBe('ready');
  await expect(
    db.query('delete from public.team_operations where id=$1', [id(10)])
  ).rejects.toThrow('WRONG_STATE');
});
it('does not expose service authority to authenticated browser roles', async () => {
  await db.exec('set role authenticated');
  try {
    await expect(
      db.query('select public.service_read_catalog_video_set($1,$2,$3,$4,$5)', [
        id(5),
        id(1),
        id(2),
        id(6),
        1
      ])
    ).rejects.toThrow('permission denied');
  } finally {
    await db.exec('reset role');
  }
});
it('binds the existing installed delegation to one native boot and refuses dispatch replay', async () => {
  await db.exec(
    `insert into private.catalog_generation_intents values('${id(40)}','${id(1)}','${id(2)}','${id(3)}');`
  );
  const next = {
    ...payload,
    setId: id(41),
    catalogIntentId: id(40),
    requestedCount: 1,
    productCount: 1
  };
  await db.query('select public.service_accept_catalog_video_set($1,$2,$3,$4,$5,$6)', [
    id(1),
    id(2),
    id(6),
    next,
    [{ index: 0, requestId: id(42) }],
    [{ recipeRowId: id(43), videoVariantIndex: 0 }]
  ]);
  await db.exec(
    `insert into public.team_operations(id,team_id,actor_id,kind,idempotency_key,state,source_material_id) values('${id(45)}','${id(1)}','${id(2)}','process','catalog-variant:${id(42)}','running','${id(3)}');insert into private.team_operation_intents values('${id(45)}','${id(1)}','restitch','1');`
  );
  await db.query('select public.service_checkpoint_catalog_video_set($1,$2,$3,$4,$5,$6,$7)', [
    id(41),
    id(1),
    id(2),
    id(6),
    1,
    0,
    [{ index: 0, requestId: id(42), operationId: id(45), state: 'working', outputId: null }]
  ]);
  const args = [id(41), Buffer.alloc(32, 0xaa), id(44), 1, 0, id(42), id(45)];
  const first = await db.query<{ v: { executionAllowed: boolean } }>(
    'select public.service_dispatch_catalog_video_variant($1,$2,$3,$4,$5,$6,$7) v',
    args
  );
  expect(first.rows[0]!.v.executionAllowed).toBe(true);
  const replay = await db.query<{ v: { executionAllowed: boolean } }>(
    'select public.service_dispatch_catalog_video_variant($1,$2,$3,$4,$5,$6,$7) v',
    args
  );
  expect(replay.rows[0]!.v.executionAllowed).toBe(false);
  await expect(
    db.query('select public.service_authorize_catalog_video_executor($1,$2,$3,$4)', [
      id(41),
      args[1],
      id(46),
      1
    ])
  ).rejects.toThrow('PERMISSION_DENIED');
});
it('replays exact grant pairs without resetting uses and bounds expired acquisitions', async () => {
  await db.exec(
    `create function private.issue_team_transfer_grant(bytea,uuid,uuid,uuid,text,uuid,uuid,text,integer,timestamptz,integer) returns uuid language plpgsql as $body$ declare created uuid; begin insert into private.team_transfer_grants(token_hash,operation_id,team_id,actor_id,purpose,material_id,destination_folder_id,tool_id,max_range_bytes,expires_at,max_uses)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)returning id into created;return created;end;$body$;`
  );
  const args = [id(41), Buffer.alloc(32, 0xaa), id(44), 1, 0, id(42), id(45)];
  const reserve = () =>
    db.query<{ v: { acquisition: number } }>(
      'select public.service_reserve_catalog_video_grants($1,$2,$3,$4,$5,$6,$7)v',
      args
    );
  const first = await reserve();
  expect((await reserve()).rows).toEqual(first.rows);
  const issue = () =>
    db.query(
      'select public.service_issue_catalog_video_grants($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [...args, 1, Buffer.alloc(32, 0xbb), Buffer.alloc(32, 0xcc), 9]
    );
  await issue();
  await db.exec(
    "update private.team_transfer_grants set uses=3,revoked_at=clock_timestamp() where purpose='finalize'"
  );
  await issue();
  expect(
    (
      await db.query<{ uses: number }>(
        "select uses from private.team_transfer_grants where purpose='finalize'"
      )
    ).rows[0]?.uses
  ).toBe(3);
  expect(
    (await db.query<{ n: number }>('select count(*)::integer n from private.team_transfer_grants'))
      .rows[0]?.n
  ).toBe(2);
  await db.exec(
    `update private.catalog_video_grant_rounds set expires_at=clock_timestamp()-interval '1 second' where video_set_id='${id(41)}'`
  );
  expect((await reserve()).rows[0]?.v.acquisition).toBe(2);
  await db.exec(
    `update private.catalog_video_grant_rounds set expires_at=clock_timestamp()-interval '1 second' where video_set_id='${id(41)}'`
  );
  await expect(reserve()).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
});
it('creates immutable ready recipes for new consumers and refuses remapping', async () => {
  await db.exec(
    `insert into private.catalog_generation_intents(id,team_id,actor_id,video_material_id)values('${id(50)}','${id(1)}','${id(2)}','${id(3)}')`
  );
  const recipe = {
    recipeRevision: 2,
    productCount: 3,
    seed: 'c'.repeat(64),
    settingsDigest: payload.settingsDigest,
    sourceVersion: '1',
    catalogIntentId: id(50)
  };
  const rows = [
    { recipeRowId: id(51), videoVariantIndex: 0 },
    { recipeRowId: id(52), videoVariantIndex: 1 },
    { recipeRowId: id(53), videoVariantIndex: 0 }
  ];
  const reference = (r = rows) =>
    db.query('select public.service_reference_ready_catalog_video_set($1,$2,$3,$4,$5)', [
      id(1),
      id(2),
      id(5),
      recipe,
      r
    ]);
  const accepted = await reference();
  expect((await reference()).rows).toEqual(accepted.rows);
  await expect(
    reference([{ ...rows[0]!, videoVariantIndex: 1 }, rows[1]!, rows[2]!])
  ).rejects.toThrow('REQUEST_REUSE_CONFLICT');
});
