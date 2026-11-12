import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Production 2026-11-12 (MY_1_v4_catalog): R2 was ticked and an update with re-stitch started
 * a second later. The round froze publication revision 1; the R2 reconciliation then republished
 * the old video as revision 2, and attaching the ready variants asked for revision 1 on every
 * pass (WRONG_STATE), holding the catalog for good.
 */
let db: TeamTestDb, team: string, connection: string;
const owner = 'c1799990-0000-4000-8000-000000000001';
let ordinal = 0;

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: owner, email: 'variant-r2-revision@example.invalid' });
  await db.root('insert into public.admin_users(user_id)values($1)', [owner]);
  team = (
    await db.asUser<{ id: string }>(
      owner,
      "select id from public.create_team('Variant R2 revision')"
    )
  )[0]!.id;
  const cred = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(connected_by,google_permission_id,google_account_email,vault_secret_id,scope)values($1,'variant-r2','variant-r2@example.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file')returning id",
      [owner]
    )
  )[0]!.id;
  connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state)values($1,$2,'root','Root','my_drive','connected')returning id",
      [team, cred]
    )
  )[0]!.id;
  await db.root(
    "insert into public.team_restitch_defaults(team_id,operation,start_image_ids,configured)values($1,'restitch',array[gen_random_uuid()],true)",
    [team]
  );
  await db.root(
    'insert into private.team_recovery_delegations(team_id,actor_id,installation_id,refresh_hash)values($1,$2,gen_random_uuid(),$3)',
    [team, owner, Buffer.alloc(32, 0xab)]
  );
}, 240000);
afterAll(async () => {
  await db?.close();
});

async function material(video: boolean) {
  ordinal += 1;
  return (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,size_bytes,checksum,drive_version)values($1,$2,$3,$3,'file',$4,$5,4,$6,'1')returning id",
      [
        team,
        connection,
        (video ? 'source-' : 'sheet-') + String(ordinal),
        video ? 'video' : 'other',
        video ? 'video/mp4' : 'application/vnd.google-apps.spreadsheet',
        'a'.repeat(32)
      ]
    )
  )[0]!.id;
}

/** A catalog published once, a round whose two variants are ready, and the revision in between. */
async function readyRound(between: 'video_r2' | 'person') {
  const source = await material(true);
  const catalog = await material(false);
  await db.root(
    "update public.team_materials set companion_of=$2,companion_kind='product_catalog'where id=$1",
    [catalog, source]
  );
  await db.root(
    "insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot)values($1,$2,$3,'https://example.invalid/',3,'https://docs.google.com/spreadsheets/d/fixture/edit','https://drive.google.com/file/d/source/view','{}')",
    [catalog, team, source]
  );
  await db.root(
    'insert into public.team_catalog_update_profiles(catalog_material_id,team_id,refresh_images,refresh_texts,grow_products,random_link_variation,restitch)values($1,$2,true,true,false,false,true)on conflict(catalog_material_id)do update set restitch=true',
    [catalog, team]
  );
  const version = (
    await db.root<{ v: string }>('select private.catalog_publication_source_version($1,$2)v', [
      source,
      team
    ])
  )[0]!.v;
  await db.root(
    "select public.service_save_catalog_publication($1,$2,gen_random_uuid(),$3,0,'immediate',null,null,$4)",
    [team, owner, catalog, { kind: 'source', materialId: source, sourceVersion: version }]
  );
  await db.root(
    'update private.catalog_video_publication_policies set legacy_delivery_unverified=false where catalog_material_id=$1',
    [catalog]
  );
  await db.root(
    "update private.catalog_video_publication_jobs set state='published',provider_revision='fixture',verified_at=clock_timestamp()where catalog_material_id=$1",
    [catalog]
  );
  const request = crypto.randomUUID();
  const r = (
    await db.root<{ v: Record<string, unknown> }>(
      'select public.service_accept_catalog_updater_variants($1,$2,$3,$4,2,(select version from public.team_catalog_update_profiles where catalog_material_id=$3))v',
      [team, owner, catalog, request]
    )
  )[0]!.v;
  expect(r.publication_revision).toBe(1);

  // Revision 2 is written while the variants are being made.
  const command = crypto.randomUUID();
  await db.root(
    "insert into private.catalog_publication_commands(request_id,team_id,actor_id,payload,receipt)values($1,$2,$3,$4,'{}')",
    [command, team, owner, between === 'video_r2' ? { origin: 'video_r2' } : { mode: 'scheduled' }]
  );
  await db.root(
    'update private.catalog_video_publication_policies set revision=2 where catalog_material_id=$1',
    [catalog]
  );
  await db.root(
    "insert into private.catalog_video_publication_jobs(catalog_material_id,team_id,actor_id,revision,command_id,target_id,state,verified_at)select catalog_material_id,team_id,actor_id,2,$2,target_id,'published',clock_timestamp()from private.catalog_video_publication_policies where catalog_material_id=$1",
    [catalog, command]
  );

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
    await db.root(
      "insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,result_material_id,idempotency_key,request_nonce,finished_at)values($1,$2,$3,'process','succeeded',$4,$5,$6,$6,clock_timestamp())",
      [operationId, team, owner, source, output.id, 'catalog-variant:' + childIds[index]]
    );
    await db.root(
      "insert into private.team_operation_intents(operation_id,team_id,tool_id,expected_source_version,expected_source_drive_file_id,expected_source_checksum)values($1,$2,'restitch','1',$3,repeat('a',32))",
      [operationId, team, 'source-' + String(ordinal - 1)]
    );
    completed.push({
      index,
      requestId: childIds[index],
      operationId,
      state: 'registered',
      outputId: output.id
    });
  }
  await db.root('select public.service_checkpoint_catalog_video_set($1,$2,$3,$4,1,0,$5)', [
    r.set_id,
    team,
    owner,
    r.executor_id,
    completed
  ]);
  return { catalog, request };
}
const attach = (request: string) =>
  db.root('select public.service_attach_catalog_updater_variant_target($1,$2,$3)', [
    team,
    owner,
    request
  ]);
const revision = async (catalog: string) =>
  (
    await db.root<{ revision: string }>(
      'select revision::text from private.catalog_video_publication_policies where catalog_material_id=$1',
      [catalog]
    )
  )[0]!.revision;

it('MY_1_v4: ready variants attach after the R2 reconciliation republished the catalog', async () => {
  const f = await readyRound('video_r2');
  await attach(f.request);
  expect(await revision(f.catalog)).toBe('3');
});

it('a publication someone else saved meanwhile still stops the attach', async () => {
  const f = await readyRound('person');
  await expect(attach(f.request)).rejects.toThrow(/WRONG_STATE/);
  expect(await revision(f.catalog)).toBe('2');
});
