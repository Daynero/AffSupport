import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Production 2026-11-11: catalog video set fa708f8e stayed 'cancel_requested'
 * («Скасовуємо…») for good. Its variant was 'working', its operation 'failed',
 * and the operation's upload ownership had ended in cleanup 'attention' after
 * 24 of 24 attempts. The fixtures below are that shape and its neighbours.
 */
let db: TeamTestDb, team: string, source: string, connection: string, credential: string;
const ACTOR = '74000000-0000-4000-8000-000000000001',
  executor = '74000000-0000-4000-8000-000000000002';

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: ACTOR, email: 'upload-cleanup-settle@example.invalid' });
  await db.root('insert into public.admin_users(user_id) values ($1)', [ACTOR]);
  team = (
    await db.asUser<{ id: string }>(ACTOR, "select id from public.create_team('Upload cleanup')")
  )[0]!.id;
  credential = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('perm-upload','upload@example.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
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

const setState = async (set: string) =>
  (
    await db.root<{ state: string }>('select state from private.catalog_video_sets where id=$1', [
      set
    ])
  )[0]!.state;
const variant = async (set: string, index: number) =>
  (
    await db.root<{ state: string; retry_count: number }>(
      'select state,retry_count from private.catalog_video_variants where video_set_id=$1 and video_variant_index=$2',
      [set, index]
    )
  )[0]!;
const ownership = async (op: string) =>
  (
    await db.root<{ cleanup_state: string; last_code: string | null }>(
      'select cleanup_state,last_code from private.process_upload_ownership where operation_id=$1',
      [op]
    )
  )[0]!;
/** The operations table stamps updated_at on every write; age it past that trigger. */
const finishedAgo = async (op: string, interval: string) => {
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

type Cleanup = 'attention' | 'pending' | 'trashed';

/**
 * A two-video creation: variant 0 registered, variant 1 'working' with an
 * operation that started an upload. `opState` 'failed' moves the ownership to
 * cleanup through the existing fence; `cleanup` then records where it ended.
 */
async function creation(opts: {
  opState: 'failed' | 'running';
  cleanup?: Cleanup;
  attempts?: number;
  errorCode?: string;
}) {
  const set = crypto.randomUUID(),
    requests = [crypto.randomUUID(), crypto.randomUUID()],
    key = 'upload-cleanup:' + set;
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
  // The upload was started: a file may exist in Drive under this id.
  await db.root(
    "insert into private.process_upload_ownership(operation_id,team_id,actor_id,connection_id,credential_id,root_id,parent_id,file_id,source_file_id,expected_name,mime_type,size_bytes,checksum,handoff_expires_at,upload_state)values($1,$2,$3,$4,$5,'root','root',$6,'source','catalog_variant_1.mp4','video/mp4',4,repeat('c',32),clock_timestamp()+interval '1 hour','started')",
    [op, team, ACTOR, connection, credential, 'upload' + op.replaceAll('-', '')]
  );
  if (opts.opState === 'failed') {
    await db.root(
      "select public.service_transition_team_operation($1,'failed','failed',0,null,$2,false)",
      [op, opts.errorCode ?? 'PROCESS_RESULT_UNCERTAIN']
    );
    if (opts.cleanup && opts.cleanup !== 'pending')
      await db.root(
        'update private.process_upload_ownership set cleanup_state=$2,attempts=$3,next_attempt_at=null where operation_id=$1',
        [op, opts.cleanup, opts.attempts ?? 24]
      );
  }
  return { set, op };
}

const settle = async () =>
  (
    await db.root<{ v: { settled: number; resolved: number } }>(
      'select public.service_settle_catalog_video_cancellations(10) v'
    )
  )[0]!.v;
const cancel = async (set: string) =>
  db.root("update private.catalog_video_sets set state='cancel_requested' where id=$1", [set]);

it('fa708f8e: a canceled set closes once its failed variant’s upload cleanup gave up', async () => {
  const f = await creation({ opState: 'failed', cleanup: 'attention', attempts: 24 });
  await finishedAgo(f.op, '2 hours');
  await cancel(f.set);
  await settle();
  expect(await setState(f.set)).toBe('canceled');
  // The possible file stays where it is; the recorded outcome is unchanged.
  expect(await ownership(f.op)).toEqual({
    cleanup_state: 'attention',
    last_code: 'PROCESS_RESULT_UNCERTAIN'
  });
});

it('a canceled set closes once cleanup trashed the uploaded file', async () => {
  const f = await creation({ opState: 'failed', cleanup: 'trashed', attempts: 3 });
  await cancel(f.set);
  await settle();
  expect(await setState(f.set)).toBe('canceled');
});

it('waits while cleanup of the uploaded file is still running', async () => {
  const f = await creation({ opState: 'failed', cleanup: 'pending' });
  await finishedAgo(f.op, '1 hour');
  await cancel(f.set);
  await settle();
  expect(await setState(f.set)).toBe('cancel_requested');
  expect((await ownership(f.op)).cleanup_state).toBe('pending');
});

it('closes a cleanup that never ended a day later as abandoned, without touching Drive', async () => {
  const f = await creation({ opState: 'failed', cleanup: 'pending' });
  await finishedAgo(f.op, '25 hours');
  await cancel(f.set);
  await settle();
  expect(await setState(f.set)).toBe('canceled');
  expect(await ownership(f.op)).toEqual({
    cleanup_state: 'attention',
    last_code: 'PROCESS_RESULT_UNCERTAIN'
  });
});

it('keeps blocking while the operation that owns the upload is still running', async () => {
  const f = await creation({ opState: 'running' });
  await finishedAgo(f.op, '2 days');
  await cancel(f.set);
  await settle();
  expect(await setState(f.set)).toBe('cancel_requested');
  expect(
    (
      await db.root<{ state: string }>('select state from public.team_operations where id=$1', [
        f.op
      ])
    )[0]!.state
  ).toBe('running');
});

it('a set nobody cancels retries the variant once its upload cleanup ended', async () => {
  const f = await creation({ opState: 'failed', cleanup: 'attention', attempts: 24 });
  expect(await setState(f.set)).not.toBe('canceled');
  const result = await settle();
  expect(result.resolved).toBeGreaterThanOrEqual(1);
  expect(await variant(f.set, 1)).toEqual({ state: 'queued', retry_count: 1 });
  expect(await setState(f.set)).toBe('preparing');
});

it('a set nobody cancels keeps its answer while cleanup still runs', async () => {
  const f = await creation({ opState: 'failed', cleanup: 'pending' });
  await finishedAgo(f.op, '1 hour');
  await settle();
  expect((await variant(f.set, 1)).state).toBe('working');
});
