import { beforeAll, afterAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * 1.4.3: catalog manager rounds that can never finish.
 *  - Stop on a video variant round raised WRONG_STATE forever: the round holds
 *    the item with lease 'catalog-variants:<request>' until 'infinity', and the
 *    manager's Stop refused any live lease (production 2026-11-10, TR_16_v29).
 *  - A variant round whose child operation ended (succeeded with lost
 *    confirmation, or failed) had nobody to resolve it without an agent.
 *  - Running attempts nothing can ever pick up stayed 'running' for weeks.
 */
let db: TeamTestDb, team: string, source: string, connection: string;
const owner = 'c2200000-0000-4000-8000-000000000001';

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: owner, email: 'updater-stuck@example.invalid' });
  await db.root('insert into public.admin_users(user_id)values($1)', [owner]);
  team = (await db.asUser<{ id: string }>(owner, "select id from public.create_team('Stuck')"))[0]!
    .id;
  const cred = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(connected_by,google_permission_id,google_account_email,vault_secret_id,scope)values($1,'stuck','stuck@example.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file')returning id",
      [owner]
    )
  )[0]!.id;
  connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state)values($1,$2,'root','Root','my_drive','connected')returning id",
      [team, cred]
    )
  )[0]!.id;
  source = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,size_bytes,checksum,drive_version)values($1,$2,'source','source','file','video','video/mp4',4,repeat('a',32),'1')returning id",
      [team, connection]
    )
  )[0]!.id;
  await db.root(
    "insert into public.team_restitch_defaults(team_id,operation,start_image_ids,configured)values($1,'restitch',array[gen_random_uuid()],true)",
    [team]
  );
  await db.root(
    'insert into private.team_recovery_delegations(team_id,actor_id,installation_id,refresh_hash)values($1,$2,gen_random_uuid(),$3)',
    [team, owner, Buffer.alloc(32, 0xaa)]
  );
}, 240000);
afterAll(async () => {
  await db?.close();
});

async function newCatalog(): Promise<string> {
  // Each catalog gets its own source video, as in production.
  source = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,size_bytes,checksum,drive_version)values($1,$2,gen_random_uuid()::text,'source','file','video','video/mp4',4,repeat('a',32),'1')returning id",
      [team, connection]
    )
  )[0]!.id;
  const catalog = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,size_bytes,checksum,drive_version,companion_of,companion_kind)values($1,$2,gen_random_uuid()::text,'sheet','file','other','application/vnd.google-apps.spreadsheet',4,repeat('a',32),'1',$3,'product_catalog')returning id",
      [team, connection, source]
    )
  )[0]!.id;
  await db.root(
    "insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot)values($1,$2,$3,'https://example.invalid/',3,'https://docs.google.com/spreadsheets/d/fixture/edit','https://drive.google.com/file/d/source/view','{}')",
    [catalog, team, source]
  );
  await db.root(
    'insert into public.team_catalog_update_profiles(catalog_material_id,team_id,refresh_images,refresh_texts,grow_products,random_link_variation,restitch)values($1,$2,true,true,false,false,true)on conflict(catalog_material_id)do update set restitch=true',
    [catalog, team]
  );
  return catalog;
}

const item = async (catalog: string) =>
  (
    await db.root<{
      round_due_at: string | null;
      lease_owner: string | null;
      reconciliation_required: boolean;
    }>(
      'select round_due_at,lease_owner,reconciliation_required from public.team_catalog_updater_items where catalog_material_id=$1',
      [catalog]
    )
  )[0];
const attempt = async (id: string) =>
  (
    await db.root<{ result: string; failure_code: string | null }>(
      'select result,failure_code from public.team_catalog_update_attempts where attempt_id=$1',
      [id]
    )
  )[0]!;
const sweep = async () =>
  (
    await db.root<{ v: Record<string, number> }>(
      'select public.service_sweep_catalog_updater_rounds(10)v'
    )
  )[0]!.v;

it('Stop ends a video variant round that holds the item until infinity', async () => {
  const catalog = await newCatalog();
  await db.root(
    'update public.team_catalog_update_profiles set video_variant_count=2 where catalog_material_id=$1',
    [catalog]
  );
  await db.asUser(owner, 'select public.run_team_catalog_update_now($1,array[$2]::uuid[])', [
    team,
    catalog
  ]);
  const snap = (
    await db.root<{ attempt_id: string }>(
      'select attempt_id from private.catalog_variant_round_snapshots where catalog_material_id=$1',
      [catalog]
    )
  )[0]!;
  await db.root('select public.service_adopt_catalog_variant_round($1,$2,$3,$4)', [
    team,
    owner,
    catalog,
    snap.attempt_id
  ]);
  const held = (await item(catalog))!;
  expect(held.lease_owner).toBe('catalog-variants:' + snap.attempt_id);
  const stopped = (
    await db.asUser<{ v: boolean }>(
      owner,
      'select public.cancel_team_catalog_update_attempt_as_actor($1,$2,$3,$4,$5)v',
      [team, catalog, held.round_due_at, snap.attempt_id, owner]
    )
  )[0]!.v;
  expect(stopped).toBe(true);
  expect(await attempt(snap.attempt_id)).toMatchObject({ result: 'cancelled' });
  const after = await item(catalog);
  expect(after?.round_due_at ?? null).toBeNull();
  expect(after?.lease_owner ?? null).toBeNull();
  const request = (
    await db.root<{ canceled_at: string | null }>(
      'select canceled_at from private.catalog_updater_variant_requests where request_id=$1',
      [snap.attempt_id]
    )
  )[0]!;
  expect(request.canceled_at).not.toBeNull();
  // A second Stop is a quiet no-op, not an error.
  expect(
    (
      await db.asUser<{ v: boolean }>(owner, 'select public.cancel_team_catalog_update($1,$2)v', [
        team,
        catalog
      ])
    )[0]!.v
  ).toBe(false);
});

it('Stop still refuses a round an ordinary worker is writing right now', async () => {
  const catalog = await newCatalog();
  await db.root(
    "insert into public.team_catalog_updater_items(catalog_material_id,team_id,round_due_at,next_attempt_at,lease_owner,lease_expires_at)values($1,$2,clock_timestamp(),clock_timestamp(),'catalog-updater:worker',clock_timestamp()+interval '5 minutes')on conflict(catalog_material_id)do update set round_due_at=excluded.round_due_at,lease_owner=excluded.lease_owner,lease_expires_at=excluded.lease_expires_at",
    [catalog, team]
  );
  // A claim lease alone no longer blocks Stop (20261207250000); a worker that has
  // started writing holds the reconciliation marker, and that still refuses.
  const began = (
    await db.root<{ v: boolean }>(
      "select public.service_begin_catalog_update_write($1,'catalog-updater:worker',gen_random_uuid(),'1',3,null,3,'{}'::jsonb)v",
      [catalog]
    )
  )[0]!.v;
  expect(began).toBe(true);
  await expect(
    db.asUser(owner, 'select public.cancel_team_catalog_update($1,$2)', [team, catalog])
  ).rejects.toThrow(/CATALOG_UPDATE_RECONCILIATION_REQUIRED/);
});

it('the sweep registers a lost confirmation and retries a failed child of a manager round', async () => {
  const catalog = await newCatalog();
  const requestId = crypto.randomUUID();
  const r = (
    await db.root<{ v: Record<string, unknown> }>(
      'select public.service_accept_catalog_updater_variants($1,$2,$3,$4,2,(select version from public.team_catalog_update_profiles where catalog_material_id=$3))v',
      [team, owner, catalog, requestId]
    )
  )[0]!.v;
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
    childIds.map((id, index) => ({ index, requestId: id })),
    rowIds.map((recipeRowId, index) => ({ recipeRowId, videoVariantIndex: index % 2 }))
  ]);
  const output = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,size_bytes,checksum,drive_version)values($1,$2,gen_random_uuid()::text,'out','file','video','video/mp4',4,repeat('a',32),'1')returning id",
      [team, connection]
    )
  )[0]!.id;
  const children = [];
  for (const [index, childId] of childIds.entries()) {
    const op = crypto.randomUUID();
    // Child 0 finished on the server but its confirmation never arrived;
    // child 1 failed without output.
    await db.root(
      "insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,result_material_id,error_code,idempotency_key,request_nonce,finished_at)values($1,$2,$3,'process',$4,$5,$6,$7,$8,$8,clock_timestamp())",
      [
        op,
        team,
        owner,
        index === 0 ? 'succeeded' : 'failed',
        source,
        index === 0 ? output : null,
        index === 0 ? null : 'PROCESS_FAILED',
        'catalog-variant:' + childId
      ]
    );
    await db.root(
      "insert into private.team_operation_intents(operation_id,team_id,tool_id,expected_source_version,expected_source_drive_file_id,expected_source_checksum)values($1,$2,'restitch','1','source',repeat('a',32))",
      [op, team]
    );
    children.push({ index, requestId: childId, operationId: op, state: 'unknown', outputId: null });
  }
  await db.root('select public.service_checkpoint_catalog_video_set($1,$2,$3,$4,1,0,$5)', [
    r.set_id,
    team,
    owner,
    r.executor_id,
    children
  ]);
  const swept = await sweep();
  expect(swept.variantSets).toBeGreaterThanOrEqual(1);
  const variants = await db.root<{
    video_variant_index: number;
    state: string;
    retry_count: number;
  }>(
    'select video_variant_index,state,retry_count from private.catalog_video_variants where video_set_id=$1 order by 1',
    [r.set_id]
  );
  expect(variants).toEqual([
    { video_variant_index: 0, state: 'registered', retry_count: 0 },
    { video_variant_index: 1, state: 'queued', retry_count: 1 }
  ]);
  expect(await attempt(r.attempt_id as string)).toMatchObject({ result: 'running' });
});

it('the sweep closes running attempts nothing can ever pick up, and only those', async () => {
  // (a) the item no longer owns the attempt's round (production: 22 schedule
  // attempts running since late October with empty stage history).
  const lost = await newCatalog();
  const lostAttempt = (
    await db.root<{ attempt_id: string }>(
      "insert into public.team_catalog_update_attempts(catalog_material_id,team_id,round_due_at,trigger_kind,started_at,result,stage_history)values($1,$2,clock_timestamp()-interval '15 days','schedule',clock_timestamp()-interval '15 days','running','[]')returning attempt_id",
      [lost, team]
    )
  )[0]!.attempt_id;
  // (b) the item owns the round, nothing has claimed it for hours.
  const idle = await newCatalog();
  const idleRound = (
    await db.root<{ r: string }>("select (clock_timestamp()-interval '8 hours')::text r")
  )[0]!.r;
  await db.root(
    "insert into public.team_catalog_updater_items(catalog_material_id,team_id,round_due_at,next_attempt_at)values($1,$2,$3,clock_timestamp()-interval '7 hours')on conflict(catalog_material_id)do update set round_due_at=excluded.round_due_at,next_attempt_at=excluded.next_attempt_at,lease_owner=null,lease_expires_at=null",
    [idle, team, idleRound]
  );
  // The item's round opens its attempt through track_catalog_update_round.
  const idleAttempt = (
    await db.root<{ attempt_id: string }>(
      'update public.team_catalog_update_attempts set started_at=round_due_at where catalog_material_id=$1 and round_due_at=$2 returning attempt_id',
      [idle, idleRound]
    )
  )[0]!.attempt_id;
  // Guards: a young orphan and a round that a worker holds stay untouched.
  const young = await newCatalog();
  const youngAttempt = (
    await db.root<{ attempt_id: string }>(
      "insert into public.team_catalog_update_attempts(catalog_material_id,team_id,round_due_at,trigger_kind,started_at,result,stage_history)values($1,$2,clock_timestamp()-interval '1 hour','schedule',clock_timestamp()-interval '1 hour','running','[]')returning attempt_id",
      [young, team]
    )
  )[0]!.attempt_id;
  const leased = await newCatalog();
  const leasedRound = (
    await db.root<{ r: string }>("select (clock_timestamp()-interval '9 hours')::text r")
  )[0]!.r;
  await db.root(
    "insert into public.team_catalog_updater_items(catalog_material_id,team_id,round_due_at,next_attempt_at,lease_owner,lease_expires_at)values($1,$2,$3,clock_timestamp()-interval '9 hours','catalog-updater:w',clock_timestamp()+interval '2 minutes')on conflict(catalog_material_id)do update set round_due_at=excluded.round_due_at,next_attempt_at=excluded.next_attempt_at,lease_owner=excluded.lease_owner,lease_expires_at=excluded.lease_expires_at",
    [leased, team, leasedRound]
  );
  const leasedAttempt = (
    await db.root<{ attempt_id: string }>(
      'update public.team_catalog_update_attempts set started_at=round_due_at where catalog_material_id=$1 and round_due_at=$2 returning attempt_id',
      [leased, leasedRound]
    )
  )[0]!.attempt_id;

  const swept = await sweep();
  expect(swept.orphans).toBeGreaterThanOrEqual(2);
  expect(await attempt(lostAttempt)).toMatchObject({ result: 'cancelled' });
  expect(await attempt(idleAttempt)).toMatchObject({
    result: 'failed',
    failure_code: 'PROCESS_FAILED'
  });
  expect((await item(idle))?.round_due_at ?? null).toBeNull();
  expect(await attempt(youngAttempt)).toMatchObject({ result: 'running' });
  expect(await attempt(leasedAttempt)).toMatchObject({ result: 'running' });
  // Idempotent.
  expect((await sweep()).orphans).toBe(0);
});

it('releases a catalog stranded in review with nothing to reconcile', async () => {
  // Production (Sanchos): failed and cancelled manual attempts, quarantined
  // item, no reconciliation row, round already cleared.
  const catalog = await newCatalog();
  await db.root(
    "insert into public.team_catalog_updater_items(catalog_material_id,team_id,round_due_at,next_attempt_at,reconciliation_required)values($1,$2,null,'infinity',true)on conflict(catalog_material_id)do update set round_due_at=null,next_attempt_at='infinity',reconciliation_required=true",
    [catalog, team]
  );
  await db.root(
    "insert into public.team_catalog_update_attempts(catalog_material_id,team_id,round_due_at,trigger_kind,started_at,ended_at,result,failure_code,stage_history)values($1,$2,clock_timestamp()-interval '1 day','manual',clock_timestamp()-interval '1 day',clock_timestamp()-interval '1 day','failed','PROCESS_RESULT_UNCERTAIN','[]')",
    [catalog, team]
  );
  await db.root(
    "update public.team_product_catalogs set last_update_error='CATALOG_ATTEMPT_STATE_INCONSISTENT',last_update_error_at=clock_timestamp() where material_id=$1",
    [catalog]
  );
  const swept = await sweep();
  expect(swept.released).toBeGreaterThanOrEqual(1);
  expect(await item(catalog)).toMatchObject({ reconciliation_required: false });
  const record = (
    await db.root<{ last_update_error: string | null }>(
      'select last_update_error from public.team_product_catalogs where material_id=$1',
      [catalog]
    )
  )[0]!;
  expect(record.last_update_error).toBeNull();
});
