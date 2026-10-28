import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
vi.mock('../apps/web/src/analytics/service', () => ({ analytics: { track: vi.fn() } }));
import { beginCatalogUiFlow } from '../apps/web/src/team/catalog-updater/analytics';
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

it('exposes the produced server refusal through the read-only agent diagnosis', async () => {
  const track = vi.fn();
  const flow = beginCatalogUiFlow('profile', { field: 'updateInterval' }, { track });
  flow.stage('save_requested');
  flow.fail('PERMISSION_DENIED');
  for (const [event, properties] of track.mock.calls) {
    await db.db.query(
      'insert into public.analytics_events(user_id,event_name,flow_id,attempt_id,properties,error_code,occurred_at,created_at) values($1,$2,$3::uuid,$3::text,$4,$5,$6,$6)',
      [
        USER,
        event,
        flow.id,
        JSON.stringify(properties),
        properties.error_code ?? null,
        '2026-10-01T11:00:00Z'
      ]
    );
  }
  const result = await getInspect(flow.id);
  expect(result.found).toBe(true);
  if (!result.found) throw new Error('Expected rejected schedule evidence');
  expect(result.capability).toBe('team.catalog_manager_profile');
  expect(result.terminal?.event).toBe('operation_failed');
  expect(result.events.at(-1)?.properties).toMatchObject({
    error_code: 'PERMISSION_DENIED',
    action_identifier: 'save_requested'
  });
});

it('keeps a settings read failure distinct from an empty successfully displayed editor', async () => {
  const track = vi.fn();
  const flow = beginCatalogUiFlow('template', {}, { track });
  flow.stage('readback_requested');
  flow.fail('READ_FAILED');
  for (const [event, properties] of track.mock.calls) {
    await db.db.query(
      'insert into public.analytics_events(user_id,event_name,flow_id,attempt_id,properties,error_code,occurred_at,created_at) values($1,$2,$3::uuid,$3::text,$4,$5,$6,$6)',
      [
        USER,
        event,
        flow.id,
        JSON.stringify(properties),
        properties.error_code ?? null,
        '2026-10-01T12:00:00Z'
      ]
    );
  }
  const result = await getInspect(flow.id);
  expect(result.found).toBe(true);
  if (!result.found) throw new Error('Expected settings read evidence');
  expect(result.capability).toBe('team.catalog_manager_template');
  expect(result.terminal?.event).toBe('operation_failed');
  expect(result.events.at(-1)?.properties.error_code).toBe('READ_FAILED');
  expect(result.events.some(event => event.event_name === 'operation_completed')).toBe(false);
});
