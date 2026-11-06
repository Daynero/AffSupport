import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
const OWNER = '47000000-0000-4000-8000-000000000071';
const VIEWER = '47000000-0000-4000-8000-000000000072';
let db: TeamTestDb;
let team: string;
let connection: string;
beforeAll(async () => {
  db = await createTeamTestDb();
  // PGlite's pgcrypto stub tests equality, not cryptographic strength. This
  // suite needs SHA-256's actual output shape; native PostgreSQL proves the hash.
  await db.root(`create or replace function extensions.digest(bytea,text) returns bytea language sql immutable
   as $$select decode(md5($1)||md5($1),'hex')$$`);
  await createUser(db, { id: OWNER, email: 'share-owner@example.invalid' });
  await createUser(db, { id: VIEWER, email: 'share-viewer@example.invalid' });
  await db.root('insert into public.admin_users(user_id) values($1)', [OWNER]);
  team = (
    await db.asUser<{ id: string }>(OWNER, 'select id from public.create_team($1)', ['Share test'])
  )[0]!.id;
  await db.root(
    "insert into public.team_members(team_id,user_id,base_role) values($1,$2,'viewer')",
    [team, VIEWER]
  );
  const credential = (
    await db.root<{ id: string }>(
      `insert into private.google_drive_credentials
  (google_permission_id,google_account_email,scope,vault_secret_id,connected_by)
  values('share-fixture','share-owner@example.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id`,
      [OWNER]
    )
  )[0]!.id;
  connection = (
    await db.root<{ id: string }>(
      `insert into public.team_drive_connections
  (team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at)
  values($1,$2,'root','Root','my_drive','connected',now()) returning id`,
      [team, credential]
    )
  )[0]!.id;
}, 180_000);
afterAll(() => db?.close());
async function material() {
  const file = 'synthetic-' + crypto.randomUUID();
  const id = (
    await db.root<{ id: string }>(
      `insert into public.team_materials
  (team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type)
  values($1,$2,$3,'root','Synthetic sheet','file','other','text/csv') returning id`,
      [team, connection, file]
    )
  )[0]!.id;
  return { id, file };
}
const key = (ms = Date.now()) => `share.v2:${ms}:${crypto.randomUUID()}`;
interface Receipt {
  intentId: string;
  state: string;
  shareVersion: string | null;
  writeAllowed: boolean;
  attribution: string;
}
async function begin(
  item: { id: string; file: string },
  nonce = key(),
  options: { actor?: string; version?: string | null; remember?: boolean; public?: boolean } = {}
) {
  return (
    await db.root<{ receipt: Receipt }>(
      'select public.service_begin_material_share($1,$2,$3,$4,$5,$6,$7,$8,$9) receipt',
      [
        team,
        options.actor ?? OWNER,
        item.id,
        connection,
        item.file,
        nonce,
        options.remember ?? false,
        options.public ?? false,
        options.version ?? null
      ]
    )
  )[0]!.receipt;
}
async function confirm(item: { file: string }, receipt: Receipt, noWrite = false) {
  return (
    await db.root<{ ok: boolean }>(
      'select public.service_confirm_material_share($1,$2,$3,$4,null,$5) ok',
      [team, OWNER, receipt.intentId, item.file, noWrite]
    )
  )[0]!.ok;
}
async function status(item: { id: string; file: string }, actor = OWNER) {
  return (
    await db.root<{
      status: { pending: boolean; commandId: string | null; shareVersion: string | null };
    }>('select public.service_material_share_status($1,$2,$3,$4) status', [
      team,
      actor,
      item.id,
      item.file
    ])
  )[0]!.status;
}
it('issues exactly one create permit and makes the same immutable request read-only on replay', async () => {
  const item = await material(),
    nonce = key();
  const first = await begin(item, nonce);
  expect(first).toMatchObject({
    state: 'write_started',
    writeAllowed: true,
    attribution: 'unchanged'
  });
  expect(await begin(item, nonce)).toMatchObject({
    intentId: first.intentId,
    writeAllowed: false,
    attribution: 'unknown'
  });
  expect((await status(item)).shareVersion).toBe(first.shareVersion);
});
it('rejects changed consent or target under the same retained request key', async () => {
  const a = await material(),
    b = await material(),
    nonce = key();
  await begin(a, nonce);
  await expect(begin(a, nonce, { remember: true })).rejects.toThrow(/INVALID_INPUT/);
  await expect(begin(b, nonce)).rejects.toThrow(/INVALID_INPUT/);
});
it('blocks a new key while another request owns an unknown per-file write', async () => {
  const item = await material();
  const first = await begin(item);
  const next = await begin(item);
  expect(next).toMatchObject({ state: 'blocked', writeAllowed: false, attribution: 'unknown' });
  expect(next.intentId).not.toBe(first.intentId);
  expect(await confirm(item, next)).toBe(true);
  expect(await begin(item, key(), { version: first.shareVersion })).toMatchObject({
    writeAllowed: true
  });
});
it('fences a delayed preflight after another request advances the share authority', async () => {
  const item = await material(),
    oldKey = key();
  const first = await begin(item);
  expect(await confirm(item, first)).toBe(true);
  await expect(begin(item, oldKey, { version: null })).rejects.toThrow(/STALE_RESULT/);
  const fresh = await begin(item, key(), { version: first.shareVersion });
  expect(fresh.writeAllowed).toBe(true);
  expect(fresh.shareVersion).not.toBe(first.shareVersion);
});
it('keeps view access useful without allowing a viewer to create a permission', async () => {
  const item = await material();
  await expect(begin(item, key(), { actor: VIEWER })).rejects.toThrow(/PERMISSION_DENIED/);
  expect(await begin(item, key(), { actor: VIEWER, public: true })).toMatchObject({
    writeAllowed: false,
    state: 'confirmed'
  });
});
it('does not disclose another member request identity while reporting shared pending state', async () => {
  const item = await material(),
    nonce = key();
  await begin(item, nonce);
  expect(await status(item)).toMatchObject({ pending: true, commandId: nonce.split(':')[2] });
  expect(await status(item, VIEWER)).toMatchObject({ pending: true, commandId: null });
});
it('retains acknowledged provider proof and releases raw source references after confirmation', async () => {
  const item = await material(),
    nonce = key(),
    first = await begin(item, nonce);
  await db.root('select public.service_acknowledge_material_share($1,$2,$3,$4)', [
    team,
    OWNER,
    first.intentId,
    'synthetic-permission'
  ]);
  expect(await begin(item, nonce)).toMatchObject({
    writeAllowed: false,
    attribution: 'acknowledged'
  });
  expect(await confirm(item, first)).toBe(true);
  expect(
    (
      await db.root(
        'select material_id,provider_file_id,permission_id,state from private.team_material_share_intents where id=$1',
        [first.intentId]
      )
    )[0]
  ).toMatchObject({
    material_id: null,
    provider_file_id: null,
    permission_id: 'synthetic-permission',
    state: 'confirmed'
  });
});
it('preserves unknown attribution after observing public access rather than claiming its writer', async () => {
  const item = await material(),
    nonce = key(),
    first = await begin(item, nonce);
  await db.root('select public.service_observe_material_share_public($1,$2,$3,$4)', [
    team,
    OWNER,
    item.id,
    item.file
  ]);
  expect(await begin(item, nonce)).toMatchObject({
    intentId: first.intentId,
    writeAllowed: false,
    state: 'confirmed',
    attribution: 'unknown'
  });
});
it('records a reserved but explicitly unexecuted POST as unchanged after the final public read', async () => {
  const item = await material(),
    nonce = key(),
    first = await begin(item, nonce);
  expect(await confirm(item, first, true)).toBe(true);
  expect(await begin(item, nonce)).toMatchObject({
    state: 'confirmed',
    writeAllowed: false,
    attribution: 'unchanged'
  });
});
it.each([-6, 6])('rejects a new key issued %s minutes from the server clock', async minutes => {
  await expect(begin(await material(), key(Date.now() + minutes * 60_000))).rejects.toThrow(
    /CATALOG_LINK_REQUEST_EXPIRED/
  );
});
it('prunes only expired completed receipts and makes their old keys incapable of another write', async () => {
  const item = await material(),
    first = await begin(item);
  await confirm(item, first);
  const oldKey = key(Date.now() - 33 * 86_400_000);
  await db.root(
    "update private.team_material_share_intents set request_key=$2,created_at=now()-interval '33 days' where id=$1",
    [first.intentId, oldKey]
  );
  expect(
    (await db.root<{ n: number }>('select public.service_prune_material_share_receipts(100) n'))[0]!
      .n
  ).toBe(1);
  await expect(begin(item, oldKey, { version: first.shareVersion })).rejects.toThrow(
    /CATALOG_LINK_REQUEST_EXPIRED/
  );
  const pending = await begin(await material());
  await db.root(
    "update private.team_material_share_intents set created_at=now()-interval '33 days' where id=$1",
    [pending.intentId]
  );
  await db.root('select public.service_prune_material_share_receipts(100)');
  expect(
    await db.root('select id from private.team_material_share_intents where id=$1', [
      pending.intentId
    ])
  ).toHaveLength(1);
});
it('expires an idle authority without allowing an ABA replay of its old observed version', async () => {
  const item = await material(),
    first = await begin(item);
  await confirm(item, first);
  await db.root(
    "update private.team_material_share_authorities set last_consumed_at=now()-interval '33 days' where team_id=$1 and version=$2",
    [team, first.shareVersion]
  );
  await db.root('select public.service_prune_material_share_receipts(100)');
  expect((await status(item)).shareVersion).toBeNull();
  const fresh = await begin(item);
  expect(fresh.shareVersion).not.toBe(first.shareVersion);
  await confirm(item, fresh);
  await expect(begin(item, key(), { version: first.shareVersion })).rejects.toThrow(/STALE_RESULT/);
});
it('keeps both reference fences installed and service-only RPCs out of client roles', async () => {
  expect(
    (await db.root<{ ok: boolean }>('select private.task_cleanup_coverage_verified() ok'))[0]!.ok
  ).toBe(true);
  const signature =
    'public.service_begin_material_share(uuid,uuid,uuid,uuid,text,text,boolean,boolean,uuid)';
  expect(
    (
      await db.root(
        "select has_function_privilege('anon',$1,'execute') anon,has_function_privilege('authenticated',$1,'execute') authenticated,has_function_privilege('service_role',$1,'execute') service",
        [signature]
      )
    )[0]
  ).toEqual({ anon: false, authenticated: false, service: true });
  expect(
    (
      await db.root(
        "select material_id,provider_file_id from private.team_material_share_intents where state='confirmed'"
      )
    ).every(row => row.material_id === null && row.provider_file_id === null)
  ).toBe(true);
});
