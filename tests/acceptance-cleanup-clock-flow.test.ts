import { readFile } from 'node:fs/promises';
import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest';
import { createTeamTestDb, type TeamTestDb } from './support/team-db';
const io = vi.hoisted(() => ({
  files: new Map<string, unknown>(),
  query: vi.fn(),
  deleted: [] as string[],
  failDelete: false
}));
vi.mock('../scripts/acceptance/fixtures.mjs', async original => ({
  ...(await original<Record<string, unknown>>()),
  verifiedLocalStack: async () => ({ ANON_KEY: 'synthetic', SERVICE_ROLE_KEY: 'synthetic' })
}));
vi.mock('../scripts/acceptance/private-state.mjs', () => ({
  readPrivateState: async (_namespace: string, name: string) => {
    if (!io.files.has(name)) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    return structuredClone(io.files.get(name));
  },
  writePrivateState: async (
    _namespace: string,
    name: string,
    value: unknown,
    options: { createOnly?: boolean } = {}
  ) => {
    if (options.createOnly && io.files.has(name)) throw Error('EXISTS');
    io.files.set(name, structuredClone(value));
  }
}));
vi.mock('pg', () => ({
  default: {
    Client: class {
      async connect() {}
      query = io.query;
      async end() {
        await io.query('select pg_advisory_unlock_all()');
      }
    }
  }
}));
import { clearLocalFixtures } from '../scripts/acceptance/cleanup.mjs';
import { readFaultFixtureSource } from '../scripts/acceptance/fault-schema.mjs';
const namespace = 'acceptance-cleanup-clock';
const actors = Object.fromEntries(
  ['A', 'B', 'C', 'S', 'X'].map((alias, index) => [
    alias,
    {
      id: `36000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      email: `${namespace}-${alias.toLowerCase()}@soty.invalid`,
      password: 'a'.repeat(32),
      provisioned: true
    }
  ])
);
const teams = {
  W1: '36000000-0000-4000-8000-000000000101',
  W2: '36000000-0000-4000-8000-000000000102'
};
const target = {
  kind: 'local',
  environment: 'beta',
  marker: 'soty-acceptance',
  namespace,
  authUrl: 'http://127.0.0.1:54321',
  functionsUrl: 'http://127.0.0.1:54321/functions/v1',
  databaseUrl: 'postgresql://postgres:synthetic@127.0.0.1:54322/postgres'
};
let h: TeamTestDb, overlay: string;
beforeAll(async () => {
  h = await createTeamTestDb();
  overlay = await readFile(
    new URL('../supabase/fixtures/acceptance-clock.sql', import.meta.url),
    'utf8'
  );
  io.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    const result = params ? await h.db.query(sql, params) : (await h.db.exec(sql)).at(-1)!;
    return { ...result, rowCount: result.rows.length };
  });
}, 120000);
beforeEach(async () => {
  await h.db.exec('rollback; drop table if exists private.acceptance_scoped_faults');
  io.files.clear();
  io.deleted = [];
  io.failDelete = false;
  io.files.set('fixtures.json', { namespace, actors, teams });
  for (const [alias, actor] of Object.entries(actors)) {
    await h.root(
      'insert into auth.users(id,email,email_confirmed_at,last_sign_in_at,raw_user_meta_data) values($1,$2,now(),now(),$3::jsonb) on conflict(id) do nothing',
      [actor.id, actor.email, JSON.stringify({ acceptance_namespace: namespace })]
    );
    await h.root(
      "insert into public.profiles(id,display_name,account_status) values($1,$2,'active') on conflict(id) do nothing",
      [actor.id, `036 ${alias}`]
    );
  }
  await h.root('insert into public.admin_users(user_id) values($1) on conflict do nothing', [
    actors.S.id
  ]);
  await h.db.transaction(async tx => {
    for (const [alias, owner] of [
      ['W1', 'A'],
      ['W2', 'X']
    ] as const) {
      await tx.query(
        'insert into public.teams(id,name,owner_id) values($1,$2,$3) on conflict(id) do nothing',
        [teams[alias], `${namespace} ${alias}`, actors[owner].id]
      );
      await tx.query(
        "insert into public.team_members(team_id,user_id,base_role) values($1,$2,'admin') on conflict do nothing",
        [teams[alias], actors[owner].id]
      );
    }
  });
  await h.db.exec(
    "create or replace function private.tariff_now() returns timestamptz language sql stable security definer set search_path='' as $$ select pg_catalog.now() $$; revoke all on function private.tariff_now() from public,anon,authenticated,service_role; drop table if exists private.acceptance_tariff_clock;"
  );
  await h.db.exec(overlay);
  await h.root(
    "insert into private.acceptance_tariff_clock(singleton,namespace,tariff_at,expires_at) values(true,$1,'2030-01-01',clock_timestamp()+interval '1 hour')",
    [namespace]
  );
});
afterAll(async () => h?.close());
const auth: typeof fetch = async (input, init) => {
  const id = String(input).split('/').at(-1)!;
  if (init?.method === 'DELETE') {
    if (io.failDelete) {
      io.failDelete = false;
      return new Response('{}', { status: 503 });
    }
    await h.root('delete from auth.users where id=$1', [id]);
    io.deleted.push(id);
    return new Response('{}');
  }
  const rows = await h.root<{ id: string; email: string; user_metadata: unknown }>(
    'select id,email,raw_user_meta_data as user_metadata from auth.users where id=$1',
    [id]
  );
  return new Response(JSON.stringify(rows[0] ?? {}), { status: rows.length ? 200 : 404 });
};
async function clockState() {
  return (
    await h.root<{ real: boolean; overlay: boolean }>(
      "select private.tariff_now()=now() as real,to_regclass('private.acceptance_tariff_clock') is not null as overlay"
    )
  )[0];
}
async function orphanFault() {
  await h.db.exec(await readFaultFixtureSource());
  await h.root(
    `insert into private.acceptance_scoped_faults
    (namespace,fault_id,kind,actor_id,team_id,operation_id,flow_id,ttl_ms,state,created_at_ms,expires_at_ms,changed_at_ms)
    values($1,'36000000-0000-4000-8000-000000000201','missing_signal',$2,$3,
    '36000000-0000-4000-8000-000000000202','36000000-0000-4000-8000-000000000203',1000,'armed',0,1000,0)`,
    [namespace, actors.A.id, teams.W1]
  );
}
it('actual cleanup dry-run validates the clock and leaves fixtures and time intact', async () => {
  await orphanFault();
  const result = await clearLocalFixtures(target, { dryRun: true }, auth);
  expect(result).toMatchObject({
    ok: true,
    dryRun: true,
    tariffClock: { state: 'overlay', willRestore: true },
    scopedFaults: { state: 'absent', restored: true, dryRun: true }
  });
  expect(await clockState()).toEqual({ real: false, overlay: true });
  expect(io.deleted).toEqual([]);
  expect(io.files.has('cleanup.json')).toBe(false);
  expect(
    (await h.root<{ n: number }>('select count(*)::int n from private.acceptance_scoped_faults'))[0]
      .n
  ).toBe(1);
  await h.db.exec('drop table private.acceptance_scoped_faults');
});
it('actual cleanup refuses a foreign clock before deleting any fixture', async () => {
  await h.root("update private.acceptance_tariff_clock set namespace='acceptance-other-campaign'");
  await expect(clearLocalFixtures(target, {}, auth)).rejects.toThrow('ACCEPTANCE_CLOCK_REFUSED');
  expect(io.deleted).toEqual([]);
  expect(io.files.has('cleanup.json')).toBe(false);
  expect((await h.root<{ n: number }>('select count(*)::int as n from public.teams'))[0].n).toBe(2);
});
it('clock teardown survives interrupted Auth cleanup and the same receipt completes on retry', async () => {
  await orphanFault();
  io.failDelete = true;
  await expect(clearLocalFixtures(target, {}, auth)).rejects.toThrow(
    'ACCEPTANCE_CLEANUP_AUTH_PENDING'
  );
  expect(await clockState()).toEqual({ real: true, overlay: false });
  expect(
    (
      await h.root<{ absent: boolean }>(
        "select to_regclass('private.acceptance_scoped_faults') is null absent"
      )
    )[0].absent
  ).toBe(true);
  expect(io.files.get('cleanup.json')).toMatchObject({ phase: 'app-disabled-auth-pending' });
  expect(await clearLocalFixtures(target, {}, auth)).toMatchObject({
    ok: true,
    tariffClock: { state: 'real', restored: true },
    confirmedAbsent: { teams: 2, users: 5 }
  });
  expect(io.deleted).toHaveLength(5);
  expect(await clearLocalFixtures(target, {}, auth)).toMatchObject({
    ok: true,
    tariffClock: { state: 'real' }
  });
  expect(io.deleted).toHaveLength(5);
});
