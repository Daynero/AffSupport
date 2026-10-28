import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import { launchConfig } from './fixtures/launches';
import { launchPreview, parseLaunchSources } from '../packages/shared/src/team/launches';
import { assignLaunchFixture } from './support/launch-assignment';
import { classifyCatalogImageName } from '../packages/shared/src/team/catalog-images';

const ACTOR = '45150000-0000-4000-8000-000000000001';
const OWNER = '45150000-0000-4000-8000-000000000002';
const EDITOR = '45150000-0000-4000-8000-000000000003';
let db: TeamTestDb,
  team: string,
  video: string,
  agent: string,
  buyer: string,
  offer: string,
  legacyImage: string;
let sequence = 0;
interface Generation {
  id: string;
  revisionId: string;
  launchId: string;
  url: string;
}
interface Intent {
  id: string;
  fence: string;
  checkpoint: Record<string, unknown>;
}
interface Resources {
  settings?: unknown;
  texts: unknown[];
  images: Array<Record<string, unknown>>;
}
let oldUnfrozen: Generation,
  oldFrozen: Generation,
  oldSnapshot: Resources,
  oldIntent: Intent,
  oldIntentSnapshot: Resources;

async function prepare(actor = ACTOR): Promise<Generation> {
  const config = launchConfig({
    agentRowId: agent,
    materialId: video,
    buyerId: buyer,
    offerId: offer,
    method: 'catalog',
    catalog: {
      productCount: 2,
      restitchEnabled: false,
      finalDurationMode: 'random-30-40',
      customFinalDurationSeconds: null
    }
  });
  const key = `r2-resource-${++sequence}`;
  const saved = (
    await db.asUser<{ v: { id: string; version: string } }>(
      actor,
      'select public.save_launch_draft($1,null,null,$2,$3::jsonb,null) v',
      [team, key, JSON.stringify(config)]
    )
  )[0]!.v;
  const source = (
    await db.asUser<{ v: unknown }>(actor, 'select public.get_launch_sources($1,$2) v', [
      team,
      saved.id
    ])
  )[0]!.v;
  const parsed = parseLaunchSources(source);
  if (!parsed) throw new Error('Invalid synthetic sources');
  await db.asUser<{ v: { version: string } }>(
    actor,
    'select public.save_launch_draft($1,$2,$3,$4,$5::jsonb,$6::jsonb) v',
    [
      team,
      saved.id,
      saved.version,
      `${key}-sources`,
      JSON.stringify(config),
      JSON.stringify(source)
    ]
  );
  const assignedVersion = await assignLaunchFixture(db, actor, team, saved.id, agent);
  const preview = launchPreview(config, parsed);
  if (!preview.ok) throw new Error('Invalid synthetic preview');
  const generation = (
    await db.root<{ v: { id: string; revisionId: string } }>(
      'select public.service_accept_launch_generation($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb) v',
      [
        team,
        saved.id,
        actor,
        assignedVersion,
        `${key}-accept`,
        `digest-${sequence}`,
        JSON.stringify(config),
        JSON.stringify(source),
        JSON.stringify(preview.value)
      ]
    )
  )[0]!.v;
  return { ...generation, launchId: saved.id, url: preview.value.advertisingUrl };
}
async function freeze(generation: Generation, actor = ACTOR) {
  return (
    await db.root<{ v: Resources }>('select private.freeze_launch_catalog_resources($1,$2,$3) v', [
      team,
      generation.id,
      actor
    ])
  )[0]!.v;
}
async function begin(
  key: string,
  version?: 2,
  url = 'https://example.test/catalog',
  actor = ACTOR
): Promise<Intent> {
  const payload = {
    teamId: team,
    videoMaterialId: video,
    sourceLink: url,
    productCount: 2,
    replacesMaterialId: null,
    ...(version === 2 ? { catalogImageContractVersion: 2 } : {})
  };
  return (
    await db.root<{ v: Intent }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5::jsonb,$6) v',
      [team, video, actor, key, JSON.stringify(payload), OWNER]
    )
  )[0]!.v;
}
async function plan(intent: Intent, actor = ACTOR) {
  return (
    await db.root<{ v: Resources }>(
      'select public.service_plan_catalog_resources($1,$2,$3,$4,$5) v',
      [team, intent.id, actor, OWNER, intent.fence]
    )
  )[0]!.v;
}

beforeAll(async () => {
  // Accept real legacy work BEFORE applying1550, proving migration never relabels it.
  db = await createTeamTestDb({
    throughMigration: '20261206154000_catalog_image_analytics_guard.sql'
  });
  await createUser(db, { id: ACTOR, email: 'launch-r2-resource@example.test' });
  await db.root('insert into public.admin_users(user_id) values($1)', [ACTOR]);
  team = (
    await db.asUser<{ id: string }>(
      ACTOR,
      "select id from public.create_team('R2 resource fixture')"
    )
  )[0]!.id;
  const account = (
    await db.root<{ id: string }>(
      "insert into public.team_accounts(team_id,created_by,name) values($1,$2,'g1') returning id",
      [team, ACTOR]
    )
  )[0]!.id;
  agent = (
    await db.root<{ id: string }>(
      "insert into public.team_account_agents(team_id,account_id,created_by,agent_id) values($1,$2,$3,'1234567892') returning id",
      [team, account, ACTOR]
    )
  )[0]!.id;
  const credential = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('r2-launch-permission','r2@example.test','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
      [ACTOR]
    )
  )[0]!.id;
  const connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values($1,$2,'root','Root','my_drive','connected',now()) returning id",
      [team, credential]
    )
  )[0]!.id;
  video = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) values($1,$2,'video','v5.mp4','file','video','video/mp4','1') returning id",
      [team, connection]
    )
  )[0]!.id;
  legacyImage = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) values($1,$2,'legacy-image','IMG_OLD.png','file','image','image/png','1') returning id",
      [team, connection]
    )
  )[0]!.id;
  buyer = (
    await db.asUser<{ v: { id: string } }>(
      ACTOR,
      "select public.create_launch_dictionary($1,'buyers','patrik','r2-buyer-create') v",
      [team]
    )
  )[0]!.v.id;
  offer = (
    await db.asUser<{ v: { id: string } }>(
      ACTOR,
      "select public.create_launch_dictionary($1,'offers','Offer','r2-offer-create') v",
      [team]
    )
  )[0]!.v.id;
  await db.root(
    "insert into public.team_product_catalog_settings(team_id,title,description,price,image_link,updated_by) values($1,'Legacy title','Legacy description',10,'https://legacy.example/image',$2)",
    [team, ACTOR]
  );
  await db.asUser(ACTOR, 'select public.set_team_product_catalog_image_sources($1,$2::jsonb)', [
    team,
    JSON.stringify([{ materialId: legacyImage, kind: 'file' }])
  ]);
  oldUnfrozen = await prepare();
  oldFrozen = await prepare();
  oldSnapshot = await freeze(oldFrozen);
  oldIntent = await begin('old-standalone-before1550');
  oldIntentSnapshot = await plan(oldIntent);
  await db.db.exec(
    readFileSync('supabase/migrations/20261206155000_catalog_r2_launch_resource_freeze.sql', 'utf8')
  );
  await db.root(
    "insert into private.catalog_image_config(team_id,mode) values($1,'v2') on conflict(team_id) do update set mode='v2'",
    [team]
  );
  await db.root('delete from public.team_product_catalog_image_sources where team_id=$1', [team]);
  const publication = (
    await db.root<{ id: string; object_key: string }>(
      "insert into private.catalog_image_publications(team_id,sha256,size_bytes,mime,width,height,classification,state) values($1,repeat('a',64),3,'image/png',1,1,$2::jsonb,'ready') returning id,object_key",
      [team, JSON.stringify(classifyCatalogImageName('IMG_R2.png'))]
    )
  )[0]!;
  await db.root(
    "update private.catalog_image_publications set public_url='https://media.test/'||object_key where id=$1",
    [publication.id]
  );
  await db.root(
    'insert into public.team_catalog_image_pool_entries(team_id,publication_id,public_url,classification) select team_id,id,public_url,classification from private.catalog_image_publications where id=$1',
    [publication.id]
  );
}, 60_000);
afterAll(async () => {
  await db?.close();
});

describe('authoritative Launch/standalone R2 resource snapshots', () => {
  it('keeps already accepted v1 generations and frozen Drive checkpoints byte-identical', async () => {
    expect(
      (
        await db.root<{ version: number }>(
          'select catalog_image_contract_version version from public.team_launch_generations where id=$1',
          [oldFrozen.id]
        )
      )[0]!.version
    ).toBe(1);
    expect(await freeze(oldFrozen)).toEqual(oldSnapshot);
    expect(oldSnapshot.images[0]?.driveFileId).toBe('legacy-image');
    expect(await plan(oldIntent)).toEqual(oldIntentSnapshot);
    expect(oldIntentSnapshot.images[0]?.driveFileId).toBe('legacy-image');
  });
  it('proves accepted v1 Launch work without a child can finish after team admission', async () => {
    const key = `launch:${oldUnfrozen.id}:catalog`;
    expect(
      (
        await db.root<{ v: number }>(
          'select public.service_catalog_image_request_version_v2($1,$2,$3,$4) v',
          [team, video, ACTOR, key]
        )
      )[0]!.v
    ).toBe(1);
    const claimed = (
      await db.root<{ v: { catalogImageContractVersion: number } }>(
        'select public.service_claim_launch_generation($1,$2,$3,$4) v',
        [team, oldUnfrozen.id, ACTOR, 'legacy-launch-worker']
      )
    )[0]!.v;
    expect(claimed.catalogImageContractVersion).toBe(1);
    await db.root(
      "insert into public.team_product_catalog_image_sources(team_id,material_id,kind) values($1,$2,'file')",
      [team, legacyImage]
    );
    const child = await begin(key, undefined, oldUnfrozen.url);
    expect((await plan(child)).images[0]?.driveFileId).toBe('legacy-image');
    await db.root('delete from public.team_product_catalog_image_sources where team_id=$1', [team]);
    await expect(begin('fresh-old-after-v2')).rejects.toThrow('CATALOG_IMAGE_UPGRADE_REQUIRED');
  });
  it('freezes R2-only Launch before restitch under its reserved future child UUID and never redraws retry', async () => {
    const g = await prepare();
    const claimed = (
      await db.root<{ v: { catalogImageContractVersion: number } }>(
        'select public.service_claim_launch_generation($1,$2,$3,$4) v',
        [team, g.id, ACTOR, 'current-launch-worker']
      )
    )[0]!.v;
    expect(claimed.catalogImageContractVersion).toBe(2);
    expect(
      (
        await db.root<{ n: number }>(
          'select count(*)::int n from public.service_draw_product_catalog_images($1,2)',
          [team]
        )
      )[0]!.n
    ).toBe(0);
    const frozen = await freeze(g);
    expect(frozen.images).toHaveLength(2);
    expect(frozen.images[0]?.kind).toBe('r2');
    const reserved = (
      await db.root<{ id: string }>(
        'select catalog_image_attempt_id id from public.team_launch_generations where id=$1',
        [g.id]
      )
    )[0]!.id;
    const child = await begin(`launch:${g.id}:catalog`, 2, g.url);
    expect(child.id).toBe(reserved);
    expect((await plan(child)).images).toEqual(frozen.images);
    expect(
      (
        await db.root<{ n: number }>(
          'select count(*)::int n from private.catalog_image_uses where catalog_attempt_id=$1',
          [child.id]
        )
      )[0]!.n
    ).toBe(2);
    await db.root(
      'update public.team_catalog_image_pool_entries set active=false where team_id=$1',
      [team]
    );
    expect(await freeze(g)).toEqual(frozen);
    expect((await plan(child)).images).toEqual(frozen.images);
    expect(
      (
        await db.root<{ n: number }>(
          'select count(*)::int n from private.catalog_image_uses where catalog_attempt_id=$1',
          [child.id]
        )
      )[0]!.n
    ).toBe(2);
    await db.root(
      'update public.team_catalog_image_pool_entries set active=true where team_id=$1',
      [team]
    );
  });
  it('plans new standalone v2 inputs from R2 and rejects an empty v2 pool without legacy fallback', async () => {
    const child = await begin('new-standalone-v2', 2);
    const resources = await plan(child);
    expect(resources.images).toHaveLength(2);
    expect(resources.images[0]?.kind).toBe('r2');
    await db.root(
      'update public.team_catalog_image_pool_entries set active=false where team_id=$1',
      [team]
    );
    const empty = await begin('new-standalone-empty-v2', 2);
    await expect(plan(empty)).rejects.toThrow('WRONG_STATE');
    expect((await plan(child)).images).toEqual(resources.images);
    await db.root(
      'update public.team_catalog_image_pool_entries set active=true where team_id=$1',
      [team]
    );
  });
  it('reauthorizes memoized Launch resources after edit loss, archive and cancellation without redrawing', async () => {
    await createUser(db, { id: EDITOR, email: 'launch-r2-editor@example.test' });
    await db.root(
      'insert into public.team_members(team_id,user_id,base_role,permission_overrides) values($1,$2,\'editor\',\'{"view":true,"upload":true,"edit":true}\')',
      [team, EDITOR]
    );
    const g = await prepare(EDITOR);
    const frozen = await freeze(g, EDITOR);
    const child = await begin(`launch:${g.id}:catalog`, 2, g.url, EDITOR);
    expect((await plan(child, EDITOR)).images).toEqual(frozen.images);
    await db.root(
      'update public.team_members set permission_overrides=\'{"view":true,"upload":true,"edit":false}\' where team_id=$1 and user_id=$2',
      [team, EDITOR]
    );
    expect(
      (
        await db.root<{ can_view: boolean; can_upload: boolean; can_edit: boolean }>(
          "select private.can($1,'view',$2) can_view,private.can($1,'upload',$2) can_upload,private.can($1,'edit',$2) can_edit",
          [team, EDITOR]
        )
      )[0]
    ).toEqual({ can_view: true, can_upload: true, can_edit: false });
    await expect(plan(child, EDITOR)).rejects.toThrow('PERMISSION_DENIED');
    await db.root(
      'update public.team_members set permission_overrides=\'{"view":true,"upload":true,"edit":true}\' where team_id=$1 and user_id=$2',
      [team, EDITOR]
    );
    expect((await plan(child, EDITOR)).images).toEqual(frozen.images);
    await db.root('update public.team_launches set archived_at=clock_timestamp() where id=$1', [
      g.launchId
    ]);
    await expect(plan(child, EDITOR)).rejects.toThrow('PERMISSION_DENIED');
    await db.root('update public.team_launches set archived_at=null where id=$1', [g.launchId]);
    expect((await plan(child, EDITOR)).images).toEqual(frozen.images);
    await db.root("update public.team_launch_generations set state='canceled' where id=$1", [g.id]);
    await expect(plan(child, EDITOR)).rejects.toThrow('WRONG_STATE');
    expect(
      (
        await db.root<{ images: unknown[] }>(
          "select checkpoint->'images' images from private.catalog_generation_intents where id=$1",
          [child.id]
        )
      )[0]!.images
    ).toEqual(frozen.images);
    expect(
      (
        await db.root<{ n: number }>(
          'select count(*)::int n from private.catalog_image_uses where catalog_attempt_id=$1',
          [child.id]
        )
      )[0]!.n
    ).toBe(2);
  });
  it('keeps generation authority columns immutable and hidden from browser grants', async () => {
    await expect(
      db.root(
        'update public.team_launch_generations set catalog_image_contract_version=2 where id=$1',
        [oldFrozen.id]
      )
    ).rejects.toThrow('WRONG_STATE');
    expect(
      (
        await db.root<{ allowed: boolean }>(
          "select has_column_privilege('authenticated','public.team_launch_generations','catalog_image_attempt_id','SELECT') allowed"
        )
      )[0]!.allowed
    ).toBe(false);
  });
});
