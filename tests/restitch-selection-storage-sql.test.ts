import {
  acceptManualRestitchRoot,
  readManualRestitchRoot
} from '../supabase/functions/drive-ops/restitch-root';
import {
  readRestitchSelectionSource,
  readAuthoritativeRestitchSelectionRange
} from '../supabase/functions/drive-ops/restitch-range-authority';
import { readRestitchSelectionRange } from '../supabase/functions/drive-ops/restitch-range-reader';
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
import {
  createScreenSelectionBudget,
  randomFinalImageDurationSeconds,
  clampStitchEndDuration
} from '@video-compressor/shared';
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
      service_accept_manual_restitch_download: {
        sql: 'select public.service_accept_manual_restitch_download($1,$2,$3,$4,$5) value',
        args: [args.p_team, args.p_actor, args.p_material, args.p_key, args.p_client_operation]
      },
      service_read_manual_restitch_download: {
        sql: 'select public.service_read_manual_restitch_download($1,$2,$3,$4,$5) value',
        args: [args.p_team, args.p_actor, args.p_material, args.p_key, args.p_client_operation]
      },
      service_read_restitch_selection_source: {
        sql: 'select public.service_read_restitch_selection_source($1,$2,$3,$4,$5,$6) value',
        args: [
          args.p_root_operation,
          args.p_team,
          args.p_actor,
          args.p_slot,
          args.p_version,
          args.p_acquisition
        ]
      },
      service_read_active_restitch_selection_slot: {
        sql: 'select public.service_read_active_restitch_selection_slot($1,$2,$3,$4,$5,$6) value',
        args: [
          args.p_root_operation,
          args.p_team,
          args.p_actor,
          args.p_slot,
          args.p_executor,
          args.p_epoch
        ]
      },
      service_cas_restitch_selection_slot_owned: {
        sql: 'select public.service_cas_restitch_selection_slot_owned($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8) value',
        args: [
          args.p_root_operation,
          args.p_team,
          args.p_actor,
          args.p_slot,
          JSON.stringify(args.p_expected_budget),
          JSON.stringify(args.p_next_budget),
          args.p_executor,
          args.p_epoch
        ]
      },
      service_read_restitch_selection_source_owned: {
        sql: 'select public.service_read_restitch_selection_source_owned($1,$2,$3,$4,$5,$6,$7,$8) value',
        args: [
          args.p_root_operation,
          args.p_team,
          args.p_actor,
          args.p_slot,
          args.p_version,
          args.p_acquisition,
          args.p_executor,
          args.p_epoch
        ]
      },
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
    video,
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
  expect((await f.store().reserve(f.version, f.request, 0, 0)).kind).toBe('dispatch');
  expect((await f.store().reserve(f.version, f.request, 0, 0)).kind).toBe('readback');
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
    new RestitchSelectionSlotStore(service, f.scope).reserve(f.version, f.request, 0, 0)
  ).rejects.toMatchObject({ code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' });
  expect((await f.store().reserve(f.version, f.request, 0, 0)).kind).toBe('readback');
  await expect(f.store().reserve(f.version, id(sequence++), 0, 0)).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
});
it('settles a reserved prefix after membership removal and refuses another read', async () => {
  const f = await fixture();
  await f.store().select(f.version, 4);
  await f.store().reserve(f.version, f.request, 0, 0);
  await db.root(
    "update public.team_members set status='removed',removed_at=clock_timestamp() where team_id=$1 and user_id=$2",
    [f.team, actor]
  );
  await f.store().settle(f.request, { bytes: 2, ioMs: 5, complete: false });
  await expect(f.store().reserve(f.version, id(sequence++), 0, 0)).rejects.toMatchObject({
    code: 'PERMISSION_DENIED'
  });
  expect((await f.store().read()).transfers).toHaveLength(1);
});
it('settles issued accounting after parent cancellation without issuing a new permit', async () => {
  const f = await fixture();
  await f.store().select(f.version, 4);
  await f.store().reserve(f.version, f.request, 0, 0);
  await db.root(
    "update public.team_operations set state='canceled',stage='canceled',finished_at=clock_timestamp() where id=$1",
    [f.root]
  );
  await f.store().settle(f.request, { bytes: 2, ioMs: 5, complete: false });
  await expect(f.store().reserve(f.version, id(sequence++), 0, 0)).rejects.toMatchObject({
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
  await f.store().reserve(f.version, f.request, 0, 0);
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
  await f.store().reserve(f.version, f.request, 0, 0);
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
  await store.reserve(f.version, f.request, 0, 0);
  await store.settle(f.request, { bytes: 2, ioMs: 5, complete: false });
  await store.reacquire(f.version, 0);
  expect(await store.read()).toMatchObject({
    acceptedVersionId: null,
    candidates: [{ acquisition: 1, validatedAcquisition: null }]
  });
  const request = id(sequence++);
  expect((await store.reserve(f.version, request, 0, 1)).kind).toBe('dispatch');
  await store.settle(request, { bytes: 4, ioMs: 9, complete: true });
  await store.accept(f.version, 1);
  const state = await store.read();
  expect(state.acceptedVersionId).toBe(f.version);
  expect(state.candidates[0]?.validatedAcquisition).toBe(1);
  expect(state.transfers.reduce((n, t) => n + (t.settlement?.bytes ?? 0), 0)).toBe(6);
});

it('confirms a reordered measurement after actual SQL commit loses its reply and retains retry costs', async () => {
  const f = await fixture();
  let lost = false;
  const service: ServiceRpcClient = {
    rpc: async (name, args) => {
      const reply = await f.service.rpc(name, args);
      if (name === 'service_settle_restitch_selection_range' && reply.data === true && !lost) {
        lost = true;
        throw Error('SYNTHETIC_NETWORK');
      }
      return reply;
    }
  };
  const store = new RestitchSelectionSlotStore(service, f.scope);
  await store.select(f.version, 4);
  await store.reserve(f.version, f.request, 0, 0);
  await expect(
    store.settle(f.request, { complete: false, ioMs: 5, bytes: 2 })
  ).resolves.toBeUndefined();
  expect((await store.reserve(f.version, id(sequence++), 0, 0)).kind).toBe('dispatch');
  const state = await store.read();
  expect(state.transfers).toHaveLength(2);
  expect(state.transfers[0]?.settlement).toEqual({ bytes: 2, ioMs: 5, complete: false });
  expect(state.transfers[1]).toMatchObject({ retry: true, settlement: null });
});

it('does not let an old range request spend a newly reacquired SQL slot', async () => {
  const f = await fixture();
  const store = f.store();
  await store.select(f.version, 4);
  await store.reserve(f.version, f.request, 0, 0);
  await store.settle(f.request, { bytes: 2, ioMs: 5, complete: false });
  await store.reacquire(f.version, 0);
  const before = await store.read();
  const request = id(sequence++);
  await expect(store.reserve(f.version, request, 0, 0)).rejects.toMatchObject({
    code: 'INVALID_INPUT'
  });
  expect(await store.read()).toEqual(before);
  expect((await store.reserve(f.version, request, 0, 1)).kind).toBe('dispatch');
  expect((await store.read()).transfers[1]).toMatchObject({ acquisition: 1, retry: false });
});

it('does not normalize unexpected measurement fields into confirmed SQL accounting', async () => {
  const f = await fixture();
  const store = f.store();
  await store.select(f.version, 4);
  await store.reserve(f.version, f.request, 0, 0);
  const measurement = { bytes: 2, ioMs: 5, complete: false, unexpected: true };
  await expect(store.settle(f.request, measurement)).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  expect((await store.read()).transfers[0]?.settlement).toBeNull();
});

it('releases measured bytes after actual lost-ACK SQL confirmation and never re-fetches on the same request', async () => {
  const f = await fixture();
  let lost = false;
  const service: ServiceRpcClient = {
    rpc: async (name, args) => {
      const reply = await f.service.rpc(name, args);
      if (name === 'service_settle_restitch_selection_range' && reply.data === true && !lost) {
        lost = true;
        throw Error('SYNTHETIC_NETWORK');
      }
      return reply;
    }
  };
  const store = new RestitchSelectionSlotStore(service, f.scope);
  await store.select(f.version, 4);
  let time = 0,
    fetches = 0;
  const fetcher: typeof fetch = async () => {
    time += 10;
    fetches++;
    return new Response('ABCD', {
      status: 206,
      headers: { 'content-length': '4', 'content-range': 'bytes 0-3/4' }
    });
  };
  const input = {
    store,
    versionId: f.version,
    requestId: f.request,
    acquisition: 0,
    offset: 0,
    sourceFileId: f.image,
    sourceBytes: 4,
    mimeType: 'image/png' as const
  };
  const deps: Parameters<typeof readRestitchSelectionRange>[1] = {
    fetch: fetcher,
    now: () => time,
    open: (io, range) =>
      io.fetchPayload(
        'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(f.image) + '?alt=media',
        { headers: { range: 'bytes=' + range.start + '-' + range.end } }
      )
  };
  expect(await (await readRestitchSelectionRange(input, deps)).text()).toBe('ABCD');
  expect((await store.read()).transfers[0]?.settlement).toEqual({
    bytes: 4,
    ioMs: 10,
    complete: true
  });
  expect((await store.read()).acceptedVersionId).toBeNull();
  await expect(readRestitchSelectionRange(input, deps)).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  expect(fetches).toBe(1);
});

it('resolves a selected image only from frozen private provider context', async () => {
  const f = await fixture();
  await f.store().select(f.version, 4);
  const context = await readRestitchSelectionSource(f.service, f.scope, f.version, 0);
  expect(context.source).toMatchObject({
    fileId: f.image,
    sizeBytes: 4,
    mimeType: 'image/png',
    checksum: 'a'.repeat(32)
  });
  expect(context.source.parentFolderId).toBe(context.source.rootFolderId);
  await expect(
    readRestitchSelectionSource(f.service, { ...f.scope, actorId: owner }, f.version, 0)
  ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  await expect(readRestitchSelectionSource(f.service, f.scope, f.version, 1)).rejects.toMatchObject(
    { code: 'RESTITCH_SOURCES_INVALID' }
  );
  await db.root("update public.team_materials set drive_version='2' where id=$1", [f.image]);
  expect((await readRestitchSelectionSource(f.service, f.scope, f.version, 0)).source.fileId).toBe(
    f.image
  );
  await db.root("update public.team_materials set drive_file_id='replacement-image' where id=$1", [
    f.image
  ]);
  await expect(readRestitchSelectionSource(f.service, f.scope, f.version, 0)).rejects.toMatchObject(
    { code: 'SOURCE_CHANGED' }
  );
  // Closing the read/reserve race requires the same binding in the reservation CAS.
  await expect(f.store().reserve(f.version, f.request, 0, 0)).rejects.toMatchObject({
    code: 'SOURCE_CHANGED'
  });
  expect((await f.store().read()).transfers).toHaveLength(0);
});

it('runs frozen SQL authority, real token/Drive adapters and exact bookkeeping as one range path', async () => {
  const f = await fixture();
  await f.store().select(f.version, 4);
  let time = 0,
    mediaCalls = 0;
  const source = await readRestitchSelectionSource(f.service, f.scope, f.version, 0);
  const fetcher: typeof fetch = async input => {
    expect((await f.store().read()).transfers).toHaveLength(1);
    const url = new URL(String(input));
    time += 5;
    if (url.hostname === 'oauth2.googleapis.com')
      return new Response(
        JSON.stringify({ access_token: 'SYNTHETIC_ACCESS_TOKEN_047', expires_in: 3600 })
      );
    if (url.searchParams.get('alt') === 'media') {
      mediaCalls++;
      expect(decodeURIComponent(url.pathname.split('/').at(-1)!)).toBe(f.image);
      return new Response('ABCD', {
        status: 206,
        headers: { 'content-length': '4', 'content-range': 'bytes 0-3/4' }
      });
    }
    return new Response(
      JSON.stringify({
        id: f.image,
        name: 'Synthetic.png',
        size: '4',
        mimeType: 'image/png',
        md5Checksum: 'a'.repeat(32),
        version: '999',
        parents: [source.source.parentFolderId],
        trashed: false,
        capabilities: { canDownload: true }
      })
    );
  };
  const response = await readAuthoritativeRestitchSelectionRange(
    {
      service: f.service,
      scope: f.scope,
      versionId: f.version,
      acquisition: 0,
      requestId: f.request,
      offset: 0
    },
    {
      fetch: fetcher,
      now: () => time,
      readCredentials: async credentialId => {
        expect(credentialId).toBe(source.credentialId);
        expect((await f.store().read()).transfers).toHaveLength(0);
        time += 1000; // DB/credential latency is outside the active provider I/O meter.
        return {
          credential: {
            credentialId,
            connectedBy: owner,
            googlePermissionId: 'synthetic-permission',
            googleAccountEmail: 'fixture@selection.invalid',
            scope: 'https://www.googleapis.com/auth/drive.file',
            refreshToken: 'SYNTHETIC_REFRESH_TOKEN'
          },
          clientId: 'synthetic-client',
          clientSecret: 'synthetic-secret',
          oauthMode: 'testing',
          productionSignals: {
            siteUrl: 'http://127.0.0.1:5175',
            requestOrigin: 'http://127.0.0.1:5175'
          }
        };
      }
    }
  );
  expect((await f.store().read()).transfers[0]?.settlement).toEqual({
    bytes: 4,
    ioMs: 15,
    complete: true
  });
  expect(await response.text()).toBe('ABCD');
  expect(mediaCalls).toBe(1);
  expect((await f.store().read()).acceptedVersionId).toBeNull();
});

it('does not disclose frozen provider context to an authenticated browser role', async () => {
  const f = await fixture();
  await f.store().select(f.version, 4);
  await db.db.exec('begin;set local role authenticated');
  try {
    await expect(
      db.db.query('select public.service_read_restitch_selection_source($1,$2,$3,$4,$5,$6)', [
        f.root,
        f.team,
        actor,
        'end',
        f.version,
        0
      ])
    ).rejects.toThrow(/permission denied/i);
  } finally {
    await db.db.exec('rollback');
  }
  await db.root(
    "update public.team_operations set state='canceled',stage='canceled',finished_at=clock_timestamp() where id=$1",
    [f.root]
  );
  await expect(readRestitchSelectionSource(f.service, f.scope, f.version, 0)).rejects.toMatchObject(
    { code: 'WRONG_STATE' }
  );
});

it('retains one opaque candidate version across rename, metadata changes and ordinary clicks', async () => {
  const f = await fixture();
  const register = async () =>
    (
      await db.root<{ id: string }>(
        'select private.register_restitch_candidate_version($1,$2) id',
        [f.team, f.image]
      )
    )[0]!.id;
  const first = await register();
  expect(await register()).toBe(first);
  await db.root(
    "update public.team_materials set name='Renamed.png',drive_version='2',resource_key='synthetic-rotated-key' where id=$1",
    [f.image]
  );
  expect(await register()).toBe(first);
  await db.root('update public.team_materials set checksum=$2 where id=$1', [
    f.image,
    'b'.repeat(32)
  ]);
  expect(await register()).not.toBe(first);
  await db.root('update public.team_materials set checksum=$2 where id=$1', [
    f.image,
    'a'.repeat(32)
  ]);
  expect(await register()).toBe(first);
  await expect(
    db.root('update private.restitch_candidate_versions set checksum=$2 where id=$1', [
      first,
      'c'.repeat(32)
    ])
  ).rejects.toThrow('WRONG_STATE');
});

it('does not hide an independent provider copy behind a rejected identical checksum', async () => {
  const f = await fixture();
  const copy = id(sequence++);
  await db.root(
    `insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum,drive_version)
    select $2,team_id,connection_id,'copy-'||drive_file_id,parent_folder_id,'Independent.png',kind,category,mime_type,size_bytes,checksum,drive_version from public.team_materials where id=$1`,
    [f.image, copy]
  );
  const versions = await db.root<{ id: string }>(
    'select private.register_restitch_candidate_version($1,$2) id union all select private.register_restitch_candidate_version($1,$3)',
    [f.team, f.image, copy]
  );
  expect(versions).toHaveLength(2);
  expect(versions[0]!.id).not.toBe(versions[1]!.id);
});

it('keeps opaque-version storage and its factory unavailable to browser and service callers', async () => {
  const privileges = await db.root<{
    role: string;
    table_access: boolean;
    factory_access: boolean;
  }>(`select role,
    has_table_privilege(role,'private.restitch_candidate_versions','select,insert,update,delete') table_access,
    has_function_privilege(role,'private.register_restitch_candidate_version(uuid,uuid)','execute') factory_access
    from unnest(array['anon','authenticated','service_role']) role`);
  expect(privileges.every(row => !row.table_access && !row.factory_access)).toBe(true);
  const f = await fixture();
  await db.root(
    "update public.team_drive_connections set state='unavailable' where id=(select connection_id from public.team_materials where id=$1)",
    [f.image]
  );
  await expect(
    db.root('select private.register_restitch_candidate_version($1,$2)', [f.team, f.image])
  ).rejects.toThrow('PERMISSION_DENIED');
});

it('changes the opaque version when the same provider file is rebound after reconnecting', async () => {
  const f = await fixture();
  const first = (
    await db.root<{ id: string }>('select private.register_restitch_candidate_version($1,$2) id', [
      f.team,
      f.image
    ])
  )[0]!.id;
  await db.root(
    "update public.team_drive_connections set state='detached',detached_at=clock_timestamp() where id=(select connection_id from public.team_materials where id=$1)",
    [f.image]
  );
  const connection = (
    await db.root<{ id: string }>(
      `insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state)
    select team_id,credential_id,root_folder_id||'-independent','Independent root',drive_kind,'connected' from public.team_drive_connections where id=(select connection_id from public.team_materials where id=$1) returning id`,
      [f.image]
    )
  )[0]!.id;
  await db.root('update public.team_materials set connection_id=$2 where id=$1', [
    f.image,
    connection
  ]);
  const next = (
    await db.root<{ id: string }>('select private.register_restitch_candidate_version($1,$2) id', [
      f.team,
      f.image
    ])
  )[0]!.id;
  expect(next).not.toBe(first);
});

it('retains independently accessible identical-byte files in the admitted pool', async () => {
  const f = await fixture(),
    copy = id(sequence++);
  await db.root(
    `insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum,drive_version)
    select $2,team_id,connection_id,'copy-'||drive_file_id,parent_folder_id,'Copy.png',kind,category,mime_type,size_bytes,checksum,drive_version from public.team_materials where id=$1`,
    [f.image, copy]
  );
  await db.root(
    "insert into public.team_restitch_sources(team_id,slot,material_id,kind,sort_order,added_by) values($1,'end',$2,'file',1,$4),($1,'end',$3,'file',2,$4)",
    [f.team, f.image, copy, owner]
  );
  const pool = (
    await db.root<{
      value: {
        complete: boolean;
        eligibleObserved: number;
        candidates: Array<{ materialId: string }>;
      };
    }>("select private.restitch_selection_pool_snapshot($1,null,'end') value", [f.team])
  )[0]!.value;
  expect(pool.complete).toBe(true);
  expect(pool.eligibleObserved).toBe(2);
  expect(new Set(pool.candidates.map(row => row.materialId))).toEqual(new Set([f.image, copy]));
});

it('preserves missing metadata and unresolved source folders as unknown rather than all-broken evidence', async () => {
  const f = await fixture();
  await db.root(
    "insert into public.team_restitch_sources(team_id,slot,material_id,kind,sort_order,added_by) values($1,'end',$2,'file',1,$3)",
    [f.team, f.image, owner]
  );
  await db.root('update public.team_materials set checksum=null where id=$1', [f.image]);
  type Pool = {
    complete: boolean;
    unknownObserved: number;
    unknownSourceCount: number;
    eligibleObserved: number;
  };
  const read = async () =>
    (
      await db.root<{ value: Pool }>(
        "select private.restitch_selection_pool_snapshot($1,null,'end') value",
        [f.team]
      )
    )[0]!.value;
  expect(await read()).toMatchObject({
    complete: false,
    unknownObserved: 1,
    unknownSourceCount: 0,
    eligibleObserved: 0
  });
  await db.root('update public.team_materials set checksum=$2 where id=$1', [
    f.image,
    'a'.repeat(32)
  ]);
  await db.root(
    "insert into public.team_restitch_sources(team_id,slot,drive_file_id,kind,sort_order,added_by) values($1,'end','synthetic-unresolved-folder','folder',2,$2)",
    [f.team, owner]
  );
  expect(await read()).toMatchObject({
    complete: false,
    unknownObserved: 0,
    unknownSourceCount: 1,
    eligibleObserved: 1
  });
});

it('observes the 501st eligible image so a bounded pool cannot claim complete exhaustion', async () => {
  const f = await fixture(),
    folder = id(sequence++);
  await db.root(
    `insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,mime_type,drive_version)
    select $2,team_id,connection_id,'synthetic-large-pool',parent_folder_id,'Large pool','folder','application/vnd.google-apps.folder','1' from public.team_materials where id=$1`,
    [f.image, folder]
  );
  await db.root(
    `insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum,drive_version)
    select m.team_id,m.connection_id,'synthetic-pool-'||nums.n::text,'synthetic-large-pool','Synthetic-'||nums.n::text||'.png','file','image','image/png',4,$2,'1'
    from public.team_materials m cross join generate_series(1,501) nums(n) where m.id=$1`,
    [f.image, 'a'.repeat(32)]
  );
  await db.root(
    "insert into public.team_restitch_sources(team_id,slot,material_id,kind,sort_order,added_by) values($1,'end',$2,'folder',1,$3)",
    [f.team, folder, owner]
  );
  const pool = (
    await db.root<{
      value: {
        complete: boolean;
        truncated: boolean;
        eligibleObserved: number;
        candidates: unknown[];
      };
    }>("select private.restitch_selection_pool_snapshot($1,null,'end') value", [f.team])
  )[0]!.value;
  expect(pool).toMatchObject({ complete: false, truncated: true, eligibleObserved: 501 });
  expect(pool.candidates).toHaveLength(501);
});

it('keeps the owner namespace, member namespace and slots independent', async () => {
  const f = await fixture();
  await db.root(
    "insert into public.team_restitch_sources(team_id,user_id,slot,material_id,kind,sort_order,added_by) values($1,null,'start',$2,'file',1,$3),($1,$4,'end',$2,'file',1,$4)",
    [f.team, f.image, owner, actor]
  );
  const results = await db.root<{ owner_start: number; owner_end: number; member_end: number }>(
    `select
    (private.restitch_selection_pool_snapshot($1,null,'start')->>'eligibleObserved')::integer owner_start,
    (private.restitch_selection_pool_snapshot($1,null,'end')->>'eligibleObserved')::integer owner_end,
    (private.restitch_selection_pool_snapshot($1,$2,'end')->>'eligibleObserved')::integer member_end`,
    [f.team, actor]
  );
  expect(results[0]).toEqual({ owner_start: 1, owner_end: 0, member_end: 1 });
});

type AcceptedManualRoot = {
  operationId: string;
  operationState: string;
  teamId: string;
  actorId: string;
  sourceMaterialId: string;
  sourceVersion: string;
  poolNamespaceId: string;
  reused: boolean;
  recipe: {
    selectionProtocol: number;
    seed: string;
    clientOperationId: string;
    defaults: { finalDurationMode: string; customFinalDurationSeconds: number };
    sourceIdentity: { checksum: string };
  };
};
async function manualFixture() {
  const f = await fixture();
  await db.asUser(owner, 'select public.set_restitch_defaults($1,$2::jsonb)', [
    f.team,
    JSON.stringify({
      operation: 'restitch',
      sourceMode: 'drive',
      fitMode: 'cover',
      startEnabled: false,
      endEnabled: true,
      finalDurationMode: 'random-40-50',
      customFinalDurationSeconds: 2700
    })
  ]);
  await db.root(
    "insert into public.team_restitch_sources(team_id,slot,material_id,kind,sort_order,added_by) values($1,'end',$2,'file',1,$3)",
    [f.team, f.image, owner]
  );
  const clientOperation = id(sequence++),
    key = 'manual:' + clientOperation;
  const args = {
    p_team: f.team,
    p_actor: actor,
    p_material: f.video,
    p_key: key,
    p_client_operation: clientOperation
  };
  const call = async (name = 'service_accept_manual_restitch_download', body = args) => {
    const reply = await f.service.rpc(name, body);
    if (reply.error) throw Error(reply.error.message);
    return reply.data as AcceptedManualRoot | null;
  };
  return { ...f, args, call };
}
it('accepts one immutable manual-download root and reads its original recipe after settings change or lost acknowledgement', async () => {
  const f = await manualFixture();
  const accepted = (await f.call())!;
  expect(accepted).toMatchObject({
    teamId: f.team,
    actorId: actor,
    sourceMaterialId: f.video,
    operationState: 'running',
    reused: false,
    recipe: {
      selectionProtocol: 1,
      clientOperationId: f.args.p_client_operation,
      defaults: { finalDurationMode: 'custom' }
    }
  });
  expect(accepted.recipe.defaults.customFinalDurationSeconds).toBeGreaterThanOrEqual(2400);
  expect(accepted.recipe.defaults.customFinalDurationSeconds).toBeLessThanOrEqual(3000);
  await db.asUser(owner, 'select public.set_restitch_defaults($1,$2::jsonb)', [
    f.team,
    JSON.stringify({
      operation: 'restitch',
      sourceMode: 'drive',
      fitMode: 'contain',
      startEnabled: false,
      endEnabled: true,
      finalDurationMode: 'custom',
      customFinalDurationSeconds: 60
    })
  ]);
  expect(await f.call()).toEqual({ ...accepted, reused: true });
  expect(await f.call('service_read_manual_restitch_download')).toEqual({
    ...accepted,
    reused: true
  });
  const count = (
    await db.root<{ n: number }>(
      'select count(*)::integer n from public.team_operations where idempotency_key=$1',
      [f.args.p_key]
    )
  )[0]!.n;
  expect(count).toBe(1);
  const candidates = await db.root<{ version_id: string }>(
    'select version_id from private.restitch_selection_candidates where root_operation_id=$1',
    [accepted.operationId]
  );
  expect(candidates).toHaveLength(1);
  const store = new RestitchSelectionSlotStore(f.service, {
    ...f.scope,
    rootOperationId: accepted.operationId,
    executor: await claimExecutor(accepted.operationId, f.team)
  });
  expect((await store.read()).candidates).toHaveLength(0); // no draw or I/O at admission
  await store.select(candidates[0]!.version_id, 4);
  expect((await store.read()).candidates).toHaveLength(1);
});
it('reuses the actor and pool namespace across ordinary clicks without sharing it with another actor', async () => {
  const f = await manualFixture(),
    first = (await f.call())!;
  const nextClient = id(sequence++);
  const second = (await f.call('service_accept_manual_restitch_download', {
    ...f.args,
    p_key: 'manual:' + nextClient,
    p_client_operation: nextClient
  }))!;
  expect(second.operationId).not.toBe(first.operationId);
  expect(second.recipe.seed).not.toBe(first.recipe.seed);
  expect(second.poolNamespaceId).toBe(first.poolNamespaceId);
  const rows = await db.root<{ version_id: string }>(
    'select version_id from private.restitch_selection_candidates where root_operation_id=any($1::uuid[])',
    [[first.operationId, second.operationId]]
  );
  expect(rows).toHaveLength(2);
  expect(rows[0]!.version_id).toBe(rows[1]!.version_id);
  const otherClient = id(sequence++);
  const other = (await f.call('service_accept_manual_restitch_download', {
    ...f.args,
    p_actor: owner,
    p_key: 'manual:' + otherClient,
    p_client_operation: otherClient
  }))!;
  expect(other.poolNamespaceId).not.toBe(first.poolNamespaceId);
});
it('admits a download-only member without process or upload permissions', async () => {
  const f = await manualFixture();
  await db.root(
    'update public.team_members set permission_overrides=$3::jsonb where team_id=$1 and user_id=$2',
    [f.team, actor, JSON.stringify({ download: true, process: false, upload: false })]
  );
  expect(
    (
      await db.root<{ download: boolean; process: boolean; upload: boolean }>(
        "select private.can($1,'download',$2) download,private.can($1,'process',$2) process,private.can($1,'upload',$2) upload",
        [f.team, actor]
      )
    )[0]
  ).toEqual({ download: true, process: false, upload: false });
  const accepted = (await f.call())!;
  expect(
    (
      await db.root<{ kind: string }>('select kind from public.team_operations where id=$1', [
        accepted.operationId
      ])
    )[0]?.kind
  ).toBe('download');
  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::integer n from private.team_transfer_grants where operation_id=$1',
        [accepted.operationId]
      )
    )[0]?.n
  ).toBe(0);
});
it('permits metadata-only source changes but fences changed video bytes before another image range', async () => {
  const f = await manualFixture(),
    accepted = (await f.call())!;
  const version = (
    await db.root<{ version_id: string }>(
      'select version_id from private.restitch_selection_candidates where root_operation_id=$1',
      [accepted.operationId]
    )
  )[0]!.version_id;
  const store = new RestitchSelectionSlotStore(f.service, {
    ...f.scope,
    rootOperationId: accepted.operationId,
    executor: await claimExecutor(accepted.operationId, f.team)
  });
  await store.select(version, 4);
  await db.root("update public.team_materials set drive_version='2' where id=$1", [f.video]);
  const request = id(sequence++);
  expect((await store.reserve(version, request, 0, 0)).kind).toBe('dispatch');
  await store.settle(request, { bytes: 0, ioMs: 0, complete: false });
  await db.root('update public.team_materials set checksum=$2 where id=$1', [
    f.video,
    'b'.repeat(32)
  ]);
  await expect(store.reserve(version, id(sequence++), 0, 0)).rejects.toMatchObject({
    code: 'RESTITCH_SOURCES_INVALID'
  });
  expect((await store.read()).transfers).toHaveLength(1);
});
it.each(['random-30-40', 'random-40-50', 'random-50-60', 'random-centered', 'custom'] as const)(
  'freezes %s durations with the actual shared renderer policy',
  async mode => {
    for (const center of [1, 2700, 359999])
      for (const draw of [0, 0.5, 1]) {
        const settings = { finalDurationMode: mode, customFinalDurationSeconds: center };
        const value = (
          await db.root<{
            value: { finalDurationMode: string; customFinalDurationSeconds: number };
          }>('select private.freeze_restitch_selection_defaults($1::jsonb,$2) value', [
            JSON.stringify(settings),
            draw
          ])
        )[0]!.value;
        const expected =
          mode === 'custom'
            ? clampStitchEndDuration(center)
            : randomFinalImageDurationSeconds(mode, () => draw, clampStitchEndDuration(center));
        expect(value).toEqual({
          finalDurationMode: 'custom',
          customFinalDurationSeconds: expected
        });
      }
  }
);

it('recovers an actual committed admission from a lost RPC acknowledgement without accepting it twice', async () => {
  const f = await manualFixture();
  const calls: string[] = [];
  const service: ServiceRpcClient = {
    rpc: async (name, args) => {
      calls.push(name);
      const reply = await f.service.rpc(name, args);
      if (name === 'service_accept_manual_restitch_download' && !reply.error)
        throw Error('SYNTHETIC_LOST_ACK');
      return reply;
    }
  };
  const request = {
    teamId: f.team,
    actorId: actor,
    sourceMaterialId: f.video,
    idempotencyKey: f.args.p_key,
    clientOperationId: f.args.p_client_operation
  };
  const root = await acceptManualRestitchRoot(service, request);
  expect(root.reused).toBe(true);
  expect(calls).toEqual([
    'service_accept_manual_restitch_download',
    'service_read_manual_restitch_download'
  ]);
  expect(await readManualRestitchRoot(f.service, request)).toEqual(root);
  const store = new RestitchSelectionSlotStore(f.service, {
    ...f.scope,
    rootOperationId: root.operationId
  });
  expect((await store.read()).transfers).toHaveLength(0);
  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::integer n from public.team_operations where idempotency_key=$1',
        [f.args.p_key]
      )
    )[0]?.n
  ).toBe(1);
});

it('reports a disabled slot without disguising it as a missing screen or completed video', async () => {
  const f = await manualFixture(),
    root = (await f.call())!;
  const records = await db.root<{ slot: string; state: string; confirmed_bytes: number }>(
    'select slot,state,confirmed_bytes::integer from public.analytics_restitch_selection_slots where operation_id=$1 order by slot',
    [root.operationId]
  );
  expect(records).toEqual([
    { slot: 'end', state: 'awaiting_selection', confirmed_bytes: 0 },
    { slot: 'start', state: 'disabled', confirmed_bytes: 0 }
  ]);
});

it('does not rebind a root key to another client operation or material', async () => {
  const f = await manualFixture();
  const request = {
    teamId: f.team,
    actorId: actor,
    sourceMaterialId: f.video,
    idempotencyKey: f.args.p_key,
    clientOperationId: f.args.p_client_operation
  };
  const root = await acceptManualRestitchRoot(f.service, request);
  await expect(
    acceptManualRestitchRoot(f.service, { ...request, clientOperationId: id(sequence++) })
  ).rejects.toMatchObject({ code: 'REQUEST_REUSE_CONFLICT' });
  await expect(
    readManualRestitchRoot(f.service, { ...request, sourceMaterialId: f.image })
  ).rejects.toMatchObject({ code: 'REQUEST_REUSE_CONFLICT' });
  expect((await readManualRestitchRoot(f.service, request))?.operationId).toBe(root.operationId);
});

it('keeps an active root and a canceled held range until exact late accounting is confirmed', async () => {
  const f = await fixture();
  await expect(
    db.root('delete from private.restitch_selection_roots where root_operation_id=$1', [f.root])
  ).rejects.toThrow('WRONG_STATE');
  await f.store().select(f.version, 4);
  await f.store().reserve(f.version, f.request, 0, 0);
  await db.root(
    "update public.team_operations set state='canceled',stage='canceled',finished_at=clock_timestamp() where id=$1",
    [f.root]
  );
  const before = await f.store().read();
  await expect(
    db.root('delete from private.restitch_selection_roots where root_operation_id=$1', [f.root])
  ).rejects.toThrow('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN');
  expect(await f.store().read()).toEqual(before);
  await f.store().settle(f.request, { bytes: 0, ioMs: 0, complete: false });
  await db.root('delete from private.restitch_selection_roots where root_operation_id=$1', [
    f.root
  ]);
  await expect(f.store().read()).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
});
it('does not infer native quiescence from a terminal protocol1 parent', async () => {
  const f = await manualFixture(),
    root = (await f.call())!;
  await db.root(
    "update public.team_operations set state='succeeded',stage='succeeded',finished_at=clock_timestamp() where id=$1",
    [root.operationId]
  );
  await expect(
    db.root('delete from private.restitch_selection_roots where root_operation_id=$1', [
      root.operationId
    ])
  ).rejects.toThrow('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN');
  expect((await f.call('service_read_manual_restitch_download'))?.operationId).toBe(
    root.operationId
  );
});
it('does not let account cascades erase an issued image range', async () => {
  const f = await manualFixture(),
    person = id(sequence++),
    client = id(sequence++);
  await createUser(db, { id: person, email: person + '@selection.invalid' });
  await db.root('insert into public.admin_users(user_id) values($1)', [person]);
  await db.root(
    "insert into public.team_members(team_id,user_id,base_role) values($1,$2,'admin')",
    [f.team, person]
  );
  const root = (await f.call('service_accept_manual_restitch_download', {
    ...f.args,
    p_actor: person,
    p_key: 'manual:' + client,
    p_client_operation: client
  }))!;
  const version = (
    await db.root<{ version_id: string }>(
      'select version_id from private.restitch_selection_candidates where root_operation_id=$1',
      [root.operationId]
    )
  )[0]!.version_id;
  const store = new RestitchSelectionSlotStore(f.service, {
    rootOperationId: root.operationId,
    teamId: f.team,
    actorId: person,
    slot: 'end',
    executor: await claimExecutor(root.operationId, f.team, person)
  });
  await store.select(version, 4);
  await store.reserve(version, id(sequence++), 0, 0);
  const before = await store.read();
  await expect(db.root('delete from auth.users where id=$1', [person])).rejects.toThrow();
  expect(await store.read()).toEqual(before);
  expect((await store.read()).transfers[0]?.settlement).toBeNull();
});

it('keeps a bounded folder traversal explicitly incomplete even before any image is reached', async () => {
  const f = await fixture(),
    folder = id(sequence++);
  await db.root(
    `insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,mime_type,drive_version)
    select $2,team_id,connection_id,'synthetic-wide-root',parent_folder_id,'Wide folder','folder','application/vnd.google-apps.folder','1' from public.team_materials where id=$1`,
    [f.image, folder]
  );
  await db.root(
    `insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,mime_type,drive_version)
    select m.team_id,m.connection_id,'wide-child-'||nums.n::text,'synthetic-wide-root','Nested folder','folder','application/vnd.google-apps.folder','1'
    from public.team_materials m cross join generate_series(1,5001) nums(n) where m.id=$1`,
    [f.image]
  );
  await db.root(
    "insert into public.team_restitch_sources(team_id,slot,material_id,kind,sort_order,added_by) values($1,'end',$2,'folder',1,$3)",
    [f.team, folder, owner]
  );
  const pool = (
    await db.root<{
      value: {
        complete: boolean;
        truncated: boolean;
        eligibleObserved: number;
        candidates: unknown[];
      };
    }>("select private.restitch_selection_pool_snapshot($1,null,'end') value", [f.team])
  )[0]!.value;
  expect(pool).toMatchObject({ complete: false, truncated: true, eligibleObserved: 0 });
  expect(pool.candidates).toHaveLength(0);
}, 15000);

it('does not initialize fresh accounting for an existing operation whose root is missing', async () => {
  const f = await manualFixture();
  const root = id(sequence++);
  await db.root(
    "insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce,bytes_total) values($1,$2,$3,'download','pending',$4,$5,$6,4)",
    [
      root,
      f.team,
      actor,
      f.video,
      f.args.p_key,
      'restitch-download-v1:' + f.args.p_client_operation
    ]
  );
  await expect(f.call()).rejects.toThrow('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN');
  expect(await f.call('service_read_manual_restitch_download')).toBeNull();
  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::integer n from private.restitch_selection_roots where root_operation_id=$1',
        [root]
      )
    )[0]?.n
  ).toBe(0);
});

async function claimExecutor(
  root: string,
  team: string,
  person = actor,
  claim = id(sequence++),
  native = id(sequence++)
) {
  const row = (
    await db.root<{ value: { executorId: string; epoch: number; active: boolean } }>(
      'select public.service_claim_restitch_executor($1,$2,$3,$4,$5,1) value',
      [root, team, person, claim, native]
    )
  )[0]!.value;
  expect(row.active).toBe(true);
  return { id: row.executorId, epoch: row.epoch };
}

async function ownedFixture() {
  const f = await manualFixture(),
    root = (await f.call())!;
  const version = (
    await db.root<{ version_id: string }>(
      'select version_id from private.restitch_selection_candidates where root_operation_id=$1',
      [root.operationId]
    )
  )[0]!.version_id;
  const claim = id(sequence++),
    native = id(sequence++);
  const executor = await claimExecutor(root.operationId, f.team, actor, claim, native);
  const scope = { ...f.scope, rootOperationId: root.operationId, executor };
  return {
    ...f,
    accepted: root,
    version,
    claim,
    native,
    executor,
    ownedScope: scope,
    ownedStore: new RestitchSelectionSlotStore(f.service, scope)
  };
}
async function quiesceExecutor(
  f: Awaited<ReturnType<typeof ownedFixture>>,
  receipt = id(sequence++)
) {
  return (
    await db.root<{ value: boolean }>(
      'select public.service_quiesce_restitch_executor($1,$2,$3,$4,$5,$6) value',
      [f.accepted.operationId, f.team, actor, f.executor.id, f.executor.epoch, receipt]
    )
  )[0]!.value;
}
it('rejects unowned protocol writes and context reads without changing the ledger', async () => {
  const f = await ownedFixture();
  const stale = new RestitchSelectionSlotStore(f.service, {
    ...f.scope,
    rootOperationId: f.accepted.operationId
  });
  await expect(stale.select(f.version, 4)).rejects.toMatchObject({
    code: 'RESTITCH_CLIENT_OUTDATED'
  });
  expect((await stale.read()).candidates).toHaveLength(0);
  await f.ownedStore.select(f.version, 4);
  await expect(
    readRestitchSelectionSource(
      f.service,
      { ...f.scope, rootOperationId: f.accepted.operationId },
      f.version,
      0
    )
  ).rejects.toMatchObject({ code: 'RESTITCH_CLIENT_OUTDATED' });
  expect((await f.ownedStore.read()).transfers).toHaveLength(0);
});
it('never reactivates an old claim or lets an old quiescence receipt close a newer epoch', async () => {
  const f = await ownedFixture(),
    receipt = id(sequence++);
  await f.ownedStore.select(f.version, 4);
  expect(await quiesceExecutor(f, receipt)).toBe(true);
  const next = await claimExecutor(f.accepted.operationId, f.team);
  expect(next.epoch).toBe(f.executor.epoch + 1);
  const old = (
    await db.root<{ value: { active: boolean; epoch: number } }>(
      'select public.service_claim_restitch_executor($1,$2,$3,$4,$5,1) value',
      [f.accepted.operationId, f.team, actor, f.claim, f.native]
    )
  )[0]!.value;
  expect(old).toMatchObject({ active: false, epoch: f.executor.epoch });
  expect(await quiesceExecutor(f, receipt)).toBe(true);
  // Even idempotent select must recheck ownership instead of returning cached permission.
  await expect(f.ownedStore.select(f.version, 4)).rejects.toMatchObject({ code: 'WRONG_STATE' });
  await expect(f.ownedStore.reserve(f.version, id(sequence++), 0, 0)).rejects.toMatchObject({
    code: 'WRONG_STATE'
  });
  const current = new RestitchSelectionSlotStore(f.service, { ...f.ownedScope, executor: next });
  expect((await current.reserve(f.version, id(sequence++), 0, 0)).kind).toBe('dispatch');
});
it('holds an issued range across cancellation and permits only exact late settlement before quiescence', async () => {
  const f = await ownedFixture(),
    request = id(sequence++);
  await f.ownedStore.select(f.version, 4);
  await f.ownedStore.reserve(f.version, request, 0, 0);
  await db.root(
    "update public.team_operations set state='canceled',stage='canceled',finished_at=clock_timestamp() where id=$1",
    [f.accepted.operationId]
  );
  await expect(quiesceExecutor(f)).rejects.toThrow('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN');
  await expect(f.ownedStore.reserve(f.version, id(sequence++), 0, 0)).rejects.toMatchObject({
    code: 'WRONG_STATE'
  });
  await f.ownedStore.settle(request, { bytes: 2, ioMs: 3, complete: false });
  expect(await quiesceExecutor(f)).toBe(true);
  expect((await f.ownedStore.read()).transfers[0]?.settlement).toEqual({
    bytes: 2,
    ioMs: 3,
    complete: false
  });
});
it('does not treat missing executor accounting as an unclaimed root', async () => {
  const f = await ownedFixture();
  await db.root(
    'delete from private.restitch_selection_executor_claims where root_operation_id=$1',
    [f.accepted.operationId]
  );
  await db.root('delete from private.restitch_selection_executors where root_operation_id=$1', [
    f.accepted.operationId
  ]);
  await expect(claimExecutor(f.accepted.operationId, f.team)).rejects.toThrow(
    'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  );
  await expect(f.ownedStore.select(f.version, 4)).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
});
it('fences a deferred credential lookup against a changed owner before any provider I/O', async () => {
  const f = await ownedFixture();
  await f.ownedStore.select(f.version, 4);
  const scope = { ...f.ownedScope, executor: { ...f.executor } };
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(r => {
      entered = r;
    }),
    gate = new Promise<void>(r => {
      release = r;
    });
  let fetches = 0;
  const pending = readAuthoritativeRestitchSelectionRange(
    {
      service: f.service,
      scope,
      versionId: f.version,
      acquisition: 0,
      requestId: id(sequence++),
      offset: 0
    },
    {
      fetch: async () => {
        fetches++;
        throw Error('UNEXPECTED_PROVIDER_IO');
      },
      readCredentials: async () => {
        entered();
        await gate;
        return {
          credential: {
            credentialId: id(1),
            connectedBy: actor,
            googlePermissionId: 'synthetic',
            googleAccountEmail: 'fixture@selection.invalid',
            scope: 'https://www.googleapis.com/auth/drive.file',
            refreshToken: 'synthetic'
          },
          clientId: 'synthetic',
          clientSecret: 'synthetic',
          oauthMode: 'testing',
          productionSignals: {
            siteUrl: 'http://127.0.0.1:5175',
            requestOrigin: 'http://127.0.0.1:5175'
          }
        };
      }
    }
  );
  await waiting;
  await quiesceExecutor(f);
  const next = await claimExecutor(f.accepted.operationId, f.team);
  scope.executor.id = next.id;
  scope.executor.epoch = next.epoch;
  release();
  await expect(pending).rejects.toMatchObject({ code: 'WRONG_STATE' });
  expect(fetches).toBe(0);
  expect((await f.ownedStore.read()).transfers).toHaveLength(0);
});
it('keeps executor control functions and internal cores inaccessible to browser roles', async () => {
  const rows = await db.root<{
    browser: boolean;
    service: boolean;
  }>(`select has_function_privilege('authenticated',p.oid,'execute') browser,has_function_privilege('service_role',p.oid,'execute') service
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in('service_claim_restitch_executor','service_quiesce_restitch_executor','service_cas_restitch_selection_slot_owned','service_read_active_restitch_selection_slot','service_read_restitch_selection_source_owned','service_read_restitch_executor_claim')`);
  expect(rows).toHaveLength(6);
  expect(rows.every(r => !r.browser && r.service)).toBe(true);
  const cores = await db.root<{ allowed: boolean }>(
    `select has_function_privilege('service_role',p.oid,'execute') allowed from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname in('require_restitch_executor','cas_restitch_selection_slot_core','read_restitch_selection_source_core','initialize_restitch_executor')`
  );
  expect(cores).toHaveLength(4);
  expect(cores.every(r => !r.allowed)).toBe(true);
});
