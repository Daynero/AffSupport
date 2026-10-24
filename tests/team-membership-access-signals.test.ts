import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
const owner = '36000000-0000-4000-8000-000000000001';
const member = '36000000-0000-4000-8000-000000000002';
const outsider = '36000000-0000-4000-8000-000000000003';
let h: TeamTestDb;
let team: string;
beforeAll(async () => {
  h = await createTeamTestDb();
  for (const [id, name] of [
    [owner, 'Owner'],
    [member, 'Member'],
    [outsider, 'Outsider']
  ])
    await createUser(h, { id, email: `${name}@membership.test`, displayName: name });
  await h.root('insert into public.admin_users(user_id) values($1)', [owner]);
  team = (
    await h.asUser<{ id: string }>(owner, 'select id from public.create_team($1)', ['Signal space'])
  )[0].id;
  await h.root(
    "insert into public.team_members(team_id,user_id,base_role) values($1,$2,'viewer')",
    [team, member]
  );
}, 60000);
afterAll(async () => {
  await h?.close();
});
async function asReader<T = Record<string, unknown>>(
  user: string,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  return h.db.transaction(async tx => {
    await tx.exec('set local role authenticated');
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [user]);
    return (await tx.query<T>(sql, params)).rows;
  });
}
const revision = async () =>
  (
    await asReader<{ revision: number }>(
      member,
      'select revision from public.team_membership_access_signals where team_id=$1',
      [team]
    )
  )[0]?.revision;
describe('own-row membership access invalidation', () => {
  it('keeps the attachment reference inventory fully fenced after adding a team table', async () => {
    expect(
      (
        await h.root<{ verified: boolean }>(
          'select private.task_cleanup_coverage_verified() verified'
        )
      )[0].verified
    ).toBe(true);
  });
  it('delivers a durable revision for role changes and overrides without catalog traffic', async () => {
    const initial = Number(await revision());
    await h.asUser(owner, "select * from public.update_membership($1,$2,'editor','{}'::jsonb)", [
      team,
      member
    ]);
    expect(Number(await revision())).toBe(initial + 1);
    await h.asUser(
      owner,
      'select * from public.update_membership($1,$2,null,\'{"download":false}\'::jsonb)',
      [team, member]
    );
    expect(Number(await revision())).toBe(initial + 2);
    await h.asUser(
      owner,
      'select * from public.update_membership($1,$2,null,\'{"download":false}\'::jsonb)',
      [team, member]
    );
    expect(Number(await revision())).toBe(initial + 2);
  });
  it('never reveals another person’s signals or permits client writes', async () => {
    expect(
      await asReader(
        outsider,
        'select * from public.team_membership_access_signals where team_id=$1',
        [team]
      )
    ).toEqual([]);
    const own = await asReader<{ user_id: string }>(
      member,
      'select * from public.team_membership_access_signals where team_id=$1',
      [team]
    );
    expect(own.map(row => row.user_id)).toEqual([member]);
    await expect(
      asReader(
        member,
        'update public.team_membership_access_signals set revision=999 where team_id=$1',
        [team]
      )
    ).rejects.toThrow(/permission denied/i);
  });
  it('keeps own-row privacy even for a non-bypass table owner', async () => {
    const rollback = new Error('ROLLBACK_RLS_OWNER_PROBE');
    let visible: unknown[] | undefined;
    await expect(
      h.db.transaction(async tx => {
        await tx.exec(`
        create role membership_signal_owner_probe nologin nobypassrls;
        grant authenticated to membership_signal_owner_probe;
        alter table public.team_membership_access_signals owner to membership_signal_owner_probe;
        set local role membership_signal_owner_probe;
      `);
        await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [outsider]);
        visible = (await tx.query('select user_id from public.team_membership_access_signals'))
          .rows;
        // Roll back the probe owner and role as well as its transaction-local claims.
        throw rollback;
      })
    ).rejects.toBe(rollback);
    expect(visible).toEqual([]);
  });
  it('remains readable to the removed person while workspace reads are denied', async () => {
    const initial = Number(await revision());
    await h.asUser(owner, 'select * from public.remove_member($1,$2)', [team, member]);
    expect(Number(await revision())).toBe(initial + 1);
    await expect(
      h.asUser(member, 'select * from public.list_team_accounts($1)', [team])
    ).rejects.toThrow(/PERMISSION_DENIED|NOT_A_MEMBER/);
  });
  it('removes signal metadata with the deleted parent and does not break cascading user deletion', async () => {
    await h.root('delete from auth.users where id=$1', [member]);
    expect(
      await h.root('select * from public.team_membership_access_signals where user_id=$1', [member])
    ).toEqual([]);
    await h.root('delete from public.teams where id=$1', [team]);
    expect(
      await h.root('select * from public.team_membership_access_signals where team_id=$1', [team])
    ).toEqual([]);
  });
});
