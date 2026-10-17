import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import { launchConfig } from './fixtures/launches';
const OWNER = '73000000-0000-4000-8000-000000000001';
const OTHER = '73000000-0000-4000-8000-000000000002';
let db: TeamTestDb;
let team: string;
let id: string;
beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: OWNER, email: 'copy-owner@example.test' });
  await createUser(db, { id: OTHER, email: 'copy-other@example.test' });
  await db.root('insert into public.admin_users(user_id) values($1)', [OWNER]);
  team = (await db.asUser<{ id: string }>(OWNER, "select id from public.create_team('Copies')"))[0]
    .id;
  id = (
    await db.asUser<{ v: { id: string } }>(
      OWNER,
      'select public.save_launch_draft($1,null,null,\'copy-source-draft\',\'{"launchDate":"2026-01-01","timezone":"UTC","creativeAlias":"v5"}\',null) v',
      [team]
    )
  )[0].v.id;
});
afterAll(async () => {
  await db?.close();
});
describe('copy and archive Launch', () => {
  it('uses the caller local calendar at midnight and across both DST transitions', async () => {
    const cases = [
      ['Pacific/Kiritimati', '2026-03-28T09:59:00Z', '2026-03-29'],
      ['Pacific/Kiritimati', '2026-03-28T10:00:00Z', '2026-03-30'],
      ['Pacific/Honolulu', '2026-03-29T09:59:00Z', '2026-03-29'],
      ['Pacific/Honolulu', '2026-03-29T10:00:00Z', '2026-03-30'],
      ['Europe/Kyiv', '2026-03-28T21:59:00Z', '2026-03-29'],
      ['Europe/Kyiv', '2026-03-28T22:00:00Z', '2026-03-30'],
      ['Europe/Kyiv', '2026-03-29T00:59:00Z', '2026-03-30'],
      ['Europe/Kyiv', '2026-03-29T01:00:00Z', '2026-03-30'],
      ['Europe/Kyiv', '2026-10-25T00:59:00Z', '2026-10-26'],
      ['Europe/Kyiv', '2026-10-25T01:00:00Z', '2026-10-26']
    ] as const;
    for (const [zone, instant, expected] of cases) {
      const result = await db.root<{ day: string }>(
        'select private.launch_tomorrow($1,$2::timestamptz)::text as day',
        [zone, instant]
      );
      expect(result[0].day, `${zone} at ${instant}`).toBe(expected);
    }
  });
  it('keeps a missing creative reference in the copy but blocks source resolution', async () => {
    const scope = (
      await db.asUser<{ id: string }>(
        OWNER,
        "select id from public.create_team('Missing copy creative')"
      )
    )[0].id;
    const account = (
      await db.root<{ id: string }>(
        "insert into public.team_accounts(team_id,created_by,name) values($1,$2,'g1') returning id",
        [scope, OWNER]
      )
    )[0].id;
    const agent = (
      await db.root<{ id: string }>(
        "insert into public.team_account_agents(team_id,account_id,created_by,agent_id) values($1,$2,$3,'1234567892') returning id",
        [scope, account, OWNER]
      )
    )[0].id;
    const credential = (
      await db.root<{ id: string }>(
        "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('perm-copy-missing','copy@example.test','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
        [OWNER]
      )
    )[0].id;
    const connection = (
      await db.root<{ id: string }>(
        "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values($1,$2,'root','Root','my_drive','connected',now()) returning id",
        [scope, credential]
      )
    )[0].id;
    const material = (
      await db.root<{ id: string }>(
        "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) values($1,$2,'copy-missing-video','v5.mp4','file','video','video/mp4','1') returning id",
        [scope, connection]
      )
    )[0].id;
    const buyer = (
      await db.asUser<{ v: { id: string } }>(
        OWNER,
        "select public.create_launch_dictionary($1,'buyers','buyer','copy-missing-buyer') v",
        [scope]
      )
    )[0].v.id;
    const offer = (
      await db.asUser<{ v: { id: string } }>(
        OWNER,
        "select public.create_launch_dictionary($1,'offers','offer','copy-missing-offer') v",
        [scope]
      )
    )[0].v.id;
    const config = launchConfig({
      agentRowId: agent,
      offerId: offer,
      buyerId: buyer,
      materialId: material
    });
    const source = (
      await db.asUser<{ v: { id: string; version: string } }>(
        OWNER,
        'select public.save_launch_draft($1,null,null,$2,$3::jsonb,null) v',
        [scope, 'copy-missing-source', JSON.stringify(config)]
      )
    )[0].v;
    await db.root(
      "update public.team_materials set lifecycle='missing',missing_at=now() where id=$1",
      [material]
    );
    const copied = (
      await db.asUser<{ v: { id: string } }>(
        OWNER,
        "select public.copy_launch($1,$2,null,$3,'copy-missing-request','UTC') v",
        [scope, source.id, source.version]
      )
    )[0].v;
    const detail = (
      await db.asUser<{ v: { draft: { materialId: string }; activeRevision: unknown } }>(
        OWNER,
        'select public.get_launch($1,$2,null) v',
        [scope, copied.id]
      )
    )[0].v;
    expect(detail.draft.materialId).toBe(material);
    expect(detail.activeRevision).toBeNull();
    await expect(
      db.asUser(OWNER, 'select public.get_launch_sources($1,$2)', [scope, copied.id])
    ).rejects.toThrow('SOURCE_CHANGED');
    expect(
      (
        await db.root<{ n: number }>(
          'select count(*)::integer n from public.team_materials where team_id=$1',
          [scope]
        )
      )[0].n
    ).toBe(1);
  });
  it('explains a cleared assignee after membership removal and preserves manual configuration budgets', async () => {
    await db.root(
      "insert into public.team_members(team_id,user_id,base_role) values($1,$2,'editor')",
      [team, OTHER]
    );
    const source = (
      await db.asUser<{ v: { id: string; version: string } }>(
        OWNER,
        'select public.save_launch_draft($1,null,null,\'copy-member-source\',\'{"campaignCount":3,"maxBudget":30,"budgetMode":"manual","budgets":[7,19,30]}\',null) v',
        [team]
      )
    )[0].v;
    await db.asUser(
      OWNER,
      "select public.update_launch_metadata($1,$2,$3,'copy-member-assignment','todo',$4)",
      [team, source.id, source.version, OTHER]
    );
    await db.root('delete from public.team_members where team_id=$1 and user_id=$2', [team, OTHER]);
    const version = (
      await db.asUser<{ v: { version: string } }>(OWNER, 'select public.get_launch($1,$2,null) v', [
        team,
        source.id
      ])
    )[0].v.version;
    const copy = (
      await db.asUser<{ v: { id: string; assigneeCleared: boolean } }>(
        OWNER,
        "select public.copy_launch($1,$2,null,$3,'copy-member-replay','UTC') v",
        [team, source.id, version]
      )
    )[0].v;
    expect(copy.assigneeCleared).toBe(true);
    const detail = (
      await db.asUser<{
        v: { assigneeId: string | null; draft: { budgets: number[]; budgetMode: string } };
      }>(OWNER, 'select public.get_launch($1,$2,null) v', [team, copy.id])
    )[0].v;
    expect(detail.assigneeId).toBeNull();
    expect(detail.draft.budgetMode).toBe('manual');
    expect(detail.draft.budgets).toEqual([7, 19, 30]);
  });
  it('creates an independent tomorrow draft and replays without recopying', async () => {
    const sql =
      "select public.copy_launch($1,$2,null,'1','copy-launch-001','Pacific/Kiritimati') v";
    const a = (
      await db.asUser<{ v: { id: string; launchDate: string } }>(OWNER, sql, [team, id])
    )[0].v;
    const b = (
      await db.asUser<{ v: { id: string; launchDate: string } }>(OWNER, sql, [team, id])
    )[0].v;
    expect(b).toEqual(a);
    expect(a.id).not.toBe(id);
    await db.root(
      "update public.team_launch_requests set created_at=created_at-interval '2 days' where team_id=$1 and request_key='copy-launch-001'",
      [team]
    );
    const replayOfAgedReceipt = (
      await db.asUser<{ v: { id: string; launchDate: string } }>(OWNER, sql, [team, id])
    )[0].v;
    expect(replayOfAgedReceipt).toEqual(a);
    const expected = (
      await db.root<{ d: string }>(
        "select to_char((clock_timestamp() at time zone 'Pacific/Kiritimati')::date+1,'YYYY-MM-DD') d"
      )
    )[0].d;
    expect(a.launchDate).toBe(expected);
    const detail = (
      await db.asUser<{
        v: {
          activeRevision: unknown;
          expectedSourceSnapshot: unknown;
          workStatus: string;
          draft: { creativeAlias: string; timezone: string };
        };
      }>(OWNER, 'select public.get_launch($1,$2,null) v', [team, a.id])
    )[0].v;
    expect(detail.activeRevision).toBeNull();
    expect(detail.expectedSourceSnapshot).toBeNull();
    expect(detail.workStatus).toBe('todo');
    expect(detail.draft.creativeAlias).toBe('v5');
    expect(detail.draft.timezone).toBe('Pacific/Kiritimati');
    await expect(
      db.asUser(OWNER, "select public.copy_launch($1,$2,null,'1','copy-launch-001','UTC')", [
        team,
        id
      ])
    ).rejects.toThrow('LAUNCH_VERSION_CONFLICT');
  });
  it('copies a ready Launch configuration without its manual result, history, or catalog', async () => {
    const scope = (
      await db.asUser<{ id: string }>(OWNER, "select id from public.create_team('Ready copy')")
    )[0].id;
    const source = (
      await db.asUser<{ v: { id: string; version: string } }>(
        OWNER,
        'select public.save_launch_draft($1,null,null,\'ready-copy-source\',\'{"method":"other","maxBudget":10}\',null) v',
        [scope]
      )
    )[0].v;
    const revision = (
      await db.root<{ id: string }>(
        `insert into public.team_launch_revisions
         (team_id,launch_id,revision_no,result_kind,config,sources,original_url,generated_url,sub_values,result_overrides,created_by)
         values($1,$2,1,'manual',$3::jsonb,'{}','https://example.invalid/source','https://example.invalid/generated','{}',$4::jsonb,$5)
         returning id`,
        [
          scope,
          source.id,
          JSON.stringify({ method: 'catalog', maxBudget: 42 }),
          JSON.stringify({ advertisingUrl: 'https://example.invalid/private-manual' }),
          OWNER
        ]
      )
    )[0].id;
    await db.root('update public.team_launches set active_revision_id=$1 where id=$2', [
      revision,
      source.id
    ]);
    await db.root(
      `insert into public.team_launch_revision_catalogs
       (team_id,revision_id,catalog_id,material_id,variant,name_snapshot,sheet_url,settings_snapshot)
       values($1,$2,gen_random_uuid(),gen_random_uuid(),1,'Old catalog','https://drive.google.com/example','{}')`,
      [scope, revision]
    );
    const copied = (
      await db.asUser<{ v: { id: string } }>(
        OWNER,
        "select public.copy_launch($1,$2,null,$3,'ready-copy-key','UTC') v",
        [scope, source.id, source.version]
      )
    )[0].v;
    const rows = await db.root<{
      active_revision_id: string | null;
      expected_source_snapshot: unknown;
      draft_config: { method: string; maxBudget: number; advertisingUrl?: string };
      copied_from_launch_id: string;
      copied_from_revision_id: string;
    }>(
      `select active_revision_id,expected_source_snapshot,draft_config,copied_from_launch_id,copied_from_revision_id
       from public.team_launches where id=$1`,
      [copied.id]
    );
    expect(rows[0]).toMatchObject({
      active_revision_id: null,
      expected_source_snapshot: null,
      draft_config: { method: 'catalog', maxBudget: 42 },
      copied_from_launch_id: source.id,
      copied_from_revision_id: revision
    });
    expect(rows[0].draft_config.advertisingUrl).toBeUndefined();
    const counts = (
      await db.root<{ revisions: number; catalogs: number; generations: number }>(
        `select
          (select count(*)::integer from public.team_launch_revisions where launch_id=$1) revisions,
          (select count(*)::integer from public.team_launch_revision_catalogs c
            join public.team_launch_revisions r on r.id=c.revision_id where r.launch_id=$1) catalogs,
          (select count(*)::integer from public.team_launch_generations where launch_id=$1) generations`,
        [copied.id]
      )
    )[0];
    expect(counts).toEqual({ revisions: 0, catalogs: 0, generations: 0 });
  });
  it('uses the supplied current timezone at each first copy commit, including opposite sides of the date line', async () => {
    const copyAt = async (zone: string, key: string) =>
      (
        await db.asUser<{ v: { id: string; launchDate: string } }>(
          OWNER,
          'select public.copy_launch($1,$2,null,$3,$4,$5) v',
          [team, id, '1', key, zone]
        )
      )[0].v;
    const east = await copyAt('Pacific/Kiritimati', 'copy-date-east');
    const west = await copyAt('Pacific/Honolulu', 'copy-date-west');
    for (const [zone, copy] of [
      ['Pacific/Kiritimati', east],
      ['Pacific/Honolulu', west]
    ] as const) {
      const expected = (
        await db.root<{ d: string }>(
          "select to_char((clock_timestamp() at time zone $1)::date+1,'YYYY-MM-DD') d",
          [zone]
        )
      )[0].d;
      expect(copy.launchDate).toBe(expected);
      expect(copy.id).not.toBe(id);
    }
    expect(east.id).not.toBe(west.id);
    expect((await copyAt('Pacific/Kiritimati', 'copy-date-east')).launchDate).toBe(east.launchDate);
  });
  it('replays the committed copy after the source changes and refuses a changed timezone on the same key', async () => {
    const source = (
      await db.asUser<{ v: { id: string; version: string } }>(
        OWNER,
        'select public.save_launch_draft($1,null,null,$2,$3::jsonb,null) v',
        [
          team,
          'copy-durable-date-source',
          JSON.stringify({ launchDate: '2026-03-28', timezone: 'Europe/Kyiv' })
        ]
      )
    )[0].v;
    const copy = async (zone: string) =>
      (
        await db.asUser<{ v: { id: string; launchDate: string } }>(
          OWNER,
          'select public.copy_launch($1,$2,null,$3,$4,$5) v',
          [team, source.id, source.version, 'copy-durable-date-replay', zone]
        )
      )[0].v;
    const first = await copy('Pacific/Kiritimati');
    await db.asUser(OWNER, 'select public.save_launch_draft($1,$2,$3,$4,$5::jsonb,null)', [
      team,
      source.id,
      source.version,
      'copy-durable-date-source-edit',
      JSON.stringify({ launchDate: '2026-03-30', timezone: 'America/Los_Angeles' })
    ]);
    expect(await copy('Pacific/Kiritimati')).toEqual(first);
    await expect(copy('Pacific/Honolulu')).rejects.toThrow('LAUNCH_VERSION_CONFLICT');
  });
  it('denies foreign actors and stale versions', async () => {
    await expect(
      db.asUser(OTHER, "select public.copy_launch($1,$2,null,'1','copy-launch-other','UTC')", [
        team,
        id
      ])
    ).rejects.toThrow('PERMISSION_DENIED');
    await expect(
      db.asUser(OWNER, "select public.copy_launch($1,$2,null,'999','copy-launch-stale','UTC')", [
        team,
        id
      ])
    ).rejects.toThrow('LAUNCH_VERSION_CONFLICT');
  });
  it('rejects copy and archive during an active non-catalog generation without saving suppression', async () => {
    const source = (
      await db.asUser<{ v: { id: string; version: string } }>(
        OWNER,
        'select public.save_launch_draft($1,null,null,\'active-other-source\',\'{"method":"other"}\',null) v',
        [team]
      )
    )[0].v;
    const committedCopy = (
      await db.asUser<{ v: { id: string } }>(
        OWNER,
        "select public.copy_launch($1,$2,null,$3,'active-other-before','UTC') v",
        [team, source.id, source.version]
      )
    )[0].v;
    const revision = (
      await db.root<{ id: string }>(
        "insert into public.team_launch_revisions(team_id,launch_id,revision_no,result_kind,config,sources,original_url,generated_url,sub_values,created_by) values($1,$2,1,'generated','{\"method\":\"other\"}','{}','https://example.invalid','https://example.invalid','{}',$3) returning id",
        [team, source.id, OWNER]
      )
    )[0].id;
    await db.root(
      "insert into public.team_launch_generations(team_id,launch_id,revision_id,actor_id,request_key,request_digest,input_version,state) values($1,$2,$3,$4,'active-other-generation','digest','1','running')",
      [team, source.id, revision, OWNER]
    );
    await expect(
      db.asUser(OWNER, "select public.archive_launch($1,$2,$3,'active-other-archive',true)", [
        team,
        source.id,
        source.version
      ])
    ).rejects.toThrow('LAUNCH_BUSY');
    expect(
      (
        await db.asUser<{ v: { id: string } }>(
          OWNER,
          "select public.copy_launch($1,$2,null,$3,'active-other-before','UTC') v",
          [team, source.id, source.version]
        )
      )[0].v
    ).toEqual(committedCopy);
    await expect(
      db.asUser(OWNER, "select public.copy_launch($1,$2,null,$3,'active-other-copy','UTC')", [
        team,
        source.id,
        source.version
      ])
    ).rejects.toThrow('LAUNCH_BUSY');
    expect(
      (
        await db.root<{ n: number }>(
          'select count(*)::integer n from public.team_launch_member_preferences where team_id=$1',
          [team]
        )
      )[0].n
    ).toBe(0);
  });
  it('archives idempotently without preference when no catalog exists', async () => {
    await db.asUser(OWNER, "select public.archive_launch($1,$2,'1','archive-launch-001',true)", [
      team,
      id
    ]);
    await db.asUser(OWNER, "select public.archive_launch($1,$2,'1','archive-launch-001',true)", [
      team,
      id
    ]);
    const count = (
      await db.root<{ n: number }>(
        'select count(*)::integer n from public.team_launch_member_preferences where team_id=$1',
        [team]
      )
    )[0].n;
    expect(count).toBe(0);
    const list = (
      await db.asUser<{ v: { items: { id: string }[] } }>(
        OWNER,
        'select public.list_launches($1) v',
        [team]
      )
    )[0].v;
    expect(list.items.some(item => item.id === id)).toBe(false);
    expect(list.items.length).toBeGreaterThan(0);
  });
  it('warns about a historical catalog and stores suppression only in the successful archive transaction', async () => {
    const scope = (
      await db.asUser<{ id: string }>(
        OWNER,
        "select id from public.create_team('Historical retention')"
      )
    )[0].id;
    const source = (
      await db.asUser<{ v: { id: string; version: string } }>(
        OWNER,
        'select public.save_launch_draft($1,null,null,\'historical-retention-source\',\'{"method":"other"}\',null) v',
        [scope]
      )
    )[0].v;
    const old = (
      await db.root<{ id: string }>(
        "insert into public.team_launch_revisions(team_id,launch_id,revision_no,result_kind,config,sources,original_url,generated_url,sub_values,created_by) values($1,$2,1,'generated','{\"method\":\"catalog\"}','{}','https://example.invalid','https://example.invalid','{}',$3) returning id",
        [scope, source.id, OWNER]
      )
    )[0].id;
    await db.root(
      "insert into public.team_launch_revision_catalogs(team_id,revision_id,catalog_id,material_id,variant,name_snapshot,sheet_url,restitch_material_id,settings_snapshot) values($1,$2,gen_random_uuid(),gen_random_uuid(),1,'Historical catalog','https://drive.google.com/example',gen_random_uuid(),'{}')",
      [scope, old]
    );
    const warning = (
      await db.asUser<{ v: { hasCatalog: boolean; hasRestitch: boolean; suppressed: boolean } }>(
        OWNER,
        'select public.get_launch_archive_warning($1,$2) v',
        [scope, source.id]
      )
    )[0].v;
    expect(warning).toEqual({ hasCatalog: true, hasRestitch: true, suppressed: false });
    const copied = (
      await db.asUser<{ v: { id: string } }>(
        OWNER,
        "select public.copy_launch($1,$2,null,$3,'historical-retention-copy','UTC') v",
        [scope, source.id, source.version]
      )
    )[0].v;
    const copiedHistory = (
      await db.root<{ n: number }>(
        'select count(*)::integer n from public.team_launch_revisions where launch_id=$1',
        [copied.id]
      )
    )[0].n;
    const copiedGenerations = (
      await db.root<{ n: number }>(
        'select count(*)::integer n from public.team_launch_generations where launch_id=$1',
        [copied.id]
      )
    )[0].n;
    expect(copiedHistory).toBe(0);
    expect(copiedGenerations).toBe(0);
    await expect(
      db.asUser(
        OWNER,
        "select public.archive_launch($1,$2,'999','historical-retention-stale',true)",
        [scope, source.id]
      )
    ).rejects.toThrow('LAUNCH_VERSION_CONFLICT');
    expect(
      (
        await db.root<{ n: number }>(
          'select count(*)::integer n from public.team_launch_member_preferences where team_id=$1',
          [scope]
        )
      )[0].n
    ).toBe(0);
    await db.asUser(
      OWNER,
      "select public.archive_launch($1,$2,$3,'historical-retention-archive',true)",
      [scope, source.id, source.version]
    );
    expect(
      (
        await db.root<{ n: number }>(
          'select count(*)::integer n from public.team_launch_member_preferences where team_id=$1 and user_id=$2 and suppress_catalog_retention_warning',
          [scope, OWNER]
        )
      )[0].n
    ).toBe(1);
    expect(
      (
        await db.root<{ n: number }>(
          'select count(*)::integer n from public.team_launch_member_preferences where team_id=$1',
          [team]
        )
      )[0].n
    ).toBe(0);
    expect(
      (
        await db.root<{ n: number }>(
          'select count(*)::integer n from public.team_launch_revision_catalogs where revision_id=$1',
          [old]
        )
      )[0].n
    ).toBe(1);
  });
});
