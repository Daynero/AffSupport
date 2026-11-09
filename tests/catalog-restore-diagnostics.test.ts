// @vitest-environment jsdom
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { analytics, ProductAnalytics } from '../apps/web/src/analytics/service';
import { beginWorkspaceOperation } from '../apps/web/src/team/workspace/operationAnalytics';
import { assertReadOnlySql, setQueryExecutor } from '../scripts/analytics/db';
import { getWorkspaceEvidence } from '../scripts/analytics/workspace';
import { getInspect } from '../scripts/analytics/queries';
import { getInvestigation } from '../scripts/analytics/investigate';
import { resolvePeriod } from '../scripts/analytics/periods';
import { investigateOutputIsPrivate } from '../scripts/analytics/types';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
const OWNER = '47000000-0000-4000-8000-000000000093';
let db: TeamTestDb, team: string;
let serial: Promise<unknown> = Promise.resolve();
function execute<T>(work: () => Promise<T>): Promise<T> {
  const next = serial.then(work);
  serial = next.catch(() => {});
  return next;
}
beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: OWNER, email: 'restore-diagnostic@example.invalid' });
  await db.root('insert into public.admin_users(user_id) values($1)', [OWNER]);
  team = (
    await db.asUser<{ id: string }>(
      OWNER,
      "select id from public.create_team('Restore diagnostics')"
    )
  )[0]!.id;
  await db.root('create role restore_diagnostic_reader bypassrls');
  await db.root('grant usage on schema public to restore_diagnostic_reader');
  await db.root('grant select on all tables in schema public to restore_diagnostic_reader');
  setQueryExecutor((sql, params) =>
    execute(async () => {
      assertReadOnlySql(sql);
      await db.db.exec('begin read only; set local role restore_diagnostic_reader');
      try {
        const result = await db.db.query(sql, params);
        await db.db.exec('commit');
        return result.rows as Record<string, unknown>[];
      } catch (cause) {
        await db.db.exec('rollback');
        throw cause;
      }
    })
  );
}, 180000);
afterAll(async () => {
  vi.restoreAllMocks();
  setQueryExecutor(null);
  await serial;
  await db?.close();
});
it('preserves unknown restore through sanitizer, ingestion and SELECT-only CLI until hosted confirmation and visible delivery', async () => {
  const operation = crypto.randomUUID(),
    key = crypto.randomUUID();
  await db.root(
    `insert into public.team_operations
 (id,team_id,actor_id,kind,state,idempotency_key,request_nonce,error_code)
 values($1::uuid,$2::uuid,$3::uuid,'restore','running',$4,$4,'PROCESS_RESULT_UNCERTAIN')`,
    [operation, team, OWNER, key]
  );
  const ingested: Array<{ event_id: string; accepted: boolean }> = [];
  const service = new ProductAnalytics(
    events =>
      execute(async () => {
        const rows = await db.asUser<{ event_id: string; accepted: boolean }>(
          OWNER,
          'select * from public.ingest_analytics_events($1::jsonb)',
          [JSON.stringify(events)]
        );
        ingested.push(...rows);
        return { acceptedEventIds: rows.filter(row => row.accepted).map(row => row.event_id) };
      }),
    null
  );
  service.setUser(OWNER);
  const track = vi.spyOn(analytics, 'track').mockImplementation(service.track.bind(service));
  const actor = vi
    .spyOn(analytics, 'journalContext')
    .mockImplementation(service.journalContext.bind(service));
  try {
    const flow = beginWorkspaceOperation('restore', key, 1);
    flow.stage('running');
    flow.receipt(operation);
    flow.diagnostic('restore_request', { code: 'PROCESS_RESULT_UNCERTAIN' });
    flow.stage('unknown', 'PROCESS_RESULT_UNCERTAIN');
    flow.visibleResult('unknown', 'PROCESS_RESULT_UNCERTAIN');
    await service.flush();
    expect(ingested.length).toBeGreaterThan(4);
    expect(ingested.every(row => row.accepted)).toBe(true);
    const detail = await getInspect(key);
    expect(detail.found && detail.capability).toBe('team.workspace_restore');
    expect(detail.found && detail.terminal).toBeNull();
    const asOf = new Date(Date.now() + 60000).toISOString();
    const evidence = await getWorkspaceEvidence(OWNER, null, asOf);
    expect(evidence.operations).toContainEqual(
      expect.objectContaining({
        id: operation,
        action: 'restore',
        state: 'running',
        code: 'PROCESS_RESULT_UNCERTAIN',
        confirmed_count: 0
      })
    );
    const investigation = await getInvestigation(OWNER, resolvePeriod('7d', undefined, asOf));
    expect(
      investigation.findings.some(finding => finding.evidence.includes('workspace:' + operation))
    ).toBe(true);
    expect(investigateOutputIsPrivate(investigation)).toBe(true);
    const sources = await db.root<{ source: string }>(
      `select properties->>'source_kind' source from public.analytics_events where flow_id=$1::uuid and properties->>'action_identifier'='diagnostic'`,
      [key]
    );
    expect(sources).toEqual([{ source: 'restore_request' }]);
    await db.root(
      "update public.team_operations set state='succeeded',error_code=null,progress=100,finished_at=now(),updated_at=now() where id=$1",
      [operation]
    );
    flow.stage('confirmed');
    flow.visibleResult('success');
    await service.flush();
    const complete = await getInspect(key);
    expect(complete.found && complete.terminal?.event).toBe('operation_completed');
    expect(
      (await getWorkspaceEvidence(OWNER, null, new Date(Date.now() + 60000).toISOString()))
        .operations
    ).toContainEqual(
      expect.objectContaining({
        id: operation,
        action: 'restore',
        state: 'confirmed',
        confirmed_count: 1
      })
    );
    expect(JSON.stringify({ detail, evidence })).not.toMatch(/restore-diagnostic@|https?:|Fixture/);
  } finally {
    track.mockRestore();
    actor.mockRestore();
  }
});
