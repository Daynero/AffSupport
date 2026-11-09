// @vitest-environment jsdom
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { analytics, ProductAnalytics } from '../apps/web/src/analytics/service';
import { beginCatalogUiFlow } from '../apps/web/src/team/catalog-updater/analytics';
import { getCatalogStopEvidence } from '../scripts/analytics/catalog-stops';
import { getInspect } from '../scripts/analytics/queries';
import { getInvestigation } from '../scripts/analytics/investigate';
import { investigateOutputIsPrivate } from '../scripts/analytics/types';
import { resolvePeriod } from '../scripts/analytics/periods';
import { assertReadOnlySql, setQueryExecutor } from '../scripts/analytics/db';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
const OWNER = '47000000-0000-4000-8000-000000000091';
let db: TeamTestDb;
let serial: Promise<unknown> = Promise.resolve();
function execute<T>(work: () => Promise<T>): Promise<T> {
  const next = serial.then(work);
  serial = next.catch(() => {});
  return next;
}
beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: OWNER, email: 'catalog-stop@example.invalid' });
  await db.root('insert into public.admin_users(user_id) values($1)', [OWNER]);
  await db.root('create role catalog_stop_reader bypassrls');
  await db.root('grant usage on schema public to catalog_stop_reader');
  await db.root('grant select on all tables in schema public to catalog_stop_reader');
  setQueryExecutor((sql, params) =>
    execute(async () => {
      assertReadOnlySql(sql);
      await db.db.exec('begin read only; set local role catalog_stop_reader');
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
}, 180_000);
afterAll(async () => {
  vi.restoreAllMocks();
  setQueryExecutor(null);
  await db?.close();
});
async function fixture() {
  const team = (
    await db.asUser<{ id: string }>(OWNER, 'select id from public.create_team($1)', [
      'Stop fixture'
    ])
  )[0]!.id;
  const credential = (
    await db.root<{ id: string }>(
      `insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by)
 values($1,'fixture@catalog-stop.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$2) returning id`,
      [crypto.randomUUID(), OWNER]
    )
  )[0]!.id;
  const connection = (
    await db.root<{ id: string }>(
      `insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at)
 values($1,$2,'root','Root','my_drive','connected',now()) returning id`,
      [team, credential]
    )
  )[0]!.id;
  const video = crypto.randomUUID(),
    catalog = crypto.randomUUID();
  for (const [id, isVideo] of [
    [video, true],
    [catalog, false]
  ] as const)
    await db.root(
      `insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type)
  values($1::uuid,$2,$3,$1::uuid::text,'root','Synthetic fixture','file',$4,$5)`,
      [
        id,
        team,
        connection,
        isVideo ? 'video' : 'other',
        isVideo ? 'video/mp4' : 'application/vnd.google-apps.spreadsheet'
      ]
    );
  await db.root('select public.service_link_product_catalog_companion($1,$2,$3,null,$4)', [
    team,
    video,
    catalog,
    JSON.stringify({
      sourceLink: 'https://offer.example.invalid/',
      productCount: 3,
      sheetUrl: `https://docs.google.com/spreadsheets/d/${catalog}/edit`,
      videoLink: 'https://drive.google.com/file/d/fixture/view',
      createdBy: OWNER,
      settingsSnapshot: {
        title: 'Fixture',
        description: 'Fixture',
        price: 1,
        imageLink: 'https://image.example.invalid/a.png'
      }
    })
  ]);
  await db.asUser(OWNER, 'select public.request_team_catalog_update_command($1,$2,$3,$4,null)', [
    team,
    crypto.randomUUID(),
    [catalog],
    OWNER
  ]);
  const round = (
    await db.root<{ at: string; attempt_id: string }>(
      `select i.round_due_at::text at,a.attempt_id::text from public.team_catalog_updater_items i
 join public.team_catalog_update_attempts a on a.catalog_material_id=i.catalog_material_id and a.round_due_at=i.round_due_at where i.catalog_material_id=$1`,
      [catalog]
    )
  )[0]!;
  return { team, catalog, round };
}
it('passes the actual Stop producer through sanitizer, SQL ingestion and SELECT-only diagnosis without replacing the update terminal', async () => {
  const { team, catalog, round } = await fixture();
  const ingested: Array<{ accepted: boolean }> = [];
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
    const flow = beginCatalogUiFlow('stop', { count: 1, relatedFlowId: round.attempt_id });
    flow.stage('stop_requested');
    const result = await db.asUser<{ value: boolean }>(
      OWNER,
      'select public.cancel_team_catalog_update_attempt_as_actor($1,$2,$3,$4,$5) value',
      [team, catalog, round.at, round.attempt_id, OWNER]
    );
    expect(result[0]?.value).toBe(true);
    flow.stage('stop_accepted');
    flow.stage('stop_readback_requested');
    flow.stage('stop_target_inactive');
    flow.complete();
    await service.flush();
    expect(ingested.every(row => row.accepted)).toBe(true);
    expect(ingested.length).toBeGreaterThan(4);
    const observed = await getInspect(flow.id);
    expect(observed.found && observed.capability).toBe('team.catalog_manager_stop');
    expect(observed.found && observed.terminal?.event).toBe('operation_completed');
    expect(observed.catalog_stops).toMatchObject({ ui_available: true, unavailable_sources: [] });
    expect(observed.catalog_stops?.flows[0]).toMatchObject({
      flow_id: flow.id,
      target_attempt_id: round.attempt_id,
      browser_reported_reply: 'accepted',
      visible_result_observed: true,
      target: { result: 'cancelled' }
    });
    const eventId = observed.catalog_stops?.flows[0]?.stages[0]?.event_id;
    expect(eventId).toEqual(expect.any(String));
    const target = await getInspect(round.attempt_id);
    expect(target.catalog_stops?.flows[0]?.flow_id).toBe(flow.id);
    expect(target.found && target.terminal?.event).not.toBe('operation_completed');
    expect(JSON.stringify(observed.catalog_stops)).not.toMatch(/https?:|example.invalid|fixture@/);
    expect(observed.catalog_stops?.blind_spots.join(' ')).toContain(
      'not a durable server Stop receipt'
    );
    expect((await getCatalogStopEvidence(flow.id, '2000-01-01T00:00:00Z')).flows).toEqual([]);
  } finally {
    track.mockRestore();
    actor.mockRestore();
  }
});

function producer(target: string, origin?: string) {
  const service = new ProductAnalytics(
    events =>
      execute(async () => {
        const rows = await db.asUser<{ event_id: string; accepted: boolean }>(
          OWNER,
          'select * from public.ingest_analytics_events($1::jsonb)',
          [JSON.stringify(events)]
        );
        expect(rows.every(row => row.accepted)).toBe(true);
        return { acceptedEventIds: rows.filter(row => row.accepted).map(row => row.event_id) };
      }),
    null
  );
  service.setUser(OWNER);
  const track = vi.spyOn(analytics, 'track').mockImplementation(service.track.bind(service));
  const actor = vi
    .spyOn(analytics, 'journalContext')
    .mockImplementation(service.journalContext.bind(service));
  const flow = beginCatalogUiFlow('stop', {
    count: 1,
    relatedFlowId: target,
    originFlowId: origin
  });
  return {
    service,
    flow,
    restore: () => {
      track.mockRestore();
      actor.mockRestore();
    }
  };
}
it('discovers read-only Check by its original request and actor without inventing another Stop acknowledgement', async () => {
  const request = crypto.randomUUID(),
    target = crypto.randomUUID();
  const p = producer(target, request);
  try {
    p.flow.stage('stop_check_requested');
    p.flow.stage('stop_readback_requested');
    p.flow.stage('stop_readback_unknown', 'READ_FAILED');
    p.flow.fail('READ_FAILED', 'result_visible');
    await p.service.flush();
    const evidence = await getCatalogStopEvidence(request);
    expect(evidence.flows).toHaveLength(1);
    expect(evidence.flows[0]).toMatchObject({
      flow_id: p.flow.id,
      origin_flow_id: request,
      target_attempt_id: target,
      request_observed: false,
      check_observed: true,
      browser_reported_reply: 'unobserved',
      target: null
    });
    expect(
      (await getCatalogStopEvidence(OWNER, undefined, 50, OWNER)).flows.some(
        flow => flow.flow_id === p.flow.id
      )
    ).toBe(true);
    const other = crypto.randomUUID();
    expect((await getCatalogStopEvidence(other, undefined, 50, other)).flows).toEqual([]);
  } finally {
    p.restore();
  }
});
it('keeps conflicting browser target relations unresolved instead of attaching a convenient target', async () => {
  const p = producer(crypto.randomUUID());
  try {
    p.flow.stage('stop_requested');
    p.service.track('operation_stage_completed', {
      flow_id: p.flow.id,
      attempt_id: p.flow.id,
      parent_flow_id: crypto.randomUUID(),
      feature_identifier: 'catalog_manager',
      flow_step: 'catalog_manager_stop',
      action_identifier: 'stop_accepted',
      production_completed: false
    });
    await p.service.flush();
    expect((await getCatalogStopEvidence(p.flow.id)).flows[0]).toMatchObject({
      correlation: 'conflicting',
      target_attempt_id: null,
      target: null
    });
  } finally {
    p.restore();
  }
});
it('does not backdate late browser delivery into a fixed as-of window', async () => {
  const p = producer(crypto.randomUUID());
  try {
    p.flow.stage('stop_requested');
    p.flow.stage('stop_reply_unknown', 'TEAM_TRANSPORT_UNAVAILABLE');
    p.flow.fail('PROCESS_RESULT_UNCERTAIN', 'result_visible');
    await p.service.flush();
    await execute(() =>
      db.root(
        'update public.analytics_events set occurred_at=$2::timestamptz,created_at=$3::timestamptz where flow_id=$1::uuid',
        [p.flow.id, '2026-11-05T11:59:59Z', '2026-11-05T12:00:01Z']
      )
    );
    const before = await getCatalogStopEvidence(p.flow.id, '2026-11-05T12:00:00Z');
    expect(before.flows).toEqual([]);
    expect(before.blind_spots.join(' ')).toContain(
      'Missing or delayed browser evidence is unknown'
    );
    expect(
      (await getCatalogStopEvidence(p.flow.id, '2026-11-05T12:00:02Z')).flows[0]
    ).toMatchObject({
      browser_reported_reply: 'unknown',
      visible_result_observed: true,
      target: null
    });
  } finally {
    p.restore();
  }
});
it('reports an unavailable target projection without converting UI feedback into server proof', async () => {
  const p = producer(crypto.randomUUID());
  try {
    p.flow.stage('stop_requested');
    p.flow.stage('stop_accepted');
    p.flow.stage('stop_target_inactive');
    p.flow.complete();
    await p.service.flush();
    await execute(() =>
      db.root('revoke select on public.analytics_catalog_updates from catalog_stop_reader')
    );
    try {
      const evidence = await getCatalogStopEvidence(p.flow.id);
      expect(evidence).toMatchObject({ ui_available: true, target_available: false });
      expect(evidence.unavailable_sources).toContain('target:projection_unavailable');
      expect(evidence.flows[0]).toMatchObject({ ui_terminal: 'operation_completed', target: null });
    } finally {
      await execute(() =>
        db.root('grant select on public.analytics_catalog_updates to catalog_stop_reader')
      );
    }
  } finally {
    p.restore();
  }
});

it('returns a ranked privacy-safe uncertainty finding anchored to actual ingested Stop events', async () => {
  const p = producer(crypto.randomUUID());
  try {
    p.flow.stage('stop_requested');
    p.flow.stage('stop_reply_unknown', 'TEAM_TRANSPORT_UNAVAILABLE');
    p.flow.stage('stop_readback_unknown', 'READ_FAILED');
    p.flow.fail('READ_FAILED', 'result_visible');
    await p.service.flush();
    const period = resolvePeriod('7d', undefined, new Date(Date.now() + 60_000).toISOString());
    const investigation = await getInvestigation('catalog-stop@example.invalid', period);
    expect(investigateOutputIsPrivate(investigation)).toBe(true);
    const finding = investigation.findings.find(
      item => item.rule === 'catalog_stop_unconfirmed' && item.next_step.includes(p.flow.id)
    );
    expect(finding).toMatchObject({
      kind: 'fact',
      severity: 'medium',
      fingerprint: 'catalog:stop:READ_FAILED'
    });
    expect(finding?.evidence.every(value => /^event:/.test(value))).toBe(true);
    expect(finding?.code_locations[0]?.files).toContain(
      'apps/web/src/team/catalog-updater/CatalogUpdaterDialog.tsx'
    );
  } finally {
    p.restore();
  }
});
