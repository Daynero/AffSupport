import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Production 2026-11-11: creation intent ce003cbb was canceled, but its video
 * set aab5870c stayed 'cancel_requested' («Готово відео: 0 з 1») for 40 minutes.
 * The set had one variant, 'unknown', and no operation was ever created. The
 * person then could not start another catalog for the same video.
 */
let db: TeamTestDb, team: string, source: string, connection: string;
const ACTOR = '75000000-0000-4000-8000-000000000001',
  executor = '75000000-0000-4000-8000-000000000002',
  native = '75000000-0000-4000-8000-000000000003';

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: ACTOR, email: 'cancel-no-op@example.invalid' });
  await db.root('insert into public.admin_users(user_id) values ($1)', [ACTOR]);
  team = (
    await db.asUser<{ id: string }>(ACTOR, "select id from public.create_team('Cancel no op')")
  )[0]!.id;
  const credential = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('perm-no-op','no-op@example.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
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
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,size_bytes,checksum,drive_version) values($1,$2,'source','TR 108.mp4','file','video','video/mp4',4,repeat('a',32),'1') returning id",
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

const begin = async (key: string) =>
  (
    await db.root<{ v: { id: string; variant: number } }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6)v',
      [team, source, ACTOR, key, {}, executor]
    )
  )[0]!.v;
const setState = async (set: string) =>
  (
    await db.root<{ state: string }>('select state from private.catalog_video_sets where id=$1', [
      set
    ])
  )[0]!.state;
const settle = async () => db.root('select public.service_settle_catalog_video_cancellations(10)');

/** One-video creation whose only variant was reported unknown before any operation existed. */
async function canceledCreation(opts: { dispatched: boolean; heartbeatAgo: string | null }) {
  const set = crypto.randomUUID(),
    request = crypto.randomUUID();
  const intent = await begin('cancel-no-op:' + set);
  await db.root('select public.service_accept_catalog_video_set($1,$2,$3,$4,$5,$6)', [
    team,
    ACTOR,
    executor,
    {
      setId: set,
      catalogIntentId: intent.id,
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
  await db.root(
    "update private.catalog_generation_intents set checkpoint=jsonb_build_object('initialVideoPlan',jsonb_build_object('setId',$2::text)),request_payload=request_payload||'{\"catalogVideoProtocolVersion\":1}'::jsonb where id=$1",
    [intent.id, set]
  );
  await db.root(
    "update private.catalog_video_variants set state='unknown',dispatch_credential_hash=$2,dispatch_native_instance_id=$3,heartbeat_at=clock_timestamp()-$4::interval where video_set_id=$1 and video_variant_index=0",
    [
      set,
      opts.dispatched ? Buffer.alloc(32, 0xaf) : null,
      opts.dispatched ? native : null,
      opts.heartbeatAgo
    ]
  );
  // The person canceled: the intent is canceled, the set waits for proof.
  await db.root(
    "update private.catalog_video_sets set state='cancel_requested',native_instance_id=$2 where id=$1",
    [set, native]
  );
  await db.root("update private.catalog_generation_intents set state='canceled' where id=$1", [
    intent.id
  ]);
  return { set, intent };
}

it('aab5870c: a canceled set whose only variant never had an operation closes', async () => {
  const f = await canceledCreation({ dispatched: true, heartbeatAgo: '40 minutes' });
  await settle();
  expect(await setState(f.set)).toBe('canceled');
});

it('closes at once when the unknown variant was never even heard from', async () => {
  const f = await canceledCreation({ dispatched: false, heartbeatAgo: null });
  await settle();
  expect(await setState(f.set)).toBe('canceled');
});

it('waits out three minutes after the last heartbeat of a dispatched variant', async () => {
  const f = await canceledCreation({ dispatched: true, heartbeatAgo: '30 seconds' });
  await settle();
  expect(await setState(f.set)).toBe('cancel_requested');
  await db.root(
    "update private.catalog_video_variants set heartbeat_at=clock_timestamp()-interval '4 minutes' where video_set_id=$1",
    [f.set]
  );
  await settle();
  expect(await setState(f.set)).toBe('canceled');
});

it('no operation can be admitted for the canceling set meanwhile', async () => {
  const f = await canceledCreation({ dispatched: true, heartbeatAgo: '30 seconds' });
  const request = (
    await db.root<{ request_id: string }>(
      'select request_id from private.catalog_video_variants where video_set_id=$1',
      [f.set]
    )
  )[0]!.request_id;
  await expect(
    db.root(
      "insert into public.team_operations(team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce)values($1,$2,'process','pending',$3,$4,$4)",
      [team, ACTOR, source, 'catalog-variant:' + request]
    )
  ).rejects.toThrow(/WRONG_STATE/u);
});

it('a canceled creation never blocks a new one for the same video, even while it settles', async () => {
  const f = await canceledCreation({ dispatched: true, heartbeatAgo: '30 seconds' });
  expect(await setState(f.set)).toBe('cancel_requested');
  const next = await begin('product-catalog:' + crypto.randomUUID());
  expect(next.id).not.toBe(f.intent.id);
  // The canceled creation's number is free again: no catalog was registered.
  expect(next.variant).toBe(f.intent.variant);
});

const variantRow = async (set: string) =>
  (
    await db.root<{ state: string; heartbeat_at: Date | null }>(
      'select state,heartbeat_at from private.catalog_video_variants where video_set_id=$1 and video_variant_index=0',
      [set]
    )
  )[0]!;

it('95a121a2: a set that closes as canceled leaves no operation-less variant working', async () => {
  const f = await canceledCreation({ dispatched: false, heartbeatAgo: null });
  await db.root(
    "update private.catalog_video_variants set state='working',heartbeat_at=clock_timestamp()-interval '10 minutes' where video_set_id=$1",
    [f.set]
  );
  await settle();
  expect(await setState(f.set)).toBe('canceled');
  expect(await variantRow(f.set)).toEqual({ state: 'queued', heartbeat_at: null });
});

it('any path to canceled returns an operation-less working variant to queued', async () => {
  const f = await canceledCreation({ dispatched: false, heartbeatAgo: null });
  await db.root("update private.catalog_video_variants set state='working' where video_set_id=$1", [
    f.set
  ]);
  await db.root("update private.catalog_video_sets set state='canceled' where id=$1", [f.set]);
  expect((await variantRow(f.set)).state).toBe('queued');
});
