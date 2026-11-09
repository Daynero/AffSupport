import { beforeAll, afterAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import {
  prepareCatalogVideoRestitchAlias,
  enrollCatalogVideoRestitchControl
} from '../supabase/functions/drive-ops/catalog-video-restitch-alias';
import type { ServiceRpcClient } from '../supabase/functions/_shared/credentials';
const id = (n: number) => 'c1700000-0000-4000-8000-' + String(n).padStart(12, '0');
let db: TeamTestDb;
const owner = id(1),
  executor = id(2),
  native = id(3),
  set = id(4),
  source = id(5),
  image = id(6),
  request = id(7),
  operation = id(8),
  delegation = id(9);
let team: string, connection: string;
const defaults = {
  configured: true,
  operation: 'restitch',
  sourceMode: 'drive',
  fitMode: 'cover',
  startDurationMode: 'one-frame',
  customStartDurationMs: 1,
  startEnabled: false,
  endEnabled: true,
  finalDurationMode: 'random-centered',
  finalDurationRangeSeconds: [600, 660],
  customFinalDurationSeconds: 2700
};
const scope = {
  setId: set,
  claimHash: '\\x' + 'a'.repeat(64),
  nativeInstanceId: native,
  protocolVersion: 1 as const
};
const child = () => ({
  index: 0,
  requestId: request,
  operationId: operation,
  teamId: team,
  actorId: owner,
  materialId: source,
  sourceVersion: '1',
  settingsDigest: 'b'.repeat(64)
});
const service: ServiceRpcClient = {
  rpc: async (name, args) => {
    const parameters = [
      args.p_set,
      Buffer.from(String(args.p_hash).slice(2), 'hex'),
      args.p_native,
      args.p_protocol,
      args.p_index,
      args.p_request,
      args.p_operation
    ];
    let sql = 'select public.service_accept_catalog_video_restitch_alias($1,$2,$3,$4,$5,$6,$7) v';
    if (name === 'service_issue_catalog_video_restitch_control') {
      sql =
        'select public.service_issue_catalog_video_restitch_control($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) v';
      parameters.push(
        args.p_grant,
        args.p_enrollment,
        Buffer.from(String(args.p_proof_hash).slice(2), 'hex'),
        Buffer.from(String(args.p_ticket_hash).slice(2), 'hex')
      );
    } else if (name !== 'service_accept_catalog_video_restitch_alias')
      throw Error('unexpected RPC');
    const rows = await db.root<{ v: unknown }>(sql, parameters);
    return { data: rows[0]!.v, error: null };
  }
};

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, {
    id: owner,
    email: 'alias@synthetic.invalid',
    displayName: 'Synthetic alias'
  });
  await db.root('insert into public.admin_users(user_id) values($1)', [owner]);
  team = (
    await db.asUser<{ id: string }>(owner, 'select id from public.create_team($1)', [
      'Synthetic alias'
    ])
  )[0]!.id;
  const credential = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values($1,'synthetic-alias','alias@synthetic.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file') returning id",
      [owner]
    )
  )[0]!.id;
  connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state) values($1,$2,'alias-root','Synthetic root','my_drive','connected') returning id",
      [team, credential]
    )
  )[0]!.id;
  await db.root(
    "insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum,drive_version) values($1,$3,$4,$1::uuid::text,'alias-root','Source.mp4','file','video','video/mp4',4,$5,'1'),($2,$3,$4,$2::uuid::text,'alias-root','Screen.png','file','image','image/png',4,$5,'1')",
    [source, image, team, connection, 'a'.repeat(32)]
  );
  await db.root(
    "insert into public.team_restitch_sources(team_id,slot,material_id,kind,sort_order,added_by) values($1,'end',$2,'file',1,$3)",
    [team, image, owner]
  );
  const intent = (
    await db.root<{ v: { id: string } }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6) v',
      [team, source, owner, 'alias:catalog:original', {}, executor]
    )
  )[0]!.v.id;
  await db.root('select public.service_accept_catalog_video_set($1,$2,$3,$4,$5,$6)', [
    team,
    owner,
    executor,
    {
      setId: set,
      catalogIntentId: intent,
      sourceMaterialId: source,
      sourceVersion: '1',
      settings: defaults,
      settingsDigest: 'b'.repeat(64),
      requestedCount: 1,
      productCount: 1,
      recipeRevision: 1,
      seed: 'c'.repeat(64)
    },
    [{ index: 0, requestId: request }],
    [{ recipeRowId: id(10), videoVariantIndex: 0 }]
  ]);
  await db.root(
    "insert into private.team_recovery_delegations(id,team_id,actor_id,installation_id,refresh_hash) values($1,$2,$3,$4,decode(repeat('bb',32),'hex'))",
    [delegation, team, owner, executor]
  );
  // A real scoped claim credential exercises the canonical authorize_claim path.
  await db.root(
    "insert into private.team_recovery_credentials(hash,delegation_id,version,audience,expires_at) values(decode(repeat('aa',32),'hex'),$1,1,'claim',clock_timestamp()+interval '1 hour')",
    [delegation]
  );
  await db.root(
    "insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce) values($1,$2,$3,'process','running',$4,$5,$5)",
    [operation, team, owner, source, 'catalog-variant:' + request]
  );
  await db.root(
    "insert into private.team_operation_intents(operation_id,team_id,tool_id,expected_source_version,expected_source_drive_file_id,expected_source_checksum) values($1,$2,'restitch','1',$3,$4)",
    [operation, team, source, 'a'.repeat(32)]
  );
  await db.root(
    "update private.catalog_video_variants set state='working',operation_id=$2 where video_set_id=$1",
    [set, operation]
  );
}, 60000);
afterAll(async () => {
  await db?.close();
});
it('captures the original pool at acceptance and exposes only service-owned authority', async () => {
  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::integer n from private.catalog_video_restitch_candidates where video_set_id=$1',
        [set]
      )
    )[0]!.n
  ).toBe(1);
  await db.root('set role authenticated');
  try {
    await expect(db.root('select * from private.catalog_video_restitch_contexts')).rejects.toThrow(
      /permission denied/i
    );
  } finally {
    await db.root('reset role');
  }
});
it('samples child defaults once and retains frozen candidates after pool edits', async () => {
  await db.root('delete from public.team_restitch_sources where team_id=$1', [team]);
  const first = await prepareCatalogVideoRestitchAlias(service, scope, child());
  const second = await prepareCatalogVideoRestitchAlias(service, scope, child());
  expect(first.recipe.logicalKind).toBe('process');
  expect(first.recipe.defaults.customFinalDurationSeconds).toBeGreaterThanOrEqual(600);
  expect(first.recipe.defaults.customFinalDurationSeconds).toBeLessThanOrEqual(660);
  expect(first.recipe.defaults).toEqual(second.recipe.defaults);
  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::integer n from private.restitch_selection_candidates where root_operation_id=$1',
        [operation]
      )
    )[0]!.n
  ).toBe(1);
  expect(second.reused).toBe(true);
});
it('rejects a different native boot without adopting the original alias', async () => {
  await expect(
    prepareCatalogVideoRestitchAlias(service, { ...scope, nativeInstanceId: id(99) }, child())
  ).rejects.toThrow();
});

it('reports a chosen screen picture that is gone as unavailable, not as uncertain accounting', async () => {
  // 188 / beta 2026-11-09: the picture sat on a disconnected Google Drive; the launch said
  // "could not confirm the picture upload" and never explained what to fix.
  const intent = (
    await db.root<{ v: { id: string } }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6) v',
      [team, source, owner, 'alias:catalog:gone-screen', {}, executor]
    )
  )[0]!.v.id;
  const gone = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum,drive_version,lifecycle,missing_at,missing_reason) values($1,$2,'synthetic-gone-screen','alias-root','Gone.png','file','image','image/png',4,$3,'1','missing',now(),'removed') returning id",
      [team, connection, 'd'.repeat(32)]
    )
  )[0]!.id;
  await db.root(
    "insert into public.team_restitch_sources(team_id,slot,material_id,kind,sort_order,added_by) values($1,'end',$2,'file',1,$3)",
    [team, gone, owner]
  );
  try {
    await expect(
      db.root('select public.service_accept_catalog_video_set($1,$2,$3,$4,$5,$6)', [
        team,
        owner,
        executor,
        {
          setId: id(40),
          catalogIntentId: intent,
          sourceMaterialId: source,
          sourceVersion: '1',
          settings: defaults,
          settingsDigest: 'b'.repeat(64),
          requestedCount: 1,
          productCount: 1,
          recipeRevision: 1,
          seed: 'c'.repeat(64)
        },
        [{ index: 0, requestId: id(41) }],
        [{ recipeRowId: id(42), videoVariantIndex: 0 }]
      ])
    ).rejects.toThrow('RESTITCH_SOURCES_INVALID');
  } finally {
    await db.root('delete from public.team_restitch_sources where team_id=$1', [team]);
  }
});

it('distinguishes a definitely empty pool from an unobservable pool at new admission', async () => {
  const intent = (
    await db.root<{ v: { id: string } }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6) v',
      [team, source, owner, 'alias:catalog:missing-pool', {}, executor]
    )
  )[0]!.v.id;
  const accept = () =>
    db.root('select public.service_accept_catalog_video_set($1,$2,$3,$4,$5,$6)', [
      team,
      owner,
      executor,
      {
        setId: id(30),
        catalogIntentId: intent,
        sourceMaterialId: source,
        sourceVersion: '1',
        settings: defaults,
        settingsDigest: 'b'.repeat(64),
        requestedCount: 1,
        productCount: 1,
        recipeRevision: 1,
        seed: 'c'.repeat(64)
      },
      [{ index: 0, requestId: id(31) }],
      [{ recipeRowId: id(32), videoVariantIndex: 0 }]
    ]);
  await expect(accept()).rejects.toThrow('RESTITCH_NO_SCREENS');
  await db.root(
    "insert into public.team_restitch_sources(team_id,slot,drive_file_id,kind,sort_order,added_by) values($1,'end','synthetic-unindexed-folder','folder',1,$2)",
    [team, owner]
  );
  try {
    await expect(accept()).rejects.toThrow('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN');
  } finally {
    await db.root('delete from public.team_restitch_sources where team_id=$1', [team]);
  }
  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::integer n from private.catalog_video_sets where id=$1',
        [id(30)]
      )
    )[0]!.n
  ).toBe(0);
});
it('retains strict process raw source-version policy for new I/O', async () => {
  await db.root("update public.team_materials set drive_version='2' where id=$1", [source]);
  try {
    await expect(
      db.root('select private.require_restitch_executor($1,$2,$3,null,null,true)', [
        operation,
        team,
        owner
      ])
    ).rejects.toThrow('RESTITCH_SOURCES_INVALID');
  } finally {
    await db.root("update public.team_materials set drive_version='1' where id=$1", [source]);
  }
});
const enrollment = id(20),
  claim = id(21),
  secret = 'synthetic-service-secret-never-a-production-key';
let ticketHash: Buffer;
it('enrolls and redeems a delegated process control without a browser session', async () => {
  const receipt = await enrollCatalogVideoRestitchControl(service, secret, scope, child(), {
    rootOperationId: operation,
    teamId: team,
    actorId: owner,
    nativeInstanceId: native,
    enrollmentId: enrollment,
    proofDigest: 'd'.repeat(64)
  });
  expect(receipt.rootOperationId).toBe(operation);
  expect(JSON.stringify(receipt)).not.toContain('token');
  const row = (
    await db.root<{
      auth_mode: string;
      session_id: null;
      proof_hash: Uint8Array;
      token_hash: Uint8Array;
    }>(
      'select auth_mode,session_id,proof_hash,token_hash from private.restitch_native_controls where id=$1',
      [enrollment]
    )
  )[0]!;
  expect(row.auth_mode).toBe('catalog_process');
  expect(row.session_id).toBeNull();
  ticketHash = Buffer.from(row.token_hash);
  await db.root('select public.service_redeem_restitch_native_control($1,$2)', [
    enrollment,
    row.proof_hash
  ]);
  const owned = (
    await db.root<{ v: { active: boolean } }>(
      'select public.service_claim_restitch_native_control($1,$2,$3,1) v',
      [enrollment, ticketHash, claim]
    )
  )[0]!.v;
  expect(owned.active).toBe(true);
});
it('revoked delegation stops new I/O while preserving exact historical control reads', async () => {
  await db.root(
    'update private.team_recovery_delegations set revoked_at=clock_timestamp() where id=$1',
    [delegation]
  );
  try {
    await expect(
      db.root('select public.service_authorize_restitch_native_control($1,$2)', [
        enrollment,
        ticketHash
      ])
    ).rejects.toThrow('AUTH_REQUIRED');
    expect(
      (
        await db.root<{ v: { claimId: string } }>(
          'select public.service_read_restitch_native_control_claim($1,$2,$3) v',
          [enrollment, ticketHash, claim]
        )
      )[0]!.v.claimId
    ).toBe(claim);
  } finally {
    await db.root('update private.team_recovery_delegations set revoked_at=null where id=$1', [
      delegation
    ]);
  }
});
it('does not finish a process before canonical upload/finalization is terminal', async () => {
  await expect(
    db.root('select public.service_finish_restitch_native_control($1,$2,$3,$4,$5)', [
      enrollment,
      ticketHash,
      claim,
      id(22),
      'delivered'
    ])
  ).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
  expect(
    (
      await db.root<{ state: string }>('select state from public.team_operations where id=$1', [
        operation
      ])
    )[0]!.state
  ).toBe('running');
});
it('blocks new I/O after parent cancellation but retains exact late control read and closure', async () => {
  await db.root("update private.catalog_video_sets set state='cancel_requested' where id=$1", [
    set
  ]);
  await expect(
    db.root('select public.service_authorize_restitch_native_control($1,$2)', [
      enrollment,
      ticketHash
    ])
  ).rejects.toThrow('WRONG_STATE');
  expect(
    (
      await db.root<{ v: { claimId: string } }>(
        'select public.service_read_restitch_native_control_claim($1,$2,$3) v',
        [enrollment, ticketHash, claim]
      )
    )[0]!.v.claimId
  ).toBe(claim);
  await db.root(
    "update public.team_operations set state='canceled',finished_at=clock_timestamp() where id=$1",
    [operation]
  );
  expect(
    (
      await db.root<{ v: boolean }>(
        'select public.service_finish_restitch_native_control($1,$2,$3,$4,$5) v',
        [enrollment, ticketHash, claim, id(22), 'canceled']
      )
    )[0]!.v
  ).toBe(true);
  expect(
    (
      await db.root<{ state: string }>('select state from public.team_operations where id=$1', [
        operation
      ])
    )[0]!.state
  ).toBe('canceled');
});

it('refuses a partial server descriptor before exposing sampled execution defaults', async () => {
  const partial: ServiceRpcClient = {
    rpc: async () => ({
      data: { operationId: operation, teamId: team, actorId: owner, recipe: { defaults } },
      error: null
    })
  };
  await expect(prepareCatalogVideoRestitchAlias(partial, scope, child())).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
});
it('keeps the task cleanup material-reference fence inventory complete', async () => {
  const uncovered = await db.root(
    "select t.* from private.task_cleanup_reference_tables() t where not exists(select 1 from pg_catalog.pg_trigger tr join pg_catalog.pg_class c on c.oid=tr.tgrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname=t.schema_name and c.relname=t.table_name and tr.tgname='task_cleanup_reference_fence' and tr.tgenabled<>'D')"
  );
  expect(uncovered).toEqual([]);
});
it('honors the accepted centered duration range and refuses malformed bounds', async () => {
  const settings = {
    ...defaults,
    finalDurationMode: 'random-centered',
    customFinalDurationSeconds: 2700,
    finalDurationRangeSeconds: [600, 660]
  };
  const sample = async (draw: number) =>
    (
      await db.root<{ v: { customFinalDurationSeconds: number } }>(
        'select private.freeze_restitch_selection_defaults($1,$2) v',
        [settings, draw]
      )
    )[0]!.v.customFinalDurationSeconds;
  expect(await sample(0)).toBe(600);
  expect(await sample(1)).toBe(660);
  await expect(
    db.root('select private.freeze_restitch_selection_defaults($1,0.5)', [
      { ...settings, finalDurationRangeSeconds: [660, 600] }
    ])
  ).rejects.toThrow('RESTITCH_INVALID');
});
it('preserves canonical legacy image mode without fabricating a Drive alias', async () => {
  const intent = (
    await db.root<{ v: { id: string } }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6) v',
      [team, source, owner, 'alias:catalog:legacy-mode', {}, executor]
    )
  )[0]!.v.id;
  const legacySet = id(70);
  await db.root('select public.service_accept_catalog_video_set($1,$2,$3,$4,$5,$6)', [
    team,
    owner,
    executor,
    {
      setId: legacySet,
      catalogIntentId: intent,
      sourceMaterialId: source,
      sourceVersion: '1',
      settings: { ...defaults, sourceMode: 'legacy', endImageIds: [id(73)] },
      settingsDigest: 'b'.repeat(64),
      requestedCount: 1,
      productCount: 1,
      recipeRevision: 1,
      seed: 'c'.repeat(64)
    },
    [{ index: 0, requestId: id(71) }],
    [{ recipeRowId: id(72), videoVariantIndex: 0 }]
  ]);
  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::integer n from private.catalog_video_restitch_contexts where video_set_id=$1',
        [legacySet]
      )
    )[0]!.n
  ).toBe(0);
  expect(
    (
      await db.root<{ mode: string }>(
        "select settings_snapshot->>'sourceMode' mode from private.catalog_video_sets where id=$1",
        [legacySet]
      )
    )[0]!.mode
  ).toBe('legacy');
});
