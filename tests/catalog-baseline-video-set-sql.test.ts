import { afterAll, beforeAll, expect, it } from 'vitest';
import { parseCatalogPublicationSnapshot } from '../packages/shared/src/team/catalog-publication-api';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * 1.4.3: "Перевірити чинні посилання" always failed for a restitched catalog,
 * because the check only knew the original video link. authorize now hands over
 * the catalog's ready video sets (variant outputs, their ready R2 URLs and the
 * per-product assignment), and finish adopts the set the cells were proven to hold.
 */
let db: TeamTestDb, team: string, connection: string;
const owner = '77000000-0000-4000-8000-000000000501';
beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: owner, email: 'baseline-set-owner@example.invalid' });
  await db.root('insert into public.admin_users(user_id) values($1)', [owner]);
  team = (
    await db.asUser<{ id: string }>(owner, "select id from public.create_team('Baseline set')")
  )[0]!.id;
  const cred = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('baseline-set','baseline-set@example.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
      [owner]
    )
  )[0]!.id;
  connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values($1,$2,'root','Root','my_drive','connected',now()) returning id",
      [team, cred]
    )
  )[0]!.id;
  await db.root(
    "update private.catalog_video_r2_config set public_origin='https://media.example.invalid'"
  );
}, 180_000);
afterAll(async () => {
  await db?.close();
});

let seq = 0;
const material = async (name: string, video = true) =>
  (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) values($1,$2,$3,$3,'file',$4,$5,'v1') returning id",
      [
        team,
        connection,
        name,
        video ? 'video' : 'other',
        video ? 'video/mp4' : 'application/vnd.google-apps.spreadsheet'
      ]
    )
  )[0]!.id;

/** A legacy restitched catalog: two products, two variants, held for adoption. */
async function restitchedCatalog() {
  const n = ++seq;
  const source = await material('source-' + n),
    catalog = await material('catalog-' + n, false),
    outputs = [await material('variant-a-' + n), await material('variant-b-' + n)];
  const rows = [crypto.randomUUID(), crypto.randomUUID()],
    intent = crypto.randomUUID(),
    set = crypto.randomUUID(),
    seed = 'b'.repeat(64);
  await db.root(
    "insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot) values($1,$2,$3,'https://offer.example.invalid/',2,'https://docs.google.com/spreadsheets/d/fixture/edit','https://drive.google.com/file/d/source/view','{}')",
    [catalog, team, source]
  );
  await db.root(
    "insert into private.catalog_generation_intents(id,team_id,video_material_id,actor_id,request_key,request_digest,request_payload,variant,state,checkpoint) values($1,$2,$3,$4,$5,'digest','{}'::jsonb,1,'registered',$6::jsonb)",
    [
      intent,
      team,
      source,
      owner,
      'product-catalog:' + crypto.randomUUID(),
      JSON.stringify({
        materialId: catalog,
        initialVideoPlan: { setId: set, recipeRevision: 1, recipeRowIds: rows },
        sheetRows: [[{ v: 'ID' }], [{ v: 'id' }], [{ v: 'P-1' }], [{ v: 'P-2' }]]
      })
    ]
  );
  await db.root(
    'insert into private.catalog_video_sets(id,team_id,actor_id,catalog_intent_id,source_material_id,source_version,settings_snapshot,settings_digest,requested_count,product_count,recipe_revision,assignment_seed,assignment_version,state) values($1,$2,$3,$4,$5,\'v1\',\'{"configured":true,"sourceMode":"legacy","operation":"restitch"}\',repeat(\'a\',64),2,2,1,$6,1,\'ready\')',
    [set, team, owner, intent, source, seed]
  );
  for (const [index, output] of outputs.entries()) {
    await db.root(
      "insert into private.catalog_video_variants(video_set_id,team_id,video_variant_index,request_id,state,output_material_id) values($1,$2,$3,gen_random_uuid(),'registered',$4)",
      [set, team, index, output]
    );
    // Product N gets variant N.
    await db.root(
      'insert into private.catalog_video_assignments(video_set_id,team_id,recipe_revision,recipe_row_id,video_variant_index) values($1,$2,1,$3,$4)',
      [set, team, rows[index], index]
    );
  }
  const initial = (
    await db.root<{ value: { target: { sourceVersion: string } } }>(
      'select public.service_read_catalog_publication($1,$2,$3) value',
      [team, owner, catalog]
    )
  )[0]!.value;
  await db.root(
    "select public.service_save_catalog_publication($1,$2,$3,$4,0,'immediate',null,null,$5::jsonb)",
    [
      team,
      owner,
      crypto.randomUUID(),
      catalog,
      JSON.stringify({
        kind: 'source',
        materialId: source,
        sourceVersion: initial.target.sourceVersion
      })
    ]
  );
  return { catalog, source, outputs, set };
}
const begin = async (catalog: string, check = crypto.randomUUID()) => ({
  check,
  ctx: (
    await db.root<{ value: Record<string, unknown> & { fence: string } }>(
      'select public.service_begin_catalog_baseline_check($1,$2,$3,$4,1) value',
      [check, team, owner, catalog]
    )
  )[0]!.value
});

it('hands over the ready set with its outputs, ready R2 URLs and per-product assignment', async () => {
  const f = await restitchedCatalog();
  await db.root(
    "insert into private.catalog_video_r2_copies(team_id,source_material_id,source_version,state,size_bytes,part_bytes,object_key,ready_at) values($1,$2,'v1','ready',11,5242880,$3,now())",
    [team, f.outputs[1], 'v/' + 'c'.repeat(32) + '.mp4']
  );
  const { ctx } = await begin(f.catalog);
  // The original-source fields are unchanged; the sets come alongside them.
  expect(ctx.sourceMaterialId).toBe(f.source);
  expect(ctx.videoSets).toEqual([
    {
      videoSetId: f.set,
      recipeRevision: 1,
      variants: [
        expect.objectContaining({ materialId: f.outputs[0], fileId: 'variant-a-1', r2Urls: [] }),
        expect.objectContaining({
          materialId: f.outputs[1],
          fileId: 'variant-b-1',
          rootFolderId: 'root',
          resourceKey: null,
          r2Urls: ['https://media.example.invalid/v/' + 'c'.repeat(32) + '.mp4']
        })
      ],
      rows: [
        { productId: 'P-1', materialId: f.outputs[0] },
        { productId: 'P-2', materialId: f.outputs[1] }
      ]
    }
  ]);
});

it('adopts only a candidate set as the active delivery and keeps the original rule intact', async () => {
  const f = await restitchedCatalog();
  const { check, ctx } = await begin(f.catalog);
  const finish = (outcome: string, set: string | null, revision: number | null) =>
    db.root<{ value: unknown }>(
      'select public.service_finish_catalog_baseline_check($1,$2,$3,$4,$5,$6,$7,$8,$9) value',
      [check, team, owner, ctx.fence, outcome, 'v2', 'a'.repeat(64), set, revision]
    );
  await expect(finish('video_set', null, null)).rejects.toThrow('INVALID_INPUT');
  await expect(finish('source', f.set, 1)).rejects.toThrow('INVALID_INPUT');
  await expect(finish('video_set', crypto.randomUUID(), 1)).rejects.toThrow('SOURCE_CHANGED');
  await expect(finish('video_set', f.set, 2)).rejects.toThrow('SOURCE_CHANGED');
  const adopted = (await finish('video_set', f.set, 1))[0]!.value;
  expect(parseCatalogPublicationSnapshot(adopted)).toMatchObject({
    job: { state: 'waiting' },
    active: { target: { kind: 'video_set', videoSetId: f.set, recipeRevision: 1 } }
  });
  // The seven-argument call the 1.4.2 edge function makes still adopts the original.
  const g = await restitchedCatalog();
  const second = await begin(g.catalog);
  const original = (
    await db.root<{ value: unknown }>(
      "select public.service_finish_catalog_baseline_check(p_check=>$1,p_team=>$2,p_actor=>$3,p_fence=>$4,p_outcome=>'source',p_provider_revision=>'v2',p_video_cells_digest=>$5) value",
      [second.check, team, owner, second.ctx.fence, 'a'.repeat(64)]
    )
  )[0]!.value;
  expect(parseCatalogPublicationSnapshot(original)).toMatchObject({
    active: { target: { kind: 'source', materialId: g.source } }
  });
});

it('offers no set once a variant output is gone, and none for an unrestitched catalog', async () => {
  const f = await restitchedCatalog();
  await db.root(
    "update public.team_materials set lifecycle='trashed',trashed_at=now() where id=$1",
    [f.outputs[0]]
  );
  const { ctx } = await begin(f.catalog);
  // The trashed output simply drops out, so a cell naming it cannot be explained.
  expect((ctx.videoSets as { variants: { materialId: string }[] }[])[0]!.variants).toEqual([
    expect.objectContaining({ materialId: f.outputs[1] })
  ]);
  await db.root("update private.catalog_video_sets set state='canceled' where id=$1", [f.set]);
  expect(
    (
      await db.root<{ value: unknown }>('select private.catalog_baseline_video_sets($1,$2) value', [
        team,
        f.catalog
      ])
    )[0]!.value
  ).toEqual([]);
  const grants = await db.root<{ grantee: string }>(
    "select grantee from information_schema.routine_privileges where routine_name='service_finish_catalog_baseline_check'"
  );
  expect(grants.map(g => g.grantee).sort()).toEqual(['postgres', 'service_role']);
});
