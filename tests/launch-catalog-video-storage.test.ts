import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import { assignLaunchFixture } from './support/launch-assignment';
import { launchConfig } from './fixtures/launches';
import { classifyCatalogImageName } from '../packages/shared/src/team/catalog-images';
import { generateLaunch } from '../supabase/functions/drive-ops/launches';
import { catalogIntentStore } from '../supabase/functions/drive-ops/catalog-durable';
import { parseLaunchSources } from '../packages/shared/src/team/launches';
import type { ServiceRpcClient } from '../supabase/functions/_shared/credentials';
const id = (n: number) => 'c1710000-0000-4000-8000-' + String(n).padStart(12, '0');
const actor = id(1),
  executor = id(2),
  otherExecutor = id(3),
  material = id(4),
  image = id(5);
let db: TeamTestDb,
  team: string,
  agent: string,
  buyer: string,
  offer: string,
  sequence = 0;
let canceledTargetHoldApplied = false;
const names = new Set([
  'find_launch_generation',
  'get_launch',
  'service_launch_sources',
  'service_catalog_publication_clock',
  'service_find_launch_catalog_video_reuse',
  'service_initial_catalog_video_context',
  'service_accept_launch_catalog_video_generation',
  'service_begin_catalog_intent',
  'service_catalog_image_request_version_v2',
  'service_prepare_catalog_video_foreground',
  'service_retire_unused_catalog_video_foreground',
  'service_launch_catalog_foreground_source'
]);
const service: ServiceRpcClient = {
  rpc: async (name, args) => {
    if (!names.has(name)) throw Error('Unexpected test RPC ' + name);
    const keys = Object.keys(args);
    if (keys.some(key => !/^p_[a-z_]+$/u.test(key))) throw Error('Unexpected parameter');
    const values = keys.map(key =>
      key.endsWith('_hash') && typeof args[key] === 'string' && String(args[key]).startsWith('\\x')
        ? Buffer.from(String(args[key]).slice(2), 'hex')
        : args[key]
    );
    const sql = `select public.${name}(${keys.map((key, i) => `${key}=>$${i + 1}`).join(',')}) v`;
    try {
      const rows =
        name === 'find_launch_generation' || name === 'get_launch'
          ? await db.asUser<{ v: unknown }>(actor, sql, values)
          : await db.root<{ v: unknown }>(sql, values);
      return { data: rows[0]!.v, error: null };
    } catch (error) {
      return { data: null, error: { message: (error as Error).message } };
    }
  }
};
beforeAll(async () => {
  db = await createTeamTestDb({
    throughMigration: '20261207181000_catalog_video_cancellation_settlement.sql'
  });
  await createUser(db, { id: actor, email: 'launch-video@synthetic.invalid' });
  await db.root('insert into public.admin_users(user_id) values($1)', [actor]);
  team = (
    await db.asUser<{ id: string }>(actor, 'select id from public.create_team($1)', [
      'Synthetic Launch N'
    ])
  )[0]!.id;
  const account = (
    await db.root<{ id: string }>(
      "insert into public.team_accounts(team_id,created_by,name) values($1,$2,'g1') returning id",
      [team, actor]
    )
  )[0]!.id;
  agent = (
    await db.root<{ id: string }>(
      "insert into public.team_account_agents(team_id,account_id,created_by,agent_id) values($1,$2,$3,'1234567892') returning id",
      [team, account, actor]
    )
  )[0]!.id;
  buyer = (
    await db.asUser<{ v: { id: string } }>(
      actor,
      "select public.create_launch_dictionary($1,'buyers','synthetic','launch-video-buyer') v",
      [team]
    )
  )[0]!.v.id;
  offer = (
    await db.asUser<{ v: { id: string } }>(
      actor,
      "select public.create_launch_dictionary($1,'offers','Synthetic','launch-video-offer') v",
      [team]
    )
  )[0]!.v.id;
  const credential = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values($1,'synthetic-launch','synthetic@fixture.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file') returning id",
      [actor]
    )
  )[0]!.id;
  const connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state) values($1,$2,'root','Root','my_drive','connected') returning id",
      [team, credential]
    )
  )[0]!.id;
  await db.root(
    "insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum,drive_version) values($1,$3,$4,'synthetic-video','root','Video.mp4','file','video','video/mp4',100,$5,'1'),($2,$3,$4,'synthetic-image','root','Image.png','file','image','image/png',100,$5,'1')",
    [material, image, team, connection, 'a'.repeat(32)]
  );
  await db.root(
    "insert into public.team_product_catalog_settings(team_id,title,description,price,image_link,updated_by) values($1,'Synthetic','Synthetic',10,'https://synthetic.invalid/image',$2)",
    [team, actor]
  );
  await db.root(
    "insert into private.catalog_image_config(team_id,mode) values($1,'v2') on conflict(team_id) do update set mode='v2'",
    [team]
  );
  const publication = (
    await db.root<{ id: string }>(
      "insert into private.catalog_image_publications(team_id,sha256,size_bytes,mime,width,height,classification,state) values($1,repeat('b',64),3,'image/png',1,1,$2,'ready') returning id",
      [team, classifyCatalogImageName('IMG_SYNTHETIC.png')]
    )
  )[0]!.id;
  await db.root(
    "update private.catalog_image_publications set public_url='https://synthetic.invalid/'||object_key where id=$1",
    [publication]
  );
  await db.root(
    'insert into public.team_catalog_image_pool_entries(team_id,publication_id,public_url,classification) select team_id,id,public_url,classification from private.catalog_image_publications where id=$1',
    [publication]
  );
  await db.asUser(actor, 'select public.set_restitch_defaults($1,$2)', [
    team,
    {
      operation: 'restitch',
      sourceMode: 'drive',
      fitMode: 'cover',
      startEnabled: false,
      endEnabled: true,
      finalDurationMode: 'custom',
      customFinalDurationSeconds: 120
    }
  ]);
  await db.root(
    "insert into public.team_restitch_sources(team_id,slot,material_id,kind,sort_order,added_by) values($1,'end',$2,'file',1,$3)",
    [team, image, actor]
  );
  await db.root(
    "insert into private.team_recovery_delegations(team_id,actor_id,installation_id,refresh_hash) values($1,$2,$3,decode(repeat('ab',32),'hex')),($1,$2,$4,decode(repeat('bc',32),'hex'))",
    [team, actor, executor, otherExecutor]
  );
}, 60000);
afterAll(async () => {
  await db?.close();
});
async function draft() {
  const config = launchConfig({
    agentRowId: agent,
    materialId: material,
    buyerId: buyer,
    offerId: offer,
    method: 'catalog',
    catalog: {
      productCount: 3,
      restitchEnabled: true,
      finalDurationMode: 'random-centered',
      customFinalDurationSeconds: 1800,
      finalDurationRangeSeconds: [600, 660],
      catalogVideoProtocolVersion: 1,
      videoVariationCount: 2,
      videoPublication: {
        mode: 'scheduled',
        localDateTime: '2030-01-01T12:00',
        timeZone: 'Europe/Kyiv',
        resolvedOffset: '+02:00',
        dueAt: '2030-01-01T10:00:00.000Z'
      }
    }
  });
  const key = 'launch-video-draft-' + ++sequence;
  const saved = (
    await db.asUser<{ v: { id: string; version: string } }>(
      actor,
      'select public.save_launch_draft($1,null,null,$2,$3,null) v',
      [team, key, config]
    )
  )[0]!.v;
  const version = await assignLaunchFixture(db, actor, team, saved.id, agent);
  const source = (
    await db.asUser<{ v: unknown }>(actor, 'select public.get_launch_sources($1,$2) v', [
      team,
      saved.id
    ])
  )[0]!.v;
  if (!parseLaunchSources(source)) throw Error('Invalid synthetic source');
  const complete = (
    await db.asUser<{ v: { version: string } }>(
      actor,
      'select public.save_launch_draft($1,$2,$3,$4,$5,$6) v',
      [team, saved.id, version, key + '-source', config, source]
    )
  )[0]!.v;
  return {
    config,
    input: {
      teamId: team,
      launchId: saved.id,
      expectedVersion: complete.version,
      requestKey: key + '-generate',
      expectedExecutorId: executor
    }
  };
}
let accepted: { id: string; state: string },
  original: {
    request_payload: Record<string, unknown>;
    initial_video_plan: Record<string, unknown>;
    settings_snapshot: Record<string, unknown>;
    video_set_id: string;
  };
let input: Awaited<ReturnType<typeof draft>>['input'];
it('atomically accepts the original Launch, canonical catalog plan and frozen N pool', async () => {
  const d = await draft();
  input = d.input;
  accepted = (await generateLaunch(
    { caller: service, service, catalogReady: async () => {}, proveSource: vi.fn() },
    input,
    actor
  )) as typeof accepted;
  expect(accepted.state).toBe('accepted');
  original = (
    await db.root<typeof original>(
      'select request_payload,initial_video_plan,settings_snapshot,video_set_id from private.launch_catalog_video_contexts where generation_id=$1',
      [accepted.id]
    )
  )[0]!;
  expect(original.request_payload).toMatchObject({
    catalogVideoProtocolVersion: 1,
    expectedExecutorId: executor,
    videoVariationCount: 2
  });
  expect(original.settings_snapshot.finalDurationRangeSeconds).toEqual([600, 660]);
  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::integer n from private.catalog_video_restitch_candidates where video_set_id=$1',
        [original.video_set_id]
      )
    )[0]!.n
  ).toBe(1);
  expect(
    (
      await db.root<{ n: number }>(
        "select count(*)::integer n from public.team_launch_generation_steps where generation_id=$1 and stable_step_key='catalog_resources' and state='succeeded'",
        [accepted.id]
      )
    )[0]!.n
  ).toBe(1);
  const store = catalogIntentStore(
    service,
    team,
    material,
    actor,
    'launch:' + accepted.id + ':catalog'
  );
  const receipt = await store.begin(original.request_payload, id(20));
  expect(receipt.checkpoint.initialVideoPlan).toEqual(original.initial_video_plan);
  await db.root(
    'update private.catalog_generation_intents set lease_owner=null,lease_expires_at=clock_timestamp() where id=$1',
    [receipt.id]
  );
});
it('reconciles the original generation after current pools/defaults change without redrawing', async () => {
  await db.root('delete from public.team_restitch_sources where team_id=$1', [team]);
  await db.asUser(actor, 'select public.set_restitch_defaults($1,$2)', [
    team,
    {
      operation: 'restitch',
      sourceMode: 'drive',
      startEnabled: false,
      endEnabled: true,
      finalDurationMode: 'custom',
      customFinalDurationSeconds: 300
    }
  ]);
  expect(
    (
      (await generateLaunch(
        {
          caller: service,
          service,
          catalogReady: async () => {
            throw Error('must not preflight replay');
          }
        },
        input,
        actor
      )) as { id: string }
    ).id
  ).toBe(accepted.id);
  expect(
    (
      await db.root<typeof original>(
        'select request_payload,initial_video_plan,settings_snapshot,video_set_id from private.launch_catalog_video_contexts where generation_id=$1',
        [accepted.id]
      )
    )[0]!
  ).toEqual(original);
});
it('blocks the legacy one-copy preparation/reuse route and projects registered counts truthfully', async () => {
  await expect(
    db.asUser(actor, 'select public.prepare_launch_restitch($1,$2)', [team, accepted.id])
  ).rejects.toThrow('WRONG_STATE');
  expect(
    (
      await db.asUser<{ v: unknown }>(actor, 'select public.get_launch_restitch_reuse($1,$2) v', [
        team,
        accepted.id
      ])
    )[0]!.v
  ).toBeNull();
  const detail = (
    await db.asUser<{ v: { generation: { progress: unknown } } }>(
      actor,
      'select public.get_launch($1,$2,null) v',
      [team, input.launchId]
    )
  )[0]!.v;
  expect(detail.generation.progress).toEqual({
    completed: 0,
    total: 2,
    unit: 'videos',
    source: 'registered_video_variants'
  });
});
it('releases a pending Launch lease and resumes only its original accepted N intent', async () => {
  const worker = 'synthetic-launch-video-worker';
  const claimed = (
    await db.root<{ v: { fence: string } }>(
      'select public.service_claim_launch_generation($1,$2,$3,$4) v',
      [team, accepted.id, actor, worker]
    )
  )[0]!.v;
  const frozen = (
    await db.root<{ v: { requestPayload: unknown } }>(
      'select public.service_read_launch_catalog_video_context($1,$2,$3,$4,$5) v',
      [team, accepted.id, actor, worker, claimed.fence]
    )
  )[0]!.v;
  expect(frozen.requestPayload).toEqual(original.request_payload);
  await db.root('select public.service_wait_launch_catalog_video($1,$2,$3,$4,$5)', [
    team,
    accepted.id,
    actor,
    worker,
    claimed.fence
  ]);
  expect(
    (
      await db.root<{ state: string; lease_owner: null; safe_error_code: null }>(
        'select state,lease_owner,safe_error_code from public.team_launch_generations where id=$1',
        [accepted.id]
      )
    )[0]!
  ).toEqual({ state: 'accepted', lease_owner: null, safe_error_code: null });
  // Pin the scheduler instant in this isolated fixture, without sleeping15s.
  await db.root(
    'update public.team_launch_generations set next_attempt_at=clock_timestamp() where id=$1',
    [accepted.id]
  );
  const due = (
    await db.root<{ v: Array<{ generationId: string }> }>(
      'select public.service_list_launch_catalog_recovery(3) v'
    )
  )[0]!.v;
  expect(due).toContainEqual(expect.objectContaining({ generationId: accepted.id }));
  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::integer n from private.catalog_video_sets where id=$1',
        [original.video_set_id]
      )
    )[0]!.n
  ).toBe(1);
});
it('fences new N work when the original Launch is canceled', async () => {
  const result = (
    await db.asUser<{ v: { state: string } }>(
      actor,
      'select public.cancel_launch_generation($1,$2,$3,$4) v',
      [team, input.launchId, accepted.id, 'launch-video-cancel-original']
    )
  )[0]!.v;
  expect(['canceled', 'cancel_requested', 'canceled_with_cleanup_pending']).toContain(result.state);
  expect(
    (
      await db.root<{ state: string }>('select state from private.catalog_video_sets where id=$1', [
        original.video_set_id
      ])
    )[0]!.state
  ).toBe('canceled');
});
it('reuses the exact READY recipe for a delay-only generation and rejects stale outputs or changed N', async () => {
  // Independent accepted generation; previous tests intentionally removed current pools.
  await db.asUser(actor, 'select public.set_restitch_defaults($1,$2)', [
    team,
    {
      configured: true,
      operation: 'restitch',
      sourceMode: 'drive',
      fitMode: 'cover',
      startEnabled: false,
      endEnabled: true,
      finalDurationMode: 'custom',
      customFinalDurationSeconds: 120
    }
  ]);
  await db.root(
    "insert into public.team_restitch_sources(team_id,slot,material_id,kind,sort_order,added_by) values($1,'end',$2,'file',1,$3) on conflict do nothing",
    [team, image, actor]
  );
  const d = await draft();
  const first = (await generateLaunch(
    { caller: service, service, catalogReady: async () => {}, proveSource: vi.fn() },
    d.input,
    actor
  )) as { id: string };
  const c = (
    await db.root<{
      initial_video_plan: Record<string, unknown>;
      video_set_id: string;
      catalog_intent_id: string;
      settings_snapshot: Record<string, unknown>;
    }>('select * from private.launch_catalog_video_contexts where generation_id=$1', [first.id])
  )[0]!;
  await db.root("update public.team_launch_generations set state='succeeded' where id=$1", [
    first.id
  ]);
  const blankCreated = (
    await db.asUser<{
      v: {
        generation: {
          videoGeneration: {
            setId: string;
            requestedCount: number;
            registeredCount: number;
            state: string;
          };
        };
      };
    }>(actor, 'select public.get_launch($1,$2,null)v', [team, d.input.launchId])
  )[0]!.v;
  expect(blankCreated.generation.videoGeneration).toMatchObject({
    setId: c.video_set_id,
    requestedCount: 2,
    registeredCount: 0,
    state: 'accepted'
  });
  const children = await db.root<{ request_id: string; video_variant_index: number }>(
    'select request_id,video_variant_index from private.catalog_video_variants where video_set_id=$1 order by video_variant_index',
    [c.video_set_id]
  );
  const connection = (
    await db.root<{ connection_id: string }>(
      'select connection_id from public.team_materials where id=$1',
      [material]
    )
  )[0]!.connection_id;
  const outputs: string[] = [];
  for (const child of children) {
    const op = crypto.randomUUID(),
      out = crypto.randomUUID();
    outputs.push(out);
    await db.root(
      "insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind,category,mime_type) values($1,$2,$3,$4,'Ready output','file','video','video/mp4')",
      [out, team, connection, 'output-' + out]
    );
    await db.root(
      "insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,result_material_id,idempotency_key,request_nonce,finished_at) values($1,$2,$3,'process','succeeded',$4,$5,$6,$6,clock_timestamp())",
      [op, team, actor, material, out, 'catalog-variant:' + child.request_id]
    );
    await db.root(
      "insert into private.team_operation_intents(operation_id,team_id,tool_id,expected_source_version,expected_source_drive_file_id,expected_source_checksum) values($1,$2,'restitch','1','synthetic-video',repeat('a',32))",
      [op, team]
    );
    await db.root(
      "update private.catalog_video_variants set state='registered',operation_id=$2,output_material_id=$3 where video_set_id=$1 and video_variant_index=$4",
      [c.video_set_id, op, out, child.video_variant_index]
    );
  }
  await db.root("update private.catalog_video_sets set state='ready' where id=$1", [
    c.video_set_id
  ]);
  await db.root("update private.catalog_generation_intents set state='registered' where id=$1", [
    c.catalog_intent_id
  ]);
  await db.root("update public.team_launch_generations set state='succeeded' where id=$1", [
    first.id
  ]);
  await db.root(
    'update public.team_launches set active_revision_id=(select revision_id from public.team_launch_generations where id=$2) where id=$1',
    [d.input.launchId, first.id]
  );
  const next = structuredClone(d.config);
  if (next.method !== 'catalog') throw Error('fixture');
  next.catalog.videoPublication = { mode: 'immediate' };
  const digest = (
    await db.root<{ settings_digest: string }>(
      'select settings_digest from private.catalog_video_sets where id=$1',
      [c.video_set_id]
    )
  )[0]!.settings_digest;
  const find = async (config = next) =>
    (
      await db.root<{ v: Record<string, unknown> | null }>(
        'select public.service_find_launch_catalog_video_reuse($1,$2,$3,$4,$5) v',
        [team, d.input.launchId, actor, config, digest]
      )
    )[0]!.v;
  expect(await find()).toMatchObject({
    plan: {
      setId: c.video_set_id,
      assignmentSeed: c.initial_video_plan.assignmentSeed,
      recipeRowIds: c.initial_video_plan.recipeRowIds,
      childRequestIds: c.initial_video_plan.childRequestIds
    }
  });
  const changed = structuredClone(next);
  changed.catalog.videoVariationCount = 3;
  expect(await find(changed)).toBeNull();
  await db.root(
    "update public.team_materials set lifecycle='trashed',trashed_at=clock_timestamp() where id=$1",
    [outputs[0]]
  );
  expect(await find()).toBeNull();
  await db.root("update public.team_materials set lifecycle='active',trashed_at=null where id=$1", [
    outputs[0]
  ]);
  const version = (
    await db.root<{ version: string }>(
      'select aggregate_version::text version from public.team_launches where id=$1',
      [d.input.launchId]
    )
  )[0]!.version;
  const source = (
    await db.asUser<{ v: unknown }>(actor, 'select public.get_launch_sources($1,$2) v', [
      team,
      d.input.launchId
    ])
  )[0]!.v;
  const saved = (
    await db.asUser<{ v: { version: string } }>(
      actor,
      'select public.save_launch_draft($1,$2,$3,$4,$5,$6) v',
      [team, d.input.launchId, version, 'delay-only-' + first.id, next, source]
    )
  )[0]!.v;
  await db.root(
    'update private.team_recovery_delegations set revoked_at=clock_timestamp() where team_id=$1 and installation_id=$2',
    [team, executor]
  );
  const second = (await generateLaunch(
    { caller: service, service, catalogReady: async () => {}, proveSource: vi.fn() },
    { ...d.input, expectedVersion: saved.version, requestKey: 'delay-only-generation-' + first.id },
    actor
  )) as { id: string };
  const reused = (
    await db.root<{
      video_set_id: string;
      catalog_intent_id: string;
      initial_video_plan: Record<string, unknown>;
    }>('select * from private.launch_catalog_video_contexts where generation_id=$1', [second.id])
  )[0]!;
  expect(reused.video_set_id).toBe(c.video_set_id);
  expect(reused.initial_video_plan.recipeRowIds).toEqual(c.initial_video_plan.recipeRowIds);
  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::integer n from private.catalog_video_recipe_references where video_set_id=$1',
        [c.video_set_id]
      )
    )[0]!.n
  ).toBe(2);
  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::integer n from private.catalog_video_variants where video_set_id=$1',
        [c.video_set_id]
      )
    )[0]!.n
  ).toBe(2);
  const bound = (
    await db.root<{ v: { catalogIntentId: string } }>(
      'select public.service_read_catalog_video_consumer_acceptance($1,$2,$3,$4) v',
      [c.video_set_id, team, actor, reused.catalog_intent_id]
    )
  )[0]!.v;
  expect(bound.catalogIntentId).toBe(reused.catalog_intent_id);
});
it('profile N patches use exact CAS and the current product bound', async () => {
  const catalog = crypto.randomUUID();
  const connection = (
    await db.root<{ connection_id: string }>(
      'select connection_id from public.team_materials where id=$1',
      [material]
    )
  )[0]!.connection_id;
  await db.root(
    "insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind,category,mime_type) values($1,$2,$3,$4,'Catalog','file','other','application/vnd.google-apps.spreadsheet')",
    [catalog, team, connection, 'profile-' + catalog]
  );
  await db.root(
    "insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot) values($1,$2,$3,'https://example.invalid/',3,'https://docs.google.com/spreadsheets/d/fixture/edit','https://drive.google.com/file/d/source/view','{}')",
    [catalog, team, material]
  );
  await db.root(
    'insert into public.team_catalog_update_profiles(catalog_material_id,team_id,refresh_images,refresh_texts,grow_products,random_link_variation,restitch) values($1,$2,true,true,false,true,false) on conflict do nothing',
    [catalog, team]
  );
  const before = (
    await db.root<{ version: number }>(
      'select version from public.team_catalog_update_profiles where catalog_material_id=$1',
      [catalog]
    )
  )[0]!.version;
  const patch = async (version: number, value: unknown) =>
    (
      await db.asUser<{ v: { videoVariantCount: number; version: number } }>(
        actor,
        'select public.patch_team_catalog_update_profile($1,$2,$3,$4) v',
        [team, catalog, version, { videoVariantCount: value }]
      )
    )[0]!.v;
  await expect(patch(before, 4)).rejects.toThrow('INVALID_INPUT');
  await expect(patch(before, 1.5)).rejects.toThrow('INVALID_INPUT');
  expect(await patch(before, 3)).toMatchObject({ videoVariantCount: 3, version: before + 1 });
  await expect(patch(before, 2)).rejects.toThrow('STALE_RESULT');
  expect(await patch(before + 1, 1)).toMatchObject({ videoVariantCount: 1, version: before + 2 });
});

it('admits manual paired-session N Launch without background delegation and binds exact original UI scope', async () => {
  const { prepareCatalogVideoForeground, catalogForegroundProofHash } =
    await import('../supabase/functions/drive-ops/catalog-video-foreground-authority');
  await db.root(
    'update private.team_recovery_delegations set revoked_at=clock_timestamp()where team_id=$1',
    [team]
  );
  await db.root(
    "insert into public.team_restitch_sources(team_id,slot,material_id,kind,sort_order,added_by)values($1,'end',$2,'file',1,$3)on conflict do nothing",
    [team, image, actor]
  );
  const d = await draft(),
    session = crypto.randomUUID(),
    native = crypto.randomUUID(),
    enrollment = crypto.randomUUID();
  await db.root('insert into auth.sessions(id,user_id)values($1,$2)', [session, actor]);
  const receipt = {
    protocolVersion: 1 as const,
    enrollmentId: enrollment,
    nativeInstanceId: native,
    proofDigest: (await catalogForegroundProofHash('f'.repeat(43))).slice(2)
  };
  const { expectedExecutorId: _executor, ...request } = d.input;
  void _executor;
  const result = (await generateLaunch(
    {
      caller: service,
      service,
      catalogReady: async () => {},
      prepareForeground: async scope => {
        await prepareCatalogVideoForeground(
          service,
          'private-synthetic-secret-at-least-32-characters',
          { ...scope, sessionId: session, consumerKind: 'launch' },
          scope.receipt
        );
        if (scope.retireUnused)
          await service.rpc('service_retire_unused_catalog_video_foreground', {
            p_enrollment: scope.receipt.enrollmentId,
            p_team: team,
            p_actor: actor
          });
      }
    },
    { ...request, foregroundExecutor: receipt },
    actor
  )) as { id: string };
  const authority = (
    await db.root<{
      video_set_id: string;
      original_key: string;
      expected_version: string;
      native_instance_id: string;
    }>(
      'select video_set_id,original_key,expected_version,native_instance_id from private.catalog_video_foreground_authorities where enrollment_id=$1',
      [enrollment]
    )
  )[0]!;
  expect(authority).toMatchObject({
    original_key: request.requestKey,
    expected_version: request.expectedVersion,
    native_instance_id: native
  });
  expect(authority.video_set_id).toEqual(expect.any(String));
  const context = (
    await db.root<{
      video_set_id: string;
      request_payload: { foregroundExecutor: unknown; expectedExecutorId?: unknown };
    }>(
      'select video_set_id,request_payload from private.launch_catalog_video_contexts where generation_id=$1',
      [result.id]
    )
  )[0]!;
  expect(context.video_set_id).toBe(authority.video_set_id);
  expect(context.request_payload.foregroundExecutor).toEqual(receipt);
  expect(context.request_payload.expectedExecutorId).toBeUndefined();

  const sourceRow = (
    await db.root<{ connection_id: string }>(
      'select connection_id from public.team_materials where id=$1',
      [material]
    )
  )[0]!;
  const catalog = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,companion_of,companion_kind)values($1,$2,$3,'Verified blank catalog','file','other','application/vnd.google-apps.spreadsheet',$4,'product_catalog')returning id",
      [team, sourceRow.connection_id, 'blank-' + result.id, material]
    )
  )[0]!.id;
  const intent = (
    await db.root<{ catalog_intent_id: string }>(
      'select catalog_intent_id from private.launch_catalog_video_contexts where generation_id=$1',
      [result.id]
    )
  )[0]!.catalog_intent_id;
  await db.root(
    "insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot,created_by)select $1,$2,$3,r.generated_url,3,'https://docs.google.com/spreadsheets/d/synthetic/edit','https://drive.google.com/file/d/source/view','{}',$4 from public.team_launch_revisions r join public.team_launch_generations g on g.revision_id=r.id where g.id=$5",
    [catalog, team, material, actor, result.id]
  );
  await db.root(
    "update private.catalog_generation_intents set state='registered',checkpoint=checkpoint||jsonb_build_object('materialId',$2::text,'sheetRows',$3::jsonb),result=jsonb_build_object('outcome','created','catalog',jsonb_build_object('materialId',$2::text))where id=$1",
    [intent, catalog, JSON.stringify(Array.from({ length: 5 }, () => []))]
  );
  const publication = (
    await db.root<{ v: { fence: string } }>(
      'select public.service_begin_initial_catalog_publication($1,$2,$3,$4)v',
      [team, actor, intent, catalog]
    )
  )[0]!.v;
  await db.root('select public.service_finish_initial_catalog_publication($1,$2,$3,$4,$5,$6,$7)', [
    team,
    actor,
    intent,
    catalog,
    publication.fence,
    'verified-synthetic-provider-revision',
    'a'.repeat(64)
  ]);
  const first = (
    await db.root<{ request_id: string }>(
      'select request_id from private.catalog_video_variants where video_set_id=$1 order by video_variant_index limit 1',
      [authority.video_set_id]
    )
  )[0]!;
  const op = crypto.randomUUID();
  await db.root(
    "insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce,finished_at)values($1,$2,$3,'process','failed',$4,$5,$5,clock_timestamp())",
    [op, team, actor, material, 'catalog-variant:' + first.request_id]
  );
  await db.root(
    "insert into private.team_operation_intents(operation_id,team_id,tool_id,expected_source_version)values($1,$2,'restitch','1')",
    [op, team]
  );
  await db.root(
    "update private.catalog_video_variants set state='unknown',operation_id=$2 where video_set_id=$1 and video_variant_index=0",
    [authority.video_set_id, op]
  );
  await db.root("update private.catalog_video_sets set state='unknown'where id=$1", [
    authority.video_set_id
  ]);
  await db.asUser(actor, 'select public.cancel_launch_generation($1,$2,$3,$4)', [
    team,
    request.launchId,
    result.id,
    crypto.randomUUID()
  ]);
  expect(['cancel_requested', 'canceled_with_cleanup_pending']).toContain(
    (
      await db.root<{ state: string }>(
        'select state from public.team_launch_generations where id=$1',
        [result.id]
      )
    )[0]!.state
  );

  await db.root('select public.service_settle_catalog_video_cancellations(10)');
  expect(
    (
      await db.root<{ state: string }>(
        'select state from public.team_launch_generations where id=$1',
        [result.id]
      )
    )[0]!.state
  ).toBe('canceled_with_cleanup_pending');
  expect(
    (
      await db.root<{ state: string }>('select state from private.catalog_video_sets where id=$1', [
        authority.video_set_id
      ])
    )[0]!.state
  ).toBe('canceled');
  expect(
    (
      await db.root<{ mode: string }>(
        'select mode from private.catalog_video_publication_policies where catalog_material_id=$1',
        [catalog]
      )
    )[0]!.mode
  ).toBe('scheduled');
  const beforeRevision = (
    await db.root<{ revision: number }>(
      'select revision from private.catalog_video_sets where id=$1',
      [authority.video_set_id]
    )
  )[0]!.revision;
  await db.db.exec(
    readFileSync(
      new URL(
        '../supabase/migrations/20261207182000_catalog_canceled_target_hold.sql',
        import.meta.url
      ),
      'utf8'
    )
  );

  canceledTargetHoldApplied = true;
  await db.root('select public.service_settle_catalog_video_cancellations(10)');
  expect(
    (
      await db.root<{ state: string }>(
        'select state from public.team_launch_generations where id=$1',
        [result.id]
      )
    )[0]!.state
  ).toBe('canceled');
  expect(
    (
      await db.root<{ state: string; revision: number }>(
        'select state,revision from private.catalog_video_sets where id=$1',
        [authority.video_set_id]
      )
    )[0]
  ).toEqual({ state: 'canceled', revision: beforeRevision });
  expect(
    (
      await db.root<{ mode: string; revision: number }>(
        'select mode,revision from private.catalog_video_publication_policies where catalog_material_id=$1',
        [catalog]
      )
    )[0]
  ).toEqual({ mode: 'held', revision: 2 });
  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::integer n from private.catalog_video_publication_jobs where catalog_material_id=$1 and(writer_fence is not null or dispatched_at is not null)',
        [catalog]
      )
    )[0]!.n
  ).toBe(0);
  const target = { kind: 'video_set', videoSetId: authority.video_set_id, recipeRevision: 1 };
  for (const mode of ['immediate', 'scheduled', 'held'])
    await expect(
      db.root('select public.service_save_catalog_publication($1,$2,$3,$4,2,$5,$6,$7,$8)', [
        team,
        actor,
        crypto.randomUUID(),
        catalog,
        mode,
        mode === 'scheduled' ? '2030-01-02T00:00:00Z' : null,
        mode === 'scheduled' ? 'UTC' : null,
        mode === 'held' ? { ...target, recipeRevision: 99 } : target
      ])
    ).rejects.toThrow('WRONG_STATE');
  await db.root('select public.service_settle_catalog_video_cancellations(10)');
  expect(
    (
      await db.root<{ mode: string; revision: number }>(
        'select mode,revision from private.catalog_video_publication_policies where catalog_material_id=$1',
        [catalog]
      )
    )[0]
  ).toEqual({ mode: 'held', revision: 2 });
  expect(
    (
      await db.root<{ state: string }>(
        'select lifecycle state from public.team_materials where id=$1',
        [catalog]
      )
    )[0]!.state
  ).toBe('active');
});

it('waits truthfully for exact healthy N then settles the same registered catalog after READY', async () => {
  if (!canceledTargetHoldApplied) {
    await db.db.exec(
      readFileSync(
        new URL(
          '../supabase/migrations/20261207182000_catalog_canceled_target_hold.sql',
          import.meta.url
        ),
        'utf8'
      )
    );
    canceledTargetHoldApplied = true;
  }
  const { prepareCatalogVideoForeground, catalogForegroundProofHash } =
    await import('../supabase/functions/drive-ops/catalog-video-foreground-authority');
  const d = await draft(),
    session = crypto.randomUUID(),
    native = crypto.randomUUID(),
    enrollment = crypto.randomUUID();
  await db.root('insert into auth.sessions(id,user_id)values($1,$2)', [session, actor]);
  const receipt = {
    protocolVersion: 1 as const,
    enrollmentId: enrollment,
    nativeInstanceId: native,
    proofDigest: (await catalogForegroundProofHash('h'.repeat(43))).slice(2)
  };
  const { expectedExecutorId: previousExecutor, ...request } = d.input;
  void previousExecutor;
  const accepted = (await generateLaunch(
    {
      caller: service,
      service,
      catalogReady: async () => {},
      prepareForeground: async scope => {
        await prepareCatalogVideoForeground(
          service,
          'private-synthetic-secret-at-least-32-characters',
          { ...scope, sessionId: session, consumerKind: 'launch' },
          scope.receipt
        );
      }
    },
    { ...request, foregroundExecutor: receipt },
    actor
  )) as { id: string };
  const context = (
    await db.root<{ catalog_intent_id: string; video_set_id: string }>(
      'select catalog_intent_id,video_set_id from private.launch_catalog_video_contexts where generation_id=$1',
      [accepted.id]
    )
  )[0]!;
  const connection = (
    await db.root<{ connection_id: string }>(
      'select connection_id from public.team_materials where id=$1',
      [material]
    )
  )[0]!.connection_id;
  const catalog = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,companion_of,companion_kind)values($1,$2,$3,'Ready waiting catalog','file','other','application/vnd.google-apps.spreadsheet',$4,'product_catalog')returning id",
      [team, connection, 'waiting-' + accepted.id, material]
    )
  )[0]!.id;
  await db.root(
    "insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot,created_by,variant)select $1,$2,$3,r.generated_url,3,'https://docs.google.com/spreadsheets/d/synthetic-wait/edit','https://drive.google.com/file/d/source/view','{}',$4,i.variant from public.team_launch_revisions r join public.team_launch_generations g on g.revision_id=r.id join private.catalog_generation_intents i on i.id=$6 where g.id=$5",
    [catalog, team, material, actor, accepted.id, context.catalog_intent_id]
  );
  await db.root(
    "update private.catalog_generation_intents set state='registered',checkpoint=checkpoint||jsonb_build_object('materialId',$2::text,'sheetRows',$3::jsonb),result=jsonb_build_object('outcome','created','catalog',jsonb_build_object('materialId',$2::text))where id=$1",
    [context.catalog_intent_id, catalog, JSON.stringify(Array.from({ length: 5 }, () => []))]
  );
  const proof = (
    await db.root<{ v: { fence: string } }>(
      'select public.service_begin_initial_catalog_publication($1,$2,$3,$4)v',
      [team, actor, context.catalog_intent_id, catalog]
    )
  )[0]!.v;
  await db.root('select public.service_finish_initial_catalog_publication($1,$2,$3,$4,$5,$6,$7)', [
    team,
    actor,
    context.catalog_intent_id,
    catalog,
    proof.fence,
    'verified-waiting-provider',
    'b'.repeat(64)
  ]);
  await db.root(
    "update public.team_launch_generations set next_attempt_at='infinity'where team_id=$1 and id<>$2",
    [team, accepted.id]
  );
  await db.root('select public.service_settle_launch_batch(10)');
  expect(
    (
      await db.root<{ state: string; safe_error_code: string }>(
        'select state,safe_error_code from public.team_launch_generations where id=$1',
        [accepted.id]
      )
    )[0]
  ).toEqual({ state: 'interrupted', safe_error_code: 'UNKNOWN' });
  await db.db.exec(
    readFileSync(
      new URL(
        '../supabase/migrations/20261207183000_launch_catalog_video_dependency_wait.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
  await db.root(
    'update public.team_launch_generations set next_attempt_at=clock_timestamp(),lease_expires_at=clock_timestamp()where id=$1',
    [accepted.id]
  );
  await db.root('select public.service_settle_launch_batch(10)');
  expect(
    (
      await db.root<{ state: string; safe_error_code: null; bounded: boolean }>(
        "select state,safe_error_code,next_attempt_at<clock_timestamp()+interval '30 seconds'bounded from public.team_launch_generations where id=$1",
        [accepted.id]
      )
    )[0]
  ).toEqual({ state: 'accepted', safe_error_code: null, bounded: true });
  const original = await db.root<{ request_id: string }>(
    'select request_id from private.catalog_video_variants where video_set_id=$1 order by video_variant_index',
    [context.video_set_id]
  );
  await db.root("update private.catalog_video_sets set state='unknown'where id=$1", [
    context.video_set_id
  ]);
  await db.root(
    'update public.team_launch_generations set next_attempt_at=clock_timestamp()where id=$1',
    [accepted.id]
  );
  await db.root('select public.service_settle_launch_batch(10)');
  expect(
    (
      await db.root<{ state: string }>(
        'select state from public.team_launch_generations where id=$1',
        [accepted.id]
      )
    )[0]!.state
  ).toBe('interrupted');

  // Transient failed-child and invalid-plan states must never be classified as healthy waiting.
  await db.root('begin');
  try {
    const failed = crypto.randomUUID();
    await db.root(
      "insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce,finished_at)values($1,$2,$3,'process','failed',$4,$5,$5,clock_timestamp())",
      [failed, team, actor, material, 'catalog-variant:' + original[0]!.request_id]
    );
    await db.root(
      "insert into private.team_operation_intents(operation_id,team_id,tool_id,expected_source_version)values($1,$2,'restitch','1')",
      [failed, team]
    );
    await db.root("update private.catalog_video_sets set state='preparing'where id=$1", [
      context.video_set_id
    ]);
    await db.root(
      "update private.catalog_video_variants set state='working',operation_id=$2 where video_set_id=$1 and video_variant_index=0",
      [context.video_set_id, failed]
    );
    await db.root(
      "update public.team_launch_generations set state='accepted',next_attempt_at=clock_timestamp(),lease_expires_at=clock_timestamp()where id=$1",
      [accepted.id]
    );
    await db.root('select public.service_settle_launch_batch(10)');
    expect(
      (
        await db.root<{ state: string }>(
          'select state from public.team_launch_generations where id=$1',
          [accepted.id]
        )
      )[0]!.state
    ).toBe('interrupted');
  } finally {
    await db.root('rollback');
  }
  await db.root('begin');
  try {
    await db.root("update private.catalog_video_sets set state='preparing'where id=$1", [
      context.video_set_id
    ]);
    await db.root(
      "update private.catalog_generation_intents set checkpoint=jsonb_set(checkpoint,'{initialVideoPlan,childRequestIds}','[]')where id=$1",
      [context.catalog_intent_id]
    );
    await db.root(
      "update public.team_launch_generations set state='accepted',next_attempt_at=clock_timestamp(),lease_expires_at=clock_timestamp()where id=$1",
      [accepted.id]
    );
    await db.root('select public.service_settle_launch_batch(10)');
    expect(
      (
        await db.root<{ state: string }>(
          'select state from public.team_launch_generations where id=$1',
          [accepted.id]
        )
      )[0]!.state
    ).toBe('failed');
  } finally {
    await db.root('rollback');
  }
  const children = [];
  for (const [index, child] of original.entries()) {
    const op = crypto.randomUUID(),
      output = (
        await db.root<{ id: string }>(
          "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,size_bytes)values($1,$2,$3,'Output.mp4','file','video','video/mp4',4)returning id",
          [team, connection, 'ready-' + op]
        )
      )[0]!.id;
    await db.root(
      "insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,result_material_id,idempotency_key,request_nonce,finished_at)values($1,$2,$3,'process','succeeded',$4,$5,$6,$6,clock_timestamp())",
      [op, team, actor, material, output, 'catalog-variant:' + child.request_id]
    );
    await db.root(
      "insert into private.team_operation_intents(operation_id,team_id,tool_id,expected_source_version)values($1,$2,'restitch','1')",
      [op, team]
    );
    children.push({
      index,
      requestId: child.request_id,
      operationId: op,
      state: 'registered',
      outputId: output
    });
  }
  const revision = (
    await db.root<{ revision: number }>(
      'select revision from private.catalog_video_sets where id=$1',
      [context.video_set_id]
    )
  )[0]!.revision;
  await db.root('select public.service_checkpoint_catalog_video_set($1,$2,$3,$4,1,$5,$6)', [
    context.video_set_id,
    team,
    actor,
    enrollment,
    revision,
    children
  ]);
  await db.root(
    'update public.team_launch_generations set next_attempt_at=clock_timestamp(),lease_expires_at=clock_timestamp()where id=$1',
    [accepted.id]
  );
  await db.root('select public.service_settle_launch_batch(10)');
  expect(
    (
      await db.root<{ state: string }>(
        'select state from public.team_launch_generations where id=$1',
        [accepted.id]
      )
    )[0]!.state
  ).toBe('succeeded');
  expect(
    (
      await db.root<{ material_id: string }>(
        'select c.material_id from public.team_launch_revision_catalogs c join public.team_launch_generations g on g.revision_id=c.revision_id where g.id=$1',
        [accepted.id]
      )
    )[0]!.material_id
  ).toBe(catalog);
  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::integer n from public.team_product_catalogs where material_id=$1',
        [catalog]
      )
    )[0]!.n
  ).toBe(1);
});
