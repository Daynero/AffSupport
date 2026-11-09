import { createNativeScreenRecoveryProvider } from '../apps/agent/src/team-bridge/native-screen-recovery-provider';
import { resolveScreensWithRecovery } from '../apps/agent/src/team-bridge/screen-recovery';
import {
  ScreenCacheError,
  type ProtectedScreenCacheBinding
} from '../apps/agent/src/team-bridge/screen-cache';
import { createHash } from 'node:crypto';
import { handleRestitchNativeSelection } from '../supabase/functions/drive-ops/restitch-native-selection';
import { quiesceRestitchExecutor } from '../supabase/functions/drive-ops/restitch-executor';
import {
  acceptManualRestitchRoot,
  readManualRestitchRoot
} from '../supabase/functions/drive-ops/restitch-root';
import {
  readRestitchSelectionSource,
  readAuthoritativeRestitchSelectionRange
} from '../supabase/functions/drive-ops/restitch-range-authority';
import { readRestitchSelectionRange } from '../supabase/functions/drive-ops/restitch-range-reader';
import { issueRestitchScreenRange } from '../supabase/functions/drive-ops/restitch-range-issue';
import { consumeRestitchScreenRange } from '../supabase/functions/drive-ops/restitch-range-dispatch';
import { getRestitchSelectionEvidence } from '../scripts/analytics/restitch-selections';
import { getInspect } from '../scripts/analytics/queries';
import { getInvestigation } from '../scripts/analytics/investigate';
import { resolvePeriod } from '../scripts/analytics/periods';
import { investigateOutputIsPrivate, investigatePrivacyFailure } from '../scripts/analytics/types';
import { assertReadOnlySql, setQueryExecutor } from '../scripts/analytics/db';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  RestitchSelectionSlotStore,
  type RestitchSelectionSlotScope
} from '../supabase/functions/drive-ops/restitch-selection-store';
import type { ServiceRpcClient } from '../supabase/functions/_shared/credentials';
import {
  createScreenSelectionBudget,
  selectScreenCandidate,
  reserveScreenTransfer,
  refreshScreenCandidateGrant,
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
      service_read_restitch_screen_range_issue: {
        sql: 'select public.service_read_restitch_screen_range_issue($1,$2,$3,$4,$5,$6,$7,$8) value',
        args: [
          args.p_root_operation,
          args.p_team,
          args.p_actor,
          args.p_slot,
          args.p_request,
          args.p_grant,
          args.p_executor,
          args.p_epoch
        ]
      },
      service_issue_restitch_screen_range: {
        sql: 'select public.service_issue_restitch_screen_range($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11::text::bytea,$12,$13) value',
        args: [
          args.p_root_operation,
          args.p_team,
          args.p_actor,
          args.p_slot,
          args.p_version,
          args.p_acquisition,
          args.p_request,
          JSON.stringify(args.p_expected_budget),
          JSON.stringify(args.p_next_budget),
          args.p_grant,
          args.p_ticket_hash,
          args.p_executor,
          args.p_epoch
        ]
      },
      service_consume_restitch_screen_range: {
        sql: 'select public.service_consume_restitch_screen_range($1::text::bytea,$2,$3) value',
        args: [args.p_ticket_hash, args.p_dispatch, args.p_purpose]
      },
      service_read_restitch_screen_range_consumption: {
        sql: 'select public.service_read_restitch_screen_range_consumption($1::text::bytea,$2) value',
        args: [args.p_ticket_hash, args.p_dispatch]
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
    expect(investigatePrivacyFailure(investigation)).toBeNull();
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
  // The 5001-row fixture runs ingestion triggers (~13s); the bounded query itself
  // measures ~24ms. Allow setup headroom without changing any product deadline.
}, 30000);

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

interface ScreenRangeGrantReceipt {
  grantId: string;
  requestId: string;
  rootOperationId: string;
  executorId: string;
  epoch: number;
  state: 'issued' | 'consumed' | 'abandoned';
  reservation: unknown;
}
async function rangeGrantFixture() {
  const f = await ownedFixture();
  await f.ownedStore.select(f.version, 4);
  const before = await f.ownedStore.read();
  const request = id(sequence++),
    grant = id(sequence++);
  const ticketHash = '\\x' + grant.replaceAll('-', '').padEnd(64, '0');
  const next = reserveScreenTransfer(before, f.version, request, 0);
  const issueArgs = [
    f.accepted.operationId,
    f.team,
    actor,
    'end',
    f.version,
    0,
    request,
    JSON.stringify(before),
    JSON.stringify(next.state),
    grant,
    ticketHash,
    f.executor.id,
    f.executor.epoch
  ];
  const issue = async (values = issueArgs) =>
    (
      await db.root<{ value: ScreenRangeGrantReceipt }>(
        'select public.service_issue_restitch_screen_range($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11::text::bytea,$12,$13) value',
        values
      )
    )[0]!.value;
  const consume = async (purpose = 'restitch_screen_range_v1', invocation = id(sequence++)) =>
    (
      await db.root<{ value: { dispatch: boolean; grant: ScreenRangeGrantReceipt } }>(
        'select public.service_consume_restitch_screen_range($1::text::bytea,$2,$3) value',
        [ticketHash, invocation, purpose]
      )
    )[0]!.value;
  const abandon = async () =>
    (
      await db.root<{ value: boolean }>(
        'select public.service_abandon_restitch_screen_range($1,$2,$3,$4,$5,$6,$7,$8) value',
        [
          f.accepted.operationId,
          f.team,
          actor,
          'end',
          request,
          grant,
          f.executor.id,
          f.executor.epoch
        ]
      )
    )[0]!.value;
  return { ...f, before, next, request, grant, ticketHash, issueArgs, issue, consume, abandon };
}
it('atomically reserves one range before issuing its dedicated transfer row and never dispatches it twice', async () => {
  const f = await rangeGrantFixture();
  const receipt = await f.issue();
  expect(receipt).toMatchObject({
    grantId: f.grant,
    requestId: f.request,
    state: 'issued',
    executorId: f.executor.id,
    epoch: f.executor.epoch
  });
  expect(receipt.reservation).toEqual(f.next.reservation);
  expect(await f.ownedStore.read()).toEqual(f.next.state);
  expect(await f.issue()).toEqual(receipt);
  expect((await f.consume()).dispatch).toBe(true);
  expect((await f.consume()).dispatch).toBe(false);
  expect(await f.ownedStore.read()).toEqual(f.next.state);
});
it('does not burn a screen range on a control, source or generic-purpose probe', async () => {
  const f = await rangeGrantFixture();
  await f.issue();
  for (const purpose of ['control', 'source_range', 'download_range', 'process_input', 'finalize'])
    await expect(f.consume(purpose)).rejects.toThrow('PERMISSION_DENIED');
  expect((await f.consume()).dispatch).toBe(true);
});
it('reads the original issued receipt after a lost acknowledgement without accepting another row identity', async () => {
  const f = await rangeGrantFixture(),
    issued = await f.issue();
  const read = async (grant = f.grant) =>
    (
      await db.root<{ value: ScreenRangeGrantReceipt | null }>(
        'select public.service_read_restitch_screen_range_issue($1,$2,$3,$4,$5,$6,$7,$8) value',
        [
          f.accepted.operationId,
          f.team,
          actor,
          'end',
          f.request,
          grant,
          f.executor.id,
          f.executor.epoch
        ]
      )
    )[0]!.value;
  expect(await read()).toEqual(issued);
  expect(await read(id(sequence++))).toBeNull();
  await expect(
    f.issue(f.issueArgs.map((value, index) => (index === 9 ? id(sequence++) : value)))
  ).rejects.toThrow('REQUEST_REUSE_CONFLICT');
  expect(await f.ownedStore.read()).toEqual(f.next.state);
});
it('abandons an unconsumed range after cancellation with authoritative zero accounting', async () => {
  const f = await rangeGrantFixture();
  await f.issue();
  await db.root(
    "update public.team_operations set state='canceled',stage='canceled',finished_at=clock_timestamp() where id=$1",
    [f.accepted.operationId]
  );
  await expect(f.consume()).rejects.toThrow('WRONG_STATE');
  expect(await f.abandon()).toBe(true);
  expect(await f.abandon()).toBe(true);
  expect((await f.ownedStore.read()).transfers[0].settlement).toEqual({
    bytes: 0,
    ioMs: 0,
    complete: false
  });
  expect(await quiesceExecutor(f)).toBe(true);
});
it('never treats a consumed range as abandoned or resets its unknown cost after cancellation', async () => {
  const f = await rangeGrantFixture();
  await f.issue();
  expect((await f.consume()).dispatch).toBe(true);
  await db.root(
    "update public.team_operations set state='canceled',stage='canceled',finished_at=clock_timestamp() where id=$1",
    [f.accepted.operationId]
  );
  expect(await f.abandon()).toBe(false);
  expect((await f.ownedStore.read()).transfers[0].settlement).toBeNull();
  await expect(quiesceExecutor(f)).rejects.toThrow('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN');
  await f.ownedStore.settle(f.request, { bytes: 2, ioMs: 7, complete: false });
  expect(await quiesceExecutor(f)).toBe(true);
});
it('does not turn exact consumption readback into another dispatch permit', async () => {
  const f = await rangeGrantFixture();
  await f.issue();
  const invocation = id(sequence++);
  expect((await f.consume('restitch_screen_range_v1', invocation)).dispatch).toBe(true);
  const read = async (value: string) =>
    (
      await db.root<{ value: { consumedByInvocation: boolean } | null }>(
        'select public.service_read_restitch_screen_range_consumption($1::text::bytea,$2) value',
        [f.ticketHash, value]
      )
    )[0]!.value;
  expect(await read(invocation)).toMatchObject({ consumedByInvocation: true });
  expect(await read(id(sequence++))).toMatchObject({ consumedByInvocation: false });
  expect((await f.consume('restitch_screen_range_v1', invocation)).dispatch).toBe(false);
});
it('rejects a grant with no new reservation without changing its original budget', async () => {
  const f = await rangeGrantFixture();
  await expect(
    f.issue(f.issueArgs.map((value, index) => (index === 8 ? JSON.stringify(f.before) : value)))
  ).rejects.toThrow('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN');
  expect(await f.ownedStore.read()).toEqual(f.before);
});
it('keeps every dedicated range RPC and raw grant row inaccessible to browser roles', async () => {
  expect(
    (
      await db.root<{ covered: boolean }>('select private.task_cleanup_coverage_verified() covered')
    )[0]?.covered
  ).toBe(true);
  const rows = await db.root<{
    allowed: boolean;
  }>(`select has_function_privilege('service_role',p.oid,'execute')
    and not has_function_privilege('authenticated',p.oid,'execute') and not has_function_privilege('anon',p.oid,'execute') allowed
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in(
      'service_issue_restitch_screen_range','service_read_restitch_screen_range_issue','service_consume_restitch_screen_range',
      'service_read_restitch_screen_range_consumption','service_abandon_restitch_screen_range','service_refresh_restitch_screen_range')`);
  expect(rows).toHaveLength(6);
  expect(rows.every(row => row.allowed)).toBe(true);
  const [table] = await db.root<{
    allowed: boolean;
  }>(`select not has_table_privilege('authenticated','private.restitch_screen_range_grants','select')
    and not has_table_privilege('service_role','private.restitch_screen_range_grants','update') allowed`);
  expect(table.allowed).toBe(true);
});

it('retains a range authority when its frozen candidate or original executor is still referenced', async () => {
  const f = await rangeGrantFixture();
  await f.issue();
  await expect(
    db.root(
      'delete from private.restitch_selection_candidates where root_operation_id=$1 and slot=$2 and version_id=$3',
      [f.accepted.operationId, 'end', f.version]
    )
  ).rejects.toMatchObject({ code: '23503' });
  await expect(
    db.root('delete from private.restitch_selection_executor_claims where executor_id=$1', [
      f.executor.id
    ])
  ).rejects.toMatchObject({ code: '23503' });
  expect((await f.consume()).dispatch).toBe(true);
  expect((await f.ownedStore.read()).transfers[0].settlement).toBeNull();
});

it('charges an expired unused ticket refresh to the same durable candidate budget before another grant', async () => {
  const f = await rangeGrantFixture();
  await f.ownedStore.reserve(f.version, f.request, 0, 0);
  await db.root(
    `insert into private.restitch_screen_range_grants(id,root_operation_id,team_id,actor_id,slot,version_id,
    acquisition,request_id,executor_id,epoch,native_instance_id,token_hash,reservation,issued_at,expires_at)
    values($1,$2,$3,$4,'end',$5,0,$6,$7,$8,$9,$10::text::bytea,$11::jsonb,clock_timestamp()-interval '10 minutes',clock_timestamp()-interval '6 minutes')`,
    [
      f.grant,
      f.accepted.operationId,
      f.team,
      actor,
      f.version,
      f.request,
      f.executor.id,
      f.executor.epoch,
      f.native,
      f.ticketHash,
      JSON.stringify(f.next.reservation)
    ]
  );
  await expect(f.consume()).rejects.toThrow('EXPIRED');
  expect(await f.abandon()).toBe(true);
  const nextRequest = id(sequence++),
    nextGrant = id(sequence++);
  const nextHash = f.ticketHash.replace(f.grant.replaceAll('-', ''), nextGrant.replaceAll('-', ''));
  const mintArgs = (budget: Awaited<ReturnType<typeof f.ownedStore.read>>) => [
    f.accepted.operationId,
    f.team,
    actor,
    'end',
    f.version,
    0,
    nextRequest,
    JSON.stringify(budget),
    JSON.stringify(reserveScreenTransfer(budget, f.version, nextRequest, 0).state),
    nextGrant,
    nextHash,
    f.executor.id,
    f.executor.epoch
  ];
  const before = await f.ownedStore.read();
  await expect(f.issue(mintArgs(before))).rejects.toThrow('EXPIRED');
  expect(await f.ownedStore.read()).toEqual(before);
  const refresh = id(sequence++),
    after = refreshScreenCandidateGrant(before, f.version, refresh);
  const args = [
    f.accepted.operationId,
    f.team,
    actor,
    'end',
    f.request,
    f.grant,
    f.executor.id,
    f.executor.epoch,
    0,
    refresh,
    JSON.stringify(before),
    JSON.stringify(after)
  ];
  const applyRefresh = async () =>
    (
      await db.root<{ value: boolean }>(
        'select public.service_refresh_restitch_screen_range($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb) value',
        args
      )
    )[0]!.value;
  expect(await applyRefresh()).toBe(true);
  expect(await applyRefresh()).toBe(true);
  expect((await f.ownedStore.read()).refreshes).toEqual([
    { requestId: refresh, candidateVersionId: f.version }
  ]);
  expect(await f.issue(mintArgs(after))).toMatchObject({ grantId: nextGrant, state: 'issued' });
});

it('cannot create transfer authority before the exact budget reservation even through a trusted insert', async () => {
  const f = await rangeGrantFixture();
  await expect(
    db.root(
      `insert into private.restitch_screen_range_grants(id,root_operation_id,team_id,actor_id,slot,version_id,
    acquisition,request_id,executor_id,epoch,native_instance_id,token_hash,reservation,issued_at,expires_at)
    values($1,$2,$3,$4,'end',$5,0,$6,$7,$8,$9,$10::text::bytea,$11::jsonb,clock_timestamp(),clock_timestamp()+interval '4 minutes')`,
      [
        f.grant,
        f.accepted.operationId,
        f.team,
        actor,
        f.version,
        f.request,
        f.executor.id,
        f.executor.epoch,
        f.native,
        f.ticketHash,
        JSON.stringify(f.next.reservation)
      ]
    )
  ).rejects.toThrow('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN');
  expect(await f.ownedStore.read()).toEqual(f.before);
});

it('projects grant transitions with their own observation time without exposing transfer secrets or proving I/O', async () => {
  const f = await rangeGrantFixture();
  const projection = async () =>
    (
      await db.root<Record<string, unknown>>(
        "select * from public.analytics_restitch_selection_slots where operation_id=$1 and slot='end'",
        [f.accepted.operationId]
      )
    )[0]!;
  const before = await projection();
  expect(before).toMatchObject({
    grant_count: 0,
    issued_grant_count: 0,
    consumed_grant_count: 0,
    abandoned_grant_count: 0
  });
  await f.issue();
  const issued = await projection();
  expect(issued).toMatchObject({
    grant_count: 1,
    issued_grant_count: 1,
    consumed_grant_count: 0,
    abandoned_grant_count: 0,
    state: 'range_unconfirmed',
    confirmed_bytes: 0
  });
  await f.consume();
  const consumed = await projection();
  expect(consumed).toMatchObject({
    grant_count: 1,
    issued_grant_count: 0,
    consumed_grant_count: 1,
    abandoned_grant_count: 0,
    state: 'range_unconfirmed',
    confirmed_bytes: 0
  });
  expect(Date.parse(String(consumed.updated_at))).toBeGreaterThanOrEqual(
    Date.parse(String(issued.updated_at))
  );
  const raw = JSON.stringify(consumed);
  expect(raw).not.toContain(f.ticketHash);
  for (const key of [
    'token_hash',
    'consumption_id',
    'native_instance_id',
    'reservation',
    'fileId',
    'checksum'
  ])
    expect(consumed).not.toHaveProperty(key);
  setQueryExecutor(async (sql, args) => {
    assertReadOnlySql(sql);
    await db.db.exec('begin read only;set local role wishly_analytics_ro');
    try {
      const rows = await db.db.query(sql, args);
      await db.db.exec('commit');
      return rows.rows as Record<string, unknown>[];
    } catch (error) {
      await db.db.exec('rollback');
      throw error;
    }
  });
  try {
    const evidence = await getRestitchSelectionEvidence({
      ids: [f.accepted.operationId],
      asOf: new Date(Date.now() + 60000).toISOString()
    });
    expect(evidence.records).toContainEqual(
      expect.objectContaining({
        slot: 'end',
        authority: { total: 1, issued: 0, consumed: 1, abandoned: 0 },
        state: 'range_unconfirmed',
        confirmed_bytes: 0
      })
    );
    expect(evidence.blind_spots.join(' ')).toContain('Consumed authority');
    expect(JSON.stringify(evidence)).not.toContain(f.ticketHash);
  } finally {
    setQueryExecutor(null);
  }
  const unused = await rangeGrantFixture();
  await unused.issue();
  await unused.abandon();
  const abandoned = (
    await db.root<Record<string, unknown>>(
      "select * from public.analytics_restitch_selection_slots where operation_id=$1 and slot='end'",
      [unused.accepted.operationId]
    )
  )[0]!;
  expect(abandoned).toMatchObject({
    grant_count: 1,
    issued_grant_count: 0,
    consumed_grant_count: 0,
    abandoned_grant_count: 1,
    confirmed_bytes: 0,
    unconfirmed_range_count: 0
  });
});

it('issues and consumes actual SQL-backed tickets with exact lost-ACK recovery and no replay dispatch', async () => {
  const f = await ownedFixture();
  await f.ownedStore.select(f.version, 4);
  const request = {
    scope: f.ownedScope,
    nativeInstanceId: f.native,
    versionId: f.version,
    acquisition: 0,
    requestId: id(sequence++),
    grantId: id(sequence++),
    offset: 0
  };
  const calls: string[] = [];
  const service: ServiceRpcClient = {
    rpc: async (name, args) => {
      calls.push(name);
      const r = await f.service.rpc(name, args);
      if (
        !r.error &&
        ['service_issue_restitch_screen_range', 'service_consume_restitch_screen_range'].includes(
          name
        )
      )
        throw Error('SYNTHETIC_LOST_ACK_AFTER_COMMIT');
      return r;
    }
  };
  const issued = await issueRestitchScreenRange(
    service,
    'synthetic-private-key-'.repeat(3),
    request
  );
  expect(issued.reservation).toMatchObject({ requestId: request.requestId, settlement: null });
  const consumed = await consumeRestitchScreenRange(service, issued.ticket);
  expect(consumed).toMatchObject({ requestId: request.requestId, scope: { executor: f.executor } });
  expect(calls.filter(n => n === 'service_issue_restitch_screen_range')).toHaveLength(1);
  expect(calls.filter(n => n === 'service_consume_restitch_screen_range')).toHaveLength(1);
  expect(calls).toContain('service_read_restitch_screen_range_issue');
  expect(calls).toContain('service_read_restitch_screen_range_consumption');
  await expect(consumeRestitchScreenRange(f.service, issued.ticket)).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  const budget = await f.ownedStore.read();
  expect(budget.transfers).toHaveLength(1);
  expect(budget.transfers[0]?.settlement).toBeNull();
});

function executorClosureService(loseFirstReply = false): ServiceRpcClient {
  return {
    rpc: async (name, args) => {
      const parameters =
        name === 'service_read_restitch_executor_claim'
          ? [args.p_root_operation, args.p_team, args.p_actor, args.p_claim, args.p_native_instance]
          : name === 'service_quiesce_restitch_executor'
            ? [
                args.p_root_operation,
                args.p_team,
                args.p_actor,
                args.p_executor,
                args.p_epoch,
                args.p_quiescence
              ]
            : null;
      if (!parameters) throw Error('UNEXPECTED_EXECUTOR_CLOSURE_RPC');
      let data: unknown;
      try {
        data = (
          await db.root<{ value: unknown }>(
            `select public.${name}(${parameters.map((_, i) => '$' + (i + 1)).join(',')}) value`,
            parameters
          )
        )[0]!.value;
      } catch (cause) {
        return {
          data: null,
          error: { message: cause instanceof Error ? cause.message : 'UNKNOWN' }
        };
      }
      if (name === 'service_quiesce_restitch_executor' && loseFirstReply) {
        loseFirstReply = false;
        throw Error('SYNTHETIC_LOST_CLOSURE_ACK');
      }
      return { data, error: null };
    }
  };
}
function closureInput(f: Awaited<ReturnType<typeof ownedFixture>>, quiescenceId = id(sequence++)) {
  return {
    rootOperationId: f.accepted.operationId,
    teamId: f.team,
    actorId: actor,
    claimId: f.claim,
    nativeInstanceId: f.native,
    installedContract: 1,
    executorId: f.executor.id,
    epoch: f.executor.epoch,
    quiescenceId
  };
}
it('recovers the exact SQL-backed closure after its successful commit loses the reply', async () => {
  const f = await ownedFixture(),
    input = closureInput(f),
    service = executorClosureService(true);
  await expect(quiesceRestitchExecutor(service, input)).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  const next = await claimExecutor(f.accepted.operationId, f.team);
  expect(await quiesceRestitchExecutor(service, input)).toBe(true);
  const current = (
    await db.root<{ state: string; executor_id: string; epoch: number }>(
      'select state,executor_id,epoch::integer from private.restitch_selection_executors where root_operation_id=$1',
      [f.accepted.operationId]
    )
  )[0]!;
  expect(current).toEqual({ state: 'owned', executor_id: next.id, epoch: next.epoch });
  await expect(
    quiesceRestitchExecutor(service, { ...input, quiescenceId: id(sequence++) })
  ).rejects.toMatchObject({ code: 'REQUEST_REUSE_CONFLICT' });
});
it('does not close a SQL-backed owner while a reserved range remains unsettled', async () => {
  const f = await ownedFixture();
  await f.ownedStore.select(f.version, 4);
  await f.ownedStore.reserve(f.version, id(sequence++), 0, 0);
  const before = await f.ownedStore.read();
  await expect(
    quiesceRestitchExecutor(executorClosureService(), closureInput(f))
  ).rejects.toMatchObject({ code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' });
  expect(await f.ownedStore.read()).toEqual(before);
});
it('refuses a foreign native instance through the actual closure service adapter before mutation', async () => {
  const f = await ownedFixture();
  await expect(
    quiesceRestitchExecutor(executorClosureService(), {
      ...closureInput(f),
      nativeInstanceId: id(sequence++)
    })
  ).rejects.toMatchObject({ code: 'REQUEST_REUSE_CONFLICT' });
  const current = (
    await db.root<{ state: string; executor_id: string }>(
      'select state,executor_id from private.restitch_selection_executors where root_operation_id=$1',
      [f.accepted.operationId]
    )
  )[0]!;
  expect(current).toEqual({ state: 'owned', executor_id: f.executor.id });
});

async function nativeControlFixture(
  options: {
    ticketHash?: Buffer;
    beforeAccept?: (f: Awaited<ReturnType<typeof manualFixture>>) => Promise<void>;
  } = {}
) {
  const f = await manualFixture();
  await options.beforeAccept?.(f);
  const root = (await f.call())!;
  // Minimal Auth row shape only; real Auth/session behavior still needs native verification.
  await db.root(
    'create table if not exists auth.sessions(id uuid primary key,user_id uuid not null,not_after timestamptz)'
  );
  const session = id(sequence++),
    grant = id(sequence++),
    enrollment = id(sequence++),
    native = id(sequence++);
  const proof = Buffer.from(id(sequence++).replaceAll('-', '').padEnd(64, 'a'), 'hex');
  const ticket =
    options.ticketHash ?? Buffer.from(id(sequence++).replaceAll('-', '').padEnd(64, 'b'), 'hex');
  await db.root('insert into auth.sessions(id,user_id) values($1,$2)', [session, actor]);
  const issue = async (g = grant, e = enrollment, n = native, p = proof, t = ticket) =>
    (
      await db.root<{ value: Record<string, unknown> }>(
        'select public.service_issue_restitch_native_control($1,$2,$3,$4,$5,$6,$7,$8,$9) value',
        [root.operationId, f.team, actor, session, g, e, n, p, t]
      )
    )[0]!.value;
  const redeem = async (g = grant, p = proof) =>
    (
      await db.root<{ value: Record<string, unknown> }>(
        'select public.service_redeem_restitch_native_control($1,$2) value',
        [g, p]
      )
    )[0]!.value;
  const claim = async (c: string, g = grant, t = ticket) =>
    (
      await db.root<{ value: { executorId: string; epoch: number; active: boolean } }>(
        'select public.service_claim_restitch_native_control($1,$2,$3,1) value',
        [g, t, c]
      )
    )[0]!.value;
  const authorize = async () =>
    (
      await db.root<{ value: Record<string, unknown> }>(
        'select public.service_authorize_restitch_native_control($1,$2) value',
        [grant, ticket]
      )
    )[0]!.value;
  const read = async (c: string) =>
    (
      await db.root<{ value: Record<string, unknown> }>(
        'select public.service_read_restitch_native_control_claim($1,$2,$3) value',
        [grant, ticket, c]
      )
    )[0]!.value;
  const close = async (c: string, nonce: string, g = grant, t = ticket) =>
    (
      await db.root<{ value: boolean }>(
        'select public.service_quiesce_restitch_native_control($1,$2,$3,$4) value',
        [g, t, c, nonce]
      )
    )[0]!.value;
  return {
    ...f,
    root,
    session,
    grant,
    enrollment,
    native,
    proof,
    ticket,
    issue,
    redeem,
    claim,
    authorize,
    read,
    close
  };
}
it('keeps all native control tables and six service RPCs unavailable to browser roles', async () => {
  const rows = await db.root<{
    name: string;
    browser: boolean;
    service: boolean;
  }>(`select p.proname name,
    has_function_privilege('authenticated',p.oid,'execute') or has_function_privilege('anon',p.oid,'execute') browser,
    has_function_privilege('service_role',p.oid,'execute') service
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in(
    'service_issue_restitch_native_control','service_redeem_restitch_native_control','service_claim_restitch_native_control',
    'service_read_restitch_native_control_claim','service_quiesce_restitch_native_control','service_authorize_restitch_native_control')`);
  expect(rows).toHaveLength(6);
  expect(rows.every(row => !row.browser && row.service)).toBe(true);
  const access = await db.root<{ allowed: boolean }>(
    `select has_table_privilege(role,'private.restitch_native_controls','select,insert,update,delete') allowed from unnest(array['anon','authenticated','service_role']) role`
  );
  expect(access.every(row => !row.allowed)).toBe(true);
});
it('issues the same immutable native enrollment without exposing a token or proof hash', async () => {
  const f = await nativeControlFixture();
  const receipt = await f.issue();
  expect(await f.issue()).toEqual(receipt);
  expect(receipt).toMatchObject({ grantId: f.grant, nativeInstanceId: f.native, redeemed: false });
  expect(Object.keys(receipt).sort()).toEqual(
    [
      'actorId',
      'enrollmentId',
      'expiresAt',
      'grantId',
      'nativeInstanceId',
      'redeemed',
      'rootOperationId',
      'teamId'
    ].sort()
  );
  await expect(f.issue(f.grant, f.enrollment, id(sequence++))).rejects.toThrow(
    'REQUEST_REUSE_CONFLICT'
  );
  await expect(f.redeem(f.grant, Buffer.alloc(32, 99))).rejects.toThrow('AUTH_REQUIRED');
  await expect(f.claim(id(sequence++))).rejects.toThrow('AUTH_REQUIRED');
  expect(await f.redeem()).toMatchObject({ redeemed: true });
  expect(await f.redeem()).toEqual(await f.redeem());
});
it('atomically binds the original native claim and refuses replacement claims on that grant', async () => {
  const f = await nativeControlFixture(),
    claim = id(sequence++);
  await f.issue();
  await f.redeem();
  const owned = await f.claim(claim);
  expect(owned.active).toBe(true);
  expect(await f.claim(claim)).toEqual(owned);
  expect(await f.authorize()).toMatchObject({
    executorId: owned.executorId,
    epoch: owned.epoch,
    nativeInstanceId: f.native
  });
  await expect(f.claim(id(sequence++))).rejects.toThrow('REQUEST_REUSE_CONFLICT');
  await expect(
    db.root('update private.restitch_native_controls set claim_id=$2 where id=$1', [
      f.grant,
      id(sequence++)
    ])
  ).rejects.toThrow('REQUEST_REUSE_CONFLICT');
});
it('cannot adopt or close another native grant owner using a leaked claim UUID', async () => {
  const f = await nativeControlFixture(),
    originalClaim = id(sequence++);
  await f.issue();
  await f.redeem();
  const owned = await f.claim(originalClaim);
  const secondGrant = id(sequence++),
    secondProof = Buffer.alloc(32, 29),
    secondTicket = Buffer.alloc(32, 30);
  await f.issue(secondGrant, id(sequence++), f.native, secondProof, secondTicket);
  await f.redeem(secondGrant, secondProof);
  await expect(f.claim(originalClaim, secondGrant, secondTicket)).rejects.toThrow(
    'REQUEST_REUSE_CONFLICT'
  );
  await expect(f.claim(id(sequence++), secondGrant, secondTicket)).rejects.toThrow('WRONG_STATE');
  await expect(f.close(originalClaim, id(sequence++), secondGrant, secondTicket)).rejects.toThrow(
    'REQUEST_REUSE_CONFLICT'
  );
  expect(await f.authorize()).toMatchObject({ executorId: owned.executorId, active: true });
});
it('revokes new I/O after real session removal while retaining original claim and late closure evidence', async () => {
  const f = await nativeControlFixture(),
    claim = id(sequence++),
    nonce = id(sequence++);
  await f.issue();
  await f.redeem();
  const owned = await f.claim(claim);
  await db.root('delete from auth.sessions where id=$1', [f.session]);
  await expect(f.authorize()).rejects.toThrow('AUTH_REQUIRED');
  expect(await f.read(claim)).toMatchObject({ executorId: owned.executorId, active: true });
  expect(await f.close(claim, nonce)).toBe(true);
  expect(await f.close(claim, nonce)).toBe(true);
  expect(await f.read(claim)).toMatchObject({ executorId: owned.executorId, active: false });
});
it('requires the enrollment actor session instead of an unrelated live session', async () => {
  const f = await nativeControlFixture();
  await db.root('update auth.sessions set user_id=$2 where id=$1', [f.session, owner]);
  await expect(f.issue()).rejects.toThrow('AUTH_REQUIRED');
  const row = (
    await db.root<{ n: number }>(
      'select count(*)::integer n from private.restitch_native_controls where id=$1',
      [f.grant]
    )
  )[0]!;
  expect(row.n).toBe(0);
});
it('rechecks session expiry and parent cancellation before new native I/O but permits exact late closure', async () => {
  const f = await nativeControlFixture(),
    claim = id(sequence++);
  await f.issue();
  await f.redeem();
  await f.claim(claim);
  await db.root(
    "update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id=$1",
    [f.session]
  );
  await expect(f.authorize()).rejects.toThrow('AUTH_REQUIRED');
  await db.root('update auth.sessions set not_after=null where id=$1', [f.session]);
  await db.asUser(actor, 'select public.cancel_team_operation($1,$2)', [
    f.team,
    f.root.operationId
  ]);
  await expect(f.authorize()).rejects.toThrow('WRONG_STATE');
  expect(await f.close(claim, id(sequence++))).toBe(true);
});
it('bounds native control records without resetting original claims or their enrollment window', async () => {
  const f = await nativeControlFixture();
  await f.issue();
  for (let n = 1; n < 8; n++) {
    await f.issue(
      id(sequence++),
      id(sequence++),
      f.native,
      Buffer.alloc(32, 50 + n),
      Buffer.alloc(32, 70 + n)
    );
  }
  await expect(
    f.issue(id(sequence++), id(sequence++), f.native, Buffer.alloc(32, 100), Buffer.alloc(32, 101))
  ).rejects.toThrow('RATE_LIMITED');
  expect(await f.issue()).toMatchObject({ grantId: f.grant, redeemed: false });
});

async function controlledRangeFixture() {
  const f = await nativeControlFixture(),
    claimId = id(sequence++);
  await f.issue();
  await f.redeem();
  const owned = await f.claim(claimId);
  const scope: RestitchSelectionSlotScope = {
    rootOperationId: f.root.operationId,
    teamId: f.team,
    actorId: actor,
    slot: 'end',
    executor: { id: owned.executorId, epoch: owned.epoch }
  };
  const store = new RestitchSelectionSlotStore(f.service, scope);
  const version = (
    await db.root<{ version_id: string }>(
      "select version_id from private.restitch_selection_candidates where root_operation_id=$1 and slot='end' order by ordinal limit 1",
      [f.root.operationId]
    )
  )[0]!.version_id;
  await store.select(version, 4);
  const before = await store.read(),
    request = id(sequence++),
    range = id(sequence++);
  const rangeHash = Buffer.from(id(sequence++).replaceAll('-', '').padEnd(64, 'c'), 'hex');
  const next = reserveScreenTransfer(before, version, request, 0);
  const issueRange = async () =>
    (
      await db.root<{ value: Record<string, unknown> }>(
        'select public.service_issue_restitch_control_screen_range($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10) value',
        [
          f.grant,
          f.ticket,
          'end',
          version,
          0,
          request,
          JSON.stringify(before),
          JSON.stringify(next.state),
          range,
          rangeHash
        ]
      )
    )[0]!.value;
  const readIssue = async (control = f.grant, ticket = f.ticket) =>
    (
      await db.root<{ value: unknown }>(
        'select public.service_read_restitch_control_screen_range_issue($1,$2,$3,$4,$5) value',
        [control, ticket, 'end', request, range]
      )
    )[0]!.value;
  const consume = async (dispatch: string, purpose = 'restitch_screen_range_v1') =>
    (
      await db.root<{ value: { dispatch: boolean } }>(
        'select public.service_consume_restitch_control_screen_range($1,$2,$3) value',
        [rangeHash, dispatch, purpose]
      )
    )[0]!.value;
  const readConsumption = async (dispatch: string) =>
    (
      await db.root<{ value: { consumedByInvocation: boolean } }>(
        'select public.service_read_restitch_control_screen_range_consumption($1,$2) value',
        [rangeHash, dispatch]
      )
    )[0]!.value;
  const check = async (dispatch: string) =>
    (
      await db.root<{ value: { consumedByInvocation: boolean } }>(
        'select public.service_check_restitch_control_screen_range($1,$2) value',
        [rangeHash, dispatch]
      )
    )[0]!.value;
  const abandon = async () =>
    (
      await db.root<{ value: boolean }>(
        'select public.service_abandon_restitch_control_screen_range($1,$2,$3,$4,$5) value',
        [f.grant, f.ticket, 'end', request, range]
      )
    )[0]!.value;
  return {
    ...f,
    claimId,
    owned,
    scope,
    store,
    version,
    before,
    request,
    range,
    rangeHash,
    next,
    issueRange,
    readIssue,
    consume,
    readConsumption,
    check,
    abandon
  };
}
it('atomically binds an issued screen range to the exact native control without another reservation on replay', async () => {
  const f = await controlledRangeFixture();
  const issued = await f.issueRange();
  expect(await f.issueRange()).toEqual(issued);
  expect(await f.readIssue()).toEqual(issued);
  expect((await f.store.read()).transfers).toHaveLength(1);
  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::integer n from private.restitch_control_screen_ranges where range_grant_id=$1 and control_grant_id=$2',
        [f.range, f.grant]
      )
    )[0]!.n
  ).toBe(1);
});
it('checks the current Auth session at screen consumption instead of relying on earlier issuance', async () => {
  const f = await controlledRangeFixture();
  await f.issueRange();
  await db.root('delete from auth.sessions where id=$1', [f.session]);
  await expect(f.consume(id(sequence++))).rejects.toThrow('AUTH_REQUIRED');
  expect(await f.abandon()).toBe(true);
  expect((await f.store.read()).transfers[0]!.settlement).toEqual({
    bytes: 0,
    ioMs: 0,
    complete: false
  });
});
it('keeps exact consumed bookkeeping after logout but refuses another upstream authority check', async () => {
  const f = await controlledRangeFixture(),
    dispatch = id(sequence++);
  await f.issueRange();
  expect((await f.consume(dispatch)).dispatch).toBe(true);
  expect((await f.check(dispatch)).consumedByInvocation).toBe(true);
  await db.root('delete from auth.sessions where id=$1', [f.session]);
  expect((await f.readConsumption(dispatch)).consumedByInvocation).toBe(true);
  await expect(f.check(dispatch)).rejects.toThrow('AUTH_REQUIRED');
  expect(await f.abandon()).toBe(false);
  expect((await f.store.read()).transfers[0]!.settlement).toBeNull();
});
it('does not grant another dispatch from the same leaf ticket or an invocation chosen later', async () => {
  const f = await controlledRangeFixture(),
    first = id(sequence++),
    second = id(sequence++);
  await f.issueRange();
  expect((await f.consume(first)).dispatch).toBe(true);
  expect((await f.consume(second)).dispatch).toBe(false);
  await expect(f.check(second)).rejects.toThrow('PERMISSION_DENIED');
  expect((await f.readConsumption(second)).consumedByInvocation).toBe(false);
});
it('does not authorize generic internal range grants through the controlled screen transport', async () => {
  const f = await controlledRangeFixture();
  await db.root(
    'select public.service_issue_restitch_screen_range($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13)',
    [
      f.root.operationId,
      f.team,
      actor,
      'end',
      f.version,
      0,
      f.request,
      JSON.stringify(f.before),
      JSON.stringify(f.next.state),
      f.range,
      f.rangeHash,
      f.owned.executorId,
      f.owned.epoch
    ]
  );
  await expect(f.consume(id(sequence++))).rejects.toThrow('PERMISSION_DENIED');
  await expect(f.issueRange()).rejects.toThrow('REQUEST_REUSE_CONFLICT');
  expect((await f.store.read()).transfers).toHaveLength(1);
});
it('does not bind or consume under another enrolled grant from the same native boot', async () => {
  const f = await controlledRangeFixture();
  await f.issueRange();
  const second = id(sequence++),
    proof = Buffer.alloc(32, 115),
    ticket = Buffer.alloc(32, 116);
  await f.issue(second, id(sequence++), f.native, proof, ticket);
  await f.redeem(second, proof);
  await expect(f.claim(f.claimId, second, ticket)).rejects.toThrow('REQUEST_REUSE_CONFLICT');
  await expect(f.readIssue(second, ticket)).rejects.toThrow('WRONG_STATE');
  const original = id(sequence++);
  expect((await f.consume(original)).dispatch).toBe(true);
});
it('requires a screen purpose and retains missing issue acknowledgement as unknown without a new reservation', async () => {
  const f = await controlledRangeFixture();
  expect(await f.readIssue()).toBeNull();
  expect((await f.store.read()).transfers).toHaveLength(0);
  await f.issueRange();
  await expect(f.consume(id(sequence++), 'restitch_source_range_v1')).rejects.toThrow(
    'PERMISSION_DENIED'
  );
  expect((await f.store.read()).transfers[0]!.settlement).toBeNull();
});
it('keeps all controlled screen functions and bindings unavailable to browser roles and direct service table access', async () => {
  const rows = await db.root<{
    name: string;
    browser: boolean;
    service: boolean;
  }>(`select p.proname name,
    has_function_privilege('authenticated',p.oid,'execute') or has_function_privilege('anon',p.oid,'execute') browser,
    has_function_privilege('service_role',p.oid,'execute') service from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in('service_issue_restitch_control_screen_range','service_read_restitch_control_screen_range_issue',
    'service_consume_restitch_control_screen_range','service_read_restitch_control_screen_range_consumption',
    'service_check_restitch_control_screen_range','service_abandon_restitch_control_screen_range','service_refresh_restitch_control_screen_range')`);
  expect(rows).toHaveLength(7);
  expect(rows.every(row => !row.browser && row.service)).toBe(true);
  const access = await db.root<{ allowed: boolean }>(
    `select has_table_privilege(role,'private.restitch_control_screen_ranges','select,insert,update,delete') allowed from unnest(array['anon','authenticated','service_role']) role`
  );
  expect(access.every(row => !row.allowed)).toBe(true);
});

it('keeps completed consumption as bookkeeping rather than new upstream authority', async () => {
  const f = await controlledRangeFixture(),
    dispatch = id(sequence++);
  await f.issueRange();
  await f.consume(dispatch);
  await f.store.settle(f.request, { bytes: 4, ioMs: 1, complete: true });
  expect((await f.readConsumption(dispatch)).consumedByInvocation).toBe(true);
  await expect(f.check(dispatch)).rejects.toThrow('PERMISSION_DENIED');
});

async function controlSelectionFixture(options: Parameters<typeof nativeControlFixture>[0] = {}) {
  const f = await nativeControlFixture(options);
  await f.issue();
  await f.redeem();
  const owned = await f.claim(id(sequence++));
  const readSelection = async (active = true, hash = f.ticket) =>
    (
      await db.root<{
        value: {
          rootOperationId: string;
          teamId: string;
          actorId: string;
          poolNamespaceId: string;
          executorId: string;
          epoch: number;
          nativeInstanceId: string;
          slot: string;
          budget: ReturnType<typeof createScreenSelectionBudget>;
          candidates: Array<{
            versionId: string;
            materialId: string;
            sizeBytes: number;
            checksum: string;
            mimeType: string;
          }>;
          complete: boolean;
        };
      }>('select public.service_read_restitch_control_selection($1,$2,$3,$4) value', [
        f.grant,
        hash,
        'end',
        active
      ])
    )[0]!.value;
  const change = async (
    before: ReturnType<typeof createScreenSelectionBudget>,
    after: ReturnType<typeof createScreenSelectionBudget>
  ) =>
    (
      await db.root<{ value: boolean }>(
        'select public.service_cas_restitch_control_selection($1,$2,$3,$4::jsonb,$5::jsonb) value',
        [f.grant, f.ticket, 'end', JSON.stringify(before), JSON.stringify(after)]
      )
    )[0]!.value;
  return { ...f, owned, readSelection, change };
}
it('reads the frozen candidate pool only through the original enrolled owner without provider targets', async () => {
  const f = await controlSelectionFixture(),
    context = await f.readSelection();
  expect(context).toMatchObject({
    rootOperationId: f.root.operationId,
    teamId: f.team,
    actorId: actor,
    executorId: f.owned.executorId,
    epoch: f.owned.epoch,
    nativeInstanceId: f.native,
    slot: 'end',
    complete: true
  });
  expect(context.candidates.length).toBeGreaterThan(0);
  expect(context.candidates[0]).toMatchObject({
    versionId: expect.any(String),
    materialId: expect.any(String),
    sizeBytes: 4,
    checksum: expect.any(String),
    mimeType: 'image/png'
  });
  expect(JSON.stringify(context)).not.toMatch(
    /credentialId|driveFileId|resourceKey|parentFolderId|rootFolderId/u
  );
  await expect(f.readSelection(true, Buffer.alloc(32, 117))).rejects.toThrow('AUTH_REQUIRED');
});
it('atomically checks current control authority with candidate selection and preserves exact stale-CAS refusal', async () => {
  const f = await controlSelectionFixture(),
    context = await f.readSelection(),
    candidate = context.candidates[0]!;
  const next = selectScreenCandidate(context.budget, candidate.versionId, candidate.sizeBytes);
  expect(await f.change(context.budget, next)).toBe(true);
  expect(await f.change(context.budget, next)).toBe(false);
  expect((await f.readSelection()).budget).toEqual(next);
});
it('refuses a candidate transition after logout while retaining original bookkeeping without media context', async () => {
  const f = await controlSelectionFixture(),
    context = await f.readSelection(),
    candidate = context.candidates[0]!,
    next = selectScreenCandidate(context.budget, candidate.versionId, candidate.sizeBytes);
  await db.root('delete from auth.sessions where id=$1', [f.session]);
  await expect(f.change(context.budget, next)).rejects.toThrow('AUTH_REQUIRED');
  await expect(f.readSelection()).rejects.toThrow('AUTH_REQUIRED');
  const previous = await f.readSelection(false);
  expect(previous.budget).toEqual(context.budget);
  expect(previous.candidates).toEqual([]);
});
it('keeps both controlled selection adapters unavailable to browser roles', async () => {
  const rows = await db.root<{ name: string; browser: boolean; service: boolean }>(
    `select p.proname name,has_function_privilege('authenticated',p.oid,'execute') or has_function_privilege('anon',p.oid,'execute') browser,has_function_privilege('service_role',p.oid,'execute') service from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in('service_read_restitch_control_selection','service_cas_restitch_control_selection')`
  );
  expect(rows).toHaveLength(2);
  expect(rows.every(row => !row.browser && row.service)).toBe(true);
});

it('uses the real control-bound selection API to replace a rejected image within one original root', async () => {
  const token = 'c'.repeat(43),
    ticketHash = createHash('sha256').update(token).digest();
  const f = await controlSelectionFixture({
    ticketHash,
    beforeAccept: async original => {
      const another = id(sequence++);
      await db.root(
        `insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum,drive_version)
   select $1,team_id,connection_id,$1::uuid::text,parent_folder_id,'Synthetic second.png',kind,category,mime_type,size_bytes,$3,drive_version from public.team_materials where id=$2`,
        [another, original.image, 'b'.repeat(32)]
      );
      await db.root(
        "insert into public.team_restitch_sources(team_id,slot,material_id,kind,sort_order,added_by) values($1,'end',$2,'file',2,$3)",
        [original.team, another, owner]
      );
    }
  });
  const calls: string[] = [];
  let loseRefreshReply = true;
  const service: ServiceRpcClient = {
    rpc: async (name, args) => {
      calls.push(name);
      try {
        let rows: Array<{ value: unknown }>;
        if (name === 'service_read_restitch_control_selection')
          rows = await db.root(
            'select public.service_read_restitch_control_selection($1,$2,$3,$4) value',
            [
              args.p_control,
              Buffer.from(String(args.p_control_hash).slice(2), 'hex'),
              args.p_slot,
              args.p_active
            ]
          );
        else if (name === 'service_cas_restitch_control_selection')
          rows = await db.root(
            'select public.service_cas_restitch_control_selection($1,$2,$3,$4::jsonb,$5::jsonb) value',
            [
              args.p_control,
              Buffer.from(String(args.p_control_hash).slice(2), 'hex'),
              args.p_slot,
              JSON.stringify(args.p_expected_budget),
              JSON.stringify(args.p_next_budget)
            ]
          );
        else if (name === 'service_read_restitch_control_screen_range_issue')
          rows = await db.root(
            'select public.service_read_restitch_control_screen_range_issue($1,$2,$3,$4,$5) value',
            [
              args.p_control,
              Buffer.from(String(args.p_control_hash).slice(2), 'hex'),
              args.p_slot,
              args.p_request,
              args.p_grant
            ]
          );
        else if (name === 'service_issue_restitch_control_screen_range')
          rows = await db.root(
            'select public.service_issue_restitch_control_screen_range($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10) value',
            [
              args.p_control,
              Buffer.from(String(args.p_control_hash).slice(2), 'hex'),
              args.p_slot,
              args.p_version,
              args.p_acquisition,
              args.p_request,
              JSON.stringify(args.p_expected_budget),
              JSON.stringify(args.p_next_budget),
              args.p_grant,
              Buffer.from(String(args.p_ticket_hash).slice(2), 'hex')
            ]
          );
        else if (name === 'service_read_restitch_selection_source_owned')
          rows = await db.root(
            'select public.service_read_restitch_selection_source_owned($1,$2,$3,$4,$5,$6,$7,$8) value',
            [
              args.p_root_operation,
              args.p_team,
              args.p_actor,
              args.p_slot,
              args.p_version,
              args.p_acquisition,
              args.p_executor,
              args.p_epoch
            ]
          );
        else if (name === 'service_refresh_restitch_control_screen_range')
          rows = await db.root(
            'select public.service_refresh_restitch_control_screen_range($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb) value',
            [
              args.p_control,
              Buffer.from(String(args.p_control_hash).slice(2), 'hex'),
              args.p_slot,
              args.p_request,
              args.p_grant,
              args.p_acquisition,
              args.p_refresh,
              JSON.stringify(args.p_expected_budget),
              JSON.stringify(args.p_next_budget)
            ]
          );
        else if (name === 'service_abandon_restitch_control_screen_range')
          rows = await db.root(
            'select public.service_abandon_restitch_control_screen_range($1,$2,$3,$4,$5) value',
            [
              args.p_control,
              Buffer.from(String(args.p_control_hash).slice(2), 'hex'),
              args.p_slot,
              args.p_request,
              args.p_grant
            ]
          );
        else throw Error('INVALID_INPUT');
        if (name === 'service_refresh_restitch_control_screen_range' && loseRefreshReply) {
          loseRefreshReply = false;
          return { data: null, error: { message: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' } };
        }
        return { data: rows[0]!.value, error: null };
      } catch (error) {
        return { data: null, error: { message: (error as Error).message } };
      }
    }
  };
  const call = async (action: string, extra: Record<string, unknown> = {}) =>
    handleRestitchNativeSelection(
      new Request('https://project.invalid/native-selection', {
        method: 'POST',
        headers: { 'x-restitch-control-ticket': token }
      }),
      action,
      {
        protocolVersion: 1,
        grantId: f.grant,
        slot: 'end',
        actorId: owner,
        rootOperationId: id(999),
        ...extra
      },
      { service, secret: 'synthetic-range-test-key-'.repeat(3) }
    );
  expect(await call('context')).toMatchObject({
    rootOperationId: f.root.operationId,
    actorId: actor,
    defaults: f.root.recipe.defaults,
    source: { materialId: f.video, checksum: 'a'.repeat(32), sizeBytes: 4, mimeType: 'video/mp4' }
  });
  const first = await call('next');
  expect(first).toMatchObject({
    kind: 'candidate',
    candidate: { acquisition: 0 },
    binding: { rootOperationId: f.root.operationId, actorId: actor, teamId: f.team }
  });
  const a = (first as { candidate: { versionId: string; acquisition: number } }).candidate;
  const requestId = id(sequence++),
    rangeGrantId = id(sequence++),
    rangeInput = {
      versionId: a.versionId,
      acquisition: a.acquisition,
      requestId,
      rangeGrantId,
      offset: 0
    };
  const leaf = await call('range', rangeInput);
  expect(leaf).toMatchObject({
    purpose: 'restitch_screen_range_v1',
    requestId,
    grantId: rangeGrantId,
    offset: 0,
    bytes: 4,
    binding: { rootOperationId: f.root.operationId, actorId: actor }
  });
  expect(await call('range', rangeInput)).toEqual(leaf);
  expect(calls.filter(name => name === 'service_issue_restitch_control_screen_range')).toHaveLength(
    1
  );
  await expect(call('refresh', { ...rangeInput, refreshId: id(sequence++) })).rejects.toThrow(
    'WRONG_STATE'
  );
  expect(await call('abandon', { requestId, rangeGrantId })).toBe(true);
  // An expired original leaf is a test fixture, with the real immutable guards active.
  const expiredRequest = id(sequence++),
    expiredGrant = id(sequence++),
    refreshId = id(sequence++);
  const refreshBefore = await f.readSelection();
  const reserved = reserveScreenTransfer(refreshBefore.budget, a.versionId, expiredRequest, 0);
  expect(await f.change(refreshBefore.budget, reserved.state)).toBe(true);
  await db.root(
    `insert into private.restitch_screen_range_grants(id,root_operation_id,team_id,actor_id,slot,version_id,
    acquisition,request_id,executor_id,epoch,native_instance_id,token_hash,reservation,issued_at,expires_at)
    values($1,$2,$3,$4,'end',$5,0,$6,$7,$8,$9,$10,$11::jsonb,clock_timestamp()-interval '10 minutes',clock_timestamp()-interval '6 minutes')`,
    [
      expiredGrant,
      f.root.operationId,
      f.team,
      actor,
      a.versionId,
      expiredRequest,
      f.owned.executorId,
      f.owned.epoch,
      f.native,
      Buffer.alloc(32, 119),
      JSON.stringify(reserved.reservation)
    ]
  );
  await db.root(
    'insert into private.restitch_control_screen_ranges(range_grant_id,control_grant_id) values($1,$2)',
    [expiredGrant, f.grant]
  );
  const refreshInput = {
    versionId: a.versionId,
    acquisition: 0,
    requestId: expiredRequest,
    rangeGrantId: expiredGrant,
    refreshId
  };
  expect(await call('refresh', refreshInput)).toMatchObject({
    candidate: { versionId: a.versionId, acquisition: 0 }
  });
  expect(await call('refresh', refreshInput)).toMatchObject({
    candidate: { versionId: a.versionId }
  });
  expect(
    calls.filter(name => name === 'service_refresh_restitch_control_screen_range')
  ).toHaveLength(1);
  await expect(call('refresh', { ...refreshInput, refreshId: id(sequence++) })).rejects.toThrow(
    'REQUEST_REUSE_CONFLICT'
  );
  expect((await f.readSelection()).budget.refreshes).toEqual([
    { requestId: refreshId, candidateVersionId: a.versionId }
  ]);

  const cache = {
    refusedProtected: async () => [],
    resolveProtected: async (
      binding: ProtectedScreenCacheBinding,
      loader: { authorize: () => Promise<unknown> }
    ) => {
      await loader.authorize();
      if (binding.versionId === a.versionId)
        throw new ScreenCacheError('RESTITCH_SCREEN_UNSUPPORTED');
      return {
        slot: 'end' as const,
        id: binding.versionId,
        path: '/synthetic/validated-cache.png'
      };
    }
  };
  const provider = createNativeScreenRecoveryProvider({
    scope: (first as { binding: ProtectedScreenCacheBinding }).binding,
    call: async (action, body) => call(action, body),
    cache: cache as never,
    download: async () => {
      throw Error('Unexpected synthetic cache miss');
    },
    refresh: async () => {
      throw Error('Unexpected refresh');
    }
  });
  const resolved = await resolveScreensWithRecovery(
    ['end'],
    provider,
    new AbortController().signal
  );
  expect(resolved).toHaveLength(1);
  expect(resolved[0]!.id).not.toBe(a.versionId);
  const second = await call('next');
  const b = (second as { candidate: { versionId: string; acquisition: number } }).candidate;
  expect(b.versionId).not.toBe(a.versionId);
  await call('accept', { versionId: b.versionId, acquisition: b.acquisition });
  expect(await call('next')).toMatchObject({
    kind: 'candidate',
    candidate: { versionId: b.versionId }
  });
  const context = (
    await db.root<{
      value: {
        budget: {
          acceptedVersionId: string;
          candidates: Array<{ versionId: string; rejected: boolean }>;
        };
      };
    }>('select public.service_read_restitch_control_selection($1,$2,$3,true) value', [
      f.grant,
      f.ticket,
      'end'
    ])
  )[0]!.value;
  expect(context.budget.acceptedVersionId).toBe(b.versionId);
  expect(context.budget.candidates.find(c => c.versionId === a.versionId)?.rejected).toBe(true);
  expect(
    calls.every(
      name =>
        name === 'service_read_restitch_control_selection' ||
        name === 'service_cas_restitch_control_selection' ||
        name === 'service_read_restitch_control_screen_range_issue' ||
        name === 'service_issue_restitch_control_screen_range' ||
        name === 'service_read_restitch_selection_source_owned' ||
        name === 'service_abandon_restitch_control_screen_range' ||
        name === 'service_refresh_restitch_control_screen_range'
    )
  ).toBe(true);
  await db.root('delete from auth.sessions where id=$1', [f.session]);
  await expect(call('next')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
});

async function finishNativeFixture() {
  const f = await controlledRangeFixture(),
    nonce = id(sequence++);
  const finish = async (outcome = 'delivered', quiescence = nonce, claim = f.claimId) =>
    (
      await db.root<{ value: boolean }>(
        'select public.service_finish_restitch_native_control($1,$2,$3,$4,$5) value',
        [f.grant, f.ticket, claim, quiescence, outcome]
      )
    )[0]!.value;
  const state = async () =>
    (
      await db.root<{
        state: string;
        finished_at: string | null;
        executor_state: string;
        quiescence_id: string | null;
      }>(
        'select o.state,o.finished_at,e.state executor_state,c.quiescence_id from public.team_operations o join private.restitch_selection_executors e on e.root_operation_id=o.id join private.restitch_selection_executor_claims c on c.root_operation_id=o.id where o.id=$1 and c.claim_id=$2',
        [f.root.operationId, f.claimId]
      )
    )[0]!;
  return { ...f, nonce, finish, state };
}
it('atomically closes the native executor and logical delivered root with one original nonce', async () => {
  const f = await finishNativeFixture();
  await f.store.accept(f.version, 0);
  expect(await f.finish()).toBe(true);
  const state = await f.state();
  expect(state).toMatchObject({
    state: 'succeeded',
    executor_state: 'quiescent',
    quiescence_id: f.nonce,
    finished_at: expect.anything()
  });
  expect(await f.finish()).toBe(true);
  expect(await f.state()).toEqual(state);
  await expect(f.finish('failed')).rejects.toThrow('REQUEST_REUSE_CONFLICT');
  const acl = await db.root<{ browser: boolean; service: boolean }>(
    "select has_function_privilege('authenticated','public.service_finish_restitch_native_control(uuid,bytea,uuid,uuid,text)','execute') or has_function_privilege('anon','public.service_finish_restitch_native_control(uuid,bytea,uuid,uuid,text)','execute') browser,has_function_privilege('service_role','public.service_finish_restitch_native_control(uuid,bytea,uuid,uuid,text)','execute') service"
  );
  expect(acl[0]).toEqual({ browser: false, service: true });
  await expect(f.finish('delivered', id(sequence++))).rejects.toThrow('REQUEST_REUSE_CONFLICT');
});
it('keeps both native ownership and the logical root open if a range cost is still held', async () => {
  const f = await finishNativeFixture();
  await f.issueRange();
  await expect(f.finish('failed')).rejects.toThrow('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN');
  expect(await f.state()).toMatchObject({
    state: 'running',
    executor_state: 'owned',
    quiescence_id: null,
    finished_at: null
  });
});
it('allows exact failed native completion after logout without permitting new I/O', async () => {
  const f = await finishNativeFixture();
  await db.root('delete from auth.sessions where id=$1', [f.session]);
  expect(await f.finish('failed')).toBe(true);
  expect(await f.state()).toMatchObject({
    state: 'failed',
    executor_state: 'quiescent',
    quiescence_id: f.nonce
  });
  await expect(f.authorize()).rejects.toThrow('AUTH_REQUIRED');
});
it('preserves parent cancellation when an exact joined native closure arrives later', async () => {
  const f = await finishNativeFixture();
  await f.store.accept(f.version, 0);
  await db.asUser(actor, 'select public.cancel_team_operation($1,$2)', [
    f.team,
    f.root.operationId
  ]);
  expect(await f.finish('delivered')).toBe(true);
  expect(await f.state()).toMatchObject({
    state: 'canceled',
    executor_state: 'quiescent',
    quiescence_id: f.nonce
  });
});
it('refuses a delivered terminal unless every enabled frozen screen is accepted', async () => {
  const f = await finishNativeFixture();
  await expect(f.finish()).rejects.toThrow('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN');
  expect(await f.state()).toMatchObject({
    state: 'running',
    executor_state: 'owned',
    quiescence_id: null
  });
});

it('distinguishes images rejected in this attempt from remembered failures before the first draw', async () => {
  const token = 'r'.repeat(43),
    f = await controlSelectionFixture({ ticketHash: createHash('sha256').update(token).digest() });
  const service: ServiceRpcClient = {
    rpc: async (name, args) => {
      if (name === 'service_read_restitch_control_selection')
        return {
          data: await f.readSelection(
            args.p_active as boolean,
            Buffer.from(String(args.p_control_hash).slice(2), 'hex')
          ),
          error: null
        };
      if (name === 'service_cas_restitch_control_selection')
        return {
          data: await f.change(
            args.p_expected_budget as ReturnType<typeof createScreenSelectionBudget>,
            args.p_next_budget as ReturnType<typeof createScreenSelectionBudget>
          ),
          error: null
        };
      throw Error('Unexpected authority action');
    }
  };
  const call = (action: string, body: Record<string, unknown> = {}) =>
    handleRestitchNativeSelection(
      new Request('https://project.invalid/native-selection', {
        method: 'POST',
        headers: { 'x-restitch-control-ticket': token }
      }),
      action,
      { protocolVersion: 1, grantId: f.grant, slot: 'end', ...body },
      { service }
    );
  const version = (await f.readSelection()).candidates[0]!.versionId;
  expect(await call('next', { excludeVersions: [version] })).toMatchObject({
    kind: 'exhausted',
    reason: 'remembered'
  });
  expect((await f.readSelection()).budget.candidates).toHaveLength(0);
  expect(await call('next')).toMatchObject({
    kind: 'candidate',
    candidate: { versionId: version }
  });
  expect(await call('reject', { versionId: version, acquisition: 0, defect: 'unsupported' })).toBe(
    true
  );
  expect(await call('next', { excludeVersions: [version] })).toMatchObject({
    kind: 'exhausted',
    reason: 'unusable'
  });
});
