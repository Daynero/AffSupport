// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
import { ProductAnalytics, type PendingAnalyticsEvent } from '../apps/web/src/analytics/service';
import { observeSessionLogout } from '../apps/web/src/auth/session-mutation-analytics';
import { getAudit, getInspect } from '../scripts/analytics/queries';
import { getInvestigation } from '../scripts/analytics/investigate';
import { resolvePeriod } from '../scripts/analytics/periods';
const A = 'e1690000-0000-4000-8000-000000000001',
  B = 'e1690000-0000-4000-8000-000000000002';
let db: AnalyticsTestDb;
const asOf = () => new Date(Date.now() + 1000).toISOString();
beforeEach(async () => {
  db = await createAnalyticsDb();
  await db.db.query(
    `insert into public.analytics_users(id,email,email_normalized,account_status,registered_at) values($1,'session@acceptance.invalid','session@acceptance.invalid','active',now())`,
    [A]
  );
});
afterEach(async () => db?.close());
function producer() {
  const delivered: PendingAnalyticsEvent[] = [];
  const tracker = new ProductAnalytics(async events => {
    for (const event of events) {
      await db.db.query(
        `insert into public.analytics_events(user_id,event_name,event_id,attempt_id,flow_id,properties,outcome,error_code,error_stage,error_fingerprint,occurred_at,created_at)
        values($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11::timestamptz,now())`,
        [
          event.user_id,
          event.event_name,
          event.event_id,
          event.attempt_id,
          event.flow_id,
          JSON.stringify(event.properties),
          event.outcome,
          event.error_code,
          event.error_stage,
          event.error_fingerprint,
          event.occurred_at
        ]
      );
      delivered.push(event);
    }
    return true;
  }, null);
  tracker.setUser(A);
  return { tracker, delivered };
}
it('reads a real typed producer failure as a correlated closed cause with exact code locations', async () => {
  const p = producer(),
    observation = observeSessionLogout(A, p.tracker);
  observation.acquired();
  observation.failed(
    new Error('AUTH_SESSION_STATE_UNAVAILABLE', { cause: new Error('synthetic-secret') })
  );
  await p.tracker.flush();
  const audit = await getAudit(resolvePeriod('30d', undefined, asOf()));
  expect(audit.capabilities.find(c => c.id === 'account.session_logout')).toMatchObject({
    status: 'covered',
    correlated_pairs: 1
  });
  const investigation = await getInvestigation(
    'session@acceptance.invalid',
    resolvePeriod('30d', undefined, asOf())
  );
  const finding = investigation.findings.find(
    f => f.fingerprint === 'auth:library:AUTH_SESSION_STATE_UNAVAILABLE'
  );
  expect(finding).toBeDefined();
  expect(finding?.code_locations[0]?.files).toContain('apps/web/src/auth/session-mutations.ts');
  expect(JSON.stringify(investigation)).not.toContain('synthetic-secret');
  expect(await getInspect(p.delivered[0]!.attempt_id!, asOf())).toMatchObject({
    capability: 'account.session_logout',
    terminal: { outcome: 'failure' }
  });
});
it('keeps missing SDK outcomes partial after old analytics identity is removed', async () => {
  const p = producer(),
    observation = observeSessionLogout(A, p.tracker);
  observation.acquired();
  await p.tracker.flush();
  p.tracker.setUser(null);
  observation.completed();
  await p.tracker.flush();
  const audit = await getAudit(resolvePeriod('30d', undefined, asOf()));
  expect(audit.capabilities.find(c => c.id === 'account.session_logout')).toMatchObject({
    status: 'partial',
    orphan_starts: 1,
    missing: expect.arrayContaining(['terminal'])
  });
  expect(await getInspect(p.delivered[0]!.attempt_id!, asOf())).toMatchObject({
    terminal: null,
    last_proven_stage: 'lane_acquired'
  });
});
it('does not borrow another actor terminal sharing an attempt or hide the original orphan', async () => {
  const p = producer(),
    observation = observeSessionLogout(A, p.tracker);
  await p.tracker.flush();
  const first = p.delivered[0]!;
  await db.db.query(
    `insert into public.analytics_events(user_id,event_name,attempt_id,flow_id,properties,outcome,created_at,occurred_at)
    values($1,'operation_completed',$2,$3,'{"flow_step":"auth_session_sdk_logout"}','success',now(),now())`,
    [B, first.attempt_id, first.flow_id]
  );
  p.tracker.setUser(B);
  observation.completed();
  await p.tracker.flush();
  const audit = await getAudit(resolvePeriod('30d', undefined, asOf()));
  expect(audit.capabilities.find(c => c.id === 'account.session_logout')).toMatchObject({
    status: 'partial',
    correlated_pairs: 0,
    orphan_starts: 1
  });
  expect(await getInspect(first.attempt_id!, asOf())).toMatchObject({
    terminal: null,
    last_proven_stage: null,
    agent: { note: expect.stringContaining('actor') }
  });
});

it('does not hide a missing logout terminal behind another completed attempt', async () => {
  const p = producer(),
    finished = observeSessionLogout(A, p.tracker);
  finished.failed(new Error('AUTH_SESSION_LOCK_UNAVAILABLE'));
  observeSessionLogout(A, p.tracker);
  await p.tracker.flush();
  const audit = await getAudit(resolvePeriod('30d', undefined, asOf()));
  expect(audit.capabilities.find(c => c.id === 'account.session_logout')).toMatchObject({
    status: 'partial',
    samples: 2,
    orphan_starts: 1,
    missing: expect.arrayContaining(['orphan_starts'])
  });
});
