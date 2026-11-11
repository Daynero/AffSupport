import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * 1.4.3: a closed «Перенесення файлів до кошика» panel came back after every
 * reload, because hiding it lived only in the tab. Hiding is now hosted, per
 * viewer, and finished work nobody needs to see again arrives already hidden.
 */
let h: TeamTestDb, team: string, connection: string;
const owner = '37000000-0000-4000-8000-000000000611';
const member = '37000000-0000-4000-8000-000000000612';
beforeAll(async () => {
  h = await createTeamTestDb();
  await createUser(h, { id: owner, email: 'trash-dismiss-owner@example.test' });
  await createUser(h, { id: member, email: 'trash-dismiss-member@example.test' });
  await h.root('insert into public.admin_users(user_id) values($1)', [owner]);
  team = (await h.asUser<{ id: string }>(owner, "select id from public.create_team('Dismiss')"))[0]!
    .id;
  await h.root("insert into public.team_members(team_id,user_id,base_role) values($1,$2,'admin')", [
    team,
    member
  ]);
  const credential = (
    await h.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('dismiss','dismiss@example.test','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
      [owner]
    )
  )[0]!.id;
  connection = (
    await h.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state) values($1,$2,'root','Root','my_drive','connected') returning id",
      [team, credential]
    )
  )[0]!.id;
}, 120000);
afterAll(async () => {
  await h?.close();
});

let counter = 0;
async function group(actor: string, finished: boolean, ageDays = 0) {
  const material = (
    await h.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,mime_type) values($1,$2,$3,'Fixture','file','image/png') returning id",
      [team, connection, `dismiss-${++counter}`]
    )
  )[0]!.id;
  const id = crypto.randomUUID();
  await h.root(
    'insert into private.team_bulk_trash_groups(id,team_id,actor_id,source_ids,created_at) values($1,$2,$3,array[$4::uuid],now()-make_interval(days=>$5))',
    [id, team, actor, material, ageDays]
  );
  await h.root(
    'insert into private.team_bulk_trash_items(group_id,material_id,idempotency_key) values($1,$2,$3)',
    [id, material, `${id}:${material}`]
  );
  if (finished)
    await h.root(
      `insert into public.team_operations(id,team_id,actor_id,kind,state,idempotency_key,request_nonce,source_material_id,finished_at)
       values(gen_random_uuid(),$1,$2,'trash','succeeded',$3,$3,$4,now())`,
      [team, actor, `${id}:${material}`, material]
    );
  return id;
}
const listFor = async (viewer: string) =>
  new Map(
    (
      await h.asUser<{ data: Array<{ id: string; dismissed: boolean }> }>(
        viewer,
        'select public.list_team_bulk_trash($1) data',
        [team]
      )
    )[0]!.data.map(entry => [entry.id, entry.dismissed])
  );

it('keeps a dismissal per viewer and still lists the group for reconciliation', async () => {
  const open = await group(owner, false);
  expect((await listFor(owner)).get(open)).toBe(false);
  await h.asUser(owner, 'select public.dismiss_team_bulk_trash($1,$2)', [team, open]);
  await h.asUser(owner, 'select public.dismiss_team_bulk_trash($1,$2)', [team, open]);
  expect((await listFor(owner)).get(open)).toBe(true);
  // Unfinished work by someone else stays visible to them until they close it.
  expect((await listFor(member)).get(open)).toBe(false);
});

it('arrives hidden when finished and old, or finished and someone else’s', async () => {
  const fresh = await group(owner, true);
  const old = await group(owner, true, 2);
  const oldUnfinished = await group(owner, false, 2);
  const owners = await listFor(owner);
  expect(owners.get(fresh)).toBe(false);
  expect(owners.get(old)).toBe(true);
  expect(owners.get(oldUnfinished)).toBe(false);
  expect((await listFor(member)).get(fresh)).toBe(true);
});

it('refuses a dismissal without access or for another team’s group', async () => {
  const id = await group(owner, false);
  await expect(
    h.asUser(null, 'select public.dismiss_team_bulk_trash($1,$2)', [team, id])
  ).rejects.toThrow('PERMISSION_DENIED');
  await expect(
    h.asUser(owner, 'select public.dismiss_team_bulk_trash($1,$2)', [team, crypto.randomUUID()])
  ).rejects.toThrow('NOT_FOUND');
});
