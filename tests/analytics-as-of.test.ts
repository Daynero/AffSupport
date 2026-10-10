import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
import { executeCommand, parseArgs } from '../scripts/analytics/cli';
import { asOfDate, parseAsOf, resolvePeriod } from '../scripts/analytics/periods';
import { getDeliveryLag, getJourney, getRun } from '../scripts/analytics/queries';
import type { DeliveryLag, EventsData, JourneyData } from '../scripts/analytics/types';

/**
 * 031 T017 — `--as-of` pins the window's end so a repeated analysis sees the
 * same rows; every aggregating command carries `delivery_lag_ms`; `journey`
 * is bounded by default and sanitizes properties with the client allowlist.
 */

let db: AnalyticsTestDb;
const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN = '20000000-0000-4000-8000-000000000001';
const SNAPSHOT = '2026-10-01T12:00:00.000Z';

beforeAll(async () => {
  db = await createAnalyticsDb();
  await db.exec(`
    insert into public.analytics_users values
      ('${ALICE}','alice@example.com','alice@example.com','Alice','uk','free','active',true,
       '2026-01-01T00:00:00Z','2026-10-02T00:00:00Z','2026-10-02T00:00:00Z');

    -- Four events before the snapshot with known lags (100, 300, 500, 900 ms)
    -- and one created after it that a pinned read must not see.
    insert into public.analytics_events (user_id, event_name, tool, run_id, properties, occurred_at, created_at) values
      ('${ALICE}','tool_opened','compressor',null,'{"tool_identifier":"compressor"}','2026-10-01T10:00:00.000Z','2026-10-01T10:00:00.100Z'),
      ('${ALICE}','compression_started','compressor','${RUN}','{"run_id":"${RUN}"}','2026-10-01T10:01:00.000Z','2026-10-01T10:01:00.300Z'),
      ('${ALICE}','compression_completed','compressor','${RUN}','{"run_id":"${RUN}","total_input_bytes":10,"total_output_bytes":5,"path":"/Users/alice/secret.mp4","note":"Bearer abc"}','2026-10-01T10:02:00.000Z','2026-10-01T10:02:00.500Z'),
      ('${ALICE}','home_viewed',null,null,'{}','2026-10-01T11:59:59.000Z','2026-10-01T11:59:59.900Z'),
      ('${ALICE}','compression_failed','compressor','${RUN}','{"run_id":"${RUN}"}','2026-10-01T12:00:00.000Z','2026-10-01T12:00:01.000Z'),
      ('${ALICE}','home_viewed',null,null,'{}','2026-06-01T00:00:00.000Z','2026-06-01T00:00:00.000Z');
  `);
}, 30_000);

afterAll(async () => {
  await db.close();
});

describe('resolvePeriod --as-of', () => {
  it('fixes the end of the window and echoes period.as_of', () => {
    const period = resolvePeriod('7d', undefined, SNAPSHOT);
    expect(period.end).toBe(SNAPSHOT);
    expect(period.as_of).toBe(SNAPSHOT);
    expect(period.start).toBe('2026-09-24T12:00:00.000Z');
    expect(asOfDate(period)).toBe('2026-10-01');
  });

  it('accepts a bare date as UTC midnight and rejects anything else', () => {
    expect(parseAsOf('2026-10-01').toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(() => parseAsOf('yesterday')).toThrow(/Invalid --as-of/);
    expect(() => parseAsOf('2026-13-45T00:00:00Z')).toThrow(/Invalid --as-of/);
    expect(() => resolvePeriod('7d', undefined, 'nope')).toThrow(/Invalid --as-of/);
  });

  it('leaves as_of out when the window ends now', () => {
    expect(resolvePeriod('7d', undefined)).not.toHaveProperty('as_of');
  });

  it('is parsed as a global option', () => {
    const args = parseArgs(['events', '--as-of', SNAPSHOT, '--json']);
    expect(args).toMatchObject({ command: 'events', asOf: SNAPSHOT, json: true });
    expect(() => parseArgs(['events', '--as-of'])).toThrow(/--as-of/);
  });
});

describe('pinned reads', () => {
  it('excludes rows created after as_of, includes the row created exactly at it', async () => {
    const pinned = await executeCommand(
      parseArgs(['events', '--period', 'all', '--as-of', SNAPSHOT])
    );
    const data = pinned.data as EventsData;
    expect(pinned.period.as_of).toBe(SNAPSHOT);
    expect(data.events.find(row => row.event_name === 'compression_failed')).toBeUndefined();
    expect(data.events.find(row => row.event_name === 'home_viewed')?.count).toBe(2);

    const now = await executeCommand(parseArgs(['events', '--period', 'all']));
    expect(
      (now.data as EventsData).events.find(row => row.event_name === 'compression_failed')?.count
    ).toBe(1);
  });

  it('bounds run timelines too', async () => {
    expect((await getRun(RUN)).map(row => row.event_name)).toEqual([
      'compression_started',
      'compression_completed',
      'compression_failed'
    ]);
    expect((await getRun(RUN, 500, SNAPSHOT)).map(row => row.event_name)).toEqual([
      'compression_started',
      'compression_completed'
    ]);
  });
});

describe('delivery lag', () => {
  it('is percentile_cont over created_at − occurred_at in milliseconds', async () => {
    const lag = await getDeliveryLag(resolvePeriod('all', undefined, SNAPSHOT));
    // Lags up to the snapshot: 0 (June), 100, 300, 500, 900 ms.
    expect(lag).toEqual({ p50: 300, p95: 820, samples: 5 });
  });

  it('is present in every aggregating command', async () => {
    const commands = [
      ['overview'],
      ['compressor'],
      ['tools'],
      ['events'],
      ['funnel'],
      ['onboarding'],
      ['updates'],
      ['errors'],
      ['friction'],
      ['features'],
      ['cohorts'],
      ['retention'],
      ['team-workspace'],
      ['connection'],
      ['audit'],
      ['journey', 'alice@example.com']
    ];
    for (const argv of commands) {
      const result = await executeCommand(
        parseArgs([...argv, '--period', 'all', '--as-of', SNAPSHOT])
      );
      const lag = (result.data as { delivery_lag_ms?: DeliveryLag }).delivery_lag_ms;
      expect(lag, argv[0]).toEqual({ p50: 300, p95: 820, samples: 5 });
      expect(result.human, argv[0]).toContain('Delivery lag');
    }
  });

  it('is null with no samples instead of failing', async () => {
    const lag = await getDeliveryLag({
      token: 'none',
      start: '2000-01-01T00:00:00.000Z',
      end: '2000-01-02T00:00:00.000Z',
      label: 'empty'
    });
    expect(lag).toEqual({ p50: null, p95: null, samples: 0 });
  });
});

describe('journey', () => {
  it('defaults to a 30-day window ending at as_of and honours --period all', async () => {
    const bounded = await executeCommand(
      parseArgs(['journey', 'alice@example.com', '--as-of', SNAPSHOT])
    );
    expect(bounded.period.token).toBe('30d');
    expect((bounded.data as JourneyData).events.map(row => row.event_name)).toEqual([
      'home_viewed',
      'compression_completed',
      'compression_started',
      'tool_opened'
    ]);
    const all = await executeCommand(
      parseArgs(['journey', 'alice@example.com', '--period', 'all', '--as-of', SNAPSHOT])
    );
    expect((all.data as JourneyData).events).toHaveLength(5);
    // Without a period the query function itself stays unbounded.
    expect(await getJourney('alice@example.com')).toHaveLength(6);
  });

  it('sanitizes properties through the client allowlist', async () => {
    const events = await getJourney('alice@example.com');
    const completed = events.find(row => row.event_name === 'compression_completed');
    expect(completed?.properties).toEqual({
      run_id: RUN,
      total_input_bytes: 10,
      total_output_bytes: 5
    });
    expect(JSON.stringify(events)).not.toMatch(/secret\.mp4|Bearer/);
  });
});
