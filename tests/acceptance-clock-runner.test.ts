import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  commitLost: false,
  foreignSource: false,
  mismatchFixture: false,
  cleanupPending: false,
  locked: false,
  queries: [] as string[]
}));
const namespace = 'acceptance-clock-test';
const fixture = vi.hoisted(() => {
  const actors = Object.fromEntries(
    ['A', 'B', 'C', 'X', 'S'].map((alias, index) => [
      alias,
      {
        id: `36000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        email: `acceptance-clock-test-${alias.toLowerCase()}@soty.invalid`,
        password: 'a'.repeat(32),
        provisioned: true
      }
    ])
  );
  return {
    namespace: 'acceptance-clock-test',
    actors,
    teams: {
      W1: '36000000-0000-4000-8000-000000000101',
      W2: '36000000-0000-4000-8000-000000000102'
    }
  };
});
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) =>
      args[0] === 'supabase/config.toml'
        ? 'project_id = "acceptance036"\n'
        : actual.readFile(...args)
  };
});
vi.mock('../scripts/acceptance/fixtures.mjs', async original => ({
  ...(await original<Record<string, unknown>>()),
  verifiedLocalStack: async () => ({})
}));
vi.mock('../scripts/acceptance/private-state.mjs', () => ({
  readPrivateState: async (_namespace: string, name: string) => {
    if (name === 'cleanup.json') {
      if (state.cleanupPending) return {};
      throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    }
    return fixture;
  }
}));
vi.mock('pg', () => ({
  default: {
    Client: class {
      async connect() {}
      async end() {}
      async query(sql: string) {
        state.queries.push(sql);
        if (sql === 'commit' && state.commitLost) throw Error('synthetic lost commit response');
        if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ held: !state.locked }] };
        if (sql.includes('select p.prosrc'))
          return {
            rows: [
              {
                prosrc: state.foreignSource
                  ? 'select untrusted_clock()'
                  : ' select pg_catalog.now() ',
                prosecdef: true,
                provolatile: 's',
                proconfig: ['search_path=""'],
                owner: 'postgres'
              }
            ]
          };
        if (sql.includes("to_regclass('private.acceptance_tariff_clock')"))
          return { rows: [{ exists: false }] };
        if (sql.includes('select exists(select 1 from auth.users'))
          return { rows: [{ valid: !state.mismatchFixture }] };
        if (sql.includes('select private.tariff_now()=now()'))
          return { rows: [{ restored: true }] };
        if (sql.includes('returning tariff_at,expires_at'))
          return {
            rows: [
              {
                tariff_at: new Date('2030-01-01T00:00:00.000Z'),
                expires_at: new Date('2026-10-23T01:00:00.000Z')
              }
            ]
          };
        if (sql.includes('select private.tariff_now() as instant'))
          return { rows: [{ instant: new Date('2030-01-01T00:00:00.000Z') }] };
        return { rows: [{ valid: true }] };
      }
    }
  }
}));
import { changeLocalTariffClock } from '../scripts/acceptance/clock.mjs';
const target = {
  kind: 'local',
  environment: 'beta',
  marker: 'soty-acceptance',
  namespace,
  authUrl: 'http://127.0.0.1:54321',
  functionsUrl: 'http://127.0.0.1:54321/functions/v1',
  databaseUrl: 'postgresql://postgres:synthetic@127.0.0.1:54322/postgres'
};
const action = { kind: 'set', instant: '2030-01-01T00:00:00.000Z', ttlMs: 60000 };
beforeEach(() => {
  state.commitLost = false;
  state.foreignSource = false;
  state.mismatchFixture = false;
  state.cleanupPending = false;
  state.locked = false;
  state.queries = [];
});
it('observes its installed instant before confirming a commit', async () => {
  expect(await changeLocalTariffClock(target, action)).toMatchObject({
    ok: true,
    state: 'overlay',
    instant: action.instant,
    fixtureSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
  });
  expect(state.queries.at(-1)).toBe('commit');
});
it.each(['set', 'clear'])('reports unconfirmed %s after a lost commit reply', async kind => {
  state.commitLost = true;
  expect(await changeLocalTariffClock(target, kind === 'set' ? action : { kind: 'clear' })).toEqual(
    { ok: false, code: 'ACCEPTANCE_CLOCK_UNCONFIRMED' }
  );
  expect(state.queries).toContain('commit');
});
it.each(['foreignSource', 'mismatchFixture', 'locked', 'cleanupPending'] as const)(
  'refuses %s before overlay writes',
  async fault => {
    state[fault] = true;
    expect(await changeLocalTariffClock(target, action)).toEqual({
      ok: false,
      code: 'ACCEPTANCE_CLOCK_REFUSED'
    });
    expect(
      state.queries.some(
        sql =>
          sql.includes('create table private.acceptance_tariff_clock') ||
          sql.includes('insert into private.acceptance_tariff_clock')
      )
    ).toBe(false);
    expect(state.queries).not.toContain('commit');
  }
);
it('confirms an already real clock without touching application rows', async () => {
  expect(await changeLocalTariffClock(target, { kind: 'clear' })).toEqual({
    ok: true,
    state: 'real',
    namespace,
    restored: true
  });
  expect(
    state.queries.some(sql => /(?:insert|update|delete)\s+(?:into\s+)?public\./iu.test(sql))
  ).toBe(false);
});
