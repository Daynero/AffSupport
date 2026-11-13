import { beforeAll, afterAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import { assignLaunchFixture } from './support/launch-assignment';
import { launchConfig } from './fixtures/launches';
import { classifyCatalogImageName } from '../packages/shared/src/team/catalog-images';
import {
  acceptLaunchBatch,
  recoverLaunchBatchAdmission
} from '../supabase/functions/drive-ops/launch-batch';
import { parseDurableLaunchBatch } from '../packages/shared/src/team/launch-batch';
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
const names = new Set([
  'service_claim_launch_batch_admission_recovery',
  'service_retry_launch_batch_admission',
  'service_launch_batch_context',
  'service_accept_launch_batch',
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
    if (name === 'service_launch_worker_ready') return { data: true, error: null };
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
    throughMigration: '20261207401200_catalog_background_fair_claims.sql'
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
  await db.root(
    "insert into private.team_recovery_credentials(hash,delegation_id,version,audience,expires_at)select decode(repeat('aa',32),'hex'),id,version,'claim',clock_timestamp()+interval '1 hour'from private.team_recovery_delegations where installation_id=$1",
    [executor]
  );
}, 60000);
afterAll(async () => {
  await db?.close();
});
async function draft(legacy = false) {
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
  if (legacy) {
    delete config.catalog.catalogVideoProtocolVersion;
    delete config.catalog.videoVariationCount;
    delete config.catalog.videoPublication;
  }
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

const native = id(20),
  reboot = id(21),
  hash = Buffer.from('aa'.repeat(32), 'hex');
async function batch(legacy = false) {
  const d = await draft(legacy);
  return acceptLaunchBatch(service, actor, {
    teamId: team,
    expectedActorId: actor,
    expectedExecutorId: executor,
    requestKey: crypto.randomUUID(),
    items: [
      {
        launchId: d.input.launchId,
        expectedVersion: d.input.expectedVersion,
        childRequestKey: crypto.randomUUID()
      }
    ]
  });
}
async function claim(boot = native) {
  return (
    await db.root<{ v: { setId: string | null } }>(
      'select public.service_claim_catalog_video_set($1,$2,1)v',
      [hash, boot]
    )
  )[0]!.v.setId;
}
async function cancel(key: string) {
  return parseDurableLaunchBatch(
    (
      await db.asUser<{ v: unknown }>(actor, 'select public.cancel_launch_batch($1,$2,$3,$4)v', [
        team,
        key,
        crypto.randomUUID(),
        actor
      ])
    )[0]!.v
  )!;
}
it('normalizes catalog protocol defaults atomically and freezes one complete video plan', async () => {
  const accepted = await batch(true),
    member = accepted.items[0]!;
  expect(member.admission).toBe('accepted');
  expect(member.generation!.videoGeneration).toMatchObject({
    requestedCount: 1,
    registeredCount: 0,
    state: 'accepted'
  });
  const config = (
    await db.root<{ draft_config: Record<string, unknown> }>(
      'select draft_config from public.team_launches where id=$1',
      [member.launchId]
    )
  )[0]!.draft_config;
  expect(config.catalog).toMatchObject({
    catalogVideoProtocolVersion: 1,
    videoVariationCount: 1,
    videoPublication: { mode: 'immediate' }
  });
  await cancel(accepted.requestKey);
});
it('keeps a catalog provider cooldown across stale generation claims and rejects a stale owner', async () => {
  const accepted = await batch();
  const generation = accepted.items[0]!.generationId!;
  const owner = crypto.randomUUID();
  const claimArgs = [team, generation, actor, owner];
  const claimed = (
    await db.root<{ v: { fence: string } }>(
      'select public.service_claim_launch_generation($1,$2,$3,$4)v',
      claimArgs
    )
  )[0]!.v;
  const interrupt =
    'select public.service_interrupt_launch_generation_with_backoff($1,$2,$3,$4,$5,$6,$7)';
  await expect(
    db.root(interrupt, [
      team,
      generation,
      actor,
      'stale-owner',
      claimed.fence,
      'RATE_LIMITED',
      3_600_000
    ])
  ).rejects.toThrow('LEASE_MISMATCH');
  await db.root(interrupt, [...claimArgs, claimed.fence, 'RATE_LIMITED', 3_600_000]);
  const row = (
    await db.root<{ state: string; seconds: number }>(
      'select state,extract(epoch from next_attempt_at-clock_timestamp())::float8 seconds from public.team_launch_generations where id=$1',
      [generation]
    )
  )[0]!;
  expect(row.state).toBe('interrupted');
  expect(row.seconds).toBeGreaterThan(3590);
  expect(row.seconds).toBeLessThanOrEqual(3600);
  await expect(
    db.root('select public.service_claim_launch_generation($1,$2,$3,$4)', claimArgs)
  ).rejects.toThrow('NO_WORK');
  await db.root(
    "update public.team_launch_generations set next_attempt_at=clock_timestamp()-interval '1 minute' where id=$1",
    [generation]
  );
  expect(
    (
      await db.root<{ v: { state: string } }>(
        'select public.service_claim_launch_generation($1,$2,$3,$4)v',
        claimArgs
      )
    )[0]!.v.state
  ).toBe('running');
  await cancel(accepted.requestKey);
});

it('paces an uncertain oldest set so new independent work receives a claim', async () => {
  const stalled = await batch(),
    fresh = await batch();
  const stalledSet = stalled.items[0]!.generation!.videoGeneration!.setId,
    freshSet = fresh.items[0]!.generation!.videoGeneration!.setId;
  await db.root(
    "update private.catalog_video_sets set state='unknown',created_at=clock_timestamp()-interval '1 hour'where id=$1",
    [stalledSet]
  );
  expect(await claim()).toBe(stalledSet);
  expect(await claim()).toBe(freshSet);
  expect(await claim()).toBeNull();
  await cancel(stalled.requestKey);
  await cancel(fresh.requestKey);
});
it('adopts a quiescent same-installation old boot only after the silence horizon and fences the old boot', async () => {
  const accepted = await batch(),
    set = accepted.items[0]!.generation!.videoGeneration!.setId;
  expect(await claim()).toBe(set);
  await db.root(
    "update private.catalog_background_claim_schedule set next_attempt_at=clock_timestamp()-interval '1 second'where set_id=$1",
    [set]
  );
  expect(await claim(reboot)).toBeNull();
  await db.root(
    "update private.catalog_video_sets set updated_at=clock_timestamp()-interval '3 minutes'where id=$1",
    [set]
  );
  await db.root(
    "update private.catalog_background_claim_schedule set next_attempt_at=clock_timestamp()-interval '1 second'where set_id=$1",
    [set]
  );
  expect(await claim(reboot)).toBe(set);
  await expect(
    db.root('select public.service_authorize_catalog_video_executor($1,$2,$3,1)', [
      set,
      hash,
      native
    ])
  ).rejects.toThrow('PERMISSION_DENIED');
  expect(
    (
      await db.root<{ native_instance_id: string; epoch: number }>(
        'select native_instance_id,epoch from private.catalog_video_sets where id=$1',
        [set]
      )
    )[0]!
  ).toMatchObject({ native_instance_id: reboot, epoch: 2 });
  await cancel(accepted.requestKey);
});
it('keeps consumed execution authority fenced and still claims the next set after restart', async () => {
  const blocked = await batch(),
    set = blocked.items[0]!.generation!.videoGeneration!.setId;
  expect(await claim()).toBe(set);
  const request = (
    await db.root<{ request_id: string }>(
      'select request_id from private.catalog_video_variants where video_set_id=$1 and video_variant_index=0',
      [set]
    )
  )[0]!.request_id;
  const operation = (
    await db.root<{ id: string }>(
      "insert into public.team_operations(team_id,actor_id,kind,state,idempotency_key,request_nonce,source_material_id)values($1,$2,'process','running',$3,gen_random_uuid()::text,$4)returning id",
      [team, actor, 'catalog-variant:' + request, material]
    )
  )[0]!.id;
  await db.root(
    'insert into private.team_recovery_execution_fences(operation_id,team_id,actor_id,job_id)values($1,$2,$3,$4)',
    [operation, team, actor, request]
  );
  await db.root(
    "update private.catalog_video_sets set updated_at=clock_timestamp()-interval '3 minutes'where id=$1",
    [set]
  );
  await db.root(
    "update private.catalog_background_claim_schedule set next_attempt_at=clock_timestamp()-interval '1 second'where set_id=$1",
    [set]
  );
  const sibling = await batch(),
    siblingSet = sibling.items[0]!.generation!.videoGeneration!.setId;
  expect(await claim(reboot)).toBe(siblingSet);
  expect(await claim(reboot)).toBeNull();
  expect(
    (
      await db.root<{ native_instance_id: string }>(
        'select native_instance_id from private.catalog_video_sets where id=$1',
        [set]
      )
    )[0]!.native_instance_id
  ).toBe(native);
  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::int n from private.team_recovery_execution_fences where operation_id=$1',
        [operation]
      )
    )[0]!.n
  ).toBe(1);
  await cancel(blocked.requestKey);
  await cancel(sibling.requestKey);
});
it('retains cancellation intent for an uncertain created catalog while canceling siblings', async () => {
  const pending = await batch(),
    set = pending.items[0]!.generation!.videoGeneration!.setId;
  // A parent can be committed while its scheduled videos remain unfinished.
  // An incomplete publication proof must defer cancellation, never roll it back.
  await db.root("update public.team_launch_generations set state='succeeded'where id=$1", [
    pending.items[0]!.generationId
  ]);
  const receipt = await cancel(pending.requestKey);
  expect(receipt.items[0]).toMatchObject({ cancelPending: true, cancelErrorCode: 'WRONG_STATE' });
  expect(receipt.items[0]!.generation!.videoGeneration!.state).toBe('accepted');
  await db.root("update private.catalog_video_sets set state='canceled'where id=$1", [set]);
  await db.root(
    "update private.launch_batch_items set cancel_next_attempt_at=clock_timestamp()-interval '1 second'where batch_id=$1",
    [receipt.id]
  );
  expect(
    (
      await db.root<{ v: number }>('select public.service_settle_launch_batch_cancellations(3)v')
    )[0]!.v
  ).toBe(1);
  const settled = parseDurableLaunchBatch(
    (
      await db.asUser<{ v: unknown }>(actor, 'select public.get_launch_batch($1,$2)v', [
        team,
        pending.requestKey
      ])
    )[0]!.v
  )!;
  expect(settled.items[0]).toMatchObject({ cancelPending: false, cancelErrorCode: null });
});

it('keeps missing background setup pending and starts it automatically when the expected installation enrolls', async () => {
  const d = await draft(),
    newExecutor = id(88),
    input = {
      teamId: team,
      expectedActorId: actor,
      expectedExecutorId: newExecutor,
      requestKey: crypto.randomUUID(),
      items: [
        {
          launchId: d.input.launchId,
          expectedVersion: d.input.expectedVersion,
          childRequestKey: crypto.randomUUID()
        }
      ]
    };
  const accepted = await acceptLaunchBatch(service, actor, input);
  expect(accepted.items[0]).toMatchObject({
    admission: 'pending',
    generation: null,
    errorCode: 'AGENT_REQUIRED'
  });
  await db.root(
    "insert into private.team_recovery_delegations(team_id,actor_id,installation_id,refresh_hash)values($1,$2,$3,decode(repeat('cd',32),'hex'))",
    [team, actor, newExecutor]
  );
  await db.root(
    "update private.launch_batch_items set admission_next_attempt_at=clock_timestamp()-interval '1 second'where batch_id=$1",
    [accepted.id]
  );
  const ready = await recoverLaunchBatchAdmission(service);
  expect(ready!.items[0]!.admission).toBe('accepted');
  expect(
    (
      await db.root<{ executor_id: string }>(
        'select executor_id from private.catalog_video_sets where id=$1',
        [ready!.items[0]!.generation!.videoGeneration!.setId]
      )
    )[0]!.executor_id
  ).toBe(newExecutor);
  await cancel(input.requestKey);
});

it('preserves a definitive source refusal from catalog metadata instead of retrying it forever', async () => {
  const d = await draft();
  const unavailable: ServiceRpcClient = {
    rpc: (name, args) =>
      name === 'service_initial_catalog_video_context'
        ? Promise.resolve({ data: null, error: { message: 'SOURCE_CHANGED' } })
        : service.rpc(name, args)
  };
  const receipt = await acceptLaunchBatch(unavailable, actor, {
    teamId: team,
    expectedActorId: actor,
    expectedExecutorId: executor,
    requestKey: crypto.randomUUID(),
    items: [
      {
        launchId: d.input.launchId,
        expectedVersion: d.input.expectedVersion,
        childRequestKey: crypto.randomUUID()
      }
    ]
  });
  expect(receipt.items[0]).toMatchObject({
    admission: 'refused',
    errorCode: 'SOURCE_CHANGED',
    generation: null
  });
});
