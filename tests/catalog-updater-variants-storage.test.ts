import { getCatalogVideoSetEvidence } from '../scripts/analytics/catalog-video-sets';
import { assertReadOnlySql, setQueryExecutor } from '../scripts/analytics/db';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
let readyRequest: string, readyAttempt: string, readyOperation: string;
let db: TeamTestDb, team: string, catalog: string, source: string;
const owner = 'c1720000-0000-4000-8000-000000000001',
  request = 'c1720000-0000-4000-8000-000000000002';
beforeAll(async () => {
  db = await createTeamTestDb({
    throughMigration: '20261207173000_catalog_video_diagnostics.sql'
  });
  await db.root('create role variant_diagnostic_reader');
  await db.root('grant usage on schema public to variant_diagnostic_reader');
  await db.root(
    'grant select on public.analytics_catalog_video_sets,public.analytics_catalog_video_children,public.analytics_catalog_updater_video_requests,public.analytics_catalog_video_consumers to variant_diagnostic_reader'
  );
  await createUser(db, { id: owner, email: 'manager-variants@example.invalid' });
  await db.root('insert into public.admin_users(user_id)values($1)', [owner]);
  team = (
    await db.asUser<{ id: string }>(owner, "select id from public.create_team('Manager variants')")
  )[0]!.id;
  const cred = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(connected_by,google_permission_id,google_account_email,vault_secret_id,scope)values($1,'manager-variants','manager@example.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file')returning id",
      [owner]
    )
  )[0]!.id;
  const connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state)values($1,$2,'root','Root','my_drive','connected')returning id",
      [team, cred]
    )
  )[0]!.id;
  const material = async (video: boolean) =>
    (
      await db.root<{ id: string }>(
        "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,size_bytes,checksum,drive_version)values($1,$2,$3,$3,'file',$4,$5,4,$6,'1')returning id",
        [
          team,
          connection,
          video ? 'source' : 'sheet',
          video ? 'video' : 'other',
          video ? 'video/mp4' : 'application/vnd.google-apps.spreadsheet',
          'a'.repeat(32)
        ]
      )
    )[0]!.id;
  source = await material(true);
  catalog = await material(false);
  await db.root(
    "update public.team_materials set companion_of=$2,companion_kind='product_catalog'where id=$1",
    [catalog, source]
  );
  await db.root(
    "insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot)values($1,$2,$3,'https://example.invalid/',3,'https://docs.google.com/spreadsheets/d/fixture/edit','https://drive.google.com/file/d/source/view','{}')",
    [catalog, team, source]
  );
  await db.root(
    "insert into public.team_restitch_defaults(team_id,operation,start_image_ids,configured)values($1,'restitch',array[gen_random_uuid()],true)",
    [team]
  );
  await db.root(
    'insert into private.team_recovery_delegations(team_id,actor_id,installation_id,refresh_hash)values($1,$2,gen_random_uuid(),$3)',
    [team, owner, Buffer.alloc(32, 0xaa)]
  );
  await db.root(
    'insert into public.team_catalog_update_profiles(catalog_material_id,team_id,refresh_images,refresh_texts,grow_products,random_link_variation,restitch)values($1,$2,true,true,false,false,true)on conflict(catalog_material_id)do update set restitch=true',
    [catalog, team]
  );
}, 180000);
afterAll(async () => {
  await db?.close();
});
const admit = (count = 2) =>
  db.root<{ v: Record<string, unknown> }>(
    'select public.service_accept_catalog_updater_variants($1,$2,$3,$4,$5,(select version from public.team_catalog_update_profiles where catalog_material_id=$3))v',
    [team, owner, catalog, request, count]
  );
it('freezes N admission on the original updater attempt and fences legacy provider claims', async () => {
  const result = (await admit())[0]!.v;
  expect(result).toMatchObject({
    request_id: request,
    requested_count: 2,
    product_count: 3,
    catalog_material_id: catalog
  });
  expect(result.child_request_ids).toHaveLength(2);
  expect(result.recipe_row_ids).toHaveLength(3);
  const held = (
    await db.root<{ lease_owner: string; attempt: string }>(
      'select i.lease_owner,a.attempt_id attempt from public.team_catalog_updater_items i join public.team_catalog_update_attempts a on a.catalog_material_id=i.catalog_material_id and a.round_due_at=i.round_due_at where i.catalog_material_id=$1',
      [catalog]
    )
  )[0]!;
  expect(held.lease_owner).toBe('catalog-variants:' + request);
  expect(held.attempt).toBe(result.attempt_id);
  expect(
    await db.root('select * from public.service_claim_catalog_updater_items($1,1,300)', [
      'legacy-worker'
    ])
  ).toEqual([]);
  const replay = (
    await db.root<{ v: unknown }>(
      'select public.service_accept_catalog_updater_variants($1,$2,$3,$4,2,$5)v',
      [team, owner, catalog, request, Number(result.profile_version) - 1]
    )
  )[0]!.v;
  expect(replay).toEqual(result);
  await db.root(
    "select public.service_note_catalog_updater_variant_admission($1,$2,$3,'admitted','SOURCE_CHANGED')",
    [team, owner, request]
  );
  const status = (
    await db.root<{ v: unknown }>(
      'select public.service_read_catalog_updater_variants($1,$2,$3,$4)v',
      [team, owner, catalog, request]
    )
  )[0]!.v;
  expect(status).toMatchObject({ lastProvenStage: 'admitted', failureCode: 'SOURCE_CHANGED' });
});
it('cancel settles the exact original command and releases only its canonical held item', async () => {
  const receipt = (
    await db.root<{ v: unknown }>(
      'select public.service_cancel_catalog_updater_variants($1,$2,$3,$4)v',
      [team, owner, catalog, request]
    )
  )[0]!.v;
  expect(receipt).toMatchObject({
    requestId: request,
    state: 'canceled',
    requestedCount: 2,
    registeredCount: 0
  });
  expect(
    (
      await db.root<{ round_due_at: string | null }>(
        'select round_due_at from public.team_catalog_updater_items where catalog_material_id=$1',
        [catalog]
      )
    )[0]?.round_due_at ?? null
  ).toBeNull();
  expect(
    (
      await db.root<{ result: string }>(
        'select result from public.team_catalog_update_attempts where catalog_material_id=$1',
        [catalog]
      )
    )[0]!.result
  ).toBe('cancelled');
});

it('returns epoch milliseconds and bounded original admission attention evidence', async () => {
  await db.root(
    "select public.service_note_catalog_updater_variant_admission($1,$2,$3,'admitted','SOURCE_CHANGED')",
    [team, owner, request]
  );
  const receipt = (
    await db.root<{ v: { serverNow: unknown } }>(
      'select public.service_read_catalog_updater_variants($1,$2,$3,$4)v',
      [team, owner, catalog, request]
    )
  )[0]!.v;
  expect(typeof receipt.serverNow).toBe('number');
  await expect(
    db.root(
      "select public.service_note_catalog_updater_variant_admission($1,$2,$3,'admitted','https://private/token')",
      [team, owner, request]
    )
  ).rejects.toThrow('INVALID_INPUT');
});
it('resolves the exact original ready recipe row order without authorizing a catalog write', async () => {
  const originalTarget = (
    await db.root<{ v: string }>('select private.catalog_publication_source_version($1,$2)v', [
      source,
      team
    ])
  )[0]!.v;
  await db.root(
    "select public.service_save_catalog_publication($1,$2,gen_random_uuid(),$3,0,'immediate',null,null,$4)",
    [team, owner, catalog, { kind: 'source', materialId: source, sourceVersion: originalTarget }]
  );
  await db.root(
    "insert into private.catalog_video_deliveries(catalog_material_id,team_id,target_id,provider_revision,verified_at)select catalog_material_id,team_id,target_id,'fixture-original-delivery',clock_timestamp()from private.catalog_video_publication_policies where catalog_material_id=$1",
    [catalog]
  );
  await db.root(
    'update private.catalog_video_publication_policies set legacy_delivery_unverified=false where catalog_material_id=$1',
    [catalog]
  );
  await db.root(
    "update private.catalog_video_publication_jobs set state='published',provider_revision='fixture-original-delivery',verified_at=clock_timestamp()where catalog_material_id=$1",
    [catalog]
  );
  const oldDelivery = (
    await db.root<{ target_id: string }>(
      'select target_id from private.catalog_video_deliveries where catalog_material_id=$1',
      [catalog]
    )
  )[0]!.target_id;
  const nextRequest = crypto.randomUUID();
  readyRequest = nextRequest;
  const r = (
    await db.root<{ v: Record<string, unknown> }>(
      'select public.service_accept_catalog_updater_variants($1,$2,$3,$4,2,(select version from public.team_catalog_update_profiles where catalog_material_id=$3))v',
      [team, owner, catalog, nextRequest]
    )
  )[0]!.v;
  readyAttempt = r.attempt_id as string;
  const rowIds = r.recipe_row_ids as string[],
    childIds = r.child_request_ids as string[];
  await db.root('select public.service_accept_catalog_video_set($1,$2,$3,$4,$5,$6)', [
    team,
    owner,
    r.executor_id,
    {
      setId: r.set_id,
      catalogMaterialId: catalog,
      updateAttemptId: r.attempt_id,
      sourceMaterialId: source,
      sourceVersion: '1',
      settings: r.settings_snapshot,
      settingsDigest: 'b'.repeat(64),
      requestedCount: 2,
      productCount: 3,
      recipeRevision: 1,
      seed: r.assignment_seed
    },
    childIds.map((requestId, index) => ({ index, requestId })),
    rowIds.map((recipeRowId, index) => ({ recipeRowId, videoVariantIndex: index % 2 }))
  ]);
  const outputs = await db.root<{ id: string }>(
    "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,size_bytes,checksum,drive_version)select $1,m.connection_id,gen_random_uuid()::text,'Fixture','file','video','video/mp4',4,repeat('a',32),'1'from public.team_materials m cross join generate_series(1,2)where m.id=$2 returning id",
    [team, source]
  );
  const completed = [];
  for (const [index, output] of outputs.entries()) {
    const operationId = crypto.randomUUID();
    if (index === 0) readyOperation = operationId;
    await db.root(
      "insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,result_material_id,idempotency_key,request_nonce,finished_at)values($1,$2,$3,'process','succeeded',$4,$5,$6,$6,clock_timestamp())",
      [operationId, team, owner, source, output.id, 'catalog-variant:' + childIds[index]]
    );
    await db.root(
      "insert into private.team_operation_intents(operation_id,team_id,tool_id,expected_source_version,expected_source_drive_file_id,expected_source_checksum)values($1,$2,'restitch','1','source',repeat('a',32))",
      [operationId, team]
    );
    completed.push({
      index,
      requestId: childIds[index],
      operationId,
      state: 'registered',
      outputId: output.id
    });
  }
  const beforeProgress = (
    await db.root<{ n: number }>(
      "select count(*)::integer n from public.team_catalog_events where team_id=$1 and material_id=$2 and event_kind='sync_state'",
      [team, catalog]
    )
  )[0]!.n;
  await db.root('select public.service_checkpoint_catalog_video_set($1,$2,$3,$4,1,0,$5)', [
    r.set_id,
    team,
    owner,
    r.executor_id,
    completed
  ]);
  expect(
    (
      await db.root<{ n: number }>(
        "select count(*)::integer n from public.team_catalog_events where team_id=$1 and material_id=$2 and event_kind='sync_state'",
        [team, catalog]
      )
    )[0]!.n
  ).toBeGreaterThan(beforeProgress);
  const mapping = (
    await db.root<{ v: Array<{ ordinal: number; rowId: string; materialId: string }> }>(
      'select public.service_catalog_updater_variant_outputs($1,$2,$3)v',
      [team, owner, nextRequest]
    )
  )[0]!.v;
  expect(mapping.map(row => row.ordinal)).toEqual([1, 2, 3]);
  expect(mapping.map(row => row.rowId)).toEqual(rowIds);
  expect(mapping.map(row => row.materialId)).toEqual([
    outputs[0]!.id,
    outputs[1]!.id,
    outputs[0]!.id
  ]);
  await db.root('select public.service_attach_catalog_updater_variant_target($1,$2,$3)', [
    team,
    owner,
    nextRequest
  ]);
  expect(
    (
      await db.root<{ target_id: string }>(
        'select target_id from private.catalog_video_deliveries where catalog_material_id=$1',
        [catalog]
      )
    )[0]!.target_id
  ).toBe(oldDelivery);
  const status = (
    await db.root<{ v: unknown }>(
      'select public.service_read_catalog_updater_variants($1,$2,$3,$4)v',
      [team, owner, catalog, nextRequest]
    )
  )[0]!.v;
  expect(status).toMatchObject({
    state: 'ready',
    publicationState: 'blocked',
    publicationBlockedReason: 'writer_unsupported'
  });
});

it('diagnoses original command attention and proved child operations through SELECT-only CLI views', async () => {
  await db.root('grant usage on schema public to variant_diagnostic_reader');
  await db.root(
    'grant select on public.analytics_catalog_video_sets,public.analytics_catalog_video_children,public.analytics_catalog_updater_video_requests,public.analytics_catalog_video_consumers to variant_diagnostic_reader'
  );
  setQueryExecutor(async (sql, params) => {
    assertReadOnlySql(sql);
    await db.db.exec('begin read only;set local role variant_diagnostic_reader');
    try {
      return (await db.db.query(sql, params)).rows as Record<string, unknown>[];
    } finally {
      await db.db.exec('rollback');
    }
  });
  try {
    const missing = await getCatalogVideoSetEvidence(request);
    expect(missing.status).toBe('available');
    expect(missing.missing_sources).toEqual([]);
    expect(missing.commands[0]).toMatchObject({
      request_id: request,
      set_admission_missing: true,
      failure_observed: true,
      safe_failure_code: 'SOURCE_CHANGED',
      last_proven_stage: 'admitted'
    });
    const settled = await getCatalogVideoSetEvidence(readyAttempt);
    expect(settled.records[0]).toMatchObject({
      state: 'ready',
      requested_count: 2,
      registered_count: 2,
      update_attempt_id: readyAttempt
    });
    expect(settled.children).toContainEqual(
      expect.objectContaining({ operation_id: readyOperation, registration_chain: 'proved' })
    );
    expect(settled.commands[0]?.request_id).toBe(readyRequest);
    const operation = await getCatalogVideoSetEvidence(readyOperation);
    expect(operation.records).toHaveLength(1);
    expect(settled.browser_delivery).toBe('not_joined');
    expect(JSON.stringify(settled)).not.toMatch(/https?:|credential|file_id|checksum/);
  } finally {
    setQueryExecutor(null);
  }
});

it('cancel holds only the original pending target while retaining the verified old delivery', async () => {
  await db.root('select public.service_cancel_catalog_updater_variants($1,$2,$3,$4)', [
    team,
    owner,
    catalog,
    readyRequest
  ]);
  expect(
    (
      await db.root<{ mode: string }>(
        'select mode from private.catalog_video_publication_policies where catalog_material_id=$1',
        [catalog]
      )
    )[0]!.mode
  ).toBe('held');
  expect(
    (
      await db.root<{ provider_revision: string }>(
        'select provider_revision from private.catalog_video_deliveries where catalog_material_id=$1',
        [catalog]
      )
    )[0]!.provider_revision
  ).toBe('fixture-original-delivery');
});
it('seeds accepted initial N into the manager profile and exposes it without changing other flags', async () => {
  const before = (
    await db.root<{ refresh_images: boolean; restitch: boolean }>(
      'select refresh_images,restitch from public.team_catalog_update_profiles where catalog_material_id=$1',
      [catalog]
    )
  )[0]!;
  const intent = (
    await db.root<{ v: { id: string } }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,gen_random_uuid())v',
      [
        team,
        source,
        owner,
        'product-catalog:' + crypto.randomUUID(),
        { catalogVideoProtocolVersion: 1, videoVariationCount: 3 }
      ]
    )
  )[0]!.v.id;
  await db.root(
    "update private.catalog_generation_intents set checkpoint=checkpoint||jsonb_build_object('materialId',$2::uuid),state='registered'where id=$1",
    [intent, catalog]
  );
  const profile = (
    await db.asUser<{ video_variant_count: number; refresh_images: boolean; restitch: boolean }>(
      owner,
      'select *from public.list_team_catalog_update_profiles($1)where catalog_material_id=$2',
      [team, catalog]
    )
  )[0]!;
  expect(profile.video_variant_count).toBe(3);
  expect(profile.refresh_images).toBe(before.refresh_images);
  expect(profile.restitch).toBe(before.restitch);
});
it('an actually empty Drive pool preserves its known pre-set cause through admission and the SELECT-only CLI', async () => {
  const { startCatalogUpdaterVariants } =
    await import('../supabase/functions/drive-ops/updater-variants');
  await db.root("update public.team_restitch_defaults set source_mode='drive'where team_id=$1", [
    team
  ]);
  const version = (
      await db.root<{ version: number }>(
        'select version from public.team_catalog_update_profiles where catalog_material_id=$1',
        [catalog]
      )
    )[0]!.version,
    newRequest = crypto.randomUUID();
  const rpc = async (name: string, args: Record<string, unknown>) => {
    try {
      const keys = Object.keys(args);
      if (!/^service_[a-z_]+$/.test(name) || keys.some(key => !/^p_[a-z_]+$/.test(key)))
        throw Error('unexpected synthetic RPC');
      const rows = await db.root<{ value: unknown }>(
        `select public.${name}(${keys.map((key, index) => `${key}=>$${index + 1}`).join(',')})value`,
        keys.map(key => args[key])
      );
      return { data: rows[0]?.value ?? null, error: null };
    } catch (error) {
      return {
        data: null,
        error: { message: error instanceof Error ? error.message : 'PROCESS_RESULT_UNCERTAIN' }
      };
    }
  };
  const live = {
    id: 'source',
    parents: ['root'],
    trashed: false,
    shortcutTargetId: null,
    version: '1',
    checksum: 'a'.repeat(32),
    size: 4,
    mimeType: 'video/mp4',
    capabilities: { canDownload: true }
  };
  await expect(
    startCatalogUpdaterVariants(
      { rpc },
      {
        teamId: team,
        actorId: owner,
        catalogMaterialId: catalog,
        requestId: newRequest,
        requestedCount: 1,
        profileVersion: version
      },
      async () =>
        ({
          getFile: async () => live
        }) as unknown as import('../supabase/functions/_shared/drive').GoogleDriveClient
    )
  ).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
  setQueryExecutor(async (sql, params) => {
    assertReadOnlySql(sql);
    await db.db.exec('begin read only;set local role variant_diagnostic_reader');
    try {
      return (await db.db.query(sql, params)).rows as Record<string, unknown>[];
    } finally {
      await db.db.exec('rollback');
    }
  });
  try {
    const evidence = await getCatalogVideoSetEvidence(newRequest);
    expect(evidence.status).toBe('available');
    expect(evidence.commands[0]).toMatchObject({
      set_admission_missing: true,
      failure_observed: true,
      safe_failure_code: 'RESTITCH_NO_SCREENS',
      last_proven_stage: 'source_proven'
    });
  } finally {
    setQueryExecutor(null);
  }
});
