import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  applyMigrationsAfter,
  createTeamTestDb,
  createUser,
  type TeamTestDb
} from './support/team-db';
import { launchConfig } from './fixtures/launches';
import { assignLaunchFixture } from './support/launch-assignment';
import { launchPreview, parseLaunchSources } from '../packages/shared/src/team/launches';

/**
 * Release 1.4.3 reaches production as one jump: production stopped at
 * 20261207192000, and every later migration lands in a single push. The other
 * suites build the 1.4.3 schema first and only then write their fixtures, so a
 * one-shot repair never meets data written under the old schema.
 *
 * Here the shapes production was stuck in on 2026-11-11 are written under the
 * 1.4.2 schema, the 1.4.3 migrations are applied over them in version order,
 * and one tick of the per-minute settlement must close every one.
 */
const PRODUCTION_HEAD = '20261207192000_catalog_registry_video_wait_reason.sql';

let db: TeamTestDb, team: string, material: string, agent: string, buyer: string, offer: string;
let source: string, connection: string, folder: string;
let seq = 0;
const ACTOR = '75000000-0000-4000-8000-000000000001',
  executor = '75000000-0000-4000-8000-000000000002',
  native = '75000000-0000-4000-8000-000000000003',
  hash = Buffer.alloc(32, 0xa7);

const fixtures: Record<string, Record<string, string>> = {};
let applied: { file: string; ms: number }[] = [];
const stuckBefore: { name: string; state: string }[] = [];

beforeAll(async () => {
  db = await createTeamTestDb({ throughMigration: PRODUCTION_HEAD });
  await createUser(db, { id: ACTOR, email: 'upgrade-143@example.invalid' });
  await db.root('insert into public.admin_users(user_id) values ($1)', [ACTOR]);
  team = (
    await db.asUser<{ id: string }>(ACTOR, "select id from public.create_team('Upgrade 1.4.3')")
  )[0]!.id;
  const account = (
    await db.root<{ id: string }>(
      "insert into public.team_accounts(team_id,created_by,name) values($1,$2,'g1') returning id",
      [team, ACTOR]
    )
  )[0]!.id;
  agent = (
    await db.root<{ id: string }>(
      "insert into public.team_account_agents(team_id,account_id,created_by,agent_id) values($1,$2,$3,'1234567893') returning id",
      [team, account, ACTOR]
    )
  )[0]!.id;
  const credential = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('perm-upgrade','upgrade@example.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
      [ACTOR]
    )
  )[0]!.id;
  connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values($1,$2,'root','Root','my_drive','connected',now()) returning id",
      [team, credential]
    )
  )[0]!.id;
  folder = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) values($1,$2,'folder','Videos','folder',null,'application/vnd.google-apps.folder','1') returning id",
      [team, connection]
    )
  )[0]!.id;
  material = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) values($1,$2,'launch-video','v5.mp4','file','video','video/mp4','1') returning id",
      [team, connection]
    )
  )[0]!.id;
  source = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,size_bytes,checksum,drive_version) values($1,$2,'source','Source.mp4','file','video','video/mp4',4,repeat('a',32),'1') returning id",
      [team, connection]
    )
  )[0]!.id;
  buyer = (
    await db.asUser<{ v: { id: string } }>(
      ACTOR,
      "select public.create_launch_dictionary($1,'buyers','patrik','upgrade-buyer-001') v",
      [team]
    )
  )[0]!.v.id;
  offer = (
    await db.asUser<{ v: { id: string } }>(
      ACTOR,
      "select public.create_launch_dictionary($1,'offers','ProCaps TR','upgrade-offer-001') v",
      [team]
    )
  )[0]!.v.id;
  await db.root(
    "insert into public.team_product_catalog_settings(team_id,title,description,price,image_link,updated_by) values($1,'Launch product','Synthetic description',10,'https://example.invalid/image.jpg',$2)",
    [team, ACTOR]
  );
  const delegation = (
    await db.root<{ id: string }>(
      'insert into private.team_recovery_delegations(team_id,actor_id,installation_id,refresh_hash)values($1,$2,$3,$4)returning id',
      [team, ACTOR, executor, Buffer.alloc(32, 0xbf)]
    )
  )[0]!.id;
  await db.root(
    "insert into private.team_recovery_credentials(hash,delegation_id,version,audience,expires_at)values($1,$2,1,'claim',clock_timestamp()+interval '1 hour')",
    [hash, delegation]
  );

  // ---- production shapes, written under the 1.4.2 schema ----
  fixtures.owner = await catalogLaunch('working'); // 09d136d7
  fixtures.unknown = await catalogLaunch('unknown'); // 047260ac
  fixtures.registered = await restitchLaunchRegistered(); // 3465db89
  fixtures.unproven = await restitchLaunchUnproven(); // 1acf114d
  fixtures.attention = await creationAttention(); // fa708f8e
  fixtures.opless = await opLessCanceledCreation(); // aab5870c / ce003cbb
  fixtures.stuckUnknown = await opLessActiveCreation(); // repaired by 320000
  fixtures.poisoned = await poisonedActiveCreation(); // its repair raises
  fixtures.reservation = await terminalReservation(); // released by 320000

  // Under 1.4.2 the same ticks leave every one of them where production found it.
  await db.root('select public.service_settle_catalog_video_cancellations(10)');
  for (const name of ['registered', 'unproven'] as const)
    await db.root(
      "update public.team_launch_generations set next_attempt_at=clock_timestamp()-interval '1 second',lease_expires_at=null,lease_owner=null where id=$1",
      [fixtures[name]!.generation]
    );
  await db.root('select public.service_settle_launch_restitch_cancellations(10)');
  for (const name of ['owner', 'unknown', 'attention', 'opless'])
    stuckBefore.push({ name: `${name} set`, state: await setState(fixtures[name]!.set!) });
  for (const name of ['owner', 'unknown', 'registered', 'unproven'])
    stuckBefore.push({
      name: `${name} generation`,
      state: await generationState(fixtures[name]!.generation!)
    });

  applied = await applyMigrationsAfter(db, PRODUCTION_HEAD);
}, 600000);
afterAll(async () => {
  await db?.close();
});

/** The operations table stamps updated_at on every write; age it past that trigger. */
const age = async (op: string, interval: string) => {
  await db.root('set session_replication_role = replica');
  try {
    await db.root(
      "update public.team_operations set created_at=clock_timestamp()-$2::interval-interval '1 minute',updated_at=clock_timestamp()-$2::interval,finished_at=case when state in('failed','canceled','succeeded') then clock_timestamp()-$2::interval else finished_at end where id=$1",
      [op, interval]
    );
  } finally {
    await db.root('set session_replication_role = origin');
  }
};

async function acceptSet(count: number) {
  const set = crypto.randomUUID(),
    requests = Array.from({ length: count }, () => crypto.randomUUID()),
    key = 'upgrade:' + set;
  const intent = (
    await db.root<{ v: { id: string } }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6)v',
      [team, source, ACTOR, key, {}, executor]
    )
  )[0]!.v.id;
  await db.root('select public.service_accept_catalog_video_set($1,$2,$3,$4,$5,$6)', [
    team,
    ACTOR,
    executor,
    {
      setId: set,
      catalogIntentId: intent,
      sourceMaterialId: source,
      sourceVersion: '1',
      settings: { configured: true, operation: 'restitch', sourceMode: 'legacy' },
      settingsDigest: 'a'.repeat(64),
      requestedCount: count,
      productCount: count,
      recipeRevision: 1,
      seed: 'b'.repeat(64)
    },
    requests.map((requestId, index) => ({ index, requestId })),
    requests.map((_, index) => ({ recipeRowId: crypto.randomUUID(), videoVariantIndex: index }))
  ]);
  await db.root(
    "update private.catalog_generation_intents set checkpoint=jsonb_build_object('initialVideoPlan',jsonb_build_object('setId',$2::text)),request_payload=request_payload||'{\"catalogVideoProtocolVersion\":1}'::jsonb where id=$1",
    [intent, set]
  );
  return { set, intent, requests };
}

async function runningVariant(set: string, requests: string[], index: number) {
  const op = crypto.randomUUID();
  await db.root(
    "insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce)values($1,$2,$3,'process','running',$4,$5,$5)",
    [op, team, ACTOR, source, 'catalog-variant:' + requests[index]]
  );
  await db.root(
    "insert into private.team_operation_intents(operation_id,team_id,tool_id,expected_source_version,expected_source_drive_file_id,expected_source_checksum,expected_name,expected_size,mime_type)values($1,$2,'restitch','1','source',repeat('a',32),'copy.mp4',4,'video/mp4')",
    [op, team]
  );
  const revision = Number(
    (
      await db.root<{ revision: string }>(
        'select revision from private.catalog_video_sets where id=$1',
        [set]
      )
    )[0]!.revision
  );
  await db.root('select public.service_checkpoint_catalog_video_set($1,$2,$3,$4,1,$5,$6)', [
    set,
    team,
    ACTOR,
    executor,
    revision,
    requests.map((requestId, i) =>
      i === index
        ? { index: i, requestId, operationId: op, state: 'working', outputId: null }
        : { index: i, requestId, operationId: null, state: 'queued', outputId: null }
    )
  ]);
  return op;
}

async function registerVariant(set: string, index: number) {
  const output = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) values($1,$2,$3,$4,'file','video','video/mp4','1') returning id",
      [team, connection, `variant-${set}-${index}`, `catalog_variant_${index}.mp4`]
    )
  )[0]!.id;
  await db.root(
    "update private.catalog_video_variants set state='registered',output_material_id=$3 where video_set_id=$1 and video_variant_index=$2",
    [set, index, output]
  );
}

async function catalogLaunch(shape: 'working' | 'unknown') {
  const { set, intent, requests } = await acceptSet(5);
  const op = await runningVariant(set, requests, 3);
  // Both were handed to an agent: without the execution fence 1.4.2 already
  // settles the unknown shape, and production's 047260ac stayed open for a day.
  await db.root('select public.service_dispatch_catalog_video_variant($1,$2,$3,1,3,$4,$5)', [
    set,
    hash,
    native,
    requests[3],
    op
  ]);
  for (const index of [0, 1, 2]) await registerVariant(set, index);
  if (shape === 'unknown')
    await db.root(
      "update private.catalog_video_variants set state='unknown' where video_set_id=$1 and video_variant_index=3",
      [set]
    );
  await age(op, '2 hours');
  await db.root("update private.catalog_video_sets set state='cancel_requested' where id=$1", [
    set
  ]);
  const launch = (
    await db.root<{ id: string }>(
      'insert into public.team_launches(team_id,created_by)values($1,$2)returning id',
      [team, ACTOR]
    )
  )[0]!.id;
  const launchRevision = (
    await db.root<{ id: string }>(
      "insert into public.team_launch_revisions(team_id,launch_id,revision_no,result_kind,config,sources,original_url,generated_url,sub_values,created_by)values($1,$2,1,'generated','{}','{}','https://example.invalid/','https://example.invalid/','{}',$3)returning id",
      [team, launch, ACTOR]
    )
  )[0]!.id;
  const generation = crypto.randomUUID();
  await db.root(
    "insert into public.team_launch_generations(id,team_id,launch_id,revision_id,actor_id,request_key,request_digest,input_version,state,stage,cancel_requested_at)values($1,$2,$3,$4,$5,$6,'digest','v1','canceled_with_cleanup_pending','cleanup',clock_timestamp()-interval '2 hours')",
    [generation, team, launch, launchRevision, ACTOR, 'upgrade-' + generation]
  );
  await db.root(
    "insert into private.launch_catalog_video_contexts(generation_id,team_id,actor_id,settings_snapshot,request_payload,initial_video_plan,catalog_intent_id,video_set_id)select $1,team_id,actor_id,'{}',request_payload,checkpoint->'initialVideoPlan',id,$3 from private.catalog_generation_intents where id=$2",
    [generation, intent, set]
  );
  return { set, op, generation };
}

async function restitchLaunch() {
  const config = launchConfig({
    agentRowId: agent,
    materialId: material,
    buyerId: buyer,
    offerId: offer,
    method: 'catalog',
    catalog: {
      productCount: 100,
      restitchEnabled: true,
      finalDurationMode: 'custom',
      customFinalDurationSeconds: 120
    }
  });
  const key = `upgrade-draft-${++seq}`;
  const saved = (
    await db.asUser<{ v: { id: string; version: string } }>(
      ACTOR,
      'select public.save_launch_draft($1,null,null,$2,$3,null) v',
      [team, key, JSON.stringify(config)]
    )
  )[0]!.v;
  const assigned = await assignLaunchFixture(db, ACTOR, team, saved.id, agent);
  const sources = (
    await db.asUser<{ v: unknown }>(ACTOR, 'select public.get_launch_sources($1,$2) v', [
      team,
      saved.id
    ])
  )[0]!.v;
  const parsed = parseLaunchSources(sources);
  if (!parsed) throw new Error('fixture');
  const complete = (
    await db.asUser<{ v: { version: string } }>(
      ACTOR,
      'select public.save_launch_draft($1,$2,$3,$4,$5,$6) v',
      [team, saved.id, assigned, `${key}-source`, JSON.stringify(config), JSON.stringify(sources)]
    )
  )[0]!.v;
  const preview = launchPreview(config, parsed);
  if (!preview.ok) throw new Error('fixture');
  const accepted = (
    await db.root<{ v: { id: string } }>(
      'select public.service_accept_launch_generation($1,$2,$3,$4,$5,$6,$7,$8,$9) v',
      [
        team,
        saved.id,
        ACTOR,
        complete.version,
        `upgrade-generate-${seq}`,
        `digest-${seq}`,
        JSON.stringify(config),
        JSON.stringify(sources),
        JSON.stringify(preview.value)
      ]
    )
  )[0]!.v;
  const prep = (
    await db.asUser<{ v: { processKey: string } }>(
      ACTOR,
      'select public.prepare_launch_restitch($1,$2) v',
      [team, accepted.id]
    )
  )[0]!.v;
  const op = (
    await db.root<{ id: string }>(
      "insert into public.team_operations(team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce) values($1,$2,'process','running',$3,$4,$5) returning id",
      [team, ACTOR, material, prep.processKey, `upgrade-video-${seq}`]
    )
  )[0]!.id;
  await db.root(
    "insert into private.team_operation_intents(operation_id,team_id,tool_id,tool_contract_version,relation,mime_type) values($1,$2,'restitch',2,'processed_from','video/mp4')",
    [op, team]
  );
  await db.asUser(ACTOR, 'select public.bind_launch_restitch($1,$2,$3)', [team, accepted.id, op]);
  await db.root('select public.service_prepare_launch_process_upload($1,$2)', [op, ACTOR]);
  await db.root(
    "select public.service_set_team_operation_intent($1,$2,null,'video/mp4',100,null,null,'restitch',2)",
    [op, ACTOR]
  );
  await db.root('select public.service_start_launch_process_upload($1,$2)', [op, ACTOR]);
  return { launch: saved.id, generation: accepted.id, op };
}

const cancelLaunch = async (f: { launch: string; generation: string }) =>
  db.asUser(ACTOR, 'select public.cancel_launch_generation($1,$2,$3,$4)', [
    team,
    f.launch,
    f.generation,
    `upgrade-cancel-${++seq}`
  ]);

async function restitchLaunchRegistered() {
  const f = await restitchLaunch();
  const output = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) values($1,$2,$3,'restitched.mp4','file','video','video/mp4','1') returning id",
      [team, connection, 'restitched-' + f.op]
    )
  )[0]!.id;
  await db.root(
    "update private.team_operation_intents set provider_result_id='restitched-'||$1::text where operation_id=$1",
    [f.op]
  );
  await db.root(
    "update public.team_operations set state='succeeded',stage='succeeded',result_material_id=$2,finished_at=clock_timestamp() where id=$1",
    [f.op, output]
  );
  await cancelLaunch(f);
  await db.root(
    "update public.team_launch_generations set state='canceled_with_cleanup_pending',stage='cleanup' where id=$1 and state<>'canceled_with_cleanup_pending'",
    [f.generation]
  );
  return { ...f, output };
}

async function restitchLaunchUnproven() {
  const f = await restitchLaunch();
  await cancelLaunch(f);
  // 2026-10-29: the search never answered and the resumable session is long dead.
  await age(f.op, '13 days');
  return f;
}

async function creationAttention() {
  const { set, requests } = await acceptSet(2);
  const op = await runningVariant(set, requests, 1);
  await registerVariant(set, 0);
  const credential = (
    await db.root<{ credential_id: string }>(
      'select credential_id from public.team_drive_connections where id=$1',
      [connection]
    )
  )[0]!.credential_id;
  await db.root(
    "insert into private.process_upload_ownership(operation_id,team_id,actor_id,connection_id,credential_id,root_id,parent_id,file_id,source_file_id,expected_name,mime_type,size_bytes,checksum,handoff_expires_at,upload_state)values($1,$2,$3,$4,$5,'root','root',$6,'source','catalog_variant_1.mp4','video/mp4',4,repeat('c',32),clock_timestamp()+interval '1 hour','started')",
    [op, team, ACTOR, connection, credential, 'upload' + op.replaceAll('-', '')]
  );
  await db.root(
    "select public.service_transition_team_operation($1,'failed','failed',0,null,'PROCESS_RESULT_UNCERTAIN',false)",
    [op]
  );
  await db.root(
    "update private.process_upload_ownership set cleanup_state='attention',attempts=24,next_attempt_at=null where operation_id=$1",
    [op]
  );
  await age(op, '2 hours');
  await db.root("update private.catalog_video_sets set state='cancel_requested' where id=$1", [
    set
  ]);
  return { set, op };
}

async function opLessCanceledCreation() {
  const { set, intent } = await acceptSet(1);
  await db.root(
    "update private.catalog_video_variants set state='unknown' where video_set_id=$1 and video_variant_index=0",
    [set]
  );
  await db.root(
    "update private.catalog_video_sets set state='cancel_requested',updated_at=clock_timestamp()-interval '40 minutes' where id=$1",
    [set]
  );
  await db.root("update private.catalog_generation_intents set state='canceled' where id=$1", [
    intent
  ]);
  return { set, intent };
}

async function opLessActiveCreation() {
  const { set } = await acceptSet(1);
  await db.root(
    "update private.catalog_video_variants set state='unknown' where video_set_id=$1 and video_variant_index=0",
    [set]
  );
  await db.root("update private.catalog_video_sets set state='unknown' where id=$1", [set]);
  return { set };
}

/**
 * The same shape, but a row the repair cannot write (production met one on a
 * dry run: a set whose actor no longer resolved failed its foreign key). A
 * test trigger stands in for whatever makes the write fail. A one-shot repair
 * that meets one such row must not abort the whole release.
 */
async function poisonedActiveCreation() {
  const { set } = await opLessActiveCreation();
  await db.root(
    `create function private.upgrade_test_poison() returns trigger language plpgsql as $$
     begin if new.id = '${set}'::uuid then raise exception 'UPGRADE_TEST_POISON'; end if; return new; end $$`
  );
  await db.root(
    'create trigger upgrade_test_poison before update on private.catalog_video_sets for each row execute function private.upgrade_test_poison()'
  );
  return { set };
}

async function terminalReservation() {
  const op = crypto.randomUUID();
  await db.root('set session_replication_role = replica');
  try {
    await db.root(
      "insert into public.team_operations(id,team_id,actor_id,kind,state,stage,destination_folder_id,idempotency_key,request_nonce,reserved_name_key,reservation_expires_at,finished_at,error_code)values($1,$2,$3,'process','failed','failed',$4,$5,$5,'catalog_variant_upgrade_0.mp4',clock_timestamp()+interval '1 hour',clock_timestamp()-interval '1 hour','PROCESS_RESULT_UNCERTAIN')",
      [op, team, ACTOR, folder, 'upgrade-reservation-' + op]
    );
  } finally {
    await db.root('set session_replication_role = origin');
  }
  return { op };
}

const one = async <T>(sql: string, params: unknown[]) => (await db.root<T>(sql, params))[0]!;
const setState = async (set: string) =>
  (await one<{ state: string }>('select state from private.catalog_video_sets where id=$1', [set]))
    .state;
const generationState = async (id: string) =>
  (
    await one<{ state: string }>('select state from public.team_launch_generations where id=$1', [
      id
    ])
  ).state;

it('seeds shapes that 1.4.2 itself leaves stuck', () => {
  expect(stuckBefore).toHaveLength(8);
  for (const row of stuckBefore)
    expect(['cancel_requested', 'canceled_with_cleanup_pending']).toContain(row.state);
});

it('applies every 1.4.3 migration over data written under the 1.4.2 schema', () => {
  expect(applied.length).toBeGreaterThan(30);
  expect(applied[0]!.file > PRODUCTION_HEAD).toBe(true);
});

it('releases the name a finished operation still held', async () => {
  const row = await one<{ released: string | null }>(
    'select reservation_released_at released from public.team_operations where id=$1',
    [fixtures.reservation!.op]
  );
  expect(row.released).not.toBeNull();
});

it('requeues an active variant left unknown without an operation', async () => {
  const row = await one<{ state: string }>(
    'select state from private.catalog_video_variants where video_set_id=$1 and video_variant_index=0',
    [fixtures.stuckUnknown!.set]
  );
  expect(row.state).toBe('queued');
  // The row the repair could not write is left as it was, for the settlement.
  const poisoned = await one<{ state: string }>(
    'select state from private.catalog_video_variants where video_set_id=$1 and video_variant_index=0',
    [fixtures.poisoned!.set]
  );
  expect(poisoned.state).toBe('unknown');
});

it('one settlement tick closes every stuck catalog cancellation', async () => {
  await db.root('select public.service_settle_catalog_video_cancellations(10)');
  for (const name of ['owner', 'unknown', 'attention', 'opless'] as const)
    expect([name, await setState(fixtures[name]!.set!)]).toEqual([name, 'canceled']);
  expect(await generationState(fixtures.owner!.generation!)).toBe('canceled');
  expect(await generationState(fixtures.unknown!.generation!)).toBe('canceled');
});

it('one restitch settlement tick closes both pre-catalog-video Launch cancellations', async () => {
  for (const name of ['registered', 'unproven'] as const)
    await db.root(
      "update public.team_launch_generations set next_attempt_at=clock_timestamp()-interval '1 second',lease_expires_at=null,lease_owner=null where id=$1",
      [fixtures[name]!.generation]
    );
  await db.root('select public.service_settle_launch_restitch_cancellations(10)');
  expect(await generationState(fixtures.registered!.generation!)).toBe('canceled');
  expect(await generationState(fixtures.unproven!.generation!)).toBe('canceled');
  // The registered video is retained, never trashed.
  expect(
    (
      await one<{ n: number }>(
        "select count(*)::integer n from public.team_materials where id=$1 and lifecycle='active'",
        [fixtures.registered!.output]
      )
    ).n
  ).toBe(1);
});
