// @vitest-environment jsdom
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import {
  ProductAnalytics,
  startTeamFileAttempt,
  completeTeamFileAttempt
} from '../apps/web/src/analytics/service';
import { trackToolError } from '../apps/web/src/analytics/errors';
import { getInspect } from '../scripts/analytics/queries';
import { assertReadOnlySql, setQueryExecutor } from '../scripts/analytics/db';
import { lookupCodeLocations } from '../scripts/analytics/code-map';
const USER = '47000000-0000-4000-8000-000000000001';
let db: TeamTestDb;
let chain: Promise<unknown> = Promise.resolve();
beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: USER, email: 'synthetic-catalog@example.invalid' });
  await db.root('create role catalog_diagnostics_reader bypassrls');
  await db.root('grant usage on schema public to catalog_diagnostics_reader');
  await db.root('grant select on all tables in schema public to catalog_diagnostics_reader');
  setQueryExecutor((sql, params) => {
    assertReadOnlySql(sql);
    const read = chain.then(async () => {
      await db.db.exec('begin read only; set local role catalog_diagnostics_reader');
      try {
        const result = await db.db.query(sql, params);
        await db.db.exec('commit');
        return result.rows as Record<string, unknown>[];
      } catch (cause) {
        await db.db.exec('rollback');
        throw cause;
      }
    });
    chain = read.catch(() => undefined);
    return read;
  });
}, 30000);
afterAll(async () => {
  setQueryExecutor(null);
  await db.close();
});

it('delivers typed file production, browser handoff and exact export cause through real ingestion to read-only inspect', async () => {
  const ingestions: Array<{ event_id: string; accepted: boolean; reason: string }> = [];
  const service = new ProductAnalytics(async events => {
    const rows = await db.asUser<{ event_id: string; accepted: boolean; reason: string }>(
      USER,
      'select * from public.ingest_analytics_events($1::jsonb)',
      [JSON.stringify(events)]
    );
    ingestions.push(...rows);
    return { acceptedEventIds: rows.filter(row => row.accepted).map(row => row.event_id) };
  }, null);
  service.setUser(USER);
  const browser = startTeamFileAttempt(
    { action: 'download', storageKind: 'unknown', surface: 'catalog_manager', sizeBucket: 'tiny' },
    { tracker: service }
  );
  completeTeamFileAttempt(
    browser,
    { outcome: 'success', retryable: false, delivery: 'browser_handoff' },
    { tracker: service }
  );
  const native = startTeamFileAttempt(
    { action: 'download', storageKind: 'shared_drive', surface: 'material', sizeBucket: 'tiny' },
    { tracker: service }
  );
  completeTeamFileAttempt(
    native,
    { outcome: 'success', retryable: false, delivery: 'agent_saved' },
    { tracker: service }
  );
  const failure = startTeamFileAttempt(
    {
      action: 'download',
      storageKind: 'shared_drive',
      surface: 'catalog_manager',
      sizeBucket: 'tiny'
    },
    { tracker: service }
  );
  trackToolError(
    {
      tool: 'team',
      stage: 'download',
      code: 'CATALOG_EXPORT_TOO_LARGE',
      attemptId: failure.attemptId,
      retryable: false
    },
    service
  );
  completeTeamFileAttempt(failure, { outcome: 'failure', retryable: false }, { tracker: service });
  await service.flush();
  expect(ingestions).toHaveLength(7);
  expect(
    ingestions.every(row => row.accepted),
    JSON.stringify(ingestions)
  ).toBe(true);
  const asOf = new Date(Date.now() + 1000).toISOString();
  const browserInspect = await getInspect(browser.attemptId, asOf);
  const nativeInspect = await getInspect(native.attemptId, asOf);
  const failedInspect = await getInspect(failure.attemptId, asOf);
  expect(
    browserInspect.found &&
      browserInspect.events.find(row => row.event_name === 'team_file_attempt_completed')
        ?.properties
  ).toMatchObject({
    file_surface: 'catalog_manager',
    file_delivery: 'browser_handoff',
    production_completed: false
  });
  expect(
    nativeInspect.found &&
      nativeInspect.events.find(row => row.event_name === 'team_file_attempt_completed')?.properties
  ).toMatchObject({ file_delivery: 'agent_saved', production_completed: true });
  expect(
    failedInspect.found &&
      failedInspect.events.some(row => row.properties.error_code === 'CATALOG_EXPORT_TOO_LARGE')
  ).toBe(true);
  expect(lookupCodeLocations('team:download:CATALOG_EXPORT_TOO_LARGE')?.matched).toBe(
    'team:download:CATALOG_EXPORT_TOO_LARGE'
  );
  expect(JSON.stringify([browserInspect, nativeInspect, failedInspect])).not.toContain(
    'synthetic-catalog@example.invalid'
  );
});
