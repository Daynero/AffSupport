import { readFileSync } from 'node:fs';
import { getCatalogGrowthEvidence } from '../scripts/analytics/catalog-growth';
import { assertReadOnlySql, setQueryExecutor } from '../scripts/analytics/db';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
let db: TeamTestDb, team: string, catalog: string, source: string;
const owner = 'c1720000-0000-4000-8000-000000000001';
beforeAll(async () => {
  db = await createTeamTestDb({
    throughMigration: '20261207177000_catalog_nonvideo_preservation.sql'
  });
  await db.root(
    "do $$begin if not exists(select 1 from pg_roles where rolname='wishly_analytics_ro')then create role wishly_analytics_ro;end if;end$$"
  );
  await db.root('grant usage on schema public to wishly_analytics_ro');
  await db.db.exec(
    readFileSync(
      new URL(
        '../supabase/migrations/20261207178000_catalog_growth_video_recipes.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
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

it('freezes source-only growth on the same attempt and keeps policy held until verified ordinary readback', async () => {
  const sourceVersion = (
    await db.root<{ v: string }>('select private.catalog_publication_source_version($1,$2)v', [
      source,
      team
    ])
  )[0]!.v;
  await db.root(
    "select public.service_save_catalog_publication($1,$2,gen_random_uuid(),$3,0,'held',null,null,$4)",
    [team, owner, catalog, { kind: 'source', materialId: source, sourceVersion }]
  );
  await db.root(
    'update public.team_catalog_update_profiles set restitch=false,grow_products=true where catalog_material_id=$1',
    [catalog]
  );
  await db.asUser(owner, 'select public.run_team_catalog_update_now($1,array[$2]::uuid[])', [
    team,
    catalog
  ]);
  expect(
    await db.root("select *from public.service_claim_catalog_updater_items('growth',1,60)")
  ).toHaveLength(1);
  const ctx = (
    await db.root<{ v: Record<string, unknown> }>(
      'select public.service_prepare_catalog_nonvideo_update_context($1,$2)v',
      [catalog, 'growth']
    )
  )[0]!.v;
  expect(ctx).toMatchObject({ currentProductCount: 3, productCount: 4 });
  const ids = ctx.recipeRowIds as string[];
  expect(ids).toHaveLength(4);
  const policy = () =>
    db.root<{ revision: number; mode: string }>(
      'select revision,mode from private.catalog_video_publication_policies where catalog_material_id=$1',
      [catalog]
    );
  expect((await policy())[0]).toMatchObject({ revision: 1, mode: 'held' });
  expect(
    (
      await db.root<{ v: Record<string, unknown> }>(
        'select public.service_prepare_catalog_nonvideo_update_context($1,$2)v',
        [catalog, 'growth']
      )
    )[0]!.v
  ).toEqual(ctx);
  expect(
    await db.root('select *from public.team_operations where team_id=$1', [team])
  ).toHaveLength(0);
  const marker = crypto.randomUUID();
  const settings = { _catalogRecipeRowIds: ids, _catalogPublicIds: ['a', 'b', 'c', 'd'], rows: [] };
  expect(
    (
      await db.root<{ v: boolean }>(
        'select public.service_begin_catalog_nonvideo_update_write($1,$2,$3,$4,1,4,$5,$6)v',
        [catalog, 'growth', marker, '1', settings, ctx.contextToken]
      )
    )[0]!.v
  ).toBe(true);
  expect((await policy())[0]).toMatchObject({ revision: 1, mode: 'held' });
  expect(
    (
      await db.root<{ v: boolean }>(
        'select public.service_complete_catalog_update($1,$2,1,null,4,$3)v',
        [catalog, 'growth', settings]
      )
    )[0]!.v
  ).toBe(true);
  await db.root('select public.service_finish_catalog_update_write($1)', [catalog]);
  expect((await policy())[0]).toMatchObject({ revision: 2, mode: 'held' });
  expect(
    (
      await db.root<{ product_count: number }>(
        'select product_count from public.team_product_catalogs where material_id=$1',
        [catalog]
      )
    )[0]!.product_count
  ).toBe(4);
  expect(
    (
      await db.root<{ applied_at: unknown }>(
        'select applied_at from private.catalog_growth_video_recipes where catalog_material_id=$1',
        [catalog]
      )
    )[0]!.applied_at
  ).not.toBeNull();
  expect(
    await db.root('select *from public.team_operations where team_id=$1', [team])
  ).toHaveLength(0);
});
it('grows an already READY set by one balanced row without rendering media or changing held policy early', async () => {
  const original = (
    await db.root<{ attempt_id: string }>(
      'select attempt_id from private.catalog_growth_video_recipes where catalog_material_id=$1',
      [catalog]
    )
  )[0]!.attempt_id;
  const setId = crypto.randomUUID(),
    rowIds = Array.from({ length: 4 }, () => crypto.randomUUID());
  await db.root(
    'insert into private.catalog_video_sets(id,team_id,actor_id,catalog_material_id,update_attempt_id,source_material_id,source_version,settings_snapshot,settings_digest,requested_count,product_count,recipe_revision,assignment_seed,assignment_version,state)values($1,$2,$3,$4,$5,$6,\'1\',\'{"configured":true,"operation":"restitch","sourceMode":"legacy"}\',repeat(\'b\',64),2,4,1,repeat(\'a\',64),1,\'ready\')',
    [setId, team, owner, catalog, original, source]
  );
  const copy = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,size_bytes,checksum,drive_version)select team_id,connection_id,'existing-ready-copy','Ready','file','video','video/mp4',4,checksum,'1'from public.team_materials where id=$1 returning id",
      [source]
    )
  )[0]!.id;
  for (const [index, material] of [source, copy].entries()) {
    const operation = crypto.randomUUID();
    await db.root(
      "insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,result_material_id,idempotency_key,request_nonce,finished_at)values($1,$2,$3,'process','succeeded',$4,$5,$1::uuid::text,$1::uuid::text,clock_timestamp())",
      [operation, team, owner, source, material]
    );
    await db.root(
      "insert into private.team_operation_intents(operation_id,team_id,tool_id,expected_source_version)values($1,$2,'restitch','1')",
      [operation, team]
    );
    await db.root(
      "insert into private.catalog_video_variants(video_set_id,team_id,video_variant_index,request_id,operation_id,state,output_material_id)values($1,$2,$3,gen_random_uuid(),$4,'registered',$5)",
      [setId, team, index, operation, material]
    );
  }
  for (const [index, row] of rowIds.entries())
    await db.root(
      'insert into private.catalog_video_assignments(video_set_id,team_id,recipe_revision,recipe_row_id,video_variant_index)values($1,$2,1,$3,$4)',
      [setId, team, row, index % 2]
    );
  await db.root(
    "update public.team_product_catalogs set settings_snapshot=settings_snapshot||jsonb_build_object('_catalogRecipeRowIds',$2::jsonb)where material_id=$1",
    [catalog, rowIds]
  );
  await db.root(
    "select public.service_save_catalog_publication($1,$2,gen_random_uuid(),$3,2,'held',null,null,$4)",
    [team, owner, catalog, { kind: 'video_set', videoSetId: setId, recipeRevision: 1 }]
  );
  await db.asUser(owner, 'select public.run_team_catalog_update_now($1,array[$2]::uuid[])', [
    team,
    catalog
  ]);
  expect(
    await db.root("select *from public.service_claim_catalog_updater_items('growth-ready',1,60)")
  ).toHaveLength(1);
  const ctx = (
    await db.root<{ v: Record<string, unknown> }>(
      'select public.service_prepare_catalog_nonvideo_update_context($1,$2)v',
      [catalog, 'growth-ready']
    )
  )[0]!.v;
  expect(ctx).toMatchObject({ currentProductCount: 4, productCount: 5 });
  expect((ctx.recipeRowIds as string[]).slice(0, 4)).toEqual(rowIds);
  const before = (
    await db.root<{ recipe_revision: number; mode: string }>(
      'select t.recipe_revision,p.mode from private.catalog_video_publication_policies p join private.catalog_publication_targets t on t.id=p.target_id where p.catalog_material_id=$1',
      [catalog]
    )
  )[0]!;
  expect(before).toMatchObject({ recipe_revision: 1, mode: 'held' });
  expect(
    await db.root('select *from public.team_operations where team_id=$1', [team])
  ).toHaveLength(2);
  const settings = {
    _catalogRecipeRowIds: ctx.recipeRowIds,
    _catalogPublicIds: ['e', 'f', 'g', 'h', 'i'],
    rows: []
  };
  expect(
    (
      await db.root<{ v: boolean }>(
        'select public.service_begin_catalog_nonvideo_update_write($1,$2,gen_random_uuid(),$3,2,5,$4,$5)v',
        [catalog, 'growth-ready', '2', settings, ctx.contextToken]
      )
    )[0]!.v
  ).toBe(true);
  expect(
    (
      await db.root<{ v: boolean }>(
        'select public.service_complete_catalog_update($1,$2,2,null,5,$3)v',
        [catalog, 'growth-ready', settings]
      )
    )[0]!.v
  ).toBe(true);
  await db.root('select public.service_finish_catalog_update_write($1)', [catalog]);
  expect(
    (
      await db.root<{ recipe_revision: number; mode: string }>(
        'select t.recipe_revision,p.mode from private.catalog_video_publication_policies p join private.catalog_publication_targets t on t.id=p.target_id where p.catalog_material_id=$1',
        [catalog]
      )
    )[0]
  ).toMatchObject({ recipe_revision: 2, mode: 'held' });
  const counts = await db.root<{ n: number }>(
    'select count(*)::integer n from private.catalog_video_assignments where video_set_id=$1 and recipe_revision=2 group by video_variant_index order by n',
    [setId]
  );
  expect(counts.map(x => x.n)).toEqual([2, 3]);
  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::integer n from private.catalog_video_variants where video_set_id=$1',
        [setId]
      )
    )[0]!.n
  ).toBe(2);
  expect(
    await db.root('select *from public.team_operations where team_id=$1', [team])
  ).toHaveLength(2);
});
it('preserves the original elapsed scheduled due time during a later growth using the same physical outputs', async () => {
  await db.root(
    "update private.catalog_video_publication_policies set mode='scheduled',due_at=clock_timestamp()-interval '1 minute',time_zone='UTC'where catalog_material_id=$1",
    [catalog]
  );
  const due = (
    await db.root<{ due_at: Date }>(
      'select due_at from private.catalog_video_publication_policies where catalog_material_id=$1',
      [catalog]
    )
  )[0]!.due_at;
  await db.asUser(owner, 'select public.run_team_catalog_update_now($1,array[$2]::uuid[])', [
    team,
    catalog
  ]);
  expect(
    await db.root("select *from public.service_claim_catalog_updater_items('growth-due',1,60)")
  ).toHaveLength(1);
  const ctx = (
    await db.root<{ v: Record<string, unknown> }>(
      'select public.service_prepare_catalog_nonvideo_update_context($1,$2)v',
      [catalog, 'growth-due']
    )
  )[0]!.v;
  expect(ctx).toMatchObject({ currentProductCount: 5, productCount: 6 });
  const settings = {
    _catalogRecipeRowIds: ctx.recipeRowIds,
    _catalogPublicIds: ['j', 'k', 'l', 'm', 'n', 'o'],
    rows: []
  };
  expect(
    (
      await db.root<{ v: boolean }>(
        'select public.service_begin_catalog_nonvideo_update_write($1,$2,gen_random_uuid(),$3,3,6,$4,$5)v',
        [catalog, 'growth-due', '3', settings, ctx.contextToken]
      )
    )[0]!.v
  ).toBe(true);
  expect(
    (
      await db.root<{ v: boolean }>(
        'select public.service_complete_catalog_update($1,$2,3,null,6,$3)v',
        [catalog, 'growth-due', settings]
      )
    )[0]!.v
  ).toBe(true);
  const policy = (
    await db.root<{ mode: string; due_at: Date }>(
      'select mode,due_at from private.catalog_video_publication_policies where catalog_material_id=$1',
      [catalog]
    )
  )[0]!;
  expect(policy.mode).toBe('scheduled');
  expect(policy.due_at).toEqual(due);
  expect(
    await db.root('select *from public.team_operations where team_id=$1', [team])
  ).toHaveLength(2);
});

it('diagnoses growth original attempt and target command through the actual SELECT-only analytics role', async () => {
  const original = (
    await db.root<{ attempt_id: string; command_id: string }>(
      'select attempt_id,command_id from private.catalog_growth_video_recipes where catalog_material_id=$1 order by expected_update_count desc limit 1',
      [catalog]
    )
  )[0]!;
  setQueryExecutor(async (sql, params) => {
    assertReadOnlySql(sql);
    await db.db.exec('begin read only;set local role wishly_analytics_ro');
    try {
      return (await db.db.query(sql, params)).rows as Record<string, unknown>[];
    } finally {
      await db.db.exec('rollback');
    }
  });
  try {
    for (const subject of [original.attempt_id, original.command_id]) {
      const evidence = await getCatalogGrowthEvidence(subject);
      expect(evidence.status).toBe('available');
      expect(evidence.records).toEqual([
        expect.objectContaining({
          attempt_id: original.attempt_id,
          command_id: original.command_id,
          base_product_count: 5,
          product_count: 6,
          target_kind: 'video_set',
          target_bound: true
        })
      ]);
      expect(JSON.stringify(evidence)).not.toMatch(
        /https?:|driveFileId|_catalog|recipe_row_ids|secret|token/iu
      );
    }
  } finally {
    setQueryExecutor(null);
  }
  expect(
    (
      await db.root<{ ok: boolean }>(
        "select has_table_privilege('wishly_analytics_ro','public.analytics_catalog_growth_video_recipes','UPDATE')ok"
      )
    )[0]!.ok
  ).toBe(false);
  await db.db.exec('begin read only;set local role wishly_analytics_ro');
  try {
    await expect(db.db.query('select *from private.catalog_growth_video_recipes')).rejects.toThrow(
      /permission denied/iu
    );
  } finally {
    await db.db.exec('rollback');
  }
});
