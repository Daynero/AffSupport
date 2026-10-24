// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
import { ProductAnalytics, type PendingAnalyticsEvent } from '../apps/web/src/analytics/service';
import { observeProfileSync } from '../apps/web/src/auth/profile-sync-analytics';
import { getAudit, getInspect } from '../scripts/analytics/queries';
import { getInvestigation } from '../scripts/analytics/investigate';
import { resolvePeriod } from '../scripts/analytics/periods';

const A = 'e1720000-0000-4000-8000-000000000001',
  B = 'e1720000-0000-4000-8000-000000000002';
let db: AnalyticsTestDb;
const asOf = () => new Date(Date.now() + 1000).toISOString();
beforeEach(async () => {
  db = await createAnalyticsDb();
  await db.db.query(
    "insert into public.analytics_users(id,email,email_normalized,account_status,registered_at) values($1,'profile@acceptance.invalid','profile@acceptance.invalid','active',now())",
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

it('diagnoses a bounded refresh failure and preserves a separate successful retry', async () => {
  const p = producer();
  observeProfileSync(A, 'refresh', 'sibling', p.tracker).failed('PROFILE_REFRESH_TIMEOUT');
  observeProfileSync(A, 'refresh', 'focus', p.tracker).completed();
  await p.tracker.flush();
  expect(await getInspect(p.delivered[0]!.attempt_id!, asOf())).toMatchObject({
    capability: 'account.profile_refresh',
    terminal: { outcome: 'failure' }
  });
  const investigation = await getInvestigation(
    'profile@acceptance.invalid',
    resolvePeriod('30d', undefined, asOf())
  );
  const finding = investigation.findings.find(
    f => f.fingerprint === 'auth:library:PROFILE_REFRESH_TIMEOUT'
  );
  expect(finding?.code_locations[0]?.files).toContain('apps/web/src/auth/AuthContext.tsx');
  const audit = await getAudit(resolvePeriod('30d', undefined, asOf()));
  expect(audit.capabilities.find(c => c.id === 'account.profile_refresh')).toMatchObject({
    status: 'covered',
    correlated_pairs: 2
  });
  for (const event of p.delivered) {
    expect(JSON.stringify(event.properties)).not.toMatch(
      /display_name|marketing_consent|onboarding_completed|access_token|refresh_token|@/u
    );
  }
});

it('does not claim cross-tab receipt from an acknowledged source update', async () => {
  const p = producer();
  const update = observeProfileSync(A, 'update', 'form', p.tracker);
  update.completed();
  update.failed('PROFILE_UPDATE_FAILED');
  await p.tracker.flush();
  expect(p.delivered).toHaveLength(2);
  const audit = await getAudit(resolvePeriod('30d', undefined, asOf()));
  expect(audit.capabilities.find(c => c.id === 'account.profile_update')).toMatchObject({
    status: 'covered',
    correlated_pairs: 1
  });
  expect(audit.capabilities.find(c => c.id === 'account.profile_refresh')?.status).not.toBe(
    'covered'
  );
});

it('leaves a missing old-actor terminal explicit after identity replacement', async () => {
  const p = producer();
  const observation = observeProfileSync(A, 'refresh', 'visible', p.tracker);
  await p.tracker.flush();
  p.tracker.setUser(B);
  observation.superseded();
  await p.tracker.flush();
  expect(p.delivered).toHaveLength(1);
  const audit = await getAudit(resolvePeriod('30d', undefined, asOf()));
  expect(audit.capabilities.find(c => c.id === 'account.profile_refresh')).toMatchObject({
    status: 'partial',
    orphan_starts: 1
  });
});

it('refuses to attach a replacement actor terminal to the original profile attempt', async () => {
  const p = producer();
  observeProfileSync(A, 'update', 'form', p.tracker);
  await p.tracker.flush();
  const first = p.delivered[0]!;
  await db.db.query(
    `insert into public.analytics_events(user_id,event_name,attempt_id,flow_id,properties,outcome,created_at,occurred_at)
    values($1,'operation_completed',$2,$3,'{"flow_step":"auth_profile_update"}','success',now(),now())`,
    [B, first.attempt_id, first.flow_id]
  );
  expect(await getInspect(first.attempt_id!, asOf())).toMatchObject({
    terminal: null,
    last_proven_stage: null,
    agent: { note: expect.stringContaining('actor') }
  });
});
