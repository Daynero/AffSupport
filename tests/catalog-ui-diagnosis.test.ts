import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
import { getInspect } from '../scripts/analytics/queries';
let db: AnalyticsTestDb;
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FLOW = '30000000-0000-4000-8000-000000000040';
beforeAll(async () => {
  db = await createAnalyticsDb();
  await db.exec(`insert into public.analytics_events
    (user_id,event_name,flow_id,attempt_id,properties,occurred_at,created_at) values
    ('${USER}','operation_started','${FLOW}','${FLOW}','{"flow_step":"catalog_manager_profile","action_identifier":"opened"}','2026-10-01T10:00:00Z','2026-10-01T10:00:00Z'),
    ('${USER}','operation_stage_completed','${FLOW}','${FLOW}','{"flow_step":"catalog_manager_profile","action_identifier":"save_confirmed"}','2026-10-01T10:00:01Z','2026-10-01T10:00:01Z');`);
}, 30000);
afterAll(async () => {
  await db.close();
});
describe('catalog UI read-only diagnosis', () => {
  it('does not mistake a confirmed mutation for a delivered UI result', async () => {
    const result = await getInspect(FLOW);
    expect(result.found).toBe(true);
    if (!result.found) throw new Error('Expected catalog UI evidence');
    expect(result.capability).toBe('team.catalog_manager_profile');
    expect(result.terminal).toBeNull();
    expect(result.stages.missing).toContain('terminal');
    expect(result.events.at(-1)?.properties.action_identifier).toBe('save_confirmed');
  });
  it('recognizes actual visible result after its delayed signal arrives', async () => {
    await db.exec(`insert into public.analytics_events
      (user_id,event_name,flow_id,attempt_id,properties,occurred_at,created_at) values
      ('${USER}','operation_completed','${FLOW}','${FLOW}','{"flow_step":"catalog_manager_profile","action_identifier":"result_visible"}','2026-10-01T10:00:02Z','2026-10-01T10:05:00Z');`);
    const result = await getInspect(FLOW);
    expect(result.found).toBe(true);
    if (!result.found) throw new Error('Expected catalog UI evidence');
    expect(result.terminal?.event).toBe('operation_completed');
    expect(result.delivery_lag_ms.p95).toBeGreaterThan(1000);
  });
});
