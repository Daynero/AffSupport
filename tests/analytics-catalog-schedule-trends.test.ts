import { writeFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { assertReadOnlySql, setQueryExecutor } from '../scripts/analytics/db.js';
import {
  aggregateCustomHours,
  catalogScheduleTrendsSql,
  getCatalogScheduleTrends,
  normalizeCatalogInterval
} from '../scripts/analytics/catalog-schedule-trends.js';
import type { ResolvedPeriod } from '../scripts/analytics/types.js';

let db: PGlite;
const user1 = '10000000-0000-4000-8000-000000000001';
const user2 = '10000000-0000-4000-8000-000000000002';
const catalog = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const period: ResolvedPeriod = {
  token: '7d',
  start: '2026-10-16T00:00:00Z',
  end: '2026-10-20T23:59:59Z',
  label: 'test'
};
function state(interval: string | null, patch = {}) {
  return {
    updateInterval: interval,
    schedule: null,
    restitch: false,
    randomLinkVariation: true,
    refreshImages: true,
    refreshTexts: true,
    growProducts: false,
    isActive: true,
    isDeleted: false,
    ...patch
  };
}
beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(`create table public.analytics_catalog_settings_history (
    event_id uuid primary key, observed_at timestamptz, catalog_material_id uuid, actor_id uuid,
    source text, transaction_id bigint, before_state jsonb, after_state jsonb, changed_fields text[]);
    create table public.analytics_users (id uuid primary key,email_normalized text);
    create table public.analytics_catalog_settings_coverage (installed_at timestamptz,capture_enabled boolean,schema_version integer);
    insert into public.analytics_catalog_settings_coverage values ('2026-10-18T09:00:00Z',true,1);`);
  await db.query('insert into public.analytics_users values ($1,$2)', [
    user1,
    'private@example.com'
  ]);
  let id = 0;
  async function event(
    cat: number,
    at: string,
    actor: string | null,
    before: ReturnType<typeof state> | null,
    after: ReturnType<typeof state>,
    fields: string[] = []
  ) {
    id += 1;
    await db.query(
      'insert into public.analytics_catalog_settings_history values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        `30000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
        at,
        catalog(cat),
        actor,
        before ? 'change' : 'baseline',
        id,
        before,
        after,
        fields
      ]
    );
  }
  await event(1, '2026-10-18T10:00:00Z', null, null, state('1d'));
  await event(2, '2026-10-18T10:00:00Z', null, null, state('1w'));
  await event(3, '2026-10-18T10:00:00Z', null, null, state(null));
  await event(4, '2026-10-18T10:00:00Z', null, null, state('1d', { isActive: false }));
  await event(1, '2026-10-19T08:00:00Z', user1, state('1d'), state('1h'), ['updateInterval']);
  const dayClock = { timeZone: 'Europe/Kyiv', weekday: 1, time: '10:00' };
  await event(1, '2026-10-19T09:00:00Z', user1, state('1h'), state('24h', { schedule: dayClock }), [
    'updateInterval',
    'schedule'
  ]);
  await event(
    1,
    '2026-10-19T10:00:00Z',
    user1,
    state('24h', { schedule: dayClock }),
    state('1d', { schedule: dayClock }),
    ['updateInterval']
  );
  await event(2, '2026-10-19T12:00:00Z', user1, state('1w'), state('6h', { restitch: true }), [
    'updateInterval',
    'restitch'
  ]);
  await event(3, '2026-10-19T16:00:00Z', null, state(null), state('1h'), ['updateInterval']);
  await event(1, '2026-10-20T09:00:00Z', user2, state('1d', { schedule: dayClock }), state('6h'), [
    'updateInterval',
    'schedule'
  ]);
  setQueryExecutor(
    async (sql, params) => (await db.query(sql, params)).rows as Record<string, unknown>[]
  );
});
afterAll(async () => {
  setQueryExecutor(null);
  await db.close();
});

it('uses only guarded read-only SQL and normalizes aliases without changing raw evidence', () => {
  expect(() => assertReadOnlySql(catalogScheduleTrendsSql())).not.toThrow();
  expect(() => assertReadOnlySql(catalogScheduleTrendsSql(true))).not.toThrow();
  expect([null, '1h', '24h', '168h', '6h'].map(normalizeCatalogInterval)).toEqual([
    'off',
    '1h',
    '1d',
    '1w',
    '6h'
  ]);
  expect(
    aggregateCustomHours(
      [
        { interval: '6h', catalogs: 2, distinct_last_editors: 2, raw_intervals: [] },
        {
          interval: '1d',
          catalogs: 1,
          distinct_last_editors: 1,
          raw_intervals: [{ interval: '24h', count: 1 }]
        }
      ],
      [
        {
          interval: '6h',
          selections: 3,
          distinct_actors: 2,
          unknown_actor_changes: 1,
          raw_intervals: []
        },
        {
          interval: '12h',
          selections: 1,
          distinct_actors: 1,
          unknown_actor_changes: 0,
          raw_intervals: []
        }
      ]
    )
  ).toEqual([
    { hours: 6, catalogs: 2, confirmed_selections: 3, distinct_actors: 2 },
    { hours: 12, catalogs: 0, confirmed_selections: 1, distinct_actors: 1 }
  ]);
});

it('aggregates the whole population once, excludes baselines and alias-only transitions, and separates actors', async () => {
  const report = await getCatalogScheduleTrends(period, { limit: 1 });
  expect(report.status).toBe('ok');
  expect(report.totals).toEqual({
    confirmed_changes: 6,
    interval_changes: 5,
    distinct_actors: 2,
    unknown_actor_changes: 1
  });
  if (process.env.CATALOG_TRENDS_TEST_EXPORT) {
    writeFileSync(
      process.env.CATALOG_TRENDS_TEST_EXPORT,
      JSON.stringify(
        {
          ...report,
          demo: true,
          coverage: {
            ...report.coverage,
            notes: [
              'DEMO: seeded test fixtures only; this is not real user activity.',
              ...report.coverage.notes
            ]
          }
        },
        null,
        2
      )
    );
  }
  expect(report.current.catalogs).toBe(3);
  expect(report.current.known_last_editors).toBe(2);
  expect(report.current.unknown_last_editors).toBe(1);
  expect(report.popularity.find(item => item.interval === '1h')).toMatchObject({
    selections: 2,
    distinct_actors: 1,
    unknown_actor_changes: 1
  });
  expect(report.popularity.find(item => item.interval === '1d')?.raw_intervals).toEqual([
    { interval: '24h', count: 1 }
  ]);
  expect(report.transitions.reduce((total, item) => total + item.changes, 0)).toBe(5);
  expect(report.transitions.some(item => item.from === item.to)).toBe(false);
  expect(report.schedule_clock).toEqual([
    {
      time: '10:00',
      weekday: null,
      time_zone: 'Europe/Kyiv',
      catalogs: 0,
      confirmed_selections: 1,
      distinct_actors: 1
    }
  ]);
  expect(report.custom_hours).toEqual([
    { hours: 6, catalogs: 2, confirmed_selections: 2, distinct_actors: 2 }
  ]);
  expect(report.options.find(item => item.field === 'restitch')).toMatchObject({
    enabled_catalogs: 1,
    enabled_changes: 1,
    disabled_changes: 0
  });
  expect(report.truncation).toMatchObject({
    users_total: 2,
    users_returned: 1,
    users_limit: 1,
    timeline_total: 4,
    timeline_returned: 4
  });
  expect(report.users[0]?.user_id).toBe(user1);
  expect(report.users[0]?.first_observed_before.interval).toBe('1d');
  expect(report.users[0]?.first_observed.interval).toBe('1h');
  expect(report.users[0]?.timeline.map(item => item.catalog_id)).toEqual([
    catalog(1),
    catalog(1),
    catalog(1),
    catalog(2)
  ]);
  expect(report.coverage).toMatchObject({
    history_complete: false,
    baseline_rows: 4,
    unknown_actor_changes: 1,
    omitted_unobserved_days: 2
  });
  expect(report.daily.map(item => item.date)).toEqual(['2026-10-18', '2026-10-19', '2026-10-20']);
  expect(report.daily.find(item => item.date === '2026-10-19')).toMatchObject({
    confirmed_changes: 5,
    interval_changes: 4
  });
});

it('reconstructs past as-of state and scopes users by confirmed actor rather than ownership', async () => {
  const previous = await getCatalogScheduleTrends({ ...period, end: '2026-10-19T23:59:59Z' });
  expect(previous.current.distribution.find(item => item.interval === '1d')?.catalogs).toBe(1);
  expect(previous.current.distribution.find(item => item.interval === '6h')?.catalogs).toBe(1);
  expect(previous.users.some(item => item.user_id === user2)).toBe(false);
  const scoped = await getCatalogScheduleTrends(period, { user: 'PRIVATE@example.com' });
  expect(scoped.scope).toEqual({ user_id: user1, mode: 'actor' });
  expect(scoped.current.catalogs).toBe(1);
  expect(scoped.current.distribution[0]?.interval).toBe('6h');
  expect(scoped.popularity.find(item => item.interval === '6h')?.selections).toBe(1);
  expect(JSON.stringify(scoped)).not.toContain('private@example.com');
});

it('does not invent zero days before observation and rejects invalid limits', async () => {
  const before = await getCatalogScheduleTrends({ ...period, end: '2026-10-17T23:59:59Z' });
  expect(before.status).toBe('unsupported_by_producer');
  expect(before.daily).toEqual([]);
  expect(before.interval_daily_endstate).toEqual([]);
  expect(before.coverage.observed_since).toBeNull();
  expect(before.coverage.omitted_unobserved_days).toBeNull();
  await expect(getCatalogScheduleTrends(period, { limit: Number.NaN })).rejects.toThrow(
    'finite integer'
  );
  await expect(getCatalogScheduleTrends(period, { limit: Infinity })).rejects.toThrow(
    'finite integer'
  );
});

it('reports missing or unreadable authoritative evidence as unknown instead of falling back to zeros', async () => {
  try {
    setQueryExecutor(async sql => {
      if (sql.includes('to_regclass'))
        return [{ history_view: 'public.analytics_catalog_settings_history' }];
      throw Object.assign(new Error('permission denied'), { code: '42501' });
    });
    const denied = await getCatalogScheduleTrends(period);
    expect(denied.status).toBe('unsupported_by_producer');
    expect(denied.coverage.notes.join(' ')).toContain('unknown, not zero');
    setQueryExecutor(async () => [{ history_view: null }]);
    expect((await getCatalogScheduleTrends(period)).status).toBe('unsupported_by_producer');
  } finally {
    setQueryExecutor(
      async (sql, params) => (await db.query(sql, params)).rows as Record<string, unknown>[]
    );
  }
});

it('exposes disabled producer capture instead of treating stale observations as complete history', async () => {
  await db.exec('update public.analytics_catalog_settings_coverage set capture_enabled=false');
  try {
    const report = await getCatalogScheduleTrends(period);
    expect(report.coverage.capture_enabled).toBe(false);
    expect(report.coverage.schema_version).toBe(1);
    expect(report.coverage.notes.join(' ')).toContain('may be stale');
  } finally {
    await db.exec('update public.analytics_catalog_settings_coverage set capture_enabled=true');
  }
});
