import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import { launchConfig } from './fixtures/launches';

const OWNER = '79000000-0000-4000-8000-000000000001';
const ASSIGNEE = '79000000-0000-4000-8000-000000000002';
let db: TeamTestDb;
let team: string;
beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: OWNER, email: 'launch-workspace@example.test' });
  await createUser(db, { id: ASSIGNEE, email: 'launch-assignee@example.test' });
  await db.root('insert into public.admin_users(user_id) values ($1)', [OWNER]);
  team = (
    await db.asUser<{ id: string }>(OWNER, "select id from public.create_team('Launch workspace')")
  )[0].id;
  await db.root(
    "insert into public.team_members(team_id,user_id,base_role) values($1,$2,'editor')",
    [team, ASSIGNEE]
  );
});
afterAll(async () => {
  await db?.close();
});
it('accepts only the closed dependency and SUB diagnostic vocabulary in persisted analytics', async () => {
  const valid = {
    launch_code: 'AGENT_REQUIRED',
    launch_field: 'sub1',
    launch_action: 'copy_field'
  };
  expect(
    (
      await db.root<{ safe: boolean }>(
        'select public.analytics_properties_are_safe_v2($1::jsonb) as safe',
        [JSON.stringify(valid)]
      )
    )[0].safe
  ).toBe(true);
  for (const properties of [
    { ...valid, subValue: 'private_buyer' },
    { ...valid, launch_code: 'SYNTHETIC_SECRET' },
    { ...valid, launch_field: 'private_buyer' }
  ]) {
    expect(
      (
        await db.root<{ safe: boolean }>(
          'select public.analytics_properties_are_safe_v2($1::jsonb) as safe',
          [JSON.stringify(properties)]
        )
      )[0].safe
    ).toBe(false);
  }
});

it('projects a failed draft generation with a non-null inactive result flag and no URL', async () => {
  const marker = 'SYNTHETIC_DIAGNOSTIC_PRIVATE_URL';
  const launch = (
    await db.asUser<{ result: { id: string } }>(
      OWNER,
      'select public.save_launch_draft($1,null,null,$2,$3::jsonb,null) as result',
      [
        team,
        'diagnostic-active-flag',
        JSON.stringify({ originalUrl: `https://example.invalid/?token=${marker}` })
      ]
    )
  )[0].result.id;
  const revision = (
    await db.root<{ id: string }>(
      `insert into public.team_launch_revisions
       (team_id,launch_id,revision_no,result_kind,config,sources,original_url,generated_url,sub_values,created_by)
       values($1,$2,1,'generated','{"method":"other"}','{}',$3,$3,'{}',$4) returning id`,
      [team, launch, `https://example.invalid/?token=${marker}`, OWNER]
    )
  )[0].id;
  const generation = (
    await db.root<{ id: string }>(
      `insert into public.team_launch_generations
       (team_id,launch_id,revision_id,actor_id,request_key,request_digest,input_version,state,stage,safe_error_code)
       values($1,$2,$3,$4,$5,'synthetic-digest','1','failed','accepted','LAUNCH_URL_INVALID') returning id`,
      [team, launch, revision, OWNER, crypto.randomUUID()]
    )
  )[0].id;
  const projection = async () =>
    (
      await db.root<{
        result_is_active: boolean;
        safe_error_code: string;
        catalog_registered: boolean;
      }>(
        'select result_is_active,safe_error_code,catalog_registered from public.analytics_launch_generations where generation_id=$1',
        [generation]
      )
    )[0];
  expect(await projection()).toEqual({
    result_is_active: false,
    safe_error_code: 'LAUNCH_URL_INVALID',
    catalog_registered: false
  });
  await db.root('update public.team_launches set active_revision_id=$1 where id=$2', [
    revision,
    launch
  ]);
  const active = await projection();
  expect(active).toEqual({
    result_is_active: true,
    safe_error_code: 'LAUNCH_URL_INVALID',
    catalog_registered: false
  });
  expect(JSON.stringify(active)).not.toContain(marker);
  const diagnosticRow = (
    await db.root<{ row: Record<string, unknown> }>(
      'select to_jsonb(v) as row from public.analytics_launch_generations v where generation_id=$1',
      [generation]
    )
  )[0].row;
  expect(JSON.stringify(diagnosticRow)).not.toContain(marker);
  expect(Object.keys(diagnosticRow)).not.toContain('config');
  expect(Object.keys(diagnosticRow)).not.toContain('original_url');
  expect(Object.keys(diagnosticRow)).not.toContain('generated_url');
});

it('persists ordered SUB defaults, replays the original version and rejects stale replacement', async () => {
  const sub = {
    schemaVersion: 1,
    sub1: ['buyer'],
    sub2: ['creative', 'social', 'adAccountSuffix'],
    sub3: []
  };
  const args = [team, JSON.stringify({ campaignCount: 3, maxBudget: 30 }), JSON.stringify(sub)];
  const sql =
    "select public.set_launch_defaults($1,null,'workspace-defaults-01',$2::jsonb,$3::jsonb) as result";
  const first = await db.asUser<{ result: { version: string } }>(OWNER, sql, args);
  const updated = await db.asUser<{ result: { version: string } }>(
    OWNER,
    "select public.set_launch_defaults($1,$2,'workspace-defaults-02','{\"campaignCount\":5}',$3::jsonb) as result",
    [team, first[0].result.version, JSON.stringify(sub)]
  );
  expect(updated[0].result.version).not.toBe(first[0].result.version);
  expect(await db.asUser(OWNER, sql, args)).toEqual(first);
  await expect(
    db.asUser(
      OWNER,
      "select public.set_launch_defaults($1,$2,'workspace-defaults-03','{\"campaignCount\":2}',$3::jsonb)",
      [team, first[0].result.version, JSON.stringify(sub)]
    )
  ).rejects.toThrow('LAUNCH_VERSION_CONFLICT');
  const saved = (
    await db.asUser<{ result: { subConfig: unknown; config: unknown } }>(
      OWNER,
      'select public.get_launch_defaults($1) as result',
      [team]
    )
  )[0].result;
  expect(saved.subConfig).toEqual(sub);
  expect(saved.config).toEqual({ campaignCount: 5 });
});

it('refuses sensitive and per-launch values in defaults at the database boundary', async () => {
  const sub = JSON.stringify(launchConfig().subConfig);
  for (const config of [
    { originalUrl: 'https://example.invalid?token=SYNTHETIC' },
    { materialId: OWNER },
    { launchDate: '2026-10-13' },
    { budgets: [10, 20, 30] }
  ]) {
    await expect(
      db.asUser(OWNER, 'select public.set_launch_defaults($1,null,$2,$3::jsonb,$4::jsonb)', [
        team,
        crypto.randomUUID(),
        JSON.stringify(config),
        sub
      ])
    ).rejects.toThrow('INVALID_INPUT');
  }
});

it('keeps dictionaries space-scoped, revives archived values without duplicate IDs, and rejects archived defaults', async () => {
  const otherTeam = (
    await db.asUser<{ id: string }>(
      OWNER,
      "select id from public.create_team('Launch dictionary scope')"
    )
  )[0].id;
  const create = async (scope: string, kind: 'buyers' | 'offers', value: string, key: string) =>
    (
      await db.asUser<{ result: { id: string; value: string } }>(
        OWNER,
        'select public.create_launch_dictionary($1,$2,$3,$4) as result',
        [scope, kind, value, key]
      )
    )[0].result;
  const buyer = await create(team, 'buyers', 'space_buyer', 'dictionary-scope-buyer-1');
  const sameBuyer = await create(team, 'buyers', 'SPACE_BUYER', 'dictionary-scope-buyer-2');
  const foreignBuyer = await create(otherTeam, 'buyers', 'space_buyer', 'dictionary-scope-buyer-3');
  const offer = await create(team, 'offers', 'Scoped Offer', 'dictionary-scope-offer-1');
  const foreignOffer = await create(
    otherTeam,
    'offers',
    'Scoped Offer',
    'dictionary-scope-offer-2'
  );
  expect(sameBuyer.id).toBe(buyer.id);
  expect(foreignBuyer.id).not.toBe(buyer.id);
  expect(foreignOffer.id).not.toBe(offer.id);

  await db.asUser(OWNER, 'select public.archive_launch_dictionary($1,$2,$3,$4)', [
    team,
    'buyers',
    buyer.id,
    'dictionary-scope-archive'
  ]);
  const listed = (
    await db.asUser<{ result: { buyers: { id: string }[] } }>(
      OWNER,
      'select public.list_launch_dictionaries($1) as result',
      [team]
    )
  )[0].result;
  expect(listed.buyers.some(item => item.id === buyer.id)).toBe(false);
  await expect(
    db.asUser(OWNER, 'select public.set_launch_defaults($1,null,$2,$3::jsonb,$4::jsonb)', [
      otherTeam,
      'dictionary-scope-foreign-default',
      JSON.stringify({ buyerId: buyer.id }),
      JSON.stringify(launchConfig().subConfig)
    ])
  ).rejects.toThrow('INVALID_INPUT');
  await expect(
    db.asUser(OWNER, 'select public.set_launch_defaults($1,null,$2,$3::jsonb,$4::jsonb)', [
      team,
      'dictionary-scope-archived-default',
      JSON.stringify({ buyerId: buyer.id }),
      JSON.stringify(launchConfig().subConfig)
    ])
  ).rejects.toThrow('INVALID_INPUT');

  expect((await create(team, 'buyers', 'space_buyer', 'dictionary-scope-revive')).id).toBe(
    buyer.id
  );
  expect((await create(team, 'offers', 'SCOPED OFFER', 'dictionary-scope-offer-3')).id).toBe(
    offer.id
  );
});

it('applies date, status and search before pagination and excludes URL content from cards', async () => {
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const config = {
      launchDate: i < 3 ? '2026-10-13' : '2026-10-12',
      timezone: 'Europe/Kyiv',
      creativeAlias: `wanted_${i}`,
      originalUrl: 'https://example.invalid?token=SYNTHETIC_SECRET'
    };
    const saved = (
      await db.asUser<{ result: { id: string; version: string } }>(
        OWNER,
        'select public.save_launch_draft($1,null,null,$2,$3::jsonb,null) as result',
        [team, `workspace-draft-${i}`, JSON.stringify(config)]
      )
    )[0].result;
    ids.push(saved.id);
    if (i === 0)
      await db.asUser(
        OWNER,
        "select public.update_launch_metadata($1,$2,$3,'workspace-status-01','done',null)",
        [team, saved.id, saved.version]
      );
  }
  type Page = {
    items: { id: string; launchDate: string; workStatus: string }[];
    nextCursor: { id: string; date: string } | null;
  };
  const query = async (filter: unknown) =>
    (
      await db.asUser<{ result: Page }>(
        OWNER,
        'select public.list_launches($1,$2::jsonb,1) as result',
        [team, JSON.stringify(filter)]
      )
    )[0].result;
  const filter = { from: '2026-10-13', to: '2026-10-13', status: 'todo', search: 'wanted' };
  const first = await query(filter);
  const second = await query({
    ...filter,
    cursorId: first.nextCursor!.id,
    cursorDate: first.nextCursor!.date
  });
  const third = await query({
    ...filter,
    cursorId: second.nextCursor!.id,
    cursorDate: second.nextCursor!.date
  });
  expect(first.items).toHaveLength(1);
  expect(second.items).toHaveLength(1);
  expect(first.items[0].id).not.toBe(second.items[0].id);
  expect(third.items).toEqual([]);
  expect([first.items[0].id, second.items[0].id].sort()).toEqual(ids.slice(1, 3).sort());
  expect(JSON.stringify(first)).not.toContain('SYNTHETIC_SECRET');
  expect(JSON.stringify(first)).not.toContain('originalUrl');
  const signals = await db.asUser<{ launch_id: string; version: string }>(
    OWNER,
    'select launch_id,version::text from public.team_launch_signals where team_id=$1',
    [team]
  );
  expect(signals.some(row => row.launch_id === ids[0])).toBe(true);
  expect(JSON.stringify(signals)).not.toContain('SYNTHETIC_SECRET');
  await expect(
    db.asUser(OWNER, 'select payload from public.team_launch_requests where team_id=$1', [team])
  ).rejects.toThrow();
  const protectedDetail = (
    await db.asUser<{ result: { draft: { originalUrl: string } } }>(
      OWNER,
      'select public.get_launch($1,$2,null) as result',
      [team, ids[0]]
    )
  )[0].result;
  expect(protectedDetail.draft.originalUrl).toContain('SYNTHETIC_SECRET');
});
it('composes assignee, status, date and search before cursor pagination', async () => {
  const ids: string[] = [];
  for (let index = 0; index < 4; index++) {
    const saved = (
      await db.asUser<{ result: { id: string; version: string } }>(
        OWNER,
        'select public.save_launch_draft($1,null,null,$2,$3::jsonb,null) as result',
        [
          team,
          `assignee-filter-${index}`,
          JSON.stringify({
            launchDate: index === 3 ? '2026-10-12' : '2026-10-13',
            creativeAlias: `assignee_unique_${index}`
          })
        ]
      )
    )[0].result;
    ids.push(saved.id);
    if (index < 3) {
      await db.asUser(OWNER, 'select public.update_launch_metadata($1,$2,$3,$4,$5,$6)', [
        team,
        saved.id,
        saved.version,
        `assignee-status-${index}`,
        index === 2 ? 'done' : 'todo',
        ASSIGNEE
      ]);
    }
  }
  type Page = {
    items: { id: string; assigneeId: string | null }[];
    nextCursor: { id: string; date: string } | null;
  };
  const query = async (filter: Record<string, string>) =>
    (
      await db.asUser<{ result: Page }>(
        OWNER,
        'select public.list_launches($1,$2::jsonb,1) as result',
        [team, JSON.stringify(filter)]
      )
    )[0].result;
  const filter = {
    assigneeId: ASSIGNEE,
    status: 'todo',
    from: '2026-10-13',
    to: '2026-10-13',
    search: 'assignee_unique_'
  };
  const first = await query(filter);
  const second = await query({
    ...filter,
    cursorId: first.nextCursor!.id,
    cursorDate: first.nextCursor!.date
  });
  const third = await query({
    ...filter,
    cursorId: second.nextCursor!.id,
    cursorDate: second.nextCursor!.date
  });
  expect([first.items[0].id, second.items[0].id].sort()).toEqual(ids.slice(0, 2).sort());
  expect(first.items[0].assigneeId).toBe(ASSIGNEE);
  expect(second.items[0].assigneeId).toBe(ASSIGNEE);
  expect(third.items).toEqual([]);
});

it('filters a launch calendar day at a DST boundary without converting it to a UTC day', async () => {
  const dates = ['2026-03-28', '2026-03-29', '2026-03-30'];
  const ids: string[] = [];
  for (const date of dates) {
    const saved = (
      await db.asUser<{ result: { id: string } }>(
        OWNER,
        'select public.save_launch_draft($1,null,null,$2,$3::jsonb,null) as result',
        [
          team,
          `dst-launch-${date}`,
          JSON.stringify({
            launchDate: date,
            timezone: 'Europe/Kyiv',
            creativeAlias: `dst_${date}`
          })
        ]
      )
    )[0].result;
    ids.push(saved.id);
  }
  const page = (
    await db.asUser<{ result: { items: { id: string; launchDate: string }[] } }>(
      OWNER,
      'select public.list_launches($1,$2::jsonb,20) as result',
      [team, JSON.stringify({ from: '2026-03-29', to: '2026-03-29', search: 'dst_' })]
    )
  )[0].result;
  expect(page.items).toEqual([expect.objectContaining({ id: ids[1], launchDate: dates[1] })]);
});

it('finds a draft by its social account name without requiring a generated result', async () => {
  const account = (
    await db.root<{ id: string }>(
      "insert into public.team_accounts(team_id,created_by,name) values($1,$2,'SocialOnlySearch') returning id",
      [team, OWNER]
    )
  )[0].id;
  const agent = (
    await db.root<{ id: string }>(
      "insert into public.team_account_agents(team_id,account_id,created_by,agent_id) values($1,$2,$3,'1234567001') returning id",
      [team, account, OWNER]
    )
  )[0].id;
  const saved = (
    await db.asUser<{ result: { id: string } }>(
      OWNER,
      "select public.save_launch_draft($1,null,null,'workspace-social-draft',$2::jsonb,null) as result",
      [team, JSON.stringify({ agentRowId: agent, creativeAlias: 'unrelated_alias' })]
    )
  )[0].result;
  const page = (
    await db.asUser<{ result: { items: { id: string; hasResult: boolean }[] } }>(
      OWNER,
      'select public.list_launches($1,\'{"search":"socialonlysearch"}\',10) as result',
      [team]
    )
  )[0].result;
  expect(page.items.map(item => item.id)).toEqual([saved.id]);
  expect(page.items[0].hasResult).toBe(false);
});

it('revokes protected Launch list and detail after a member leaves the workspace', async () => {
  const scope = (
    await db.asUser<{ id: string }>(
      OWNER,
      "select id from public.create_team('Launch revoked view')"
    )
  )[0].id;
  await db.root(
    "insert into public.team_members(team_id,user_id,base_role) values($1,$2,'editor')",
    [scope, ASSIGNEE]
  );
  const assignees = await db.asUser<{ user_id: string; display_name: string | null }>(
    ASSIGNEE,
    'select * from public.list_launch_assignees($1)',
    [scope]
  );
  expect(assignees.map(row => row.user_id)).toContain(ASSIGNEE);
  expect(Object.keys(assignees[0]).sort()).toEqual(['display_name', 'user_id']);
  await expect(
    db.asUser(ASSIGNEE, 'select * from public.list_team_members($1)', [scope])
  ).rejects.toThrow('PERMISSION_DENIED');
  const launch = (
    await db.asUser<{ result: { id: string } }>(
      OWNER,
      'select public.save_launch_draft($1,null,null,$2,$3::jsonb,null) as result',
      [scope, 'revoked-view-fixture', JSON.stringify({ originalUrl: 'SYNTHETIC_PRIVATE_URL' })]
    )
  )[0].result;
  expect(
    (
      await db.asUser<{ result: { items: { id: string }[] } }>(
        ASSIGNEE,
        'select public.list_launches($1) as result',
        [scope]
      )
    )[0].result.items.map(item => item.id)
  ).toContain(launch.id);
  expect(
    (
      await db.asUser<{ result: { draft: { originalUrl: string } } }>(
        ASSIGNEE,
        'select public.get_launch($1,$2,null) as result',
        [scope, launch.id]
      )
    )[0].result.draft.originalUrl
  ).toBe('SYNTHETIC_PRIVATE_URL');
  await db.root('delete from public.team_members where team_id=$1 and user_id=$2', [
    scope,
    ASSIGNEE
  ]);
  await expect(db.asUser(ASSIGNEE, 'select public.list_launches($1)', [scope])).rejects.toThrow(
    'PERMISSION_DENIED'
  );
  await expect(
    db.asUser(ASSIGNEE, 'select public.get_launch($1,$2,null)', [scope, launch.id])
  ).rejects.toThrow('PERMISSION_DENIED');
  await expect(
    db.asUser(ASSIGNEE, 'select * from public.list_launch_assignees($1)', [scope])
  ).rejects.toThrow('PERMISSION_DENIED');
  const remaining = await db.asUser<{ user_id: string }>(
    OWNER,
    'select * from public.list_launch_assignees($1)',
    [scope]
  );
  expect(remaining.map(row => row.user_id)).not.toContain(ASSIGNEE);
});

it('edits dictionaries with scoped permissions, optimistic versions, replay and reversible deletion', async () => {
  type Row = { id: string; value: string; updatedAt: string };
  const create = async (value: string, key: string) =>
    (
      await db.asUser<{ v: Row }>(
        OWNER,
        "select public.create_launch_dictionary($1,'offers',$2,$3) v",
        [team, value, key]
      )
    )[0].v;
  for (const action of ['rename_dictionary', 'archive_dictionary', 'restore_dictionary']) {
    expect(
      (
        await db.root<{ safe: boolean }>(
          'select public.analytics_properties_are_safe_v2($1::jsonb) safe',
          [
            JSON.stringify({
              launch_action: action,
              flow_id: crypto.randomUUID(),
              outcome: 'success'
            })
          ]
        )
      )[0].safe
    ).toBe(true);
  }
  const original = await create('Dictionary management original', 'dictionary-manage-create');
  const edit = async (row: Row, op: string, value: string, key: string, actor = OWNER) =>
    (
      await db.asUser<{ v: Row }>(
        actor,
        'select public.edit_launch_dictionary($1,$2,$3,$4,$5,$6,$7) v',
        [team, 'offers', row.id, row.updatedAt, op, value, key]
      )
    )[0].v;
  const renamed = await edit(
    original,
    'rename',
    'Dictionary management renamed',
    'dictionary-manage-rename'
  );
  expect(renamed.value).toBe('Dictionary management renamed');
  expect(
    await edit(original, 'rename', 'Dictionary management renamed', 'dictionary-manage-rename')
  ).toEqual(renamed);
  await expect(edit(original, 'rename', 'Lost update', 'dictionary-manage-stale')).rejects.toThrow(
    'LAUNCH_VERSION_CONFLICT'
  );
  const duplicate = await create('Dictionary management duplicate', 'dictionary-manage-duplicate');
  await expect(
    edit(renamed, 'rename', duplicate.value, 'dictionary-manage-collision')
  ).rejects.toThrow('INVALID_INPUT');
  await db.root(
    "update public.team_members set base_role='viewer' where team_id=$1 and user_id=$2",
    [team, ASSIGNEE]
  );
  await expect(
    edit(renamed, 'rename', 'not permitted', 'dictionary-manage-editor', ASSIGNEE)
  ).rejects.toThrow('PERMISSION_DENIED');
  const archived = await edit(renamed, 'archive', '', 'dictionary-manage-archive');
  const listed = async () =>
    (
      await db.asUser<{ v: { offers: Row[] } }>(
        OWNER,
        'select public.list_launch_dictionaries($1) v',
        [team]
      )
    )[0].v.offers;
  expect((await listed()).some(row => row.id === original.id)).toBe(false);
  const restored = await edit(archived, 'restore', '', 'dictionary-manage-restore');
  expect((await listed()).find(row => row.id === original.id)).toEqual(restored);
  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::int n from public.team_launch_requests where team_id=$1 and request_key=$2',
        [team, 'dictionary-manage-rename']
      )
    )[0].n
  ).toBe(1);
});
