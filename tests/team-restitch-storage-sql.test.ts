import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

const owner = '23100000-0000-4000-8000-000000000011';
const stranger = '23100000-0000-4000-8000-000000000012';
let harness: TeamTestDb;
let team: string;
beforeAll(async () => {
  harness = await createTeamTestDb();
  await createUser(harness, { id: owner, email: 'owner@storage.test' });
  await createUser(harness, { id: stranger, email: 'stranger@storage.test' });
  await harness.root('insert into public.admin_users(user_id) values ($1)', [owner]);
  team = (
    await harness.asUser<{ id: string }>(owner, 'select id from public.create_team($1)', [
      'Storage'
    ])
  )[0]!.id;
  await harness.db.exec(`alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated;
    grant select, insert on storage.objects to authenticated;`);
});
afterAll(async () => {
  await harness?.close();
});

async function asStorageUser(actor: string, sql: string, params: unknown[] = []) {
  await harness.root("select set_config('request.jwt.claim.sub', $1, false)", [actor]);
  await harness.root('set role authenticated');
  try {
    return await harness.root(sql, params);
  } finally {
    await harness.root('reset role');
    await harness.root("select set_config('request.jwt.claim.sub', '', false)");
  }
}
it('still lets a member read the legacy images, but nobody can publish any more (030)', async () => {
  // The bucket is closed to writes in the same release that retires the uploader (FR-028).
  // Reading stays until the approved deletion, so spaces still in legacy mode keep working.
  await expect(
    asStorageUser(
      owner,
      "insert into storage.objects(bucket_id, name) values ('team-restitch-images', $1)",
      [`${team}/${owner}/start/image.png`]
    )
  ).rejects.toThrow(/row-level security/);
  await harness.root(
    "insert into storage.objects(bucket_id, name) values ('team-restitch-images', $1)",
    [`${team}/${owner}/start/image.png`]
  );
  const rows = await asStorageUser(owner, 'select name from storage.objects');
  expect(rows).toHaveLength(1);
});
it('does not allow outsiders to read or publish images', async () => {
  expect(await asStorageUser(stranger, 'select name from storage.objects')).toEqual([]);
  await expect(
    asStorageUser(
      stranger,
      "insert into storage.objects(bucket_id, name) values ('team-restitch-images', $1)",
      [`${team}/${stranger}/start/image.png`]
    )
  ).rejects.toThrow();
});
it('rejects writes to another user’s namespace after the bucket closes', async () => {
  await expect(
    asStorageUser(
      owner,
      "insert into storage.objects(bucket_id, name) values ('team-restitch-images', $1)",
      [`${team}/${stranger}/start/image.png`]
    )
  ).rejects.toThrow();
});
it('rejects malformed paths without a UUID cast failure', async () => {
  await expect(
    asStorageUser(
      owner,
      "insert into storage.objects(bucket_id, name) values ('team-restitch-images', $1)",
      [`invalid/${owner}/start/image.png`]
    )
  ).rejects.toThrow(/row-level security/);
});

it('reads saved owner settings through the same RPC after a page reload', async () => {
  await harness.asUser(owner, 'select public.set_restitch_defaults($1, $2::jsonb)', [
    team,
    JSON.stringify({
      operation: 'restitch',
      startImageIds: [owner],
      endImageIds: [],
      startEnabled: true,
      endEnabled: false,
      fitMode: 'cover',
      finalDurationMode: 'random-50-60',
      customFinalDurationSeconds: 2700
    })
  ]);
  const rows = await harness.asUser<{ settings: { configured: boolean; startImageIds: string[] } }>(
    owner,
    'select public.get_effective_restitch_defaults($1) as settings',
    [team]
  );
  expect(rows[0]!.settings.configured).toBe(true);
  expect(rows[0]!.settings.startImageIds).toEqual([owner]);
});

it('lists what one member left in the bucket, for account deletion (030)', async () => {
  await harness.root(
    "insert into storage.objects(bucket_id, name) values ('team-restitch-images', $1), ('team-restitch-images', $2)",
    [`${team}/${stranger}/end/a.png`, `${team}/${owner}/end/b.png`]
  );
  const rows = await harness.root<{ names: string[] }>(
    'select public.service_list_user_restitch_objects($1) as names',
    [stranger]
  );
  expect(rows[0]!.names).toEqual([`${team}/${stranger}/end/a.png`]);
});
