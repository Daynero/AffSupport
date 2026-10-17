import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
const OWNER = '71000000-0000-4000-8000-000000000001';
const OUTSIDER = '71000000-0000-4000-8000-000000000002';
let db: TeamTestDb;
let team: string;
beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: OWNER, email: 'launch-owner@example.test' });
  await createUser(db, { id: OUTSIDER, email: 'launch-outsider@example.test' });
  await db.root('insert into public.admin_users(user_id) values ($1)', [OWNER]);
  const rows = await db.asUser<{ id: string }>(
    OWNER,
    "select id from public.create_team('Launch test')"
  );
  team = rows[0].id;
});
afterAll(async () => {
  await db?.close();
});
describe('Launch persistence', () => {
  it('isolates dictionaries and keeps Buyer distinct from assignee', async () => {
    const rows = await db.asUser<{ value: { id: string; value: string } }>(
      OWNER,
      "select public.create_launch_dictionary($1,'buyers','roman test','launch-request-001') as value",
      [team]
    );
    expect(rows[0].value.value).toBe('roman_test');
    await expect(
      db.asUser(OUTSIDER, 'select public.list_launch_dictionaries($1)', [team])
    ).rejects.toThrow('PERMISSION_DENIED');
  });
  it('replays request and refuses mismatched reuse', async () => {
    const a = await db.asUser<{ result: { id: string } }>(
      OWNER,
      "select public.save_launch_draft($1,null,null,'draft-request-001','{}',null) as result",
      [team]
    );
    const b = await db.asUser<{ result: { id: string } }>(
      OWNER,
      "select public.save_launch_draft($1,null,null,'draft-request-001','{}',null) as result",
      [team]
    );
    expect(a[0].result.id).toBe(b[0].result.id);
    await expect(
      db.asUser(
        OWNER,
        'select public.save_launch_draft($1,null,null,\'draft-request-001\',\'{"creativeAlias":"v2"}\',null)',
        [team]
      )
    ).rejects.toThrow('LAUNCH_VERSION_CONFLICT');
  });
  it('requires version for existing draft and blocks cross-team reads', async () => {
    const rows = await db.asUser<{ result: { id: string; version: string } }>(
      OWNER,
      "select public.save_launch_draft($1,null,null,'draft-request-002','{}',null) as result",
      [team]
    );
    const id = rows[0].result.id;
    await expect(
      db.asUser(
        OWNER,
        "select public.save_launch_draft($1,$2,'999','draft-request-003','{}',null)",
        [team, id]
      )
    ).rejects.toThrow('LAUNCH_VERSION_CONFLICT');
    await expect(
      db.asUser(OUTSIDER, 'select public.get_launch($1,$2,null)', [team, id])
    ).rejects.toThrow('PERMISSION_DENIED');
    const grants = await db.root<{ allowed: boolean }>(
      "select has_column_privilege('authenticated','public.team_launches','draft_config','SELECT') as allowed"
    );
    expect(grants[0].allowed).toBe(false);
  });
  it('keeps a synthetic URL secret out of list projections while preserving protected detail', async () => {
    const secret = 'SYNTHETIC_CAPI_TOKEN_123';
    const originalUrl = `https://example.invalid/path?capi=${secret}&sub1=old`;
    const saved = (
      await db.asUser<{ result: { id: string } }>(
        OWNER,
        "select public.save_launch_draft($1,null,null,'privacy-url-request-001',$2::jsonb,null) as result",
        [team, JSON.stringify({ originalUrl })]
      )
    )[0].result;
    const detail = (
      await db.asUser<{ result: unknown }>(
        OWNER,
        'select public.get_launch($1,$2,null) as result',
        [team, saved.id]
      )
    )[0].result;
    expect(JSON.stringify(detail)).toContain(secret);
    const listing = (
      await db.asUser<{ result: unknown }>(
        OWNER,
        "select public.list_launches($1,'{}'::jsonb,50) as result",
        [team]
      )
    )[0].result;
    expect(JSON.stringify(listing)).not.toContain(secret);
    for (const table of [
      'team_launch_requests',
      'team_launch_signals',
      'team_launch_workspace_signals',
      'team_audit_events'
    ]) {
      const rows = await db.root<{ value: unknown }>(
        `select row_to_json(row)::jsonb as value from public.${table} as row where team_id = $1`,
        [team]
      );
      expect(JSON.stringify(rows), table).not.toContain(secret);
    }
    await expect(
      db.asUser(OUTSIDER, 'select public.get_launch($1,$2,null)', [team, saved.id])
    ).rejects.toThrow('PERMISSION_DENIED');
  });
});

it('lets a viewer read protected Launch detail but rejects every mutation seam', async () => {
  const viewer = '71000000-0000-4000-8000-000000000003';
  await createUser(db, { id: viewer, email: 'launch-viewer@example.test' });
  await db.root(
    "insert into public.team_members(team_id,user_id,base_role) values($1,$2,'viewer')",
    [team, viewer]
  );
  const saved = (
    await db.asUser<{ v: { id: string; version: string } }>(
      OWNER,
      "select public.save_launch_draft($1,null,null,'viewer-source-draft','{}',null) v",
      [team]
    )
  )[0].v;
  const value = (
    await db.asUser<{ v: { id: string } }>(viewer, 'select public.get_launch($1,$2,null) v', [
      team,
      saved.id
    ])
  )[0].v;
  expect(value.id).toBe(saved.id);
  for (const [sql, args] of [
    [
      "select public.save_launch_draft($1,$2,$3,'viewer-save-request','{}',null)",
      [team, saved.id, saved.version]
    ],
    [
      "select public.cancel_launch_request($1,$2,'viewer-generate-request','viewer-cancel-request')",
      [team, saved.id]
    ],
    [
      "select public.create_launch_dictionary($1,'buyers','viewer_buyer','viewer-buyer-request')",
      [team]
    ],
    [
      'select public.set_launch_defaults($1,null,\'viewer-default-request\',\'{}\',\'{"schemaVersion":1,"sub1":[],"sub2":[],"sub3":[]}\'::jsonb)',
      [team]
    ]
  ] as const)
    await expect(db.asUser(viewer, sql, [...args])).rejects.toThrow('PERMISSION_DENIED');
});

it('refuses protected reads and mutation replay after the workspace is archived', async () => {
  const blocked = (
    await db.asUser<{ id: string }>(OWNER, "select id from public.create_team('Blocked Launch')")
  )[0].id;
  const saved = (
    await db.asUser<{ v: { id: string; version: string } }>(
      OWNER,
      "select public.save_launch_draft($1,null,null,'blocked-draft-request','{}',null) v",
      [blocked]
    )
  )[0].v;
  await db.root("update public.teams set status='archived' where id=$1", [blocked]);
  await expect(
    db.asUser(OWNER, 'select public.get_launch($1,$2,null)', [blocked, saved.id])
  ).rejects.toThrow('PERMISSION_DENIED');
  await expect(
    db.asUser(
      OWNER,
      "select public.save_launch_draft($1,null,null,'blocked-draft-request','{}',null)",
      [blocked]
    )
  ).rejects.toThrow('PERMISSION_DENIED');
});
