// @vitest-environment jsdom
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  analytics,
  ProductAnalytics,
  type PendingAnalyticsEvent
} from '../apps/web/src/analytics/service.js';
import { observeBackgroundSetup } from '../apps/web/src/team/catalog-updater/backgroundSetupAnalytics.js';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite.js';
import { getInspect } from '../scripts/analytics/queries.js';
import { sanitizeEventProperties } from '../scripts/analytics/sanitize.js';
import { batchUuid } from './fixtures/launch-batches.js';
let db: AnalyticsTestDb;
const asOf = '2026-11-13T12:00:00Z';
beforeAll(async () => {
  db = await createAnalyticsDb();
  await db.exec(
    await readFile('supabase/migrations/20261201124000_launch_analytics_guard.sql', 'utf8')
  );
}, 30000);
afterAll(async () => {
  await db?.close();
});
async function deliver(
  flowId: string,
  stages: Array<{
    stage: 'ownership' | 'enroll' | 'delegate' | 'confirm' | 'ready';
    outcome: 'started' | 'succeeded' | 'failed' | 'canceled';
    errorCode?: string;
  }>
) {
  const delivered: PendingAnalyticsEvent[] = [];
  const service = new ProductAnalytics(async events => {
    for (const event of events) {
      const safe = await db.db.query<{ ok: boolean }>(
        'select public.analytics_properties_are_safe_v2($1::jsonb) as ok',
        [JSON.stringify(event.properties)]
      );
      expect(safe.rows[0]?.ok).toBe(true);
      delivered.push(event);
      await db.db.query(
        `insert into public.analytics_events(user_id,event_name,flow_id,properties,outcome,occurred_at,created_at) values($1,$2,$3,$4,$5,$6,$6)`,
        [
          event.user_id,
          event.event_name,
          event.flow_id,
          JSON.stringify(event.properties),
          event.outcome,
          new Date(Date.parse(asOf) - 60000 + delivered.length * 1000).toISOString()
        ]
      );
    }
    return { acceptedEventIds: events.map(event => event.event_id) };
  }, null);
  service.setUser(batchUuid(2));
  const spy = vi
    .spyOn(analytics, 'track')
    .mockImplementation((event, properties) => service.track(event, properties));
  try {
    for (const stage of stages) observeBackgroundSetup({ flowId, ...stage });
    await service.flush();
  } finally {
    spy.mockRestore();
  }
  return delivered;
}
it('reconstructs a failed confirmation through actual producer, ingest guard and read-only inspect without claiming ready', async () => {
  const flow = batchUuid(910);
  await deliver(flow, [
    { stage: 'ownership', outcome: 'started' },
    { stage: 'ownership', outcome: 'succeeded' },
    { stage: 'enroll', outcome: 'started' },
    { stage: 'enroll', outcome: 'succeeded' },
    { stage: 'delegate', outcome: 'succeeded' },
    { stage: 'confirm', outcome: 'started' },
    { stage: 'confirm', outcome: 'failed', errorCode: 'DRIVE_UNAVAILABLE' }
  ]);
  const result = await getInspect(flow, asOf);
  expect(result.found).toBe(true);
  if (!result.found) throw Error('missing evidence');
  expect(result.capability).toBe('team.background_setup');
  expect(result.last_proven_stage).toBe('confirm_failed');
  expect(result.stages.missing).toEqual(['confirm', 'ready']);
  expect(result.terminal?.outcome).toBe('failure');
  expect(result.events.at(-1)?.properties.error_code).toBe('DRIVE_UNAVAILABLE');
});
it('keeps missing final confirmation explicit; intermediate completion is not a terminal setup', async () => {
  const flow = batchUuid(911);
  await deliver(flow, [
    { stage: 'ownership', outcome: 'started' },
    { stage: 'ownership', outcome: 'succeeded' },
    { stage: 'enroll', outcome: 'succeeded' }
  ]);
  const result = await getInspect(flow, asOf);
  if (!result.found) throw Error('missing evidence');
  expect(result.terminal).toBeNull();
  expect(result.last_proven_stage).toBe('enroll_confirmed');
  expect(result.stages.missing).toContain('ready');
});
it('recognizes already-ready protected ownership without inventing a fresh enrollment', async () => {
  const flow = batchUuid(912);
  await deliver(flow, [
    { stage: 'ownership', outcome: 'started' },
    { stage: 'ownership', outcome: 'succeeded' },
    { stage: 'ready', outcome: 'succeeded' }
  ]);
  const result = await getInspect(flow, asOf);
  if (!result.found) throw Error('missing evidence');
  expect(result.stages.expected).toEqual(['ownership', 'ready']);
  expect(result.stages.missing).toEqual([]);
  expect(result.terminal?.outcome).toBe('success');
  expect(result.agent.note).toContain('separate');
});
it('replaces arbitrary provider/error text with UNKNOWN before delivery', async () => {
  const flow = batchUuid(913);
  const events = await deliver(flow, [
    { stage: 'confirm', outcome: 'failed', errorCode: 'secret /private/path token=bad' }
  ]);
  expect(events).toHaveLength(1);
  expect(events[0].properties.error_code).toBe('UNKNOWN');
  expect(JSON.stringify(sanitizeEventProperties(events[0].properties))).not.toContain('secret');
});
