// @vitest-environment jsdom
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  ProductAnalytics,
  startTeamFileAttempt,
  completeTeamFileAttempt,
  type PendingAnalyticsEvent
} from '../apps/web/src/analytics/service.js';
import { getInspect } from '../scripts/analytics/queries.js';
import { getCatalogRenameEvidence } from '../scripts/analytics/catalog-renames.js';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite.js';
import { batchUuid } from './fixtures/launch-batches.js';
let db: AnalyticsTestDb;
const asOf = '2026-11-13T12:00:00Z';
const actor = batchUuid(2),
  team = batchUuid(3),
  material = batchUuid(4);
beforeAll(async () => {
  db = await createAnalyticsDb();
  await db.exec(
    await readFile('supabase/migrations/20261207190000_agent_native_identity_analytics.sql', 'utf8')
  );
  await db.exec(`create table public.analytics_catalog_renames (
    request_key uuid,team_id uuid,actor_id uuid,material_id uuid,operation_id uuid,
    state text,error_code text,origin text,created_at timestamptz,updated_at timestamptz,
    confirmed_at timestamptz,dispatched boolean,attempt_count integer,next_attempt_at timestamptz
  )`);
}, 30000);
afterAll(async () => {
  await db?.close();
});
async function receipt(
  key: string,
  {
    state = 'confirmed',
    updated = '2026-11-13T11:00:00Z',
    code = null,
    origin = 'provider_intent',
    target = material
  }: {
    state?: string;
    updated?: string;
    code?: string | null;
    origin?: string;
    target?: string;
  } = {}
) {
  await db.db.query(
    `insert into public.analytics_catalog_renames values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,null)`,
    [
      key,
      team,
      actor,
      target,
      origin === 'absent_command' ? null : batchUuid(5),
      state,
      code,
      origin,
      '2026-11-13T10:00:00Z',
      updated,
      state === 'confirmed' ? updated : null,
      origin !== 'absent_command',
      origin === 'absent_command' ? 0 : 1
    ]
  );
}
async function observations(flowId: string, outcome: 'success' | 'failure' = 'success') {
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
        `insert into public.analytics_events(user_id,event_name,flow_id,attempt_id,properties,outcome,occurred_at,created_at) values($1,$2,$3,$4,$5,$6,$7,$7)`,
        [
          event.user_id,
          event.event_name,
          event.flow_id,
          event.attempt_id,
          JSON.stringify(event.properties),
          event.outcome,
          new Date(Date.parse(asOf) - 60000 + delivered.length * 1000).toISOString()
        ]
      );
    }
    return { acceptedEventIds: events.map(event => event.event_id) };
  }, null);
  service.setUser(actor);
  const first = startTeamFileAttempt(
    {
      flowId,
      action: 'rename',
      surface: 'catalog_manager',
      storageKind: 'unknown',
      sizeBucket: 'tiny'
    },
    { tracker: service }
  );
  const resumed = startTeamFileAttempt(
    { flowId, action: 'rename', surface: 'material', storageKind: 'unknown', sizeBucket: 'tiny' },
    { tracker: service }
  );
  completeTeamFileAttempt(resumed, { outcome, retryable: false }, { tracker: service });
  await service.flush();
  return { delivered, first, resumed };
}
it('links distinct browser observations to one stable request through producer, ingest guard and read-only inspect', async () => {
  const key = batchUuid(930);
  await receipt(key);
  const { delivered, first, resumed } = await observations(key);
  expect(first.attemptId).not.toBe(resumed.attemptId);
  expect(delivered).toHaveLength(3);
  expect(delivered.every(event => event.flow_id === key)).toBe(true);
  expect(delivered.at(-1)?.attempt_id).toBe(resumed.attemptId);
  expect(JSON.stringify(delivered)).not.toMatch(
    /catalogName|newName|boundNames|impactVersion|ETag|https:\/\//
  );
  const inspected = await getInspect(key, asOf);
  expect(inspected.found).toBe(true);
  if (!inspected.found) throw Error('missing evidence');
  expect(inspected.catalog_renames?.records[0]).toMatchObject({
    request_key: key,
    state: 'confirmed'
  });
  expect(inspected.events).toHaveLength(3);
  expect(inspected.terminal?.outcome).toBe('success');
});
it('finds confirmed provider work when the browser closed without claiming visible delivery', async () => {
  const key = batchUuid(931);
  await receipt(key);
  const inspected = await getInspect(key, asOf);
  if (!inspected.found) throw Error('missing authoritative receipt');
  expect(inspected.events).toEqual([]);
  expect(inspected.terminal).toBeNull();
  expect(inspected.stages.observed).toContain('provider_confirmed');
  expect(inspected.stages.missing).toContain('result_visible');
  expect(inspected.catalog_renames?.records[0].state).toBe('confirmed');
});
it('distinguishes an absent-command tombstone from a failed provider intent', async () => {
  const key = batchUuid(932);
  await receipt(key, { state: 'failed', code: 'NOT_FOUND', origin: 'absent_command' });
  const result = await getCatalogRenameEvidence(key, asOf);
  expect(result.records[0]).toMatchObject({
    state: 'failed',
    error_code: 'NOT_FOUND',
    origin: 'absent_command',
    operation_id: null,
    attempt_count: 0,
    dispatched: false
  });
});
it('does not project current outcomes backward before their proven update time', async () => {
  const key = batchUuid(933);
  await receipt(key, { updated: '2026-11-13T13:00:00Z' });
  const result = await getCatalogRenameEvidence(key, asOf);
  expect(result.records[0]).toMatchObject({
    state: 'unknown',
    snapshot_at_as_of: 'unknown',
    confirmed_at: null,
    operation_id: null,
    dispatched: null,
    attempt_count: null
  });
  expect(result.blind_spots.join(' ')).toContain('earlier outcome is unknown');
});
it('bounds material lookup and maps unexpected error text to UNKNOWN without content leakage', async () => {
  const target = batchUuid(934);
  await db.db.query(
    `insert into public.analytics_catalog_renames select gen_random_uuid(),$1,$2,$3,null,'failed','private-provider-message','provider_intent','2026-11-13T10:00:00Z','2026-11-13T11:00:00Z',null,false,0,null from generate_series(1,101)`,
    [team, actor, target]
  );
  const result = await getCatalogRenameEvidence(target, asOf);
  expect(result.records).toHaveLength(100);
  expect(result.truncated).toBe(true);
  expect(result.records.every(row => row.error_code === 'UNKNOWN')).toBe(true);
  expect(JSON.stringify(result)).not.toContain('private-provider-message');
});
it('drops malformed diagnostic rows without returning their payloads', async () => {
  const key = batchUuid(935);
  await receipt(key, { state: 'provider-secret-name' });
  const result = await getCatalogRenameEvidence(key, asOf);
  expect(result.records).toEqual([]);
  expect(result.invalid_record_count).toBe(1);
  expect(JSON.stringify(result)).not.toContain('provider-secret-name');
});
it('rejects non-UUID flow correlation before it reaches the existing event seam', async () => {
  const { delivered, first } = await observations('private catalog name');
  expect(first.flowId).toBeUndefined();
  expect(delivered).toHaveLength(3);
  expect(delivered.every(event => event.flow_id === null)).toBe(true);
  expect(JSON.stringify(delivered)).not.toContain('private catalog name');
});
