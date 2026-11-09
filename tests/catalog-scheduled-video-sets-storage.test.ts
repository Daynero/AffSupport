import { beforeAll, afterAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
let db: TeamTestDb, team: string, catalog: string, source: string;
const owner = 'c1720000-0000-4000-8000-000000000001';
beforeAll(async () => {
  db = await createTeamTestDb({
    throughMigration: '20261207175000_catalog_scheduled_video_sets.sql'
  });
  await db.root('create role variant_diagnostic_reader');
  await db.root('grant usage on schema public to variant_diagnostic_reader');
  await db.root(
    'grant select on public.analytics_catalog_video_sets,public.analytics_catalog_video_children,public.analytics_catalog_updater_video_requests to variant_diagnostic_reader'
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

it('normal Run freezes N and settings before legacy provider claim and adopts the SAME round', async () => {
  await db.root(
    'update public.team_catalog_update_profiles set video_variant_count=2 where catalog_material_id=$1',
    [catalog]
  );
  await db.asUser(owner, 'select public.run_team_catalog_update_now($1,array[$2]::uuid[])', [
    team,
    catalog
  ]);
  const snap = (
    await db.root<{
      attempt_id: string;
      requested_count: number;
      source_kind: string;
      product_count: number;
    }>('select *from private.catalog_variant_round_snapshots where catalog_material_id=$1', [
      catalog
    ])
  )[0]!;
  expect(snap).toMatchObject({ requested_count: 2, source_kind: 'updater', product_count: 3 });
  expect(
    await db.root("select *from public.service_claim_catalog_updater_items('legacy',1,60)")
  ).toHaveLength(0);
  await db.root(
    'update public.team_catalog_update_profiles set video_variant_count=1 where catalog_material_id=$1',
    [catalog]
  );
  const adopted = (
    await db.root<{ v: Record<string, unknown> }>(
      'select public.service_adopt_catalog_variant_round($1,$2,$3,$4)v',
      [team, owner, catalog, snap.attempt_id]
    )
  )[0]!.v;
  expect(adopted).toMatchObject({
    attempt_id: snap.attempt_id,
    request_id: snap.attempt_id,
    requested_count: 2
  });
  const reread = (
    await db.root<{ v: Record<string, unknown> }>(
      'select public.service_read_catalog_updater_variants($1,$2,$3,$4)v',
      [team, owner, catalog, snap.attempt_id]
    )
  )[0]!.v;
  expect(reread).toMatchObject({ requestedCount: 2, registeredCount: 0, state: 'accepted' });
  expect(
    await db.root('select *from public.service_claim_catalog_updater_items($1,1,60)', ['legacy'])
  ).toHaveLength(0);
  const recovery = (
    await db.root<{ v: Array<Record<string, unknown>> }>(
      'select public.service_list_catalog_variant_rounds(3)v'
    )
  )[0]!.v;
  expect(recovery).toEqual([]);
  await db.root(
    "update public.team_catalog_updater_items set next_attempt_at=clock_timestamp()-interval '1 second'where catalog_material_id=$1",
    [catalog]
  );
  expect(
    (
      await db.root<{ v: Array<Record<string, unknown>> }>(
        'select public.service_list_catalog_variant_rounds(3)v'
      )
    )[0]!.v
  ).toEqual([expect.objectContaining({ attemptId: snap.attempt_id })]);
  const generation = (
    await db.root<{ v: Record<string, unknown> }>(
      'select private.catalog_registry_video_generation($1,$2)v',
      [team, catalog]
    )
  )[0]!.v;
  expect(generation).toMatchObject({
    setId: adopted.set_id,
    requestedCount: 2,
    registeredCount: 0,
    state: 'accepted'
  });
});
it('releases only original ordinary stage and closes only after exact verified video delivery', async () => {
  const r = (
    await db.root<{
      request_id: string;
      attempt_id: string;
      set_id: string;
      executor_id: string;
      settings_snapshot: unknown;
      recipe_row_ids: string[];
      child_request_ids: string[];
      assignment_seed: string;
    }>('select *from private.catalog_updater_variant_requests where catalog_material_id=$1', [
      catalog
    ])
  )[0]!;
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
    r.child_request_ids.map((requestId, index) => ({ index, requestId })),
    r.recipe_row_ids.map((recipeRowId, index) => ({ recipeRowId, videoVariantIndex: index % 2 }))
  ]);
  expect(
    (
      await db.root<{ v: boolean }>(
        'select public.service_release_catalog_variant_regular($1,$2)v',
        [team, r.request_id]
      )
    )[0]!.v
  ).toBe(false);
  // Root fixture represents the independently verified output/checkpoint authority.
  await db.root("update private.catalog_video_sets set state='ready'where id=$1", [r.set_id]);
  await db.root(
    "select public.service_save_catalog_publication($1,$2,gen_random_uuid(),$3,0,'immediate',null,null,$4)",
    [team, owner, catalog, { kind: 'video_set', videoSetId: r.set_id, recipeRevision: 1 }]
  );
  await db.root(
    "update private.catalog_updater_variant_requests set publication_receipt='{}'where request_id=$1",
    [r.request_id]
  );
  expect(
    (
      await db.root<{ v: boolean }>(
        'select public.service_release_catalog_variant_regular($1,$2)v',
        [team, r.request_id]
      )
    )[0]!.v
  ).toBe(true);
  expect(
    await db.root("select *from public.service_claim_catalog_updater_items('ordinary',1,60)")
  ).toHaveLength(1);
  await db.root(
    "insert into private.catalog_video_deliveries(catalog_material_id,team_id,target_id,provider_revision,verified_at)select catalog_material_id,team_id,target_id,'verified',clock_timestamp()from private.catalog_video_publication_policies where catalog_material_id=$1",
    [catalog]
  );
  expect(
    (
      await db.root<{ v: number }>('select public.service_settle_catalog_variant_deliveries(3)v')
    )[0]!.v
  ).toBe(0);
  await db.root(
    'update private.catalog_variant_round_snapshots set regular_verified_at=clock_timestamp()where attempt_id=$1',
    [r.attempt_id]
  );
  // The manager-only lane retains its original held lease until final delivery;
  // final cleanup must never turn that verified success into user cancellation.
  await db.root(
    "update public.team_catalog_updater_items set lease_owner='catalog-variants:'||$2::text,lease_expires_at='infinity'where catalog_material_id=$1",
    [catalog, r.request_id]
  );
  expect(
    (
      await db.root<{ v: number }>('select public.service_settle_catalog_variant_deliveries(3)v')
    )[0]!.v
  ).toBe(1);
  expect(
    (
      await db.root<{ canceled_at: unknown }>(
        'select canceled_at from private.catalog_updater_variant_requests where request_id=$1',
        [r.request_id]
      )
    )[0]!.canceled_at
  ).toBeNull();
  expect(
    (
      await db.root<{ state: string }>('select state from private.catalog_video_sets where id=$1', [
        r.set_id
      ])
    )[0]!.state
  ).toBe('ready');
  expect(
    (
      await db.root<{ result: string }>(
        'select result from public.team_catalog_update_attempts where attempt_id=$1',
        [r.attempt_id]
      )
    )[0]!.result
  ).toBe('success');
  expect(
    await db.root("select *from public.service_claim_catalog_updater_items('ordinary-again',1,60)")
  ).toHaveLength(0);
});
it('policy-aware N=1 uses guarded generation while preserving frozen ordinary flags', async () => {
  await db.root(
    'update public.team_catalog_update_profiles set video_variant_count=1,refresh_images=true,refresh_texts=true,grow_products=true where catalog_material_id=$1',
    [catalog]
  );
  await db.asUser(owner, 'select public.run_team_catalog_update_now($1,array[$2]::uuid[])', [
    team,
    catalog
  ]);
  const s = (
    await db.root<{
      requested_count: number;
      product_count: number;
      profile_snapshot: Record<string, unknown>;
    }>(
      'select n.requested_count,n.product_count,a.profile_snapshot from private.catalog_variant_round_snapshots n join public.team_catalog_update_attempts a on a.attempt_id=n.attempt_id where n.catalog_material_id=$1 order by n.created_at desc limit 1',
      [catalog]
    )
  )[0]!;
  expect(s).toMatchObject({
    requested_count: 1,
    product_count: 4,
    profile_snapshot: {
      refreshImages: true,
      refreshTexts: true,
      growProducts: true,
      catalogVideoProtocolVersion: 1
    }
  });
  expect(
    await db.root("select *from public.service_claim_catalog_updater_items('legacy-one',1,60)")
  ).toHaveLength(0);
  const desired = (
    await db.root<{ v: Record<string, unknown> }>(
      'select private.catalog_registry_video_generation($1,$2)v',
      [team, catalog]
    )
  )[0]!.v;
  expect(desired).toMatchObject({ requestedCount: 1, registeredCount: 0, state: 'accepted' });
});
