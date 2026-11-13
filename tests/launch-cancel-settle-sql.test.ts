import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import { expireBackoff, poisonRows, settleFailure } from './support/poison-rows';
import { launchConfig } from './fixtures/launches';
import { assignLaunchFixture } from './support/launch-assignment';
import { launchPreview, parseLaunchSources } from '../packages/shared/src/team/launches';

/**
 * Production 2026-11-11: four canceled Launch generations stayed
 * 'canceled_with_cleanup_pending' («Скасовуємо… очікуємо підтвердження
 * завершення») for hours to weeks. Each fixture below is the exact shape read
 * from production; every one must reach 'canceled' on the 1.4.3 schema.
 */
let db: TeamTestDb, team: string, material: string, agent: string, buyer: string, offer: string;
let source: string, connection: string, delegation: string;
let seq = 0;
const ACTOR = '73000000-0000-4000-8000-000000000001',
  executor = '73000000-0000-4000-8000-000000000002',
  native = '73000000-0000-4000-8000-000000000003',
  hash = Buffer.alloc(32, 0xae);

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: ACTOR, email: 'launch-cancel-settle@example.invalid' });
  await db.root('insert into public.admin_users(user_id) values ($1)', [ACTOR]);
  team = (
    await db.asUser<{ id: string }>(ACTOR, "select id from public.create_team('Cancel settle')")
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
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('perm-cancel','cancel@example.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
      [ACTOR]
    )
  )[0]!.id;
  connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values($1,$2,'root','Root','my_drive','connected',now()) returning id",
      [team, credential]
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
      "select public.create_launch_dictionary($1,'buyers','patrik','cancel-buyer-001') v",
      [team]
    )
  )[0]!.v.id;
  offer = (
    await db.asUser<{ v: { id: string } }>(
      ACTOR,
      "select public.create_launch_dictionary($1,'offers','ProCaps TR','cancel-offer-001') v",
      [team]
    )
  )[0]!.v.id;
  await db.root(
    "insert into public.team_product_catalog_settings(team_id,title,description,price,image_link,updated_by) values($1,'Launch product','Synthetic description',10,'https://example.invalid/image.jpg',$2)",
    [team, ACTOR]
  );
  delegation = (
    await db.root<{ id: string }>(
      'insert into private.team_recovery_delegations(team_id,actor_id,installation_id,refresh_hash)values($1,$2,$3,$4)returning id',
      [team, ACTOR, executor, Buffer.alloc(32, 0xbe)]
    )
  )[0]!.id;
  await db.root(
    "insert into private.team_recovery_credentials(hash,delegation_id,version,audience,expires_at)values($1,$2,1,'claim',clock_timestamp()+interval '1 hour')",
    [hash, delegation]
  );
}, 240000);
afterAll(async () => {
  await db?.close();
});

const generationOf = async (id: string) =>
  (
    await db.root<{ state: string; safe_error_code: string | null }>(
      'select state,safe_error_code from public.team_launch_generations where id=$1',
      [id]
    )
  )[0]!;
const stepOutcome = async (generation: string, op: string) =>
  (
    await db.root<{ outcome: string | null }>(
      "select checkpoint->>'cleanupOutcome' outcome from public.team_launch_generation_steps where generation_id=$1 and team_operation_id=$2",
      [generation, op]
    )
  )[0]?.outcome ?? null;
const uploadPhase = async (op: string) =>
  (
    await db.root<{ phase: string }>(
      'select launch_upload_phase phase from private.team_operation_intents where operation_id=$1',
      [op]
    )
  )[0]!.phase;
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

// ---- #1 / #2: catalog-video Launch, a variant left running by a dead agent ----

async function catalogLaunch(shape: 'working' | 'unknown') {
  const set = crypto.randomUUID(),
    requests = Array.from({ length: 5 }, () => crypto.randomUUID()),
    key = 'cancel-settle:' + set;
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
      requestedCount: 5,
      productCount: 5,
      recipeRevision: 1,
      seed: 'b'.repeat(64)
    },
    requests.map((requestId, index) => ({ index, requestId })),
    requests.map((_, index) => ({ recipeRowId: crypto.randomUUID(), videoVariantIndex: index }))
  ]);
  await db.root(
    "update private.catalog_generation_intents set checkpoint=checkpoint||jsonb_build_object('initialVideoPlan',jsonb_build_object('setId',$2::text)),request_payload=request_payload||'{\"catalogVideoProtocolVersion\":1}'::jsonb where id=$1",
    [intent, set]
  );
  // Variant 3: admitted and running when the agent dropped it.
  const op = crypto.randomUUID();
  await db.root(
    "insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce)values($1,$2,$3,'process','running',$4,$5,$5)",
    [op, team, ACTOR, source, 'catalog-variant:' + requests[3]]
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
    requests.map((requestId, index) =>
      index === 3
        ? { index, requestId, operationId: op, state: 'working', outputId: null }
        : { index, requestId, operationId: null, state: 'queued', outputId: null }
    )
  ]);
  if (shape === 'working')
    // #1 (09d136d7): dispatched under an execution fence, then silent since 12:49.
    await db.root('select public.service_dispatch_catalog_video_variant($1,$2,$3,1,3,$4,$5)', [
      set,
      hash,
      native,
      requests[3],
      op
    ]);
  // Variants 0-2 finished and registered their videos.
  for (const index of [0, 1, 2]) {
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
  // #2 (047260ac): the variant was given up as unknown, its operation still running.
  if (shape === 'unknown')
    await db.root(
      "update private.catalog_video_variants set state='unknown' where video_set_id=$1 and video_variant_index=3",
      [set]
    );
  await age(op, '2 hours');
  // The Launch cancellation (13:10:39) asked the set to stop.
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
    [generation, team, launch, launchRevision, ACTOR, 'cancel-settle-' + generation]
  );
  await db.root(
    "insert into private.launch_catalog_video_contexts(generation_id,team_id,actor_id,settings_snapshot,request_payload,initial_video_plan,catalog_intent_id,video_set_id)select $1,team_id,actor_id,'{}',request_payload,checkpoint->'initialVideoPlan',id,$3 from private.catalog_generation_intents where id=$2",
    [generation, intent, set]
  );
  return { set, op, generation };
}

const settleCatalog = async () =>
  db.root('select public.service_settle_catalog_video_cancellations(10)');

it('#1: settles a canceled Launch whose dispatched variant was dropped by its agent', async () => {
  const f = await catalogLaunch('working');
  await settleCatalog();
  expect(
    (
      await db.root<{ state: string }>('select state from public.team_operations where id=$1', [
        f.op
      ])
    )[0]!.state
  ).toBe('canceled');
  expect(
    (
      await db.root<{ state: string }>('select state from private.catalog_video_sets where id=$1', [
        f.set
      ])
    )[0]!.state
  ).toBe('canceled');
  expect((await generationOf(f.generation)).state).toBe('canceled');
});

it('#2: settles a canceled Launch whose unknown variant kept a running operation', async () => {
  const f = await catalogLaunch('unknown');
  await settleCatalog();
  expect(
    (
      await db.root<{ state: string }>('select state from public.team_operations where id=$1', [
        f.op
      ])
    )[0]!.state
  ).toBe('canceled');
  expect((await generationOf(f.generation)).state).toBe('canceled');
});

it('keeps a canceled Launch open while its agent still answers', async () => {
  const f = await catalogLaunch('working');
  await age(f.op, '1 minute');
  await settleCatalog();
  expect((await generationOf(f.generation)).state).toBe('canceled_with_cleanup_pending');
});

// ---- #3 / #4: pre-catalog-video restitch Launch ----

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
  const key = `cancel-draft-${++seq}`;
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
        `cancel-generate-${seq}`,
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
      [team, ACTOR, material, prep.processKey, `cancel-video-${seq}`]
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
const cancel = async (f: { launch: string; generation: string }) =>
  db.asUser(ACTOR, 'select public.cancel_launch_generation($1,$2,$3,$4)', [
    team,
    f.launch,
    f.generation,
    `cancel-settle-${++seq}`
  ]);
const settleRestitch = async () =>
  db.root('select public.service_settle_launch_restitch_cancellations(10)');
const due = async (generation: string) =>
  db.root(
    "update public.team_launch_generations set next_attempt_at=clock_timestamp()-interval '1 second',lease_expires_at=null,lease_owner=null where id=$1",
    [generation]
  );
const quiesce = async (op: string) => {
  const token = crypto.getRandomValues(new Uint8Array(32));
  await db.root(
    "insert into private.team_transfer_grants(token_hash,operation_id,team_id,actor_id,purpose,tool_id,max_range_bytes,expires_at) values($4,$1,$2,$3,'finalize','restitch',1048576,clock_timestamp()+interval '1 hour')",
    [op, team, ACTOR, Buffer.from(token)]
  );
  await db.root('select public.service_ack_launch_upload_quiescence($1,$2)', [
    op,
    Buffer.from(token)
  ]);
};
const claimVideo = async (generation: string) => {
  const owner = crypto.randomUUID();
  const plans = (
    await db.root<{ v: { generationId: string; operationId: string; fence: string }[] }>(
      'select public.service_claim_launch_video_cleanup($1,10) v',
      [owner]
    )
  )[0]!.v.filter(plan => plan.generationId === generation);
  expect(plans).toHaveLength(1);
  return [team, generation, plans[0]!.operationId, owner, plans[0]!.fence];
};
const noteAbsent = async (authority: unknown[]) =>
  (
    await db.root<{ v: string }>(
      'select public.service_note_launch_video_absent($1,$2,$3,$4,$5) v',
      authority
    )
  )[0]!.v;

it('#3: settles a canceled Launch whose restitch finished and registered its video first', async () => {
  const f = await restitchLaunch();
  // 3465db89: the restitch succeeded and its output was registered 45 s before the cancel.
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
  await cancel(f);
  // Force the production shape regardless of how cancellation treats a late success.
  await db.root(
    "update public.team_launch_generations set state='canceled_with_cleanup_pending',stage='cleanup' where id=$1 and state<>'canceled_with_cleanup_pending'",
    [f.generation]
  );
  await due(f.generation);
  await settleRestitch();
  expect(await generationOf(f.generation)).toEqual({ state: 'canceled', safe_error_code: null });
  expect(await uploadPhase(f.op)).toBe('retained');
  expect(await stepOutcome(f.generation, f.op)).toBe('retained_catalog_material');
  // The registered video is untouched.
  expect(
    (
      await db.root<{ n: number }>(
        "select count(*)::integer n from public.team_materials where id=$1 and lifecycle='active'",
        [output]
      )
    )[0]!.n
  ).toBe(1);
});

it('#4: proves an upload absent after two empty searches once the agent stopped an hour ago', async () => {
  const f = await restitchLaunch();
  await cancel(f);
  await quiesce(f.op);
  // 1acf114d: canceled, upload 'started', quiescence proven, nothing in Drive.
  let authority = await claimVideo(f.generation);
  expect(await noteAbsent(authority)).toBe('pending');
  await db.root(
    "update private.launch_video_absence_observations set first_observed_at=clock_timestamp()-interval '11 minutes',last_observed_at=clock_timestamp()-interval '6 minutes' where operation_id=$1",
    [f.op]
  );
  // Quiesced only now: the upload may still be landing, absence is not proof yet.
  expect(await noteAbsent(authority)).toBe('pending');
  await db.root(
    "update private.team_operation_intents set launch_upload_quiesced_at=clock_timestamp()-interval '2 hours' where operation_id=$1",
    [f.op]
  );
  await db.root(
    "update private.launch_video_absence_observations set first_observed_at=clock_timestamp()-interval '12 minutes',last_observed_at=clock_timestamp()-interval '5 minutes' where operation_id=$1",
    [f.op]
  );
  await db.root(
    "update public.team_launch_generations set next_attempt_at=clock_timestamp()-interval '1 second',lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
    [f.generation]
  );
  authority = await claimVideo(f.generation);
  expect(await noteAbsent(authority)).toBe('absent');
  expect(await uploadPhase(f.op)).toBe('cleaned');
  expect(await stepOutcome(f.generation, f.op)).toBe('provider_output_absent');
  await settleRestitch();
  expect(await generationOf(f.generation)).toEqual({ state: 'canceled', safe_error_code: null });
});

it('starts the absence observation over after a long gap', async () => {
  const f = await restitchLaunch();
  await cancel(f);
  await quiesce(f.op);
  await db.root(
    "update private.team_operation_intents set launch_upload_quiesced_at=clock_timestamp()-interval '2 hours' where operation_id=$1",
    [f.op]
  );
  const authority = await claimVideo(f.generation);
  expect(await noteAbsent(authority)).toBe('pending');
  await db.root(
    "update private.launch_video_absence_observations set first_observed_at=clock_timestamp()-interval '3 hours',last_observed_at=clock_timestamp()-interval '2 hours' where operation_id=$1",
    [f.op]
  );
  expect(await noteAbsent(authority)).toBe('pending');
  expect(await uploadPhase(f.op)).toBe('started');
});

it('refuses an absence note without the cleanup lease', async () => {
  const f = await restitchLaunch();
  await cancel(f);
  await quiesce(f.op);
  const authority = await claimVideo(f.generation);
  expect(await noteAbsent([...authority.slice(0, 4), '999'])).toBe('unknown');
  expect(
    await noteAbsent([authority[0], authority[1], authority[2], crypto.randomUUID(), authority[4]])
  ).toBe('unknown');
});

it('#4 without a provider answer: settles after a resumable session lifetime, touching nothing', async () => {
  const f = await restitchLaunch();
  await cancel(f);
  await settleRestitch();
  expect((await generationOf(f.generation)).state).toBe('canceled_with_cleanup_pending');
  // Search never answered (revoked credential, missing folder) for eight days.
  await age(f.op, '8 days');
  await due(f.generation);
  await settleRestitch();
  expect(await generationOf(f.generation)).toEqual({ state: 'canceled', safe_error_code: null });
  expect(await uploadPhase(f.op)).toBe('started');
  expect(await stepOutcome(f.generation, f.op)).toBe('provider_output_unverified');
});

it('keeps a recent unproven upload pending', async () => {
  const f = await restitchLaunch();
  await cancel(f);
  await age(f.op, '2 days');
  await due(f.generation);
  await settleRestitch();
  expect(await generationOf(f.generation)).toEqual({
    state: 'canceled_with_cleanup_pending',
    safe_error_code: 'LAUNCH_RESULT_UNCERTAIN'
  });
});

it('one canceled Launch that cannot be written does not stop the others', async () => {
  const healthy = await restitchLaunch();
  const poisoned = await restitchLaunch();
  for (const f of [healthy, poisoned]) await cancel(f);
  await settleRestitch();
  for (const f of [healthy, poisoned]) {
    await age(f.op, '8 days');
    await due(f.generation);
  }
  const cure = await poisonRows(db, 'public.team_launch_generations', 'id', [poisoned.generation]);
  try {
    await settleRestitch();
    expect((await generationOf(healthy.generation)).state).toBe('canceled');
    expect((await generationOf(poisoned.generation)).state).toBe('canceled_with_cleanup_pending');
    expect(await settleFailure(db, 'launch_restitch_cancel', poisoned.generation)).toEqual({
      attempts: 1,
      last_code: 'SETTLE_TEST_POISON',
      deferred: true
    });
  } finally {
    await cure();
  }
  await expireBackoff(db, 'launch_restitch_cancel', poisoned.generation);
  await due(poisoned.generation);
  await settleRestitch();
  expect((await generationOf(poisoned.generation)).state).toBe('canceled');
  expect(await settleFailure(db, 'launch_restitch_cancel', poisoned.generation)).toBeUndefined();
});

it('reads when the current attempt began, so a reopened launch does not count from 00:00', async () => {
  // QA round 7 (1.4.3): a reopened launch showed 00:31 for a seven-minute generation.
  const f = await catalogLaunch('working');
  const row = (
    await db.root<{ launch_id: string; created_at: Date }>(
      'select launch_id,created_at from public.team_launch_generations where id=$1',
      [f.generation]
    )
  )[0]!;
  const read = async () =>
    (
      await db.asUser<{ v: { generation: { id: string; startedAt?: string } } }>(
        ACTOR,
        'select public.get_launch($1,$2) v',
        [team, row.launch_id]
      )
    )[0]!.v.generation;
  const first = await read();
  expect(first.id).toBe(f.generation);
  expect(first.startedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/u);
  expect(Date.parse(first.startedAt!)).toBe(row.created_at.getTime());
  // A retried attempt without a step yet has no server start: the browser keeps its own.
  await db.root('update public.team_launch_generations set attempt_no=2 where id=$1', [
    f.generation
  ]);
  expect((await read()).startedAt).toBeUndefined();
});
