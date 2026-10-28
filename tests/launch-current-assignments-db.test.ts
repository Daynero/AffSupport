import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { launchConfig } from './fixtures/launches';
import { launchPreview, parseLaunchSources } from '../packages/shared/src/team/launches';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  unifiedAccountsFixture,
  UNIFIED_ACCOUNTS_OWNER as OWNER,
  UNIFIED_ACCOUNTS_VIEWER as VIEWER
} from './support/team-unified-accounts';

let f: Awaited<ReturnType<typeof unifiedAccountsFixture>>;
const migration = '20261206148000_launch_current_assignments.sql';
async function call<T = any>(name: string, args: unknown[], actor = OWNER): Promise<T> {
  return (
    await f.db.asUser<{ value: T }>(
      actor,
      `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) value`,
      args
    )
  )[0]!.value;
}
async function launch(agent = f.agents[0]!.id) {
  return (
    await f.db.root<{ id: string }>(
      `insert into public.team_launches(team_id,created_by,draft_config,effective_launch_date)
     values($1,$2,$3::jsonb,'2020-01-01') returning id`,
      [f.team, OWNER, JSON.stringify({ agentRowId: agent, creativeAlias: 'synthetic' })]
    )
  )[0]!.id;
}
async function state(agent = f.agents[0]!.id) {
  return call('get_team_agent_assignment_state', [f.team, agent]);
}
async function assign(id: string, agent = f.agents[0]!.id, version = '0', key = randomUUID()) {
  return call('set_launch_assignment', [f.team, id, agent, version, key]);
}
beforeAll(async () => {
  f = await unifiedAccountsFixture({
    socialCount: 2,
    agentsPerSocial: 2,
    runsPerAgent: 0,
    throughMigration: '20261206147000_launch_catalog_manual_trash.sql'
  });
  // Existing source relations must migrate to unknown, not silently reserve/free.
  await launch();
  await f.db.db.exec(readFileSync(`supabase/migrations/${migration}`, 'utf8'));
}, 120_000);
afterAll(async () => {
  await f?.close();
});

describe('explicit operational launch assignment', () => {
  it('migrates historical sources to unknown and supports explicit history confirmation', async () => {
    const legacy = (
      await f.db.root<{ launch_id: string }>(
        "select launch_id from private.team_launch_assignments where state='legacy_unknown'"
      )
    )[0]!.launch_id;
    expect((await state()).availability).toEqual({
      status: 'unknown',
      assignmentCount: 0,
      legacyCount: 1
    });
    const read = await call('get_launch_assignment', [f.team, legacy]);
    expect(read).toMatchObject({
      state: 'legacy_unknown',
      version: '1',
      agentRowId: f.agents[0]!.id
    });
    const legacyList = await call('list_launches', [f.team, '{}', 100]);
    expect(legacyList.items.find((row: any) => row.id === legacy).agentFree).toBeNull();
    const snapshot = await state();
    await expect(
      call('release_team_agent_assignments', [
        f.team,
        f.agents[0]!.id,
        snapshot.version,
        randomUUID()
      ])
    ).rejects.toThrow('WRONG_STATE');
    await call('set_launch_assignment', [f.team, legacy, null, '1', randomUUID()]);
    expect((await state()).availability.status).toBe('free');
    const releasedList = await call('list_launches', [f.team, '{}', 100]);
    expect(releasedList.items.find((row: any) => row.id === legacy).agentFree).toBeNull();
  });
  it('supports many launches per RK, exact replay, stale-editor conflicts and actor-scoped readback', async () => {
    const first = await launch();
    const second = await launch();
    const key = randomUUID();
    const accepted = await assign(first, f.agents[0]!.id, '0', key);
    expect(await assign(first, f.agents[0]!.id, '0', key)).toEqual(accepted);
    expect(await call('get_launch_assignment_mutation', [f.team, key])).toEqual(accepted);
    expect(await call('get_launch_assignment_mutation', [f.team, key], VIEWER)).toBeNull();
    await expect(assign(first, f.agents[0]!.id, '0')).rejects.toThrow('LAUNCH_VERSION_CONFLICT');
    await assign(second);
    expect((await state()).availability).toEqual({
      status: 'busy',
      assignmentCount: 2,
      legacyCount: 0
    });
    await call('set_launch_assignment', [f.team, first, null, accepted.version, randomUUID()]);
    expect((await state()).availability.assignmentCount).toBe(1);
    await call('set_launch_assignment', [f.team, second, null, '1', randomUUID()]);
    expect((await state()).availability.status).toBe('free');
  });
  it('does not assign through autosave; detach preserves immutable result and autosave never relinks it', async () => {
    const id = await launch();
    expect((await call('get_launch_assignment', [f.team, id])).state).toBe('unassigned');
    const revision = (
      await f.db.root<{ id: string }>(
        `insert into public.team_launch_revisions(team_id,launch_id,revision_no,result_kind,config,sources,original_url,generated_url,sub_values,created_by)
       values($1,$2,1,'manual',$3::jsonb,$4::jsonb,'https://synthetic.test/old','https://synthetic.test/result','{}',$5) returning id`,
        [
          f.team,
          id,
          JSON.stringify({ agentRowId: f.agents[0]!.id }),
          JSON.stringify({ agentRowId: f.agents[0]!.id, accountId: f.agents[0]!.account_id }),
          OWNER
        ]
      )
    )[0]!.id;
    await f.db.root('update public.team_launches set active_revision_id=$1 where id=$2', [
      revision,
      id
    ]);
    const before = (
      await f.db.root<{ value: unknown }>(
        'select to_jsonb(r) value from public.team_launch_revisions r where id=$1',
        [revision]
      )
    )[0]!.value;
    await assign(id);
    await call('set_launch_assignment', [f.team, id, null, '1', randomUUID()]);
    const launchVersion = (
      await f.db.root<{ version: string }>(
        'select aggregate_version::text version from public.team_launches where id=$1',
        [id]
      )
    )[0]!.version;
    await call('save_launch_draft', [
      f.team,
      id,
      launchVersion,
      randomUUID(),
      JSON.stringify({ agentRowId: f.agents[0]!.id }),
      null
    ]);
    expect((await call('get_launch_assignment', [f.team, id])).state).toBe('released');
    expect(
      (
        await f.db.root<{ value: unknown }>(
          'select to_jsonb(r) value from public.team_launch_revisions r where id=$1',
          [revision]
        )
      )[0]!.value
    ).toEqual(before);
    await expect(
      f.db.root("update public.team_launch_revisions set config='{}' where id=$1", [revision])
    ).rejects.toThrow('WRONG_STATE');
  });
  it('validates permissions/team and archived source eligibility without blocking cleanup', async () => {
    const id = await launch();
    await expect(
      call('set_launch_assignment', [f.team, id, f.agents[0]!.id, '0', randomUUID()], VIEWER)
    ).rejects.toThrow('PERMISSION_DENIED');
    const other = (
      await f.db.asUser<{ id: string }>(
        OWNER,
        "select id from public.create_team('foreign assignment')"
      )
    )[0]!.id;
    await expect(call('get_launch_assignment', [other, id])).rejects.toThrow('NOT_FOUND');
    await assign(id);
    const pre = await call('get_team_account_archive_preflight', [
      f.team,
      'agent',
      f.agents[0]!.id
    ]);
    await call('set_team_account_archived', [
      f.team,
      'agent',
      f.agents[0]!.id,
      true,
      pre.lifecycleVersion,
      pre.token,
      randomUUID()
    ]);
    await expect(assign(await launch())).rejects.toThrow('ACCOUNT_ARCHIVED');
    await call('set_launch_assignment', [f.team, id, null, '1', randomUUID()]);
    const archived = await call('get_team_account_archive_preflight', [
      f.team,
      'agent',
      f.agents[0]!.id
    ]);
    await call('set_team_account_archived', [
      f.team,
      'agent',
      f.agents[0]!.id,
      false,
      archived.lifecycleVersion,
      archived.token,
      randomUUID()
    ]);
    expect((await call('get_launch_assignment', [f.team, id])).state).toBe('released');
  });
  it('derives availability independent of finance date and releases all holds atomically with CAS', async () => {
    const agent = f.agents[1]!.id;
    const id = await launch(agent);
    await assign(id, agent);
    await call('add_team_agent_run', [f.team, agent, 'manual hold']);
    const before = await state(agent);
    await call('add_team_agent_run', [f.team, agent, 'concurrent hold']);
    await expect(
      call('release_team_agent_assignments', [f.team, agent, before.version, randomUUID()])
    ).rejects.toThrow('LAUNCH_VERSION_CONFLICT');
    const fresh = await state(agent);
    const key = randomUUID();
    const result = await call('release_team_agent_assignments', [
      f.team,
      agent,
      fresh.version,
      key
    ]);
    expect(result).toMatchObject({
      releasedCount: 1,
      clearedManualCount: 2,
      availability: { status: 'free' }
    });
    expect(
      await call('release_team_agent_assignments', [f.team, agent, fresh.version, key])
    ).toEqual(result);
    const current = await launch(agent);
    await assign(current, agent);
    const overview = await call('get_team_accounts_overview', [
      f.team,
      '2026-10-01',
      '2026-10-01',
      'UTC'
    ]);
    const row = overview.accounts.flatMap((a: any) => a.agents).find((a: any) => a.id === agent);
    expect(row.availability).toMatchObject({ status: 'busy', assignmentCount: 1 });
    expect(overview.launchAssignments.find((l: any) => l.id === current)).toMatchObject({
      agentRowId: agent,
      assignmentState: 'assigned',
      assignmentVersion: '1'
    });
    expect(overview.launchSummaries.find((l: any) => l.id === current)).toBeUndefined();
    const aggregate = (
      await f.db.root<{ version: string }>(
        'select aggregate_version::text version from public.team_launches where id=$1',
        [current]
      )
    )[0]!.version;
    await call('archive_launch', [f.team, current, aggregate, randomUUID(), false]);
    expect((await call('get_launch_assignment', [f.team, current])).state).toBe('released');
    expect((await state(agent)).availability.status).toBe('free');
  });
  it('fences fresh generation but preserves accepted replay/publication after release', async () => {
    const agent = f.agents[2]!.id;
    await f.db.root("update public.team_account_agents set agent_id='888123456' where id=$1", [
      agent
    ]);
    const credential = (
      await f.db.root<{ id: string }>(
        "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('assignment-permission','synthetic@assignment.test','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
        [OWNER]
      )
    )[0]!.id;
    const connection = (
      await f.db.root<{ id: string }>(
        "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values($1,$2,'assignment-root','Synthetic','my_drive','connected',now()) returning id",
        [f.team, credential]
      )
    )[0]!.id;
    const material = (
      await f.db.root<{ id: string }>(
        "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) values($1,$2,'assignment-video','synthetic.mp4','file','video','video/mp4','1') returning id",
        [f.team, connection]
      )
    )[0]!.id;
    const buyer = await call('create_launch_dictionary', [
      f.team,
      'buyers',
      'assignment_buyer',
      randomUUID()
    ]);
    const offer = await call('create_launch_dictionary', [
      f.team,
      'offers',
      'assignment_offer',
      randomUUID()
    ]);
    const config = launchConfig({
      agentRowId: agent,
      materialId: material,
      buyerId: buyer.id,
      offerId: offer.id,
      method: 'other'
    });
    const draft = await call('save_launch_draft', [
      f.team,
      null,
      null,
      randomUUID(),
      JSON.stringify(config),
      null
    ]);
    const source = await call('get_launch_sources', [f.team, draft.id]);
    const saved = await call('save_launch_draft', [
      f.team,
      draft.id,
      draft.version,
      randomUUID(),
      JSON.stringify(config),
      JSON.stringify(source)
    ]);
    const parsed = parseLaunchSources(source);
    if (!parsed) throw new Error('Synthetic source invalid');
    const preview = launchPreview(config, parsed);
    if (!preview.ok) throw new Error('Synthetic preview invalid');
    const key = randomUUID();
    const args = (version: string) => [
      f.team,
      draft.id,
      OWNER,
      version,
      key,
      'accepted-digest',
      JSON.stringify(config),
      JSON.stringify(source),
      JSON.stringify(preview.value)
    ];
    await expect(call('service_accept_launch_generation', args(saved.version))).rejects.toThrow(
      'WRONG_STATE'
    );
    await assign(draft.id, f.agents[3]!.id);
    const version = async () =>
      (
        await f.db.root<{ version: string }>(
          'select aggregate_version::text version from public.team_launches where id=$1',
          [draft.id]
        )
      )[0]!.version;
    await expect(call('service_accept_launch_generation', args(await version()))).rejects.toThrow(
      'WRONG_STATE'
    );
    await assign(draft.id, agent, '1');
    const acceptedArgs = args(await version());
    const accepted = await call('service_accept_launch_generation', acceptedArgs);
    await call('set_launch_assignment', [f.team, draft.id, null, '2', randomUUID()]);
    const replay = await call('service_accept_launch_generation', acceptedArgs);
    expect(replay).toMatchObject({
      id: accepted.id,
      revisionId: accepted.revisionId,
      replayed: true,
      state: 'accepted'
    });
    expect(
      await call('service_publish_launch_generation', [f.team, accepted.id, OWNER, accepted.fence])
    ).toMatchObject({ state: 'succeeded', revisionId: accepted.revisionId });
    expect((await call('get_launch_assignment', [f.team, draft.id])).state).toBe('released');
  });
  it('moves current assignment with stable RK identity while retaining source provenance', async () => {
    const agent = f.agents[2]!;
    const id = await launch(agent.id);
    await assign(id, agent.id);
    const place = (
      await f.db.root<{ id: string; version: string }>(
        'select id,version::text from public.team_agent_placements where agent_row_id=$1 and ends_on is null',
        [agent.id]
      )
    )[0]!;
    const target = f.socials.find(row => row.id !== agent.account_id)!.id;
    await f.db.root("update public.team_account_agents set agent_id='moved-unique' where id=$1", [
      agent.id
    ]);
    await call('move_team_account_agent', [
      f.team,
      agent.id,
      target,
      '2026-10-26',
      place.id,
      place.version,
      'UTC',
      randomUUID()
    ]);
    const overview = await call('get_team_accounts_overview', [
      f.team,
      '2026-10-26',
      '2026-10-26',
      'UTC'
    ]);
    expect(overview.launchAssignments.find((row: any) => row.id === id)).toMatchObject({
      agentRowId: agent.id,
      accountId: target
    });
    expect((await call('get_launch_assignment', [f.team, id])).agentRowId).toBe(agent.id);
    await call('set_launch_assignment', [f.team, id, null, '1', randomUUID()]);
  });
  it('extends the actual ingestion guard only with closed assignment action names', async () => {
    for (const action of ['assign_account', 'release_account'])
      expect(
        (
          await f.db.root<{ ok: boolean }>(
            'select public.analytics_properties_are_safe_v2($1::jsonb) ok',
            [JSON.stringify({ launch_action: action })]
          )
        )[0]!.ok
      ).toBe(true);
    expect(
      (
        await f.db.root<{ ok: boolean }>(
          'select public.analytics_properties_are_safe_v2($1::jsonb) ok',
          [JSON.stringify({ launch_action: 'arbitrary account note' })]
        )
      )[0]!.ok
    ).toBe(false);
  });
  it('preserves complete conservative cleanup reference coverage for new team tables', async () => {
    const coverage = await f.db.root<{ verified: boolean; missing: string[] }>(`select
      private.task_cleanup_coverage_verified() verified,
      array(select t.table_name from private.task_cleanup_reference_tables() t
       where not exists(select 1 from pg_catalog.pg_trigger tr
         join pg_catalog.pg_class c on c.oid=tr.tgrelid
         join pg_catalog.pg_namespace n on n.oid=c.relnamespace
         where n.nspname=t.schema_name and c.relname=t.table_name
           and tr.tgname='task_cleanup_reference_fence' and tr.tgenabled<>'D')) missing`);
    expect(coverage[0]).toEqual({ verified: true, missing: [] });
  });
  it('keeps safe diagnostic projections SELECT-only and helpers inaccessible', async () => {
    const rls = await f.db.root<{ enabled: boolean; forced: boolean }>(`select
      c.relrowsecurity enabled, c.relforcerowsecurity forced
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname='private' and c.relname in ('team_launch_assignments','team_launch_assignment_events')`);
    expect(rls).toHaveLength(2);
    expect(rls.every(table => table.enabled && table.forced)).toBe(true);
    const result = await f.db.root<{ mutate: boolean; read: boolean; helper: boolean }>(`select
      has_table_privilege('wishly_analytics_ro','public.analytics_launch_assignments','INSERT') mutate,
      has_table_privilege('wishly_analytics_ro','public.analytics_launch_assignments','SELECT') read,
      has_function_privilege('authenticated','private.launch_assignment_json(uuid,uuid)','EXECUTE') helper`);
    expect(result[0]).toEqual({ mutate: false, read: true, helper: false });
    const columns = await f.db.root<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema='public' and table_name='analytics_launch_assignments'"
    );
    expect(columns.map(x => x.column_name).join(',')).not.toMatch(/name|note|config|source|url/);
  });
  it('refuses permanent RK/social deletion with a stable code while work is assigned', async () => {
    const agent = f.agents[3]!;
    const id = await launch(agent.id);
    await assign(id, agent.id);
    await expect(call('delete_team_account_agent', [f.team, agent.id])).rejects.toThrow(
      'WRONG_STATE'
    );
    await expect(call('delete_team_account', [f.team, agent.account_id])).rejects.toThrow(
      'WRONG_STATE'
    );
    await call('set_launch_assignment', [f.team, id, null, '1', randomUUID()]);
    expect((await call('get_launch_assignment', [f.team, id])).state).toBe('released');
  });
  it('annotates source-chip availability only for a confirmed matching current RK', async () => {
    const source = f.agents[0]!.id;
    const id = await launch(source);
    await assign(id, source);
    const matching = await call('list_launches', [f.team, '{}', 100]);
    expect(matching.items.find((row: any) => row.id === id).agentFree).toBe(false);
    await assign(id, f.agents[1]!.id, '1');
    const reassigned = await call('list_launches', [f.team, '{}', 100]);
    expect(reassigned.items.find((row: any) => row.id === id).agentFree).toBeNull();
    const detail = await call('get_launch', [f.team, id, null]);
    await call('save_launch_draft', [
      f.team,
      id,
      detail.version,
      randomUUID(),
      JSON.stringify({ agentRowId: f.agents[1]!.id, creativeAlias: 'synthetic' }),
      null
    ]);
    const configured = await call('list_launches', [f.team, '{}', 100]);
    const configuredLaunch = configured.items.find((row: any) => row.id === id);
    expect(configuredLaunch.assignment.sourceAgentRowId).toBe(f.agents[1]!.id);
    expect(configuredLaunch.agentFree).toBe(false);
    await call('set_launch_assignment', [f.team, id, null, '2', randomUUID()]);
  });
  it('caps displayed assignment summaries without losing exact availability', async () => {
    const agent = f.agents[3]!.id;
    // Fixture population is not a user mutation. Avoid 5001 redundant realtime
    // invalidations; ordinary RPC regressions above exercise the real trigger.
    await f.db.root(
      'alter table private.team_launch_assignments disable trigger account_workspace_signal'
    );
    await f.db.root(
      `with launches as (
      insert into public.team_launches(team_id,created_by,draft_config,effective_launch_date)
      select $1,$2,jsonb_build_object('agentRowId',$3::text,'creativeAlias','bounded fixture'),'2020-01-01'
      from generate_series(1,5001) returning id,team_id
    ) insert into private.team_launch_assignments(launch_id,team_id,agent_row_id,source_agent_row_id,state)
      select id,team_id,$3::uuid,$3::uuid,'assigned' from launches`,
      [f.team, OWNER, agent]
    );
    await f.db.root(
      'alter table private.team_launch_assignments enable trigger account_workspace_signal'
    );
    const overview = await call('get_team_accounts_overview', [
      f.team,
      '2026-10-26',
      '2026-10-26',
      'UTC'
    ]);
    expect(overview.assignmentCoverage).toBe('partial');
    expect(overview.launchAssignments).toHaveLength(5000);
    expect((await state(agent)).availability).toMatchObject({
      status: 'busy',
      assignmentCount: 5001
    });
  }, 30_000);
});
