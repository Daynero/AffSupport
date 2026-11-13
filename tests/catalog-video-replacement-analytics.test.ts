// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import { ProductAnalytics } from '../apps/web/src/analytics/service';
import { beginCatalogUiFlow } from '../apps/web/src/team/catalog-updater/analytics';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
import { getCatalogVideoReplacementEvidence } from '../scripts/analytics/catalog-video-replacements';
import { getInspect } from '../scripts/analytics/queries';
import { assertReadOnlySql, setQueryExecutor } from '../scripts/analytics/db';
import { createTeamTestDb, createUser } from './support/team-db';
let db: AnalyticsTestDb;
const key = 'cf540000-0000-4000-8000-000000000010';
beforeAll(async () => {
  db = await createAnalyticsDb();
  await db.exec(
    await readFile('supabase/migrations/20261207190000_agent_native_identity_analytics.sql', 'utf8')
  );
  await db.exec(
    await readFile(
      'supabase/migrations/20261208122000_automatic_catalog_analytics_guard.sql',
      'utf8'
    )
  );
  await db.exec(
    `create table public.analytics_catalog_video_replacements(request_id uuid,team_id uuid,actor_id uuid,catalog_material_id uuid,publication_job_id uuid,state text,error_code text,move_to_video_folder boolean,move_dispatched boolean,created_at timestamptz,updated_at timestamptz);insert into public.analytics_catalog_video_replacements values('${key}','cf540000-0000-4000-8000-000000000002','cf540000-0000-4000-8000-000000000001','cf540000-0000-4000-8000-000000000003',null,'confirmed',null,true,true,'2026-11-13T10:00Z','2026-11-13T11:00Z');`
  );
}, 30000);
afterAll(async () => db?.close());
it('finds server-confirmed replacements without claiming browser delivery', async () => {
  const result = await getInspect(key, '2026-11-13T12:00Z');
  expect(result.found).toBe(true);
  expect(result.catalog_video_replacements?.records[0]?.state).toBe('confirmed');
  if (result.found) {
    expect(result.terminal).toBeNull();
    expect(result.stages.missing).toContain('result_visible');
  }
});

it('does not reconstruct an earlier outcome from a later mutable receipt', async () => {
  const result = await getCatalogVideoReplacementEvidence(key, '2026-11-13T10:30Z');
  expect(result.records[0]?.state).toBe('unknown');
  expect(JSON.stringify(result)).not.toMatch(/https?:|fileName|credential|parent_id/);
});

it('carries the real producer through privacy validation, stored events and CLI inspection', async () => {
  const key2 = 'cf540000-0000-4000-8000-000000000011';
  const service = new ProductAnalytics(async events => {
    for (const event of events) {
      const checked = await db.db.query<{ ok: boolean }>(
        'select public.analytics_properties_are_safe_v2($1::jsonb)ok',
        [JSON.stringify(event.properties)]
      );
      expect(checked.rows[0]?.ok).toBe(true);
      await db.db.query(
        'insert into public.analytics_events(user_id,event_name,flow_id,attempt_id,properties,outcome,occurred_at,created_at)values($1,$2,$3,$4,$5::jsonb,$6,now(),now())',
        [
          event.user_id,
          event.event_name,
          event.flow_id,
          event.attempt_id,
          JSON.stringify(event.properties),
          event.outcome
        ]
      );
    }
    return { acceptedEventIds: events.map(e => e.event_id) };
  }, null);
  service.setUser('cf540000-0000-4000-8000-000000000001');
  const flow = beginCatalogUiFlow('replace_video', { parentFlowId: key2, count: 1 }, service);
  flow.stage('save_requested');
  flow.stage('save_confirmed');
  await service.flush();
  const pending = await getInspect(key2);
  if (pending.found) expect(pending.terminal).toBeNull();
  else throw Error('Missing start');
  flow.complete();
  await service.flush();
  const complete = await getInspect(key2);
  expect(complete.found).toBe(true);
  if (complete.found) {
    expect(complete.capability).toBe('team.catalog_manager_replace_video');
    expect(complete.last_proven_stage).toBeTruthy();
  }
});

it('reaches diagnosis through real ingestion and the migration-owned SELECT-only role', async () => {
  const live = await createTeamTestDb();
  let serial: Promise<unknown> = Promise.resolve();
  const actor = 'cf540000-0000-4000-8000-000000000001';
  const request = 'cf540000-0000-4000-8000-000000000012';
  try {
    await createUser(live, { id: actor, email: 'replacement-diagnosis@example.invalid' });
    setQueryExecutor((sql, params) => {
      const next = serial.then(async () => {
        assertReadOnlySql(sql);
        await live.db.exec('begin read only; set local role wishly_analytics_ro');
        try {
          const result = await live.db.query(sql, params);
          await live.db.exec('commit');
          return result.rows as Record<string, unknown>[];
        } catch (error) {
          await live.db.exec('rollback');
          throw error;
        }
      });
      serial = next.catch(() => {});
      return next;
    });
    const service = new ProductAnalytics(async events => {
      const rows = await live.asUser<{ event_id: string; accepted: boolean }>(
        actor,
        'select * from public.ingest_analytics_events($1::jsonb)',
        [JSON.stringify(events)]
      );
      expect(rows.length).toBe(events.length);
      expect(rows.every(row => row.accepted)).toBe(true);
      return { acceptedEventIds: rows.filter(row => row.accepted).map(row => row.event_id) };
    }, null);
    service.setUser(actor);
    const flow = beginCatalogUiFlow('replace_video', { parentFlowId: request, count: 1 }, service);
    flow.stage('save_requested');
    flow.stage('save_confirmed');
    flow.complete();
    await service.flush();
    const detail = await getInspect(request);
    expect(detail.found && detail.capability).toBe('team.catalog_manager_replace_video');
    expect(detail.found && detail.terminal?.event).toBe('operation_completed');
    expect(detail.catalog_video_replacements?.supported).toBe(true);
  } finally {
    await serial;
    setQueryExecutor(null);
    await live.close();
  }
}, 30000);
