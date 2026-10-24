import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import { inspectCleanupGraph, emptyTariffEvent } from '../scripts/acceptance/cleanup-graph.mjs';
import { cleanupOwnership, clearLocalFixtures } from '../scripts/acceptance/cleanup.mjs';
const namespace = 'acceptance-cleanup-unit';
const actor = '36000000-0000-4000-8000-000000000041';
const foreign = '36000000-0000-4000-8000-000000000042';
let h: TeamTestDb;
let team: string;
let ownership: any;
const db = {
  query: async (sql: string, params?: unknown[]) => ({ rows: await h.root(sql, params) })
};
async function makeTeam(name: string, owner: string): Promise<string> {
  return h.db.transaction(async tx => {
    const id = (
      await tx.query<{ id: string }>(
        'insert into public.teams(name,owner_id) values($1,$2) returning id',
        [name, owner]
      )
    ).rows[0].id;
    await tx.query(
      "insert into public.team_members(team_id,user_id,base_role) values($1,$2,'admin')",
      [id, owner]
    );
    return id;
  });
}
beforeAll(async () => {
  h = await createTeamTestDb();
  await createUser(h, { id: actor, email: `${namespace}-a@soty.invalid`, displayName: '036 A' });
  await createUser(h, {
    id: foreign,
    email: 'foreign@fixture.invalid',
    displayName: 'Foreign sentinel'
  });
  team = await makeTeam(`${namespace} W1`, actor);
  ownership = {
    namespace,
    actors: [{ alias: 'A', id: actor, email: `${namespace}-a@soty.invalid` }],
    adminId: actor,
    expectedTeams: [{ alias: 'W1', id: team, name: `${namespace} W1`, ownerId: actor }]
  };
}, 120000);
afterAll(async () => h?.close());
it('rejects unsafe targets and malformed ownership before accessing runtime', async () => {
  await expect(clearLocalFixtures({ kind: 'production' })).rejects.toThrow(
    'ACCEPTANCE_TARGET_UNSAFE'
  );
  expect(() => cleanupOwnership(namespace, { actors: {}, teams: {}, namespace })).toThrow(
    'ACCEPTANCE_FIXTURE_MISMATCH'
  );
});
it('accepts only the empty namespace-owned graph', async () => {
  const result = await inspectCleanupGraph(db, ownership);
  expect(result.ok).toBe(true);
  expect(result.teamIds).toEqual([team]);
});
it('refuses a fixture identity referenced by another team and leaves that sentinel intact', async () => {
  const other = await makeTeam('Foreign team', foreign);
  const member = (
    await h.root<{ id: string }>(
      "insert into public.team_members(team_id,user_id,base_role) values($1,$2,'viewer') returning id",
      [other, actor]
    )
  )[0].id;
  try {
    const result = await inspectCleanupGraph(db, ownership);
    expect(result.ok).toBe(false);
    expect(result.blockers).toContainEqual({
      code: 'foreign_or_populated_reference',
      table: 'public.team_members'
    });
    expect(
      (
        await h.root<{ n: number }>('select count(*)::int n from public.team_members where id=$1', [
          member
        ])
      )[0].n
    ).toBe(1);
  } finally {
    await h.root('delete from public.team_members where id=$1', [member]);
    await h.root(
      'delete from public.team_membership_access_signals where team_id=$1 and user_id=$2',
      [other, actor]
    );
    await h.root('delete from public.teams where id=$1', [other]);
  }
});
it('refuses profile-cascaded waitlists instead of silently deleting them', async () => {
  for (const table of ['team_workspace_waitlist', 'windows_app_waitlist']) {
    await h.root(`insert into public.${table}(user_id,email) values($1,$2)`, [
      actor,
      `${namespace}-a@soty.invalid`
    ]);
    try {
      const result = await inspectCleanupGraph(db, ownership);
      expect(result.blockers).toContainEqual({
        code: 'foreign_or_populated_reference',
        table: `public.${table}`
      });
    } finally {
      await h.root(`delete from public.${table} where user_id=$1`, [actor]);
    }
  }
});
it('refuses storage objects without guessing ownership or invoking a provider', async () => {
  const id = (
    await h.root<{ id: string }>(
      "insert into storage.objects(bucket_id,name) values('test','control-sentinel') returning id"
    )
  )[0].id;
  try {
    expect((await inspectCleanupGraph(db, ownership)).blockers).toContainEqual({
      code: 'storage_cleanup_unsupported'
    });
  } finally {
    await h.root('delete from storage.objects where id=$1', [id]);
  }
});
it('rejects unknown JSON references even after the known team disappeared', async () => {
  await h.root('create table private.acceptance_reference_probe(payload jsonb)');
  await h.root('insert into private.acceptance_reference_probe values($1::jsonb)', [
    JSON.stringify({ nested: { team: team } })
  ]);
  await h.root('delete from public.teams where id=$1', [team]);
  const result = await inspectCleanupGraph(db, ownership);
  expect(result.teamIds).toEqual([]);
  expect(result.blockers).toContainEqual({
    code: 'foreign_or_populated_reference',
    table: 'private.acceptance_reference_probe'
  });
});
it('never treats arbitrary tariff JSON history as an empty fixture', () => {
  const row = {
    actor_id: actor,
    team_id: null,
    kind: 'granted',
    before: null,
    after: {
      planCode: 'lead',
      endsOn: '2026-11-20',
      extraSeats: 0,
      note: namespace,
      externalRef: null,
      revokedAt: null,
      teamId: null,
      notify: false
    }
  };
  expect(emptyTariffEvent(row, ownership, [team])).toBe(true);
  expect(
    emptyTariffEvent({ ...row, after: { ...row.after, foreignActor: foreign } }, ownership, [team])
  ).toBe(false);
  expect(emptyTariffEvent({ ...row, actor_id: foreign }, ownership, [team])).toBe(false);
});
