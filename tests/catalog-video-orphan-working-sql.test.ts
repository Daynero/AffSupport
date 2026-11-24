import { beforeAll, afterAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Production 2026-11-24 (onemedia): a catalog created with five re-stitched videos stopped at
 * «Готово відео 1 з 5» for good — the second variant was marked working and its admission was
 * lost before its operation existed — and deleting the catalog did not stop its videos either.
 */
let db: TeamTestDb, team: string, source: string, delegation: string;
const owner = 'c2410000-0000-4000-8000-000000000001',
  executor = 'c2410000-0000-4000-8000-000000000002',
  native = 'c2410000-0000-4000-8000-000000000003',
  hash = Buffer.alloc(32, 0xac);
beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: owner, email: 'orphan-working@example.invalid' });
  await db.root('insert into public.admin_users(user_id)values($1)', [owner]);
  team = (await db.asUser<{ id: string }>(owner, "select id from public.create_team('Orphan')"))[0]!
    .id;
  const cred = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(connected_by,google_permission_id,google_account_email,vault_secret_id,scope)values($1,'live','live@example.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file')returning id",
      [owner]
    )
  )[0]!.id;
  const connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state)values($1,$2,'root','Root','my_drive','connected')returning id",
      [team, cred]
    )
  )[0]!.id;
  source = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,size_bytes,checksum,drive_version)values($1,$2,'source','Source','file','video','video/mp4',4,repeat('a',32),'1')returning id",
      [team, connection]
    )
  )[0]!.id;
  delegation = (
    await db.root<{ id: string }>(
      'insert into private.team_recovery_delegations(team_id,actor_id,installation_id,refresh_hash)values($1,$2,$3,$4)returning id',
      [team, owner, executor, Buffer.alloc(32, 0xbd)]
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

const revisionOf = async (set: string) =>
  Number(
    (
      await db.root<{ revision: string }>(
        'select revision from private.catalog_video_sets where id=$1',
        [set]
      )
    )[0]!.revision
  );
const variant = async (set: string) =>
  (
    await db.root<{
      state: string;
      operation_id: string | null;
      retry_count: number;
      heartbeat_at: Date | null;
      silence_observed_at: Date | null;
    }>(
      'select state,operation_id,retry_count,heartbeat_at,silence_observed_at from private.catalog_video_variants where video_set_id=$1 and video_variant_index=0',
      [set]
    )
  )[0]!;
const setState = async (set: string) =>
  (
    await db.root<{ state: string }>('select state from private.catalog_video_sets where id=$1', [
      set
    ])
  )[0]!.state;
const operationState = async (op: string) =>
  (
    await db.root<{ state: string; error_code: string | null }>(
      'select state,error_code from public.team_operations where id=$1',
      [op]
    )
  )[0]!;

async function fixture(options: { admit: boolean } = { admit: true }) {
  const set = crypto.randomUUID(),
    request = crypto.randomUUID(),
    key = 'live:' + set;
  const intent = (
    await db.root<{ v: { id: string } }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6)v',
      [team, source, owner, key, {}, executor]
    )
  )[0]!.v.id;
  await db.root('select public.service_accept_catalog_video_set($1,$2,$3,$4,$5,$6)', [
    team,
    owner,
    executor,
    {
      setId: set,
      catalogIntentId: intent,
      sourceMaterialId: source,
      sourceVersion: '1',
      settings: { configured: true, operation: 'restitch', sourceMode: 'legacy' },
      settingsDigest: 'a'.repeat(64),
      requestedCount: 1,
      productCount: 1,
      recipeRevision: 1,
      seed: 'b'.repeat(64)
    },
    [{ index: 0, requestId: request }],
    [{ recipeRowId: crypto.randomUUID(), videoVariantIndex: 0 }]
  ]);
  // What the creation flow records before it hands the set to the agent.
  await db.root(
    "update private.catalog_generation_intents set checkpoint=checkpoint||jsonb_build_object('initialVideoPlan',jsonb_build_object('setId',$2::text)),request_payload=request_payload||'{\"catalogVideoProtocolVersion\":1}'::jsonb where id=$1",
    [intent, set]
  );
  if (!options.admit) return { set, request, key, op: null as string | null };
  const op = crypto.randomUUID();
  await db.root(
    "insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce)values($1,$2,$3,'process','running',$4,$5,$5)",
    [op, team, owner, source, 'catalog-variant:' + request]
  );
  await db.root(
    "insert into private.team_operation_intents(operation_id,team_id,tool_id,expected_source_version,expected_source_drive_file_id,expected_source_checksum,expected_name,expected_size,mime_type)values($1,$2,'restitch','1','source',repeat('a',32),'copy.mp4',4,'video/mp4')",
    [op, team]
  );
  await db.root('select public.service_checkpoint_catalog_video_set($1,$2,$3,$4,1,$5,$6)', [
    set,
    team,
    owner,
    executor,
    await revisionOf(set),
    [{ index: 0, requestId: request, operationId: op, state: 'working', outputId: null }]
  ]);
  await db.root('select public.service_dispatch_catalog_video_variant($1,$2,$3,1,0,$4,$5)', [
    set,
    hash,
    native,
    request,
    op
  ]);
  return { set, request, key, op: op as string | null };
}
const release = async (set: string) =>
  (
    await db.root<{ n: number }>(
      "select private.release_silent_catalog_video_variants($1,interval '2 minutes')n",
      [set]
    )
  )[0]!.n;
const orphanWorking = async (set: string, observedMinutesAgo: number | null) => {
  await db.root(
    "update private.catalog_video_variants set state='working',silence_observed_at=case when $2::integer is null then null else clock_timestamp()-make_interval(mins=>$2::integer) end where video_set_id=$1",
    [set, observedMinutesAgo]
  );
};

it('requeues a working variant whose admission was lost before its operation, after observed silence', async () => {
  const f = await fixture({ admit: false });
  await orphanWorking(f.set, null);
  // First look only observes the silence.
  expect(await release(f.set)).toBe(0);
  expect((await variant(f.set)).state).toBe('working');
  expect((await variant(f.set)).silence_observed_at).not.toBeNull();
  // Still inside the window.
  expect(await release(f.set)).toBe(0);
  expect((await variant(f.set)).state).toBe('working');
  // Past it: back to the queue, the set prepares again.
  await orphanWorking(f.set, 3);
  expect(await release(f.set)).toBe(1);
  expect(await variant(f.set)).toMatchObject({ state: 'queued', operation_id: null });
  expect(await setState(f.set)).toBe('preparing');
});

it('never requeues a working variant that has an operation or a heartbeat', async () => {
  const f = await fixture();
  await db.root(
    "update private.catalog_video_variants set silence_observed_at=clock_timestamp()-interval '10 minutes' where video_set_id=$1",
    [f.set]
  );
  expect(await release(f.set)).toBe(0);
  expect((await variant(f.set)).state).toBe('working');
  const g = await fixture({ admit: false });
  await orphanWorking(g.set, 10);
  await db.root(
    'update private.catalog_video_variants set heartbeat_at=clock_timestamp() where video_set_id=$1',
    [g.set]
  );
  expect(await release(g.set)).toBe(0);
  expect((await variant(g.set)).state).toBe('working');
});

async function catalogFor(set: string) {
  const catalog = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type)select team_id,connection_id,'catalog-'||gen_random_uuid(),'Catalog','file','other','application/vnd.google-apps.spreadsheet' from public.team_materials where id=$1 returning id",
      [source]
    )
  )[0]!.id;
  await db.root(
    "insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot)values($1,$2,$3,'https://offer.example.invalid/',1,'https://docs.google.com/spreadsheets/d/fixture/edit','https://drive.google.com/file/d/source/view','{}')",
    [catalog, team, source]
  );
  await db.root(
    "update private.catalog_generation_intents set checkpoint=checkpoint||jsonb_build_object('materialId',$2::text) where id=(select catalog_intent_id from private.catalog_video_sets where id=$1)",
    [set, catalog]
  );
  return catalog;
}

it('stops the unfinished videos of a catalog moved to the trash', async () => {
  const running = await fixture();
  const idle = await fixture({ admit: false });
  const runningCatalog = await catalogFor(running.set);
  const idleCatalog = await catalogFor(idle.set);
  await db.root("update public.team_materials set lifecycle='trashed',trashed_at=clock_timestamp() where id in($1,$2)", [
    runningCatalog,
    idleCatalog
  ]);
  // A variant that may still run waits for its executor; an idle set ends at once.
  expect(await setState(running.set)).toBe('cancel_requested');
  expect(await setState(idle.set)).toBe('canceled');
});

it('leaves a ready set and other catalogs alone', async () => {
  const ready = await fixture({ admit: false });
  const other = await fixture({ admit: false });
  const catalog = await catalogFor(ready.set);
  await catalogFor(other.set);
  await db.root("update private.catalog_video_sets set state='ready' where id=$1", [ready.set]);
  await db.root("update public.team_materials set lifecycle='trashed',trashed_at=clock_timestamp() where id=$1", [catalog]);
  expect(await setState(ready.set)).toBe('ready');
  expect(await setState(other.set)).toBe('accepted');
});
