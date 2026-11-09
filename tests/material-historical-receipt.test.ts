import { beforeAll, afterAll, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { assertReadOnlySql, setQueryExecutor } from '../scripts/analytics/db';
import { getMaterialGroupEvidence } from '../scripts/analytics/material-groups';
import { parseMaterialHistoricalReceipt } from '../supabase/functions/drive-ops/material-historical-receipt';
const team = '76000000-0000-4000-8000-000000000001',
  actor = '76000000-0000-4000-8000-000000000002',
  operationId = '76000000-0000-4000-8000-000000000003',
  materialId = '76000000-0000-4000-8000-000000000004';
let db: PGlite;
beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(`create schema private;create role anon;create role authenticated;create role service_role;create role wishly_analytics_ro;
 create function private.can(uuid,text,uuid) returns boolean language sql as 'select $3=''${actor}''::uuid';
 create table public.team_operations(id uuid,team_id uuid,actor_id uuid,source_material_id uuid,kind text,destination_folder_id uuid,state text);
 create table private.team_material_group_intents(id uuid,operation_id uuid,team_id uuid,source_material_id uuid,action text,state text,execution_protocol integer,execution_closed boolean,dispatch_member uuid,member_snapshot jsonb,applied_member_ids uuid[]);
 create table public.team_materials(id uuid,team_id uuid,drive_file_id text,placement_state text,lifecycle text);
 insert into public.team_operations values('${operationId}','${team}','${actor}','${materialId}','trash',null,'succeeded');
 insert into public.team_materials values('${materialId}','${team}','provider-file','ready','trashed');
 insert into private.team_material_group_intents values('${operationId}','${operationId}','${team}','${materialId}','trash','succeeded',2,true,null,'[{"material_id":"${materialId}","drive_file_id":"provider-file"}]',array['${materialId}']::uuid[]);`);
  await db.exec(`alter table private.team_material_group_intents add column created_at timestamptz default '2026-11-08T10:00:00Z',add column updated_at timestamptz default '2026-11-08T10:00:00Z';
 alter table public.team_operations add column updated_at timestamptz default '2026-11-08T10:00:00Z';
 alter table private.team_material_group_intents add column destination_parent_id text;
 alter table public.team_materials add column parent_folder_id text;
 update public.team_materials set parent_folder_id='original-parent';
 update private.team_material_group_intents set member_snapshot=jsonb_build_array(jsonb_build_object('material_id','${materialId}','drive_file_id','provider-file','parent_folder_id','original-parent'));
 alter table public.team_operations add column idempotency_key text, add column error_code text;
 create table private.team_bulk_trash_groups(id uuid,team_id uuid,actor_id uuid);
 create table private.team_bulk_trash_items(group_id uuid,material_id uuid,idempotency_key text,requested_at timestamptz,error_code text);
 update public.team_operations set idempotency_key='old-trash-key';
 insert into private.team_bulk_trash_groups values('${operationId}','${team}','${actor}');
 insert into private.team_bulk_trash_items values('${operationId}','${materialId}','old-trash-key',now(),null);`);
  await db.exec(
    readFileSync('supabase/migrations/20261207167000_material_historical_receipts.sql', 'utf8')
  );
  await db.exec(`create view public.analytics_material_group_execution as
   select g.id,g.operation_id,g.team_id,o.actor_id,g.action,'registered'::text state,null::text code,
    jsonb_array_length(g.member_snapshot)::integer member_count,cardinality(g.applied_member_ids)::integer confirmed_count,
    false has_unconfirmed_dispatch,g.created_at,g.updated_at,2 claim_protocol,1 execution_epoch
   from private.team_material_group_intents g join public.team_operations o on o.id=g.operation_id;
   grant select on public.analytics_material_group_execution to wishly_analytics_ro;`);
}, 30000);
afterAll(async () => {
  await db.close();
});
async function read() {
  return (
    await db.query<{ r: unknown }>(
      'select public.service_read_material_historical_receipt($1,$2,$3,$4,$5) r',
      [team, actor, operationId, materialId, 'trash']
    )
  ).rows[0]!.r;
}
it('reads immutable completion separately from a current matching, changed or missing catalog observation without writes', async () => {
  const expected = { operationId, materialId, action: 'trash' as const };
  expect(parseMaterialHistoricalReceipt(await read(), expected).historicalReceipt.state).toBe(
    'matches'
  );
  await db.exec(`update public.team_materials set lifecycle='active'`);
  expect(parseMaterialHistoricalReceipt(await read(), expected).historicalReceipt.state).toBe(
    'changed'
  );
  await db.exec("update public.team_materials set lifecycle='missing'");
  expect(parseMaterialHistoricalReceipt(await read(), expected).historicalReceipt.state).toBe(
    'unknown'
  );
  await db.exec("update public.team_materials set lifecycle='active'");
  await db.exec(`update public.team_materials set drive_file_id='replacement'`);
  expect(parseMaterialHistoricalReceipt(await read(), expected).historicalReceipt.state).toBe(
    'unknown'
  );
  expect(
    (await db.query<{ state: string }>('select state from public.team_operations')).rows[0]!.state
  ).toBe('succeeded');
  expect(
    (await db.query<{ lifecycle: string }>('select lifecycle from public.team_materials')).rows[0]!
      .lifecycle
  ).toBe('active');
});
it('does not expose unfinished or unclosed historical execution as success', async () => {
  await db.exec('update private.team_material_group_intents set execution_closed=false');
  expect(await read()).toBeNull();
  await db.exec('update private.team_material_group_intents set execution_closed=true');
});
it('rejects forged current-success claims and identity substitutions', () => {
  const value = {
    operationId,
    materialId,
    state: 'succeeded',
    reused: true,
    historicalReceipt: {
      protocolVersion: 1,
      action: 'trash',
      basis: 'catalog_snapshot',
      observedAt: new Date().toISOString(),
      state: 'matches',
      memberCount: 2,
      matchingCount: 1,
      missingCount: 0
    }
  };
  expect(() =>
    parseMaterialHistoricalReceipt(value, { operationId, materialId, action: 'trash' })
  ).toThrow('PROCESS_RESULT_UNCERTAIN');
});

it('projects changed historical evidence in a reopened hosted receipt while fresh matches retain compatibility', async () => {
  await db.exec(
    "update public.team_materials set drive_file_id='provider-file',lifecycle='trashed'"
  );
  const snapshot = async () =>
    (
      await db.query<{
        r: {
          items: Array<{ state: string; historicalReceipt?: { state: string; basis: string } }>;
        };
      }>('select private.bulk_trash_snapshot($1) r', [operationId])
    ).rows[0]!.r;
  expect((await snapshot()).items[0]!.historicalReceipt).toBeUndefined();
  await db.exec("update public.team_materials set lifecycle='active'");
  const reopened = await snapshot();
  expect(reopened.items[0]).toMatchObject({
    state: 'confirmed',
    historicalReceipt: { state: 'changed', basis: 'catalog_snapshot' }
  });
  expect((await snapshot()).items[0]).toMatchObject({
    historicalReceipt: { state: 'changed', basis: 'catalog_snapshot' }
  });
  expect(
    (
      await db.query<{ allowed: boolean }>(
        "select has_function_privilege('authenticated','public.service_read_material_historical_receipt(uuid,uuid,uuid,uuid,text,uuid)','execute') allowed"
      )
    ).rows[0]!.allowed
  ).toBe(false);
});

it('reads an exact completed key before current-material access without admission or provider work', async () => {
  await db.exec('delete from public.team_materials');
  const byKey = async (key: string, subject = actor) =>
    (
      await db.query<{ r: unknown }>(
        'select public.service_read_material_historical_receipt_by_key($1,$2,$3,$4,$5) r',
        [team, subject, materialId, 'trash', key]
      )
    ).rows[0]!.r;
  expect(
    parseMaterialHistoricalReceipt(await byKey('old-trash-key'), {
      operationId,
      materialId,
      action: 'trash'
    }).historicalReceipt
  ).toMatchObject({ state: 'unknown', missingCount: 1 });
  expect(await byKey('unrecognized-key')).toBeNull();
  await expect(byKey('old-trash-key', '76000000-0000-4000-8000-000000000099')).rejects.toThrow(
    'PERMISSION_DENIED'
  );
  expect(
    (await db.query<{ n: number }>('select count(*)::int n from public.team_operations')).rows[0]!.n
  ).toBe(1);
});

it('exports only opaque historical-observation facts to the SELECT-only analytics role', async () => {
  await db.exec(
    `insert into public.team_materials values('${materialId}','${team}','provider-file','ready','active','original-parent')`
  );
  await db.exec('set role wishly_analytics_ro');
  try {
    const rows = (
      await db.query<Record<string, unknown>>(
        'select * from public.analytics_material_historical_observations'
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: 'changed',
      basis: 'catalog_snapshot',
      matching_count: 0,
      missing_count: 0
    });
    expect(JSON.stringify(rows)).not.toContain('provider-file');
    expect(JSON.stringify(rows)).not.toContain('original-parent');
    await expect(db.exec("update public.team_materials set lifecycle='trashed'")).rejects.toThrow();
  } finally {
    await db.exec('reset role');
  }
});

it('delivers distinct original receipt and current observation through the actual SELECT-only CLI reader', async () => {
  await db.exec('set role wishly_analytics_ro');
  setQueryExecutor(async (sql, params) => {
    assertReadOnlySql(sql);
    return (await db.query(sql, params)).rows as Record<string, unknown>[];
  });
  try {
    const evidence = await getMaterialGroupEvidence({
      actorId: actor,
      asOf: '2026-11-08T12:00:00Z'
    });
    expect(evidence.records[0]).toMatchObject({ state: 'registered', confirmed_count: 1 });
    expect(evidence.historical_observations?.records[0]).toMatchObject({
      state: 'changed',
      basis: 'catalog_snapshot',
      matching_count: 0
    });
    expect(evidence.historical_observations?.basis).toBe('current_catalog_snapshot_only');
    expect(evidence.blind_spots.join(' ')).toContain('not current provider verification');
    expect(JSON.stringify(evidence)).not.toContain('provider-file');
  } finally {
    setQueryExecutor(null);
    await db.exec('reset role');
  }
});

it('does not let a matching source hide a subsequently restored companion', async () => {
  const companion = '76000000-0000-4000-8000-000000000005';
  await db.exec(`update public.team_materials set lifecycle='trashed' where id='${materialId}';
   insert into public.team_materials values('${companion}','${team}','companion-file','ready','active','original-parent');
   update private.team_material_group_intents set member_snapshot=member_snapshot||jsonb_build_array(jsonb_build_object('material_id','${companion}','drive_file_id','companion-file','parent_folder_id','original-parent')),applied_member_ids=array_append(applied_member_ids,'${companion}'::uuid);`);
  const receipt = parseMaterialHistoricalReceipt(await read(), {
    operationId,
    materialId,
    action: 'trash'
  });
  expect(receipt.historicalReceipt).toMatchObject({
    state: 'changed',
    memberCount: 2,
    matchingCount: 1,
    missingCount: 0
  });
  expect(
    (await db.query<{ state: string }>('select state from public.team_operations')).rows[0]!.state
  ).toBe('succeeded');
});

it('keeps a fresh unstarted bulk item queued without invoking historical authority', async () => {
  const group = '76000000-0000-4000-8000-000000000006',
    material = '76000000-0000-4000-8000-000000000007';
  await db.exec(`insert into private.team_bulk_trash_groups values('${group}','${team}','${actor}');
 insert into private.team_bulk_trash_items values('${group}','${material}','new-unstarted-key',null,null);`);
  const receipt = (
    await db.query<{ r: { items: Array<{ state: string; historicalReceipt?: unknown }> } }>(
      'select private.bulk_trash_snapshot($1) r',
      [group]
    )
  ).rows[0]!.r;
  expect(receipt.items[0]).toMatchObject({ state: 'queued' });
  expect(receipt.items[0]!.historicalReceipt).toBeUndefined();
});
