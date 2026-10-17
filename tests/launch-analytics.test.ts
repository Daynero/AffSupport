// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
import { getInspect, getAudit } from '../scripts/analytics/queries';
import { getLaunchEvidence, getLaunchAudit } from '../scripts/analytics/launches';
import { sanitizeEventProperties } from '../scripts/analytics/sanitize';
import { sanitizeTeamAnalyticsProperties } from '../packages/shared/src/team/analytics';
import {
  launchIntent,
  launchAction,
  launchVisible,
  launchObservedGeneration
} from '../apps/web/src/team/launches/analytics';
import type { LaunchGeneration } from '../packages/shared/src/team/launches';
import { ProductAnalytics, type PendingAnalyticsEvent } from '../apps/web/src/analytics/service';
import { resolvePeriod } from '../scripts/analytics/periods';
import { getInvestigation } from '../scripts/analytics/investigate';
const GENERATION = '78000000-0000-4000-8000-000000000001',
  LAUNCH = '78000000-0000-4000-8000-000000000002',
  REVISION = '78000000-0000-4000-8000-000000000003',
  ACTOR = '78000000-0000-4000-8000-000000000004',
  FLOW = '78000000-0000-4000-8000-000000000005';
const ASOF = '2026-10-12T18:00:00Z';
let db: AnalyticsTestDb;
beforeAll(async () => {
  db = await createAnalyticsDb();
  await db.exec(
    await readFile('supabase/migrations/20261201124000_launch_analytics_guard.sql', 'utf8')
  );
  await db.exec(`create table public.analytics_launch_generations(generation_id uuid,launch_id uuid,revision_id uuid,actor_id uuid,team_id uuid,flow_id text,attempt_no integer,state text,stage text,method text,safe_error_code text,created_at timestamptz,updated_at timestamptz,lease_expires_at timestamptz,next_attempt_at timestamptz,result_is_active boolean,catalog_registered boolean,steps jsonb);
 insert into public.analytics_launch_generations values('${GENERATION}','${LAUNCH}','${REVISION}','${ACTOR}',gen_random_uuid(),'${FLOW}',2,'succeeded','result_committed','other',null,'2026-10-12T10:00:00Z','2026-10-12T10:00:01Z',null,null,true,false,'[]');`);
}, 30_000);
afterAll(async () => {
  await db?.close();
});
describe('Launch diagnostic contract', () => {
  it('recovers a persisted generation even when no browser lifecycle or visible event arrived', async () => {
    const result = await getInspect(GENERATION, ASOF);
    expect(result.found).toBe(true);
    if (!result.found) throw new Error('fixture');
    expect(result.capability).toBe('team.launches');
    expect(result.events).toEqual([]);
    expect(result.terminal?.event).toBe('database:launch_succeeded');
    expect(result.terminal?.occurred_at).toBe('2026-10-12T10:00:01.000Z');
    expect(result.first_seen_at).toBe('2026-10-12T10:00:00.000Z');
    expect(result.last_seen_at).toBe('2026-10-12T10:00:01.000Z');
    expect(result.launches?.generations[0].created_at).toBe('2026-10-12T10:00:00.000Z');
    expect(result.last_proven_stage).toBe('result_committed');
    expect(result.launches?.generations[0].result_is_active).toBe(true);
    expect(result.launches?.generations[0].attempt_no).toBe(2);
    expect(result.launches?.blind_spots.join(' ')).toContain('visibility');
  });
  it('does not present current database state as evidence before that state existed', async () => {
    const result = await getLaunchEvidence(GENERATION, '2026-10-12T10:00:00.500Z');
    expect(result.generations).toEqual([]);
    expect(result.blind_spots.join(' ')).toContain('historical');
  });
  it('does not attribute an old generation to a newer investigation window', async () => {
    const result = await getLaunchEvidence(GENERATION, ASOF, '2026-10-13T00:00:00Z');
    expect(result.generations).toEqual([]);
  });
  it('audit distinguishes persisted success from missing browser visibility', async () => {
    const period = resolvePeriod('today', undefined, ASOF);
    const audit = await getAudit(period);
    const launch = audit.capabilities.find(c => c.id === 'team.launches');
    expect(launch?.status).toBe('partial');
    expect(launch?.missing).toContain('browser_result_visible');
    expect(launch?.unobservable.join(' ')).toContain(
      'Browser storage can reject analytics enqueue'
    );
  });
  it('the typed producers and CLI reject user content and unknown enum values', () => {
    const secret = 'SYNTHETIC_CAPI_SECRET';
    const value = sanitizeTeamAnalyticsProperties({
      flow_id: FLOW,
      run_id: GENERATION,
      revision_id: REVISION,
      launch_action: 'generate',
      launch_stage: 'catalog_creating',
      originalUrl: `https://example.invalid?token=${secret}`,
      creativeAlias: secret,
      launch_code: secret
    });
    expect(value).toEqual({
      flow_id: FLOW,
      run_id: GENERATION,
      revision_id: REVISION,
      launch_action: 'generate',
      launch_stage: 'catalog_creating'
    });
    expect(sanitizeEventProperties({ ...value, originalUrl: secret, launch_code: secret })).toEqual(
      value
    );
    const tracker = { track: vi.fn() };
    launchIntent({ flowId: FLOW, launchId: LAUNCH }, 'other', tracker);
    launchAction({ generationId: GENERATION }, 'generate', 'failure', secret, undefined, tracker);
    expect(JSON.stringify(tracker.track.mock.calls)).not.toContain(secret);
    expect(tracker.track.mock.calls[1][1].launch_code).toBe('UNKNOWN');
  });
  it('the database guard rejects a raw URL even with valid Launch identifiers', async () => {
    const result = await db.db.query<{ ok: boolean }>(
      'select public.analytics_properties_are_safe_v2($1::jsonb) as ok',
      [JSON.stringify({ revision_id: REVISION, originalUrl: 'https://example.invalid/?token=x' })]
    );
    expect(result.rows[0]?.ok).toBe(false);
  });
  it('preserves actionable dependency reasons without recording SUB values', () => {
    const tracker = { track: vi.fn() };
    launchAction(
      { generationId: GENERATION },
      'retry',
      'blocked',
      'AGENT_REQUIRED',
      undefined,
      tracker
    );
    expect(tracker.track.mock.calls[0][1].launch_code).toBe('AGENT_REQUIRED');
    expect(
      sanitizeTeamAnalyticsProperties({ launch_field: 'sub1', value: 'private_buyer' })
    ).toEqual({ launch_field: 'sub1' });
    expect(sanitizeEventProperties({ launch_code: 'RESTITCH_NO_SCREENS' })).toEqual({
      launch_code: 'RESTITCH_NO_SCREENS'
    });
  });
  it('sends the producing generation with a visible generated revision', () => {
    const tracker = { track: vi.fn() };
    launchVisible({ launchId: LAUNCH, revisionId: REVISION, generationId: GENERATION }, tracker);
    expect(tracker.track).toHaveBeenCalledWith('team_launch_visible', {
      flow_id: undefined,
      workflow_id: LAUNCH,
      run_id: GENERATION,
      revision_id: REVISION,
      outcome: 'success'
    });
  });
  it('observes unsettled child cleanup as a stage, not a terminal cancellation', () => {
    const tracker = { track: vi.fn() };
    const generation = {
      id: GENERATION,
      state: 'canceled_with_cleanup_pending',
      stage: 'cleanup',
      stateVersion: '7',
      progress: null,
      errorCode: 'LAUNCH_RESULT_UNCERTAIN',
      childOperationIds: []
    } satisfies LaunchGeneration;
    launchObservedGeneration({ launchId: LAUNCH, generationId: GENERATION }, generation, tracker);
    expect(tracker.track).toHaveBeenCalledOnce();
    expect(tracker.track).toHaveBeenCalledWith(
      'team_launch_stage',
      expect.objectContaining({ run_id: GENERATION, launch_state: 'canceled_with_cleanup_pending' })
    );
    tracker.track.mockClear();
    launchObservedGeneration(
      { launchId: LAUNCH, generationId: GENERATION },
      { ...generation, state: 'canceled' },
      tracker
    );
    expect(tracker.track).toHaveBeenCalledWith(
      'team_launch_terminal',
      expect.objectContaining({ run_id: GENERATION, outcome: 'cancelled' })
    );
  });
  it('removes the visibility blind spot only after a correlated browser receipt', async () => {
    const delivered: PendingAnalyticsEvent[] = [];
    const service = new ProductAnalytics(async events => {
      for (const event of events) {
        const guard = await db.db.query<{ ok: boolean }>(
          'select public.analytics_properties_are_safe_v2($1::jsonb) as ok',
          [JSON.stringify(event.properties)]
        );
        expect(guard.rows[0]?.ok).toBe(true);
        delivered.push(event);
        await db.db.query(
          `insert into public.analytics_events
           (user_id,event_name,run_id,properties,occurred_at,created_at)
           values($1,$2,$3,$4,'2026-10-12T10:00:02Z','2026-10-12T10:00:02Z')`,
          [event.user_id, event.event_name, event.run_id, JSON.stringify(event.properties)]
        );
      }
      return { acceptedEventIds: events.map(event => event.event_id) };
    }, null);
    service.setUser(ACTOR);
    launchVisible({ launchId: LAUNCH, revisionId: REVISION, generationId: GENERATION }, service);
    await service.flush();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      event_name: 'team_launch_visible',
      run_id: GENERATION,
      properties: { revision_id: REVISION }
    });
    expect(service.pendingCount()).toBe(0);
    const result = await getInspect(GENERATION, ASOF);
    expect(result.found).toBe(true);
    if (!result.found) throw new Error('fixture');
    expect(result.events.some(event => event.event_name === 'team_launch_visible')).toBe(true);
    expect(result.launches?.blind_spots.join(' ')).not.toContain('visibility');
  });
});

it('correlates a mutation with its request key and never records provider exception text or output', async () => {
  const { launchMutation } = await import('../apps/web/src/team/launches/analytics');
  const tracker = { track: vi.fn() };
  const secret = 'SYNTHETIC_SECRET_MUTATION';
  const result = { url: `https://example.invalid?token=${secret}` };
  expect(
    await launchMutation(
      { flowId: FLOW, launchId: LAUNCH },
      'save_draft',
      async () => result,
      tracker
    )
  ).toBe(result);
  const failure = Object.assign(new Error(secret), { code: secret });
  await expect(
    launchMutation(
      { flowId: FLOW, launchId: LAUNCH },
      'save_draft',
      async () => {
        throw failure;
      },
      tracker
    )
  ).rejects.toBe(failure);
  expect(tracker.track.mock.calls.map(call => call[0])).toEqual([
    'team_launch_intent',
    'team_launch_action',
    'team_launch_intent',
    'team_launch_action'
  ]);
  expect(tracker.track.mock.calls[3][1]).toMatchObject({
    flow_id: FLOW,
    outcome: 'failure',
    launch_code: 'UNKNOWN'
  });
  expect(JSON.stringify(tracker.track.mock.calls)).not.toContain(secret);
});

it('keeps a committed Launch action successful when analytics storage rejects writes', async () => {
  const { launchAction, launchMutation } = await import('../apps/web/src/team/launches/analytics');
  const tracker = {
    track: vi.fn(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    })
  };
  const receipt = { id: LAUNCH, version: '2' };
  const execute = vi.fn().mockResolvedValue(receipt);
  expect(
    await launchMutation({ flowId: FLOW, launchId: LAUNCH }, 'copy_launch', execute, tracker)
  ).toBe(receipt);
  expect(execute).toHaveBeenCalledOnce();
  expect(() =>
    launchAction(
      { launchId: LAUNCH },
      'copy_field',
      'success',
      undefined,
      'advertising_url',
      tracker
    )
  ).not.toThrow();
  const failure = new Error('authoritative failure');
  await expect(
    launchMutation(
      { flowId: FLOW, launchId: LAUNCH },
      'copy_launch',
      async () => {
        throw failure;
      },
      tracker
    )
  ).rejects.toBe(failure);
});

it('records historical restore intent and outcome using identifiers only', async () => {
  const { launchMutation } = await import('../apps/web/src/team/launches/analytics');
  const tracker = { track: vi.fn() };
  const secret = 'SYNTHETIC_RESTORED_URL_SECRET';
  const historical = { originalUrl: `https://example.invalid/?token=${secret}` };
  expect(
    await launchMutation(
      { flowId: FLOW, launchId: LAUNCH, revisionId: REVISION },
      'restore_config',
      async () => historical,
      tracker
    )
  ).toBe(historical);
  expect(tracker.track.mock.calls).toEqual([
    [
      'team_launch_intent',
      expect.objectContaining({
        flow_id: FLOW,
        revision_id: REVISION,
        launch_action: 'restore_config'
      })
    ],
    [
      'team_launch_action',
      expect.objectContaining({
        flow_id: FLOW,
        revision_id: REVISION,
        launch_action: 'restore_config',
        outcome: 'success'
      })
    ]
  ]);
  expect(JSON.stringify(tracker.track.mock.calls)).not.toContain(secret);
});

it('audit names a failed generation without a cause while cancellation stays separate', async () => {
  const failed = '78000000-0000-4000-8000-000000000006';
  const canceled = '78000000-0000-4000-8000-000000000007';
  await db.exec(`insert into public.analytics_launch_generations
    (generation_id,launch_id,revision_id,actor_id,team_id,flow_id,attempt_no,state,stage,method,safe_error_code,created_at,updated_at,result_is_active,catalog_registered,steps)
    values
    ('${failed}','${LAUNCH}','${REVISION}','${ACTOR}',gen_random_uuid(),'${FLOW}',3,'failed','catalog_creating','catalog',null,'2026-10-12T11:00:00Z','2026-10-12T11:00:01Z',false,false,'[]'),
    ('${canceled}','${LAUNCH}','${REVISION}','${ACTOR}',gen_random_uuid(),'${FLOW}',4,'canceled','cancel','catalog',null,'2026-10-12T12:00:00Z','2026-10-12T12:00:01Z',false,false,'[]')`);
  const inspected = await getInspect(failed, ASOF);
  if (!inspected.found) throw new Error('failed Launch fixture missing');
  expect(inspected.terminal?.event).toBe('database:launch_failed');
  expect(inspected.terminal?.outcome).toBe('failure');
  await db.exec(`insert into public.analytics_events(user_id,event_name,run_id,properties,occurred_at,created_at)
    values('${ACTOR}','team_launch_terminal','${failed}','{"outcome":"success"}','2026-10-12T11:00:02Z','2026-10-12T11:00:02Z')`);
  const conflicting = await getInspect(failed, ASOF);
  if (!conflicting.found) throw new Error('failed Launch fixture missing after client signal');
  expect(conflicting.events.some(event => event.event_name === 'team_launch_terminal')).toBe(true);
  expect(conflicting.terminal).toMatchObject({
    event: 'database:launch_failed',
    outcome: 'failure'
  });
  const audit = await getAudit(resolvePeriod('today', undefined, ASOF));
  const launch = audit.capabilities.find(c => c.id === 'team.launches');
  expect(launch?.status).toBe('partial');
  expect(launch?.missing).toContain('known_failure_code');
  const canceledOnly = await getLaunchEvidence(canceled, ASOF);
  expect(canceledOnly.generations[0].safe_error_code).toBeNull();
  const canceledInspect = await getInspect(canceled, ASOF);
  if (!canceledInspect.found) throw new Error('canceled Launch fixture missing');
  expect(canceledInspect.terminal?.outcome).toBe('cancelled');
  expect((await getLaunchAudit('2026-10-12T11:30:00Z', ASOF))?.unknown_causes).toBe(0);
});

it('keeps delivery unknown until a delayed browser receipt actually reaches analytics', async () => {
  const generation = '78000000-0000-4000-8000-000000000008';
  const revision = '78000000-0000-4000-8000-000000000009';
  await db.exec(`insert into public.analytics_launch_generations
    (generation_id,launch_id,revision_id,actor_id,team_id,flow_id,attempt_no,state,stage,method,safe_error_code,created_at,updated_at,result_is_active,catalog_registered,steps)
    values('${generation}','${LAUNCH}','${revision}','${ACTOR}',gen_random_uuid(),'${FLOW}',5,'succeeded','result_committed','other',null,'2026-10-12T13:00:00Z','2026-10-12T13:00:01Z',true,false,'[]');
    insert into public.analytics_events(user_id,event_name,run_id,properties,occurred_at,created_at)
    values('${ACTOR}','team_launch_visible','${generation}','{"revision_id":"${revision}"}','2026-10-12T13:00:02Z','2026-10-12T19:00:00Z')`);
  const before = await getInspect(generation, ASOF);
  if (!before.found) throw new Error('Launch fixture missing before visibility');
  expect(before.launches?.blind_spots.join(' ')).toContain('visibility');
  expect((await getLaunchAudit('2026-10-12T12:30:00Z', ASOF))?.missing_visibility).toBe(1);
  const after = await getInspect(generation, '2026-10-12T20:00:00Z');
  if (!after.found) throw new Error('Launch fixture missing after visibility');
  expect(after.launches?.blind_spots.join(' ')).not.toContain('visibility');
});

it('keeps an uncertain canceled child unsettled instead of reporting cancellation as complete', async () => {
  const generation = '78000000-0000-4000-8000-000000000014';
  const child = '78000000-0000-4000-8000-000000000015';
  await db.exec(`insert into public.analytics_launch_generations
    (generation_id,launch_id,revision_id,actor_id,team_id,flow_id,attempt_no,state,stage,method,safe_error_code,created_at,updated_at,result_is_active,catalog_registered,steps)
    values('${generation}','${LAUNCH}','${REVISION}','${ACTOR}',gen_random_uuid(),'${FLOW}',9,'canceled_with_cleanup_pending','cleanup','catalog','LAUNCH_RESULT_UNCERTAIN','2026-10-12T13:30:00Z','2026-10-12T13:30:01Z',false,false,
    '[{"stage":"cleanup","state":"running","child_operation_id":"${child}","created_at":"2026-10-12T13:30:00Z","updated_at":"2026-10-12T13:30:01Z"}]')`);
  await db.exec(`insert into public.analytics_events(user_id,event_name,run_id,properties,occurred_at,created_at)
    values('${ACTOR}','team_launch_terminal','${generation}','{"outcome":"success"}','2026-10-12T13:30:02Z','2026-10-12T13:30:02Z')`);
  const inspected = await getInspect(generation, ASOF);
  if (!inspected.found) throw new Error('uncertain Launch fixture missing');
  expect(inspected.terminal).toBeNull();
  expect(inspected.last_proven_stage).toBe('cleanup');
  expect(inspected.launches?.generations[0]).toMatchObject({
    state: 'canceled_with_cleanup_pending',
    safe_error_code: 'LAUNCH_RESULT_UNCERTAIN',
    steps: [{ child_operation_id: child, state: 'running' }]
  });
  expect(inspected.launches?.blind_spots.join(' ')).toContain('unsettled');
  expect((await getLaunchAudit('2026-10-12T13:29:00Z', ASOF))?.unsettled).toBe(1);
  await db.exec(`insert into public.analytics_users(id,email,email_normalized)
    values('${ACTOR}','launch-fixture@example.invalid','launch-fixture@example.invalid')
    on conflict(id) do nothing`);
  const investigation = await getInvestigation(ACTOR, resolvePeriod('today', undefined, ASOF));
  expect(
    investigation.coverage.blind_spots.find(spot => spot.kind === 'launch_settlement_unknown')
      ?.values
  ).toContain(generation);
  expect(
    investigation.findings.find(finding =>
      finding.evidence.includes(`launch-generation:${generation}`)
    )
  ).toMatchObject({
    kind: 'insufficient',
    fingerprint: 'launches:generation:LAUNCH_RESULT_UNCERTAIN'
  });
});

it('does not borrow a visible receipt from a different generation of the same revision', async () => {
  const generation = '78000000-0000-4000-8000-000000000010';
  const revision = '78000000-0000-4000-8000-000000000011';
  await db.exec(`insert into public.analytics_launch_generations
    (generation_id,launch_id,revision_id,actor_id,team_id,flow_id,attempt_no,state,stage,method,safe_error_code,created_at,updated_at,result_is_active,catalog_registered,steps)
    values('${generation}','${LAUNCH}','${revision}','${ACTOR}',gen_random_uuid(),'${FLOW}',6,'succeeded','result_committed','other',null,'2026-10-12T15:00:00Z','2026-10-12T15:00:01Z',true,false,'[]');
    insert into public.analytics_events(user_id,event_name,run_id,properties,occurred_at,created_at)
    values('${ACTOR}','team_launch_visible','${GENERATION}','{"revision_id":"${revision}"}','2026-10-12T15:00:02Z','2026-10-12T15:00:02Z')`);
  expect((await getLaunchAudit('2026-10-12T14:30:00Z', ASOF))?.missing_visibility).toBe(1);
  const inspectedBefore = await getInspect(generation, ASOF);
  if (!inspectedBefore.found) throw new Error('Launch fixture missing before visibility');
  expect(inspectedBefore.launches?.blind_spots.join(' ')).toContain('visibility');
  const byRevisionBefore = await getInspect(revision, ASOF);
  if (!byRevisionBefore.found) throw new Error('Launch revision fixture missing');
  expect(byRevisionBefore.events.some(event => event.event_name === 'team_launch_visible')).toBe(
    true
  );
  expect(byRevisionBefore.launches?.blind_spots.join(' ')).toContain('visibility');
  await db.exec(`insert into public.analytics_users(id,email,email_normalized)
    values('${ACTOR}','launch-fixture@example.invalid','launch-fixture@example.invalid')
    on conflict(id) do nothing`);
  const before = await getInvestigation(ACTOR, resolvePeriod('today', undefined, ASOF));
  expect(
    before.coverage.blind_spots.find(spot => spot.kind === 'launch_visibility_unknown')?.values
  ).toContain(generation);
  await db.exec(`insert into public.analytics_events(user_id,event_name,run_id,properties,occurred_at,created_at)
    values('${ACTOR}','team_launch_visible','${generation}','{"revision_id":"${revision}"}','2026-10-12T15:00:03Z','2026-10-12T15:00:03Z')`);
  expect((await getLaunchAudit('2026-10-12T14:30:00Z', ASOF))?.missing_visibility).toBe(0);
  const inspectedAfter = await getInspect(generation, ASOF);
  if (!inspectedAfter.found) throw new Error('Launch fixture missing after visibility');
  expect(inspectedAfter.launches?.blind_spots.join(' ')).not.toContain('visibility');
  const byRevisionAfter = await getInspect(revision, ASOF);
  if (!byRevisionAfter.found) throw new Error('Launch revision fixture missing after visibility');
  expect(byRevisionAfter.launches?.blind_spots.join(' ')).not.toContain('visibility');
  const after = await getInvestigation(ACTOR, resolvePeriod('today', undefined, ASOF));
  expect(
    after.coverage.blind_spots.find(spot => spot.kind === 'launch_visibility_unknown')?.values
  ).not.toContain(generation);
});

it('does not return an unexpected diagnostic view value as user content', async () => {
  const generation = '78000000-0000-4000-8000-000000000012';
  const secret = 'SYNTHETIC_PRIVATE_VIEW_VALUE';
  await db.exec(`insert into public.analytics_launch_generations
    (generation_id,launch_id,revision_id,actor_id,team_id,flow_id,attempt_no,state,stage,method,safe_error_code,created_at,updated_at,result_is_active,catalog_registered,steps)
    values('${generation}','${LAUNCH}','${REVISION}','${ACTOR}',gen_random_uuid(),'${secret}',7,'${secret}','${secret}','${secret}','${secret}','2026-10-12T16:00:00Z','2026-10-12T16:00:01Z',false,false,
    '[{"stage":"${secret}","state":"${secret}","child_operation_id":"${secret}","created_at":"${secret}","updated_at":"${secret}"}]')`);
  const evidence = await getLaunchEvidence(generation, ASOF);
  expect(JSON.stringify(evidence)).not.toContain(secret);
  expect(evidence.generations[0]).toMatchObject({
    flow_id: null,
    state: 'unknown',
    stage: 'unknown',
    method: 'unknown',
    safe_error_code: 'UNKNOWN',
    steps: [
      {
        stage: 'unknown',
        state: 'unknown',
        child_operation_id: null,
        created_at: 'unknown',
        updated_at: 'unknown'
      }
    ]
  });
  expect(evidence.blind_spots.join(' ')).toContain('unexpected');
  expect(JSON.stringify(await getInspect(generation, ASOF))).not.toContain(secret);
});

it('bounds diagnostic step history and reports omitted evidence', async () => {
  const generation = '78000000-0000-4000-8000-000000000013';
  const step = {
    stage: 'catalog_creating',
    state: 'running',
    child_operation_id: null,
    created_at: '2026-10-12T17:00:00Z',
    updated_at: '2026-10-12T17:00:01Z'
  };
  const steps = JSON.stringify(Array.from({ length: 51 }, () => step));
  await db.exec(`insert into public.analytics_launch_generations
    (generation_id,launch_id,revision_id,actor_id,team_id,flow_id,attempt_no,state,stage,method,safe_error_code,created_at,updated_at,result_is_active,catalog_registered,steps)
    values('${generation}','${LAUNCH}','${REVISION}','${ACTOR}',gen_random_uuid(),'${FLOW}',8,'running','catalog_creating','catalog',null,'2026-10-12T17:00:00Z','2026-10-12T17:00:01Z',false,false,'${steps}'::jsonb)`);
  const evidence = await getLaunchEvidence(generation, ASOF);
  expect(evidence.generations[0].steps).toHaveLength(50);
  expect(evidence.blind_spots.join(' ')).toContain('truncated');
});

it('investigation distinguishes a known Launch failure from a missing cause', async () => {
  const known = '78000000-0000-4000-8000-000000000016';
  const unknown = '78000000-0000-4000-8000-000000000017';
  await db.exec(`insert into public.analytics_users(id,email,email_normalized)
    values('${ACTOR}','launch-fixture@example.invalid','launch-fixture@example.invalid')
    on conflict(id) do nothing;
    insert into public.analytics_launch_generations
    (generation_id,launch_id,revision_id,actor_id,team_id,flow_id,attempt_no,state,stage,method,safe_error_code,created_at,updated_at,result_is_active,catalog_registered,steps)
    values
    ('${known}','${LAUNCH}','${REVISION}','${ACTOR}',gen_random_uuid(),'${FLOW}',10,'failed','catalog_creating','catalog','LAUNCH_BUSY','2026-10-12T17:30:00Z','2026-10-12T17:30:01Z',false,false,'[]'),
    ('${unknown}','${LAUNCH}','${REVISION}','${ACTOR}',gen_random_uuid(),'${FLOW}',11,'failed','catalog_creating','catalog',null,'2026-10-12T17:31:00Z','2026-10-12T17:31:01Z',false,false,'[]')`);
  const investigation = await getInvestigation(ACTOR, resolvePeriod('today', undefined, ASOF));
  expect(
    investigation.findings.find(finding => finding.evidence.includes(`launch-generation:${known}`))
  ).toMatchObject({ kind: 'fact', fingerprint: 'launches:generation:LAUNCH_BUSY' });
  expect(
    investigation.findings.find(finding =>
      finding.evidence.includes(`launch-generation:${unknown}`)
    )
  ).toMatchObject({ kind: 'insufficient' });
});

it('keeps partial and interrupted generations distinct through inspect, audit and investigate', async () => {
  const partial = '78000000-0000-4000-8000-000000000018';
  const interrupted = '78000000-0000-4000-8000-000000000019';
  await db.exec(`insert into public.analytics_users(id,email,email_normalized)
    values('${ACTOR}','launch-fixture@example.invalid','launch-fixture@example.invalid')
    on conflict(id) do nothing;
    insert into public.analytics_launch_generations
    (generation_id,launch_id,revision_id,actor_id,team_id,flow_id,attempt_no,state,stage,method,safe_error_code,created_at,updated_at,result_is_active,catalog_registered,steps)
    values
    ('${partial}','${LAUNCH}','${REVISION}','${ACTOR}',gen_random_uuid(),'${FLOW}',12,'partial','catalog_registering','catalog','LAUNCH_RESULT_UNCERTAIN','2026-10-12T17:35:00Z','2026-10-12T17:35:01Z',false,false,'[]'),
    ('${interrupted}','${LAUNCH}','${REVISION}','${ACTOR}',gen_random_uuid(),'${FLOW}',13,'interrupted','catalog_sharing','catalog',null,'2026-10-12T17:36:00Z','2026-10-12T17:36:01Z',false,false,'[]')`);
  const partialInspect = await getInspect(partial, ASOF);
  const interruptedInspect = await getInspect(interrupted, ASOF);
  expect(partialInspect.found).toBe(true);
  expect(interruptedInspect.found).toBe(true);
  if (!partialInspect.found || !interruptedInspect.found)
    throw new Error('Launch fixtures missing');
  expect(partialInspect.terminal).toMatchObject({
    event: 'database:launch_partial',
    outcome: 'failure'
  });
  expect(partialInspect.last_proven_stage).toBe('catalog_registering');
  expect(interruptedInspect.terminal).toMatchObject({
    event: 'database:launch_interrupted',
    outcome: 'failure'
  });
  expect(interruptedInspect.last_proven_stage).toBe('catalog_sharing');
  const audit = await getLaunchAudit('2026-10-12T17:34:00Z', ASOF);
  expect(audit).toMatchObject({ generations: 2, unknown_causes: 1 });
  const investigation = await getInvestigation(ACTOR, resolvePeriod('today', undefined, ASOF));
  expect(
    investigation.findings.find(f => f.evidence.includes(`launch-generation:${partial}`))
  ).toMatchObject({ kind: 'fact', fingerprint: 'launches:generation:LAUNCH_RESULT_UNCERTAIN' });
  expect(
    investigation.findings.find(f => f.evidence.includes(`launch-generation:${interrupted}`))
  ).toMatchObject({ kind: 'insufficient' });
});

it('keeps reuse provenance unknown on older diagnostic schemas', async () => {
  const result = await getLaunchEvidence(GENERATION, ASOF);
  expect(result.generations[0].reuse_evidence).toBeNull();
  expect(result.blind_spots.join(' ')).toContain('Reuse provenance is unavailable');
});

it('exposes only opaque reuse receipts and rejects malformed provenance', async () => {
  await db.exec('begin');
  try {
    await db.exec(
      'alter table public.analytics_launch_generations add column reuse_evidence jsonb'
    );
    const receipt = {
      video_operation_id: FLOW,
      video_generation_id: GENERATION,
      catalog_revision_id: REVISION
    };
    await db.db.query(
      'update public.analytics_launch_generations set reuse_evidence=$1 where generation_id=$2',
      [JSON.stringify({ ...receipt, provider_payload: 'secret' }), GENERATION]
    );
    const inspected = await getInspect(GENERATION, ASOF);
    if (!inspected.found) throw new Error('fixture');
    expect(inspected.launches?.generations[0].reuse_evidence).toEqual(receipt);
    expect(JSON.stringify(inspected)).not.toContain('secret');
    await db.db.query(
      'update public.analytics_launch_generations set reuse_evidence=$1 where generation_id=$2',
      [
        JSON.stringify({ ...receipt, video_operation_id: 'https://example.invalid/?token=secret' }),
        GENERATION
      ]
    );
    const invalid = await getLaunchEvidence(GENERATION, ASOF);
    expect(invalid.generations[0].reuse_evidence).toBeNull();
    expect(invalid.blind_spots.join(' ')).toContain('unexpected values');
    expect(JSON.stringify(invalid)).not.toContain('secret');
  } finally {
    await db.exec('rollback');
  }
});
