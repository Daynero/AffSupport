import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  applyMigrationsAfter,
  createTeamTestDb,
  createUser,
  type TeamTestDb
} from './support/team-db';

/**
 * next QA 2026-11-17: the admin analytics tab failed on the authenticated role's eight-second
 * timeout, because admin_overview and admin_daily_activity read every event in the range
 * (20261217120000). The faster forms must answer exactly what the old ones did.
 */
const BEFORE = '20261217110000_catalog_global_pilot_completion.sql';
const ADMIN = '35000000-0000-4000-8000-000000000001';
const OTHER = '35000000-0000-4000-8000-000000000002';
let harness: TeamTestDb;

const RANGE = ['2026-11-10T09:30:00Z', '2026-11-14T12:00:00Z'] as const;

async function answers() {
  const [overview] = await harness.asUser<{ o: unknown }>(
    ADMIN,
    'select public.admin_overview($1,$2) o',
    [...RANGE]
  );
  const daily = await harness.asUser(
    ADMIN,
    'select activity_date::text, active_users::int, event_count::int from public.admin_daily_activity($1,$2)',
    [...RANGE]
  );
  return { overview: overview!.o, daily };
}

let before: Awaited<ReturnType<typeof answers>>;
beforeAll(async () => {
  harness = await createTeamTestDb({ throughMigration: BEFORE });
  await createUser(harness, { id: ADMIN, email: 'admin@analytics.test' });
  await createUser(harness, { id: OTHER, email: 'other@analytics.test' });
  await harness.root('insert into public.admin_users (user_id) values ($1)', [ADMIN]);
  const events: Array<[string | null, string, Record<string, unknown>, string]> = [
    // Earlier on the first day than the range start: the daily series has always counted it.
    [ADMIN, 'operation_started', {}, '2026-11-10T03:00:00Z'],
    [
      OTHER,
      'compression_completed',
      { mode: 'optimal', total_input_bytes: 1000, total_output_bytes: 400, saving_percent: 60 },
      '2026-11-10T10:00:00Z'
    ],
    [
      ADMIN,
      'compression_batch_started',
      { mode: 'custom', image_embedding: true },
      '2026-11-10T11:00:00Z'
    ],
    [ADMIN, 'videos_added', { video_count: 3 }, '2026-11-11T08:00:00Z'],
    [null, 'link_check_completed', {}, '2026-11-11T09:00:00Z'],
    [OTHER, 'agent_connected', {}, '2026-11-13T22:00:00Z'],
    [OTHER, 'compression_failed', {}, '2026-11-14T11:00:00Z'],
    // After the range end, on its last day: daily counts it, the overview does not.
    [ADMIN, 'tool_opened', {}, '2026-11-14T13:00:00Z'],
    [ADMIN, 'tool_opened', {}, '2026-11-15T13:00:00Z']
  ];
  for (const [user, name, properties, at] of events) {
    await harness.root(
      `insert into public.analytics_events(user_id,event_name,tool,properties,occurred_at,created_at)
       values($1,$2,$3,$4,$5,$5)`,
      [user, name, name === 'tool_opened' ? 'compressor' : null, JSON.stringify(properties), at]
    );
  }
  before = await answers();
  await applyMigrationsAfter(harness, BEFORE);
}, 120_000);
afterAll(async () => {
  await harness?.close();
});

it('answers what the old functions answered', async () => {
  expect(before.daily).toHaveLength(5);
  expect(before.overview).toMatchObject({
    agent_connections: 1,
    compressor_opens: 0,
    successful_compressions: 1,
    failed_compressions: 1,
    total_videos: 3,
    total_saved_bytes: 600,
    image_embedding_batches: 1,
    videos_optimal: 1
  });
  expect(before.daily.find(row => row.activity_date === '2026-11-12')).toEqual({
    activity_date: '2026-11-12',
    active_users: 0,
    event_count: 0
  });
  expect(await answers()).toEqual(before);
});

it('keeps both functions for administrators only', async () => {
  await expect(
    harness.asUser(OTHER, 'select public.admin_overview($1,$2)', [...RANGE])
  ).rejects.toThrow('Administrator access required');
  await expect(
    harness.asUser(OTHER, 'select * from public.admin_daily_activity($1,$2)', [...RANGE])
  ).rejects.toThrow('Administrator access required');
});
