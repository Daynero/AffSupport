import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
const OWNER = '23000000-0000-4000-8000-000000000071';
const VIEWER = '23000000-0000-4000-8000-000000000072';
let db: TeamTestDb;
let team: string;
interface Claim {
  teamId: string;
  runId: string;
  leaseToken: string;
  count: number;
}
const save = (enabled: boolean, count = 200, user = OWNER) =>
  db.asUser<{ value: { enabled: boolean; count: number; nextRunAt: string | null } }>(
    user,
    'select public.set_team_product_catalog_text_schedule($1,$2,$3) value',
    [team, enabled, count]
  );
const claim = async () =>
  (
    await db.root<{ value: Claim[] }>('select public.service_claim_catalog_text_schedule() value')
  )[0]!.value;
const due = () =>
  db.root(
    "update private.catalog_text_schedule set next_run_at=clock_timestamp()-interval '1 hour',next_attempt_at=clock_timestamp()-interval '1 hour',lease_until=null where team_id=$1",
    [team]
  );
const items = (prefix: string, n = 2) =>
  Array.from({ length: n }, (_, i) => ({
    title: `${prefix} ${i}`,
    description: 'A complete generated description.'
  }));
const commit = async (c: Claim, texts = items('new', c.count)) =>
  (
    await db.root<{ value: boolean }>(
      'select public.service_commit_catalog_text_schedule($1,$2,$3,$4) value',
      [team, c.runId, c.leaseToken, JSON.stringify(texts)]
    )
  )[0]!.value;
beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: OWNER, email: 'owner@schedule.test', displayName: 'Owner' });
  await createUser(db, { id: VIEWER, email: 'viewer@schedule.test', displayName: 'Viewer' });
  await db.root('insert into public.admin_users(user_id)values($1)', [OWNER]);
  team = (
    await db.asUser<{ id: string }>(OWNER, "select id from public.create_team('Text schedule')")
  )[0]!.id;
  await db.root(
    "insert into public.team_members(team_id,user_id,base_role)values($1,$2,'viewer')",
    [team, VIEWER]
  );
}, 30000);
afterAll(async () => {
  await db?.close();
});
describe('durable weekly replacement', () => {
  it('defaults off/200, requires manage_metadata, and first enables seven days later', async () => {
    const result = (
      await db.asUser<{ value: unknown }>(
        VIEWER,
        'select public.get_team_product_catalog_text_schedule($1) value',
        [team]
      )
    )[0]!.value;
    expect(result).toEqual({
      enabled: false,
      count: 200,
      nextRunAt: null,
      lastRunAt: null,
      lastError: null
    });
    await expect(save(true, 200, VIEWER)).rejects.toThrow(/PERMISSION_DENIED/);
    await expect(save(true, 0)).rejects.toThrow(/INVALID_INPUT/);
    await expect(save(true, 1001)).rejects.toThrow(/INVALID_INPUT/);
    const enabled = (await save(true))[0]!.value;
    expect(new Date(enabled.nextRunAt!).getTime() - Date.now()).toBeGreaterThan(6.99 * 86400000);
    const edited = (await save(true, 300))[0]!.value;
    expect(edited.nextRunAt).toBe(enabled.nextRunAt);
    expect(await claim()).toEqual([]);
    const acl = await db.root<{ allowed: boolean }>(
      "select has_function_privilege('authenticated','public.service_claim_catalog_text_schedule(integer)','execute') allowed"
    );
    expect(acl[0]!.allowed).toBe(false);
  });
  it('rejects null tokens before any claim without changing texts or schedule', async () => {
    await save(true, 2);
    const before = await db.root('select * from private.catalog_text_schedule where team_id=$1', [
      team
    ]);
    const result = await db.root<{ commit: boolean; fail: boolean }>(
      `select public.service_commit_catalog_text_schedule($1,null,null,$2) commit,public.service_fail_catalog_text_schedule($1,null,null,'SAVE_FAILED') fail`,
      [team, JSON.stringify(items('unclaimed'))]
    );
    expect(result[0]).toEqual({ commit: false, fail: false });
    expect(
      await db.root('select * from private.catalog_text_schedule where team_id=$1', [team])
    ).toEqual(before);
    expect(
      await db.root('select id from public.team_product_catalog_texts where team_id=$1', [team])
    ).toEqual([]);
  });

  it('claims once, atomically replaces and makes a lost-commit replay read only', async () => {
    await save(true, 2);
    await due();
    await db.asUser(OWNER, 'select public.replace_team_product_catalog_texts($1,$2)', [
      team,
      JSON.stringify(items('old'))
    ]);
    const [first] = await claim();
    expect(first!.count).toBe(2);
    expect(await claim()).toEqual([]);
    expect(await commit(first!)).toBe(true);
    const original = await db.root<{ id: string; title: string }>(
      'select id,title from public.team_product_catalog_texts where team_id=$1 order by position',
      [team]
    );
    expect(original.map(t => t.title)).toEqual(['new 0', 'new 1']);
    expect(await commit(first!, items('replayed'))).toBe(true);
    expect(
      await db.root(
        'select id,title from public.team_product_catalog_texts where team_id=$1 order by position',
        [team]
      )
    ).toEqual(original);
    expect(await claim()).toEqual([]);
    const counts = await db.root<{ n: number }>(
      "select count(*)::integer n from private.catalog_text_schedule_journal where run_id=$1 and stage='committed'",
      [first!.runId]
    );
    expect(counts[0]!.n).toBe(1);
  });
  it('rejects malformed replacement without deleting old data', async () => {
    await due();
    const [current] = await claim();
    const before = await db.root(
      'select id,title from public.team_product_catalog_texts where team_id=$1 order by position',
      [team]
    );
    await expect(
      commit(current!, [
        { title: 'valid', description: 'ok' },
        { title: '', description: 'bad' }
      ])
    ).rejects.toThrow(/INVALID_INPUT/);
    expect(
      await db.root(
        'select id,title from public.team_product_catalog_texts where team_id=$1 order by position',
        [team]
      )
    ).toEqual(before);
    expect(await commit(current!)).toBe(true);
  });
  it('recovers an expired lease with a new token and fences stale workers', async () => {
    await due();
    const [old] = await claim();
    await db.root(
      "update private.catalog_text_schedule set lease_until=clock_timestamp()-interval '1 second' where team_id=$1",
      [team]
    );
    const [recovered] = await claim();
    expect(recovered!.runId).toBe(old!.runId);
    expect(recovered!.leaseToken).not.toBe(old!.leaseToken);
    expect(await commit(old!)).toBe(false);
    expect(await commit(recovered!)).toBe(true);
  });
  it('fences concurrent manual edits and disabling while preserving their contents', async () => {
    await due();
    const [old] = await claim();
    await db.asUser(OWNER, 'select public.replace_team_product_catalog_texts($1,$2)', [
      team,
      JSON.stringify(items('manual'))
    ]);
    expect(await commit(old!)).toBe(false);
    await save(false, 2);
    expect(await commit(old!)).toBe(false);
    expect(
      (
        await db.root<{ title: string }>(
          'select title from public.team_product_catalog_texts where team_id=$1 order by position',
          [team]
        )
      ).map(t => t.title)
    ).toEqual(['manual 0', 'manual 1']);
    expect(await claim()).toEqual([]);
  });
  it('retains prior texts on failure with backoff and exposes bounded content-free evidence', async () => {
    await save(true, 2);
    await due();
    const [current] = await claim();
    await db.root('select public.service_fail_catalog_text_schedule($1,$2,$3,$4)', [
      team,
      current!.runId,
      current!.leaseToken,
      'READ_FAILED'
    ]);
    expect(await claim()).toEqual([]);
    const state = await db.root<{ last_error: string }>(
      'select * from public.analytics_catalog_text_schedule where team_id=$1',
      [team]
    );
    expect(state[0]!.last_error).toBe('READ_FAILED');
    const journal = await db.root(
      'select * from public.analytics_catalog_text_schedule_journal where team_id=$1',
      [team]
    );
    expect(JSON.stringify(journal)).not.toMatch(
      /manual 0|complete generated description|owner@schedule/
    );
    // PGlite's cron.schedule stub does not create a job: absence must remain explicit.
    expect(
      (
        await db.root<{ capture_enabled: boolean }>(
          'select * from public.analytics_catalog_text_schedule_coverage'
        )
      )[0]!.capture_enabled
    ).toBe(false);
    await db.root(
      "insert into cron.job(jobid,jobname,active)values(71001,'wishly-catalog-updater',true)"
    );
    expect(
      (
        await db.root<{ capture_enabled: boolean }>(
          'select * from public.analytics_catalog_text_schedule_coverage'
        )
      )[0]!.capture_enabled
    ).toBe(true);
    await db.root('update cron.job set active=false where jobid=71001');
    expect(
      (
        await db.root<{ capture_enabled: boolean }>(
          'select * from public.analytics_catalog_text_schedule_coverage'
        )
      )[0]!.capture_enabled
    ).toBe(false);
  });
  it('does not block deleting the configuring member and fails closed afterward', async () => {
    const member = '23000000-0000-4000-8000-000000000073';
    await createUser(db, { id: member, email: 'member@schedule.test', displayName: 'Member' });
    await db.root('insert into public.admin_users(user_id)values($1)', [member]);
    await db.root(
      "insert into public.team_members(team_id,user_id,base_role)values($1,$2,'admin')",
      [team, member]
    );
    await save(false, 2);
    await save(true, 3, member);
    await due();
    const [owned] = await claim();
    await db.root('delete from auth.users where id=$1', [member]);
    expect(await commit(owned!)).toBe(false);
    await db.root(
      "update private.catalog_text_schedule set lease_until=clock_timestamp()-interval '1 second' where team_id=$1",
      [team]
    );
    expect(await claim()).toEqual([]);
    const state = (
      await db.root<{ enabled: boolean; last_error: string }>(
        'select enabled,last_error from private.catalog_text_schedule where team_id=$1',
        [team]
      )
    )[0]!;
    expect(state).toEqual({ enabled: false, last_error: 'PERMISSION_DENIED' });
  });

  it('takes the schedule lock before manual text row locks and keeps manual edits intact', async () => {
    await save(false, 2);
    await db.asUser(OWNER, 'select public.replace_team_product_catalog_texts($1,$2)', [
      team,
      JSON.stringify(items('ordered'))
    ]);
    const [text] = await db.root<{ id: string }>(
      'select id from public.team_product_catalog_texts where team_id=$1 order by position limit 1',
      [team]
    );
    await db.asUser(OWNER, 'select public.update_team_product_catalog_text($1,$2,$3,$4)', [
      team,
      text!.id,
      'Edited title',
      'Edited description'
    ]);
    expect(
      (
        await db.root<{ title: string }>(
          'select title from public.team_product_catalog_texts where id=$1',
          [text!.id]
        )
      )[0]!.title
    ).toBe('Edited title');
    // PGlite serializes connections. Assert the actual deployed function's lock ordering;
    // native overlap behavior remains PostgreSQL's row-lock contract, not a fake race test.
    for (const [signature, mutation] of [
      [
        'public.replace_team_product_catalog_texts(uuid,jsonb)',
        'delete from public.team_product_catalog_texts'
      ],
      [
        'public.update_team_product_catalog_text(uuid,uuid,text,text)',
        'update public.team_product_catalog_texts'
      ]
    ]) {
      const definition = (
        await db.root<{ body: string }>('select pg_get_functiondef($1::regprocedure) body', [
          signature
        ])
      )[0]!.body;
      const lock = definition.indexOf(
        'perform 1 from private.catalog_text_schedule where team_id=p_team for update'
      );
      expect(lock).toBeGreaterThan(0);
      expect(lock).toBeLessThan(definition.indexOf(mutation));
    }
  });

  it('dispatches independently of catalog items and executes before the Drive OAuth gate', () => {
    const migration = readFileSync(
      'supabase/migrations/20261206160000_catalog_text_schedule.sql',
      'utf8'
    );
    expect(migration).toContain(
      'launch_work_due boolean := private.catalog_text_schedule_due() or'
    );
    const entry = readFileSync('supabase/functions/catalog-updater/index.ts', 'utf8');
    expect(entry.indexOf('await runCatalogTextScheduleTickSafely')).toBeLessThan(
      entry.indexOf('requireDriveOAuthGate(signals')
    );
  });
});
