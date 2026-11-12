import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Production after 1.4.3 (2026-11-12) still held two shapes nothing could settle:
 *
 *  - fa708f8e: a canceled set whose failed variant ran under a paired native session.
 *    The selection executor stayed 'owned' with an open claim, and the session that
 *    could acknowledge quiescence had expired, so the cancellation waited forever.
 *  - 52c28131: a variant whose run succeeded, but whose output was never registered and
 *    then went missing in Drive. The set and its update round stayed 'unknown'.
 *
 * The fixtures are those shapes, and the neighbours that must keep their guard.
 */
let db: TeamTestDb, team: string, source: string, connection: string;
const ACTOR = '74100000-0000-4000-8000-000000000001',
  executor = '74100000-0000-4000-8000-000000000002';

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: ACTOR, email: 'stuck-shapes@example.invalid' });
  await db.root('insert into public.admin_users(user_id) values ($1)', [ACTOR]);
  team = (
    await db.asUser<{ id: string }>(ACTOR, "select id from public.create_team('Stuck shapes')")
  )[0]!.id;
  const credential = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('perm-stuck','stuck@example.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
      [ACTOR]
    )
  )[0]!.id;
  connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values($1,$2,'root','Root','my_drive','connected',now()) returning id",
      [team, credential]
    )
  )[0]!.id;
  source = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,size_bytes,checksum,drive_version) values($1,$2,'source','Source.mp4','file','video','video/mp4',4,repeat('a',32),'1') returning id",
      [team, connection]
    )
  )[0]!.id;
  await db.root(
    "insert into public.team_product_catalog_settings(team_id,title,description,price,image_link,updated_by) values($1,'Product','Synthetic description',10,'https://example.invalid/image.jpg',$2)",
    [team, ACTOR]
  );
}, 240000);
afterAll(async () => {
  await db?.close();
});

const replica = async <T>(work: () => Promise<T>): Promise<T> => {
  await db.root('set session_replication_role = replica');
  try {
    return await work();
  } finally {
    await db.root('set session_replication_role = origin');
  }
};
const setState = async (set: string) =>
  (
    await db.root<{ state: string }>('select state from private.catalog_video_sets where id=$1', [
      set
    ])
  )[0]!.state;
const variant = async (set: string, index: number) =>
  (
    await db.root<{ state: string; retry_count: number; request_id: string }>(
      'select state,retry_count,request_id from private.catalog_video_variants where video_set_id=$1 and video_variant_index=$2',
      [set, index]
    )
  )[0]!;
const finishedAgo = (op: string, interval: string) =>
  replica(() =>
    db.root(
      "update public.team_operations set created_at=clock_timestamp()-$2::interval-interval '1 minute',updated_at=clock_timestamp()-$2::interval,finished_at=clock_timestamp()-$2::interval where id=$1",
      [op, interval]
    )
  );
const settleCancellations = () =>
  db.root('select public.service_settle_catalog_video_cancellations(10)');
const settleShapes = async () =>
  (
    await db.root<{ v: { retried: number; blocked: number; closedRounds: number } }>(
      'select private.settle_catalog_stuck_shapes(20) v'
    )
  )[0]!.v;

/**
 * A two-video creation: variant 0 registered, variant 1 'working' under operation `op`.
 */
async function creation() {
  const set = crypto.randomUUID(),
    requests = [crypto.randomUUID(), crypto.randomUUID()],
    key = 'stuck-shapes:' + set;
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
      requestedCount: 2,
      productCount: 2,
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
  const op = crypto.randomUUID();
  await db.root(
    "insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce)values($1,$2,$3,'process','running',$4,$5,$5)",
    [op, team, ACTOR, source, 'catalog-variant:' + requests[1]]
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
      index === 1
        ? { index, requestId, operationId: op, state: 'working', outputId: null }
        : { index, requestId, operationId: null, state: 'queued', outputId: null }
    )
  ]);
  const output = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) values($1,$2,$3,'catalog_variant_0.mp4','file','video','video/mp4','1') returning id",
      [team, connection, `variant-${set}-0`]
    )
  )[0]!.id;
  await db.root(
    "update private.catalog_video_variants set state='registered',output_material_id=$2 where video_set_id=$1 and video_variant_index=0",
    [set, output]
  );
  return { set, op, intent, request: requests[1]! };
}

// --- fa708f8e -----------------------------------------------------------------------

/**
 * The paired-session executor of a failed variant: an alias, an 'owned' selection
 * executor with an open claim, and the native control that could have acknowledged it.
 */
async function pairedExecutor(
  f: { set: string; op: string; request: string },
  controlLive: boolean
) {
  const native = crypto.randomUUID(),
    claim = crypto.randomUUID(),
    selectionExecutor = crypto.randomUUID(),
    aliasExecutor = crypto.randomUUID();
  await replica(async () => {
    await db.root(
      'insert into private.restitch_selection_roots(root_operation_id,team_id,actor_id,source_material_id,source_version,recipe_owner_id,pool_namespace_id,recipe) values($1,$2,$3,$4,\'1\',$3,gen_random_uuid(),\'{"selectionProtocol":"1"}\')',
      [f.op, team, ACTOR, source]
    );
    await db.root(
      "insert into private.restitch_selection_executors(root_operation_id,epoch,executor_id,state) values($1,1,$2,'owned')",
      [f.op, selectionExecutor]
    );
    await db.root(
      'insert into private.restitch_selection_executor_claims(root_operation_id,claim_id,native_instance_id,executor_id,epoch) values($1,$2,$3,$4,1)',
      [f.op, claim, native, selectionExecutor]
    );
    await db.root(
      "insert into private.restitch_process_aliases(root_operation_id,video_set_id,team_id,actor_id,video_variant_index,request_id,source_material_id,source_version,settings_digest,pool_namespace_id,executor_id,native_instance_id,set_epoch,workspace_epoch,auth_mode,foreground_enrollment_id) values($1,$2,$3,$4,1,$5,$6,'1',repeat('a',64),gen_random_uuid(),$7,$8,1,1,'paired_session',gen_random_uuid())",
      [f.op, f.set, team, ACTOR, f.request, source, aliasExecutor, native]
    );
    await db.root(
      `insert into private.restitch_native_controls(id,root_operation_id,team_id,actor_id,session_id,enrollment_id,native_instance_id,proof_hash,token_hash,created_at,challenge_until,expires_at,auth_mode,process_alias_id)
       values(gen_random_uuid(),$1,$2,$3,gen_random_uuid(),gen_random_uuid(),$4,decode(md5(random()::text)||md5(random()::text),'hex'),decode(md5(random()::text)||md5(random()::text),'hex'),$5::timestamptz,$5::timestamptz+interval '1 minute',$5::timestamptz+interval '20 hours','catalog_browser_session',$1)`,
      [
        f.op,
        team,
        ACTOR,
        native,
        (
          await db.root<{ at: string }>(
            `select (clock_timestamp()-interval ${controlLive ? "'1 hour'" : "'2 days'"})::text at`
          )
        )[0]!.at
      ]
    );
  });
  return { claim };
}
const claimRow = async (op: string) =>
  (
    await db.root<{ quiescence_id: string | null; terminal_outcome: string | null }>(
      'select quiescence_id,terminal_outcome from private.restitch_selection_executor_claims where root_operation_id=$1',
      [op]
    )
  )[0]!;
const executorState = async (op: string) =>
  (
    await db.root<{ state: string }>(
      'select state from private.restitch_selection_executors where root_operation_id=$1',
      [op]
    )
  )[0]!.state;

async function failedPaired(controlLive: boolean, finished: string) {
  const f = await creation();
  await db.root(
    "select public.service_transition_team_operation($1,'failed','failed',0,null,'PROCESS_RESULT_UNCERTAIN',false)",
    [f.op]
  );
  await finishedAgo(f.op, finished);
  const p = await pairedExecutor(f, controlLive);
  await db.root("update private.catalog_video_sets set state='cancel_requested' where id=$1", [
    f.set
  ]);
  return { ...f, ...p };
}

it('fa708f8e: a canceled set settles once the native session of its failed variant expired', async () => {
  const f = await failedPaired(false, '2 hours');
  await settleCancellations();
  expect(await setState(f.set)).toBe('canceled');
  const claim = await claimRow(f.op);
  expect(claim.terminal_outcome).toBe('failed');
  expect(claim.quiescence_id).not.toBeNull();
  expect(await executorState(f.op)).toBe('quiescent');
  expect(
    await db.root(
      'select operation_state,reason from private.restitch_released_executor_claims where root_operation_id=$1',
      [f.op]
    )
  ).toEqual([{ operation_state: 'failed', reason: 'native_session_expired' }]);
});

it('a native session that is still valid keeps the cancellation waiting', async () => {
  const f = await failedPaired(true, '2 hours');
  await settleCancellations();
  expect(await setState(f.set)).toBe('cancel_requested');
  expect(await claimRow(f.op)).toEqual({ quiescence_id: null, terminal_outcome: null });
  expect(await executorState(f.op)).toBe('owned');
});

it('an operation that ended minutes ago still gets the chance to quiesce itself', async () => {
  const f = await failedPaired(false, '5 minutes');
  await settleCancellations();
  expect(await setState(f.set)).toBe('cancel_requested');
  expect(await executorState(f.op)).toBe('owned');
});

// --- 52c28131 -----------------------------------------------------------------------

/** Variant 1's run succeeded with an output that was never registered and is gone now. */
async function succeededMissing(retryCount = 0, finished = '2 hours') {
  const f = await creation();
  const output = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version,lifecycle,missing_at) values($1,$2,$3,'catalog_variant_1.mp4','file','video','video/mp4','1','missing',now()) returning id",
      [team, connection, `variant-${f.set}-1`]
    )
  )[0]!.id;
  await replica(async () => {
    await db.root(
      "update public.team_operations set state='succeeded',result_material_id=$2,progress=100,finished_at=clock_timestamp() where id=$1",
      [f.op, output]
    );
    await db.root(
      "update private.catalog_video_variants set state='unknown',retry_count=$2 where video_set_id=$1 and video_variant_index=1",
      [f.set, retryCount]
    );
    await db.root("update private.catalog_video_sets set state='unknown' where id=$1", [f.set]);
  });
  await finishedAgo(f.op, finished);
  return { ...f, output };
}

it('52c28131: a succeeded run whose output went missing is retried, and the set moves on', async () => {
  const f = await succeededMissing();
  const result = await settleShapes();
  expect(result.retried).toBeGreaterThanOrEqual(1);
  const v = await variant(f.set, 1);
  expect(v).toMatchObject({ state: 'queued', retry_count: 1 });
  expect(v.request_id).not.toBe(f.request);
  expect(await setState(f.set)).toBe('preparing');
  expect(
    await db.root(
      'select failure_code from private.catalog_video_variant_attempts where video_set_id=$1 and video_variant_index=1',
      [f.set]
    )
  ).toEqual([{ failure_code: 'PROCESS_OUTPUT_MISSING' }]);
  // The succeeded operation itself is never rewritten.
  expect(
    (
      await db.root<{ state: string }>('select state from public.team_operations where id=$1', [
        f.op
      ])
    )[0]!.state
  ).toBe('succeeded');
});

it('a run that just finished is left alone: its registration may still be landing', async () => {
  const f = await succeededMissing(0, '2 minutes');
  await settleShapes();
  expect((await variant(f.set, 1)).state).toBe('unknown');
  expect(await setState(f.set)).toBe('unknown');
});

it('with the retry budget spent, the creation is canceled and its cancellation settles', async () => {
  const f = await succeededMissing(2);
  await settleShapes();
  expect(await setState(f.set)).toBe('cancel_requested');
  await settleCancellations();
  expect(await setState(f.set)).toBe('canceled');
});

it('52c28131 on production: a published upload whose output went missing does not hold the cancellation', async () => {
  const f = await succeededMissing(2);
  // Production's run published its output through upload ownership before the file went missing.
  await replica(async () => {
    await db.root(
      "insert into private.process_upload_ownership(operation_id,team_id,actor_id,connection_id,credential_id,root_id,parent_id,file_id,source_file_id,expected_name,mime_type,size_bytes,checksum,handoff_expires_at,upload_state) select $1,$2,$3,c.id,c.credential_id,'root','root',$4,'source','catalog_variant_1.mp4','video/mp4',4,repeat('b',32),clock_timestamp()+interval '1 hour','published' from public.team_drive_connections c where c.id=$5",
      [f.op, team, ACTOR, `variant-${f.set}-1`, connection]
    );
  });
  await settleShapes();
  expect(await setState(f.set)).toBe('cancel_requested');
  await settleCancellations();
  expect(await setState(f.set)).toBe('canceled');
});

/** A canceled set whose variant 1 succeeded and published an output that is still active. */
async function canceledWithActiveOutput(finished: string) {
  const f = await succeededMissing(2, finished);
  await replica(async () => {
    await db.root(
      "update public.team_materials set lifecycle='active',missing_at=null where id=$1",
      [f.output]
    );
    await db.root(
      "insert into private.process_upload_ownership(operation_id,team_id,actor_id,connection_id,credential_id,root_id,parent_id,file_id,source_file_id,expected_name,mime_type,size_bytes,checksum,handoff_expires_at,upload_state) select $1,$2,$3,c.id,c.credential_id,'root','root',$4,'source','catalog_variant_1.mp4','video/mp4',4,repeat('b',32),clock_timestamp()+interval '1 hour','published' from public.team_drive_connections c where c.id=$5",
      [f.op, team, ACTOR, `variant-${f.set}-1`, connection]
    );
    await db.root(
      "update private.catalog_video_variants set state='working' where video_set_id=$1 and video_variant_index=1",
      [f.set]
    );
    await db.root("update private.catalog_video_sets set state='cancel_requested' where id=$1", [
      f.set
    ]);
  });
  return f;
}

it('a published output that is still active keeps a fresh cancellation waiting: its registration may be landing', async () => {
  const f = await canceledWithActiveOutput('2 minutes');
  await settleCancellations();
  expect(await setState(f.set)).toBe('cancel_requested');
});

it('f48e7d9e: a run that finished and published after the cancel no longer holds it for good', async () => {
  // Production 2026-11-12 (КАТАЛОГИ): canceled at 22:27:25, variant 0 succeeded and published at
  // 22:27:27, never registered; the set stayed «Скасовуємо…» and woke the updater every minute.
  const f = await canceledWithActiveOutput('10 minutes');
  await settleCancellations();
  expect(await setState(f.set)).toBe('canceled');
  // The output stays an ordinary file of the space; the succeeded run is never rewritten.
  expect(
    (
      await db.root<{ lifecycle: string }>(
        'select lifecycle from public.team_materials where id=$1',
        [f.output]
      )
    )[0]!.lifecycle
  ).toBe('active');
  expect(
    (
      await db.root<{ state: string }>('select state from public.team_operations where id=$1', [
        f.op
      ])
    )[0]!.state
  ).toBe('succeeded');
});

// --- d1da2bc7 / 53a1aede -------------------------------------------------------------

/** Variant 1's run failed with `code`; the creation that drove the set stopped long ago. */
async function failedIdle(code: string, idle = '13 hours') {
  const f = await creation();
  await replica(async () => {
    await db.root(
      "update public.team_operations set state='failed',error_code=$2,finished_at=clock_timestamp() where id=$1",
      [f.op, code]
    );
    await db.root(
      "update private.catalog_video_variants set state='unknown' where video_set_id=$1 and video_variant_index=1",
      [f.set]
    );
  });
  await finishedAgo(f.op, idle);
  await replica(() =>
    db.root(
      "update private.catalog_video_sets set state='unknown',updated_at=clock_timestamp()-$2::interval where id=$1",
      [f.set, idle]
    )
  );
  return f;
}

it('d1da2bc7: a set whose variant failed for good and that nothing drives any more is canceled', async () => {
  for (const code of ['PERMISSION_DENIED', 'SOURCE_CHANGED']) {
    const f = await failedIdle(code);
    await settleShapes();
    expect(await setState(f.set)).toBe('cancel_requested');
    await settleCancellations();
    expect(await setState(f.set)).toBe('canceled');
  }
});

it('a failure the retry would take is not requeued by the pass', async () => {
  const f = await failedIdle('DRIVE_UNAVAILABLE');
  await settleShapes();
  expect(await setState(f.set)).toBe('unknown');
  expect(await variant(f.set, 1)).toMatchObject({ state: 'unknown', retry_count: 0 });
});

it('a set that moved within twelve hours is left to whatever drives it', async () => {
  const f = await failedIdle('PERMISSION_DENIED', '2 hours');
  await settleShapes();
  expect(await setState(f.set)).toBe('unknown');
});

it('an update round stalled for a day is closed and frees its catalog', async () => {
  const f = await succeededMissing(0, '2 minutes');
  const catalog = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) values($1,$2,$3,$3,'file','other','application/vnd.google-apps.spreadsheet','v1') returning id",
      [team, connection, 'stalled-catalog-' + f.set]
    )
  )[0]!.id;
  const attempt = crypto.randomUUID(),
    request = crypto.randomUUID();
  await db.root(
    "insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot,created_by) values($1,$2,$3,'https://example.invalid/shop',2,'https://docs.google.com/spreadsheets/d/x','https://drive.google.com/file/d/x','{}',$4)",
    [catalog, team, source, ACTOR]
  );
  await replica(async () => {
    await db.root(
      "insert into public.team_catalog_updater_items(catalog_material_id,team_id,round_due_at,lease_owner,lease_expires_at,next_attempt_at) values($1,$2,now()-interval '26 hours','catalog-variants:'||$3::text,now()-interval '1 hour',now()-interval '1 hour')",
      [catalog, team, request]
    );
    await db.root(
      "insert into public.team_catalog_update_attempts(attempt_id,catalog_material_id,team_id,round_due_at,trigger_kind,started_at,result) values($1,$2,$3,now()-interval '26 hours','manual',now()-interval '26 hours','running')",
      [attempt, catalog, team]
    );
    await db.root(
      `insert into private.catalog_updater_variant_requests(request_id,team_id,actor_id,catalog_material_id,attempt_id,set_id,source_material_id,requested_count,product_count,profile_version,executor_id,settings_snapshot,provider_context,recipe_row_ids,child_request_ids,assignment_seed)
       values($1,$2,$3,$4,$5,$6,$7,2,2,1,$8,'{}','{}','[]','[]',repeat('b',64))`,
      [request, team, ACTOR, catalog, attempt, f.set, source, executor]
    );
    await db.root(
      "update private.catalog_video_sets set catalog_intent_id=null,update_attempt_id=$2,catalog_material_id=$3,updated_at=now()-interval '13 hours' where id=$1",
      [f.set, attempt, catalog]
    );
  });
  const result = await settleShapes();
  expect(result.closedRounds).toBeGreaterThanOrEqual(1);
  expect(
    (
      await db.root<{ result: string; failure_code: string }>(
        'select result,failure_code from public.team_catalog_update_attempts where attempt_id=$1',
        [attempt]
      )
    )[0]
  ).toEqual({ result: 'failed', failure_code: 'PROCESS_RESULT_UNCERTAIN' });
  // No open round holds the catalog any more: the next update can start.
  expect(
    await db.root(
      'select 1 from public.team_catalog_updater_items where catalog_material_id=$1 and (round_due_at is not null or lease_owner is not null)',
      [catalog]
    )
  ).toEqual([]);
});
