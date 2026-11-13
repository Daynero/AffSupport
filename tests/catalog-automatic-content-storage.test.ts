import { getCatalogUpdateDiagnosis } from '../scripts/analytics/catalog-updates';
import { setQueryExecutor, assertReadOnlySql } from '../scripts/analytics/db';
import { investigatePrivacyFailure } from '../scripts/analytics/types';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import { launchConfig } from './fixtures/launches';
import { launchPreview, parseLaunchSources } from '../packages/shared/src/team/launches';
import { assignLaunchFixture } from './support/launch-assignment';

const ACTOR = '45150000-0000-4000-8000-000000000001';
const OWNER = '45150000-0000-4000-8000-000000000002';
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
  contentPolicyVersion?: number;
  texts: unknown[];
  images: Array<Record<string, unknown>>;
}
let oldEmpty: Intent;
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
  // Accept real work before automatic admission, including an empty standalone checkpoint.
  db = await createTeamTestDb({
    throughMigration: '20261208100200_catalog_global_retirement.sql'
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
  oldEmpty = await begin('old-empty');
  await db.db.exec(
    readFileSync('supabase/migrations/20261208120000_automatic_catalog_content.sql', 'utf8')
  );
  await db.db.exec(
    readFileSync(
      'supabase/migrations/20261208121000_automatic_catalog_content_diagnostics.sql',
      'utf8'
    )
  );
}, 180_000);
afterAll(async () => {
  await db?.close();
});

describe('automatic catalog admission and source identity', () => {
  it('keeps old frozen recipes and old empty intent policy unchanged', async () => {
    expect(await freeze(oldFrozen)).toEqual(oldSnapshot);
    expect(await plan(oldIntent)).toEqual(oldIntentSnapshot);
    const resumed = await begin('old-empty');
    expect(resumed.id).toBe(oldEmpty.id);
    expect(resumed.checkpoint).not.toHaveProperty('contentPolicyVersion');
    await expect(
      db.root(
        'update private.catalog_generation_intents set checkpoint=checkpoint||\'{"contentPolicyVersion":1}\' where id=$1',
        [oldEmpty.id]
      )
    ).rejects.toThrow('WRONG_STATE');
  });
  it('resumes old accepted unfrozen Launch using its legacy source hash', async () => {
    const child = await begin(`launch:${oldUnfrozen.id}:catalog`, undefined, oldUnfrozen.url);
    expect(child.checkpoint).not.toHaveProperty('contentPolicyVersion');
    const frozen = await plan(child);
    expect(frozen).not.toHaveProperty('contentPolicyVersion');
    expect(frozen.settings).toMatchObject({ title: 'Legacy title', priceMin: 10 });
  });
  it('seeds new standalone and matching Launch children once and refuses mutation', async () => {
    const standalone = await begin('automatic-new');
    expect(standalone.checkpoint.contentPolicyVersion).toBe(1);
    await expect(
      db.root(
        "update private.catalog_generation_intents set checkpoint=checkpoint-'contentPolicyVersion' where id=$1",
        [standalone.id]
      )
    ).rejects.toThrow('WRONG_STATE');
    const generation = await prepare();
    const child = await begin(`launch:${generation.id}:catalog`, undefined, generation.url);
    expect(child.checkpoint.contentPolicyVersion).toBe(1);
    const frozen = await plan(child);
    expect(frozen).toMatchObject({
      contentPolicyVersion: 1,
      texts: [],
      settings: { contentPolicyVersion: 1 }
    });
    expect(frozen.images).toHaveLength(2);
  });
  it('ignores retired text/price changes but keeps real image source changes fenced', async () => {
    const version = async () =>
      (
        await db.root<{ v: string }>('select private.launch_catalog_settings_version($1) v', [team])
      )[0]!.v;
    const before = await version();
    expect(before).toMatch(/^automatic-v1:/u);
    await db.root(
      "update public.team_product_catalog_settings set title='Retired',description='Changed',price=99,price_min=99,price_max=99 where team_id=$1",
      [team]
    );
    expect(await version()).toBe(before);
    await db.root("update public.team_materials set drive_version='2' where id=$1", [legacyImage]);
    expect(await version()).not.toBe(before);
    await db.root("update public.team_materials set drive_version='1' where id=$1", [legacyImage]);
  });
  it('freezes new Launch and standalone image resources with no settings row', async () => {
    await db.root('delete from public.team_product_catalog_settings where team_id=$1', [team]);
    const generation = await prepare();
    expect(await freeze(generation)).toMatchObject({ contentPolicyVersion: 1, texts: [] });
    const standalone = await begin('automatic-without-settings');
    expect((await plan(standalone)).texts).toEqual([]);
  });
});

let catalog: string;
const worker = 'automatic-worker';
const frozenRow = {
  title: 'Manual item',
  description: 'Retained description',
  price: 97,
  imageLink: 'https://fixture.invalid/image'
};
const recipe = {
  contentPolicyVersion: 1,
  productCount: 2,
  automaticRowCount: 1,
  retainedRowCount: 1,
  rows: [
    frozenRow,
    {
      ...frozenRow,
      title: 'Generated item',
      price: 24,
      contentPolicyVersion: 1,
      contentVariantId: 1
    }
  ]
};
const content = async (base?: string, value?: unknown, owner = worker) =>
  (
    await db.root<{
      v: { attemptId: string; baseSignature: string; recipe: typeof recipe | null };
    }>('select public.service_catalog_update_content_recipe($1,$2,$3,$4::jsonb) v', [
      catalog,
      owner,
      base ?? null,
      value ? JSON.stringify(value) : null
    ])
  )[0]!.v;
async function round() {
  await db.root(
    "insert into public.team_catalog_updater_items(team_id,catalog_material_id,round_due_at,lease_owner,lease_expires_at) values($1,$2,clock_timestamp(),$3,clock_timestamp()+interval '5 minutes') on conflict(catalog_material_id) do update set round_due_at=excluded.round_due_at,lease_owner=excluded.lease_owner,lease_expires_at=excluded.lease_expires_at,reconciliation_required=false",
    [team, catalog, worker]
  );
}
describe('bounded updater content recipes', () => {
  beforeAll(async () => {
    catalog = (
      await db.root<{ id: string }>(
        "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type) select team_id,connection_id,'content-sheet','Catalog','file','other','application/vnd.google-apps.spreadsheet' from public.team_materials where id=$1 returning id",
        [video]
      )
    )[0]!.id;
    await db.root(
      "update public.team_materials set companion_of=$2,companion_kind='product_catalog' where id=$1",
      [catalog, video]
    );
    await db.root(
      "insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot) values($1,$2,$3,'https://fixture.invalid/',1,'https://docs.google.com/spreadsheets/d/content-sheet/edit','https://drive.google.com/file/d/video/view',$4::jsonb)",
      [catalog, team, video, JSON.stringify(frozenRow)]
    );
    await db.root(
      'insert into public.team_catalog_update_profiles(catalog_material_id,team_id,refresh_images,refresh_texts,grow_products,random_link_variation,restitch) values($1,$2,false,false,true,false,false) on conflict do nothing',
      [catalog, team]
    );
    await db.root(
      'insert into public.team_catalog_updaters(team_id) values($1) on conflict do nothing',
      [team]
    );
    await round();
  });
  it('freezes once and returns original rows after a lost freeze reply; scalar proof is exact', async () => {
    const first = await content();
    expect(first.recipe).toBeNull();
    expect((await content(first.baseSignature, recipe)).recipe).toEqual(recipe);
    expect(
      (
        await content(first.baseSignature, {
          ...recipe,
          rows: recipe.rows.map(row => ({ ...row, price: 999 }))
        })
      ).recipe
    ).toEqual(recipe);
    const receipt = (
      await db.root(
        'select content_policy_version,planned_row_count,automatic_row_count,retained_row_count from public.team_catalog_update_attempts where attempt_id=$1',
        [first.attemptId]
      )
    )[0];
    expect(receipt).toEqual({
      content_policy_version: 1,
      planned_row_count: 2,
      automatic_row_count: 1,
      retained_row_count: 1
    });
    setQueryExecutor(async (sql, params) => {
      assertReadOnlySql(sql);
      return db.root(sql, params);
    });
    try {
      const diagnosis = await getCatalogUpdateDiagnosis(first.attemptId);
      expect(diagnosis.attempts).toEqual([
        expect.objectContaining({
          content_receipt_status: 'frozen',
          content_policy_version: 1,
          planned_row_count: 2,
          automatic_row_count: 1,
          retained_row_count: 1,
          result: 'running',
          delivery_proven: false
        })
      ]);
      expect(investigatePrivacyFailure(diagnosis)).toBeNull();
      expect(JSON.stringify(diagnosis)).not.toMatch(
        /Manual item|Generated item|fixture.invalid|Retained description/u
      );
    } finally {
      setQueryExecutor(null);
    }
  });
  it('refuses stale leases and changed source snapshots before returning frozen data', async () => {
    await expect(content(undefined, undefined, 'wrong-worker')).rejects.toThrow('LEASE_MISMATCH');
    await db.root(
      'update public.team_product_catalogs set settings_snapshot=settings_snapshot||\'{"changed":true}\' where material_id=$1',
      [catalog]
    );
    await expect(content()).rejects.toThrow('SOURCE_CHANGED');
    await db.root(
      "update public.team_product_catalogs set settings_snapshot=settings_snapshot-'changed' where material_id=$1",
      [catalog]
    );
  });
  it('refuses unknown provider outcomes, then reuses the same recipe once confirmed unchanged', async () => {
    await db.root(
      'update public.team_catalog_updater_items set reconciliation_required=true where catalog_material_id=$1',
      [catalog]
    );
    await expect(content()).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
    await db.root(
      'update public.team_catalog_updater_items set reconciliation_required=false where catalog_material_id=$1',
      [catalog]
    );
    expect((await content()).recipe).toEqual(recipe);
  });
  it('replaces only the latest recipe in a new round and keeps historical counts', async () => {
    const prior = await content();
    await round();
    const current = await content();
    expect(current.attemptId).not.toBe(prior.attemptId);
    expect(current.recipe).toBeNull();
    await expect(content('stale-base', recipe)).rejects.toThrow('SOURCE_CHANGED');
    await expect(
      content(current.baseSignature, { ...recipe, retainedRowCount: 0 })
    ).rejects.toThrow('INVALID_INPUT');
    await content(current.baseSignature, { ...recipe, automaticRowCount: 0, retainedRowCount: 2 });
    expect(
      (
        await db.root<{ n: number }>(
          'select count(*)::integer n from private.catalog_update_content_recipes where catalog_material_id=$1',
          [catalog]
        )
      )[0]!.n
    ).toBe(1);
    expect(
      (
        await db.root<{ n: number }>(
          'select count(*)::integer n from public.team_catalog_update_attempts where catalog_material_id=$1 and planned_row_count=2',
          [catalog]
        )
      )[0]!.n
    ).toBe(2);
  });
  it('registers recipe references with the cleanup fence and detects a disabled fence', async () => {
    const covered = async () =>
      (
        await db.root<{ covered: boolean }>(
          'select private.task_cleanup_coverage_verified() covered'
        )
      )[0]!.covered;
    expect(await covered()).toBe(true);
    await db.root(
      'alter table private.catalog_update_content_recipes disable trigger task_cleanup_reference_fence'
    );
    try {
      expect(await covered()).toBe(false);
    } finally {
      await db.root(
        'alter table private.catalog_update_content_recipes enable trigger task_cleanup_reference_fence'
      );
    }
    expect(await covered()).toBe(true);
  });
  it('denies browser access to private recipes and service-only freeze RPC', async () => {
    await db.root('set role authenticated');
    try {
      await expect(
        db.asUser(ACTOR, 'select * from private.catalog_update_content_recipes')
      ).rejects.toThrow(/permission denied/u);
      await expect(
        db.asUser(ACTOR, 'select public.service_catalog_update_content_recipe($1,$2)', [
          catalog,
          worker
        ])
      ).rejects.toThrow(/permission denied/u);
    } finally {
      await db.root('reset role');
    }
  });
});
