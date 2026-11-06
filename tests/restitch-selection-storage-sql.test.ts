import { getInspect } from '../scripts/analytics/queries';
import { getInvestigation } from '../scripts/analytics/investigate';
import { resolvePeriod } from '../scripts/analytics/periods';
import { investigateOutputIsPrivate } from '../scripts/analytics/types';
import { assertReadOnlySql, setQueryExecutor } from '../scripts/analytics/db';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  RestitchSelectionSlotStore,
  type RestitchSelectionSlotScope
} from '../supabase/functions/drive-ops/restitch-selection-store';
import type { ServiceRpcClient } from '../supabase/functions/_shared/credentials';
import { createScreenSelectionBudget } from '@video-compressor/shared';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
const id = (n: number) => 'b1550000-0000-4000-8000-' + String(n).padStart(12, '0');
const owner = id(1),
  actor = id(2);
let db: TeamTestDb;
let sequence = 100;
beforeAll(async () => {
  db = await createTeamTestDb();
  for (const person of [owner, actor]) {
    await createUser(db, {
      id: person,
      email: person + '@selection.invalid',
      displayName: 'Synthetic selection actor'
    });
    await db.root('insert into public.admin_users(user_id) values($1)', [person]);
  }
}, 60000);
afterAll(async () => {
  await db?.close();
});
async function fixture() {
  const team = (
    await db.asUser<{ id: string }>(owner, 'select id from public.create_team($1)', [
      'Synthetic selection ' + sequence
    ])
  )[0]!.id;
  await db.root(
    "insert into public.team_members(team_id,user_id,base_role) values($1,$2,'admin')",
    [team, actor]
  );
  const credential = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values($1,$2,'fixture@selection.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file') returning id",
      [owner, 'selection-' + sequence]
    )
  )[0]!.id;
  const connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state) values($1,$2,$3,'Synthetic root','my_drive','connected') returning id",
      [team, credential, 'root-' + sequence]
    )
  )[0]!.id;
  const video = id(sequence++),
    image = id(sequence++),
    root = id(sequence++),
    version = id(sequence++),
    request = id(sequence++);
  await db.root(
    "insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum,drive_version) values($1,$3,$4,$1::uuid::text,$5,'Synthetic source.mp4','file','video','video/mp4',4,$6,'1'),($2,$3,$4,$2::uuid::text,$5,'Synthetic screen.png','file','image','image/png',4,$6,'1')",
    [video, image, team, connection, 'root-' + (sequence - 5), 'a'.repeat(32)]
  );
  await db.root(
    "insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce) values($1,$2,$3,'download','running',$4,$1::uuid::text,'selection:'||$1::uuid::text)",
    [root, team, actor, video]
  );
  const recipe = {
    schemaVersion: 1,
    seed: id(sequence++),
    defaults: {
      operation: 'restitch',
      sourceMode: 'drive',
      configured: true,
      startEnabled: false,
      endEnabled: true
    }
  };
  await db.root(
    'insert into private.restitch_selection_roots(root_operation_id,team_id,actor_id,source_material_id,source_version,recipe_owner_id,pool_namespace_id,recipe) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
    [root, team, actor, video, '1', owner, id(sequence++), JSON.stringify(recipe)]
  );
  await db.root(
    "insert into private.restitch_selection_candidates(root_operation_id,slot,version_id,material_id,ordinal,size_bytes,mime_type,checksum,drive_version) values($1,'end',$2,$3,1,4,'image/png',$4,'1')",
    [root, version, image, 'a'.repeat(32)]
  );
  await db.root(
    'update private.restitch_selection_slots set snapshot_complete=true where root_operation_id=$1',
    [root]
  );
  const scope: RestitchSelectionSlotScope = {
    rootOperationId: root,
    teamId: team,
    actorId: actor,
    slot: 'end'
  };
  const rpc: ServiceRpcClient['rpc'] = async (name, args) => {
    const map: Record<string, { sql: string; args: unknown[] }> = {
      service_read_restitch_selection_slot: {
        sql: 'select public.service_read_restitch_selection_slot($1,$2,$3,$4) value',
        args: [args.p_root_operation, args.p_team, args.p_actor, args.p_slot]
      },
      service_cas_restitch_selection_slot: {
        sql: 'select public.service_cas_restitch_selection_slot($1,$2,$3,$4,$5::jsonb,$6::jsonb) value',
        args: [
          args.p_root_operation,
          args.p_team,
          args.p_actor,
          args.p_slot,
          JSON.stringify(args.p_expected_budget),
          JSON.stringify(args.p_next_budget)
        ]
      },
      service_settle_restitch_selection_range: {
        sql: 'select public.service_settle_restitch_selection_range($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) value',
        args: [
          args.p_root_operation,
          args.p_team,
          args.p_actor,
          args.p_slot,
          args.p_request,
          JSON.stringify(args.p_expected_reservation),
          JSON.stringify(args.p_measurement)
        ]
      }
    };
    const call = map[name];
    if (!call) throw Error('Unexpected service method');
    await db.db.exec('begin;set local role service_role');
    try {
      const result = await db.db.query<{ value: unknown }>(call.sql, call.args);
      await db.db.exec('commit');
      return { data: result.rows[0]?.value, error: null };
    } catch (error) {
      await db.db.exec('rollback');
      return { data: null, error: { message: (error as Error).message } };
    }
  };
  const service: ServiceRpcClient = { rpc };
  return {
    team,
    root,
    image,
    version,
    request,
    scope,
    service,
    store: () => new RestitchSelectionSlotStore(service, scope)
  };
}
it('persists acknowledged selection/range and returns duplicate dispatch only as readback', async () => {
  const f = await fixture();
  await f.store().select(f.version, 4);
  expect((await f.store().reserve(f.version, f.request, 0)).kind).toBe('dispatch');
  expect((await f.store().reserve(f.version, f.request, 0)).kind).toBe('readback');
  await f.store().settle(f.request, { bytes: 2, ioMs: 5, complete: false });
  const state = await f.store().read();
  expect(state.transfers).toHaveLength(1);
  expect(state.transfers[0]?.settlement).toEqual({ bytes: 2, ioMs: 5, complete: false });
});
it('retains an actual SQL reservation when its committed acknowledgement is lost', async () => {
  const f = await fixture();
  await f.store().select(f.version, 4);
  let lost = false;
  const service: ServiceRpcClient = {
    rpc: async (name, args) => {
      const reply = await f.service.rpc(name, args);
      if (name === 'service_cas_restitch_selection_slot' && reply.data === true && !lost) {
        lost = true;
        throw Error('SYNTHETIC_NETWORK');
      }
      return reply;
    }
  };
  await expect(
    new RestitchSelectionSlotStore(service, f.scope).reserve(f.version, f.request, 0)
  ).rejects.toMatchObject({ code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' });
  expect((await f.store().reserve(f.version, f.request, 0)).kind).toBe('readback');
  await expect(f.store().reserve(f.version, id(sequence++), 0)).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
});
it('settles a reserved prefix after membership removal and refuses another read', async () => {
  const f = await fixture();
  await f.store().select(f.version, 4);
  await f.store().reserve(f.version, f.request, 0);
  await db.root(
    "update public.team_members set status='removed',removed_at=clock_timestamp() where team_id=$1 and user_id=$2",
    [f.team, actor]
  );
  await f.store().settle(f.request, { bytes: 2, ioMs: 5, complete: false });
  await expect(f.store().reserve(f.version, id(sequence++), 0)).rejects.toMatchObject({
    code: 'PERMISSION_DENIED'
  });
  expect((await f.store().read()).transfers).toHaveLength(1);
});
it('settles issued accounting after parent cancellation without issuing a new permit', async () => {
  const f = await fixture();
  await f.store().select(f.version, 4);
  await f.store().reserve(f.version, f.request, 0);
  await db.root(
    "update public.team_operations set state='canceled',stage='canceled',finished_at=clock_timestamp() where id=$1",
    [f.root]
  );
  await f.store().settle(f.request, { bytes: 2, ioMs: 5, complete: false });
  await expect(f.store().reserve(f.version, id(sequence++), 0)).rejects.toMatchObject({
    code: 'WRONG_STATE'
  });
});
it('refuses a scope substitution and a disabled slot', async () => {
  const f = await fixture();
  await expect(
    new RestitchSelectionSlotStore(f.service, { ...f.scope, actorId: owner }).read()
  ).rejects.toMatchObject({ code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' });
  await expect(
    new RestitchSelectionSlotStore(f.service, { ...f.scope, slot: 'start' }).select(f.version, 4)
  ).rejects.toMatchObject({ code: 'RESTITCH_SOURCES_INVALID' });
});
it('does not allow even a maintenance update to reset a used budget', async () => {
  const f = await fixture();
  await f.store().select(f.version, 4);
  await f.store().reserve(f.version, f.request, 0);
  await expect(
    db.root(
      "update private.restitch_selection_slots set budget=$2::jsonb where root_operation_id=$1 and slot='end'",
      [f.root, JSON.stringify(createScreenSelectionBudget())]
    )
  ).rejects.toMatchObject({ message: expect.stringContaining('WRONG_STATE') });
  expect((await f.store().read()).transfers).toHaveLength(1);
});
it('keeps all direct tables and mutation RPCs unavailable to browser roles', async () => {
  const rows = await db.root<{ name: string; browser: boolean; service: boolean }>(
    "select name,has_function_privilege('authenticated',name,'execute') browser,has_function_privilege('service_role',name,'execute') service from unnest(array['public.service_read_restitch_selection_slot(uuid,uuid,uuid,text)','public.service_cas_restitch_selection_slot(uuid,uuid,uuid,text,jsonb,jsonb)','public.service_settle_restitch_selection_range(uuid,uuid,uuid,text,uuid,jsonb,jsonb)'])name"
  );
  expect(rows).toHaveLength(3);
  expect(rows.every(row => !row.browser && row.service)).toBe(true);
  const tables = await db.root<{
    name: string;
    forced: boolean;
    browser: boolean;
    service: boolean;
  }>(
    "select c.relname name,c.relforcerowsecurity forced,has_table_privilege('authenticated',c.oid,'select,insert,update,delete') browser,has_table_privilege('service_role',c.oid,'select,insert,update,delete') service from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname in('restitch_selection_roots','restitch_selection_slots','restitch_selection_candidates')"
  );
  expect(tables).toHaveLength(3);
  expect(tables.every(row => row.forced && !row.browser && !row.service)).toBe(true);
});
it('retains cleanup-reference inventory and late-reference fences for all storage records', async () => {
  const rows = await db.root<{ table_name: string; fenced: boolean }>(
    "select i.table_name,exists(select 1 from pg_trigger t where t.tgrelid=to_regclass(i.schema_name||'.'||i.table_name) and t.tgname='task_cleanup_reference_fence' and t.tgenabled<>'D') fenced from private.task_cleanup_reference_tables() i where i.schema_name='private' and i.table_name in('restitch_selection_roots','restitch_selection_slots','restitch_selection_candidates')"
  );
  expect(rows).toHaveLength(3);
  expect(rows.every(row => row.fenced)).toBe(true);
});

it('exposes the actual SQL reservation through the SELECT-only CLI without claiming video delivery', async () => {
  const f = await fixture();
  await f.store().select(f.version, 4);
  await f.store().reserve(f.version, f.request, 0);
  let chain: Promise<unknown> = Promise.resolve();
  setQueryExecutor((sql, args) => {
    assertReadOnlySql(sql);
    const read = chain.then(async () => {
      await db.db.exec('begin read only;set local role wishly_analytics_ro');
      try {
        const result = await db.db.query(sql, args);
        await db.db.exec('commit');
        return result.rows as Record<string, unknown>[];
      } catch (error) {
        await db.db.exec('rollback');
        throw error;
      }
    });
    chain = read.catch(() => {});
    return read;
  });
  try {
    const asOf = new Date(Date.now() + 60000).toISOString();
    const detail = await getInspect(f.root, asOf);
    expect(detail).toMatchObject({
      found: true,
      capability: 'team.restitch_selection',
      terminal: null,
      last_proven_stage: 'range_reserved',
      restitch_selections: {
        supported: true,
        records: expect.arrayContaining([
          expect.objectContaining({
            operation_id: f.root,
            slot: 'end',
            state: 'range_unconfirmed',
            unconfirmed_range_count: 1,
            confirmed_bytes: 0
          })
        ])
      }
    });
    if (!detail.found) throw Error('Expected reservation evidence');
    expect(detail.stages.missing).toContain('video_processed');
    expect(detail.stages.missing).toContain('result_visible');
    expect(JSON.stringify(detail)).not.toContain(f.image);
    expect(JSON.stringify(detail)).not.toContain('Synthetic screen');
    expect(JSON.stringify(detail)).not.toContain('a'.repeat(32));
    const investigation = await getInvestigation(actor, resolvePeriod('7d', undefined, asOf));
    expect(investigation.findings).toContainEqual(
      expect.objectContaining({
        kind: 'fact',
        evidence: ['restitch_selection:' + f.root + ':end'],
        code_locations: expect.arrayContaining([
          expect.objectContaining({ fingerprint: 'restitch:selection:accounting' })
        ])
      })
    );
    expect(investigateOutputIsPrivate(investigation)).toBe(true);
  } finally {
    await chain;
    setQueryExecutor(null);
  }
});

it('reacquires lost unvalidated bytes through SQL without resetting confirmed cost', async () => {
  const f = await fixture();
  const store = f.store();
  await store.select(f.version, 4);
  await store.reserve(f.version, f.request, 0);
  await store.settle(f.request, { bytes: 2, ioMs: 5, complete: false });
  await store.reacquire(f.version);
  expect(await store.read()).toMatchObject({
    acceptedVersionId: null,
    candidates: [{ acquisition: 1, validatedAcquisition: null }]
  });
  const request = id(sequence++);
  expect((await store.reserve(f.version, request, 0)).kind).toBe('dispatch');
  await store.settle(request, { bytes: 4, ioMs: 9, complete: true });
  await store.accept(f.version, 1);
  const state = await store.read();
  expect(state.acceptedVersionId).toBe(f.version);
  expect(state.candidates[0]?.validatedAcquisition).toBe(1);
  expect(state.transfers.reduce((n, t) => n + (t.settlement?.bytes ?? 0), 0)).toBe(6);
});
