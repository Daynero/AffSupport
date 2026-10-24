import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
const owner = '36000000-0000-4000-9000-000000000001';
const manager = '36000000-0000-4000-9000-000000000002';
const viewer = '36000000-0000-4000-9000-000000000003';
let h: TeamTestDb;
let team: string;
let invitation: string;
beforeAll(async () => {
  h = await createTeamTestDb();
  for (const [id, name] of [
    [owner, 'Owner'],
    [manager, 'Manager'],
    [viewer, 'Viewer']
  ])
    await createUser(h, { id, email: `${name}@manager-signal.test` });
  await h.root('insert into public.admin_users(user_id) values($1)', [owner]);
  team = (
    await h.asUser<{ id: string }>(owner, 'select id from public.create_team($1)', [
      'Manager signal'
    ])
  )[0].id;
  await h.root(
    "insert into public.team_members(team_id,user_id,base_role) values($1,$2,'admin'),($1,$3,'viewer')",
    [team, manager, viewer]
  );
}, 60000);
afterAll(async () => {
  await h?.close();
});
async function revision(user: string) {
  const rows = await h.root<{ revision: string | number }>(
    'select revision from public.team_membership_access_signals where team_id=$1 and user_id=$2',
    [team, user]
  );
  return Number(rows[0]?.revision ?? 0);
}
it('invalidates the owner when another member changes without disclosing the affected identity', async () => {
  const before = await revision(owner);
  try {
    await h.asUser(owner, "select * from public.update_membership($1,$2,'editor','{}'::jsonb)", [
      team,
      manager
    ]);
    expect(await revision(owner)).toBe(before + 1);
  } finally {
    await h.asUser(owner, "select * from public.update_membership($1,$2,'admin','{}'::jsonb)", [
      team,
      manager
    ]);
  }
});
it('invalidates current managers for pending invitations, without waking ordinary viewers', async () => {
  const before = {
    owner: await revision(owner),
    manager: await revision(manager),
    viewer: await revision(viewer)
  };
  invitation = (
    await h.asUser<{ id: string }>(
      owner,
      "select id from public.create_invitation($1,$2,'editor',$3)",
      [team, 'invited@manager-signal.test', Buffer.alloc(32, 11)]
    )
  )[0].id;
  expect(await revision(owner)).toBe(before.owner + 1);
  expect(await revision(manager)).toBe(before.manager + 1);
  expect(await revision(viewer)).toBe(before.viewer);
});
it('ignores delivery bookkeeping but invalidates changed invitation validity', async () => {
  const before = await revision(owner);
  await h.root(
    "update public.team_invitations set last_sent_at=last_sent_at+interval '1 second' where id=$1",
    [invitation]
  );
  expect(await revision(owner)).toBe(before);
  await h.root(
    "update public.team_invitations set expires_at=expires_at+interval '1 day' where id=$1",
    [invitation]
  );
  expect(await revision(owner)).toBe(before + 1);
});
it('retains own-row SELECT even for an owner and never exposes other recipients', async () => {
  const rows = await h.db.transaction(async tx => {
    await tx.exec('set local role authenticated');
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [owner]);
    return (
      await tx.query<{ user_id: string }>(
        'select user_id from public.team_membership_access_signals where team_id=$1',
        [team]
      )
    ).rows;
  });
  expect(rows.map(x => x.user_id)).toEqual([owner]);
});
