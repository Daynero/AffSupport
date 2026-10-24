import { afterEach, beforeEach, expect, it } from 'vitest';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
import { getRecoveryRetirementEvidence } from '../scripts/analytics/recovery-retirement';
import { getInvestigation } from '../scripts/analytics/investigate';
import { getInspect } from '../scripts/analytics/queries';
import { resolvePeriod } from '../scripts/analytics/periods';
import { investigateOutputIsPrivate } from '../scripts/analytics/types';
const ACTOR = 'e1670000-0000-4000-8000-000000000001';
const ATTEMPT = 'e1670000-0000-4000-8000-000000000002';
const INSTALLATION = 'e1670000-0000-4000-8000-000000000003';
const AS_OF = '2026-10-22T20:00:00.000Z';
let db: AnalyticsTestDb;
beforeEach(async () => {
  db = await createAnalyticsDb();
  await db.exec(`create table public.analytics_recovery_retirement(actor_id uuid,attempt_id uuid,installation_id uuid,retired_count integer,confirmed_at timestamptz);
  insert into public.analytics_recovery_retirement values('${ACTOR}','${ATTEMPT}','${INSTALLATION}',1,'2026-10-22T19:00:00Z');
  insert into public.analytics_users(id,email,email_normalized,display_name,account_status,registered_at)
  values('${ACTOR}','receipt@acceptance.test.invalid','receipt@acceptance.test.invalid','Synthetic receipt','active','2026-10-01');`);
});
afterEach(async () => db?.close());
it('runs actor-scoped receipt SQL and refuses another actor nonce collision', async () => {
  await db.exec(
    `insert into public.analytics_recovery_retirement values('e1670000-0000-4000-8000-000000000099','${ACTOR}','e1670000-0000-4000-8000-000000000098',9,'2026-10-22T19:00:00Z');`
  );
  const result = await getRecoveryRetirementEvidence(ACTOR, null, AS_OF, 'actor');
  expect(result.receipts.map(row => row.attempt_id)).toEqual([ATTEMPT]);
});
it('investigate explains committed server retirement without inventing client receipt or protected-key cleanup', async () => {
  const result = await getInvestigation(
    'receipt@acceptance.test.invalid',
    resolvePeriod('30d', undefined, AS_OF)
  );
  expect(result).toMatchObject({
    recovery_retirement: {
      supported: true,
      receipts: [
        {
          actor_id: ACTOR,
          attempt_id: ATTEMPT,
          server_outcome: 'confirmed',
          browser_outcome: 'unknown',
          native_cleanup: 'unknown'
        }
      ]
    }
  });
  expect(
    result.findings.find(
      finding => finding.fingerprint === 'team:recovery_retirement:server_confirmed'
    )
  ).toMatchObject({
    kind: 'fact',
    evidence: [`retirement:${ATTEMPT}`]
  });
  expect(investigateOutputIsPrivate(result)).toBe(true);
});
it('inspect identifies the receipt while keeping result visibility and native cleanup unproven', async () => {
  expect(await getInspect(ATTEMPT, AS_OF)).toMatchObject({
    found: true,
    capability: 'team.recovery_retirement',
    last_proven_stage: 'server_confirmed',
    terminal: null,
    recovery_retirement: {
      receipts: [{ attempt_id: ATTEMPT, browser_outcome: 'unknown', native_cleanup: 'unknown' }]
    }
  });
});

async function acknowledgement(
  actor: string,
  event: string,
  outcome: string,
  created = '2026-10-22T19:01:00Z'
) {
  await db.exec(`insert into public.analytics_events(user_id,event_name,attempt_id,outcome,properties,created_at)
    values('${actor}','${event}','${ATTEMPT}','${outcome}',
      '{"flow_step":"recovery_retirement_ack","error_code":"RECOVERY_RETIREMENT_UNCONFIRMED","error_category":"network"}', '${created}');`);
}
it('correlates browser acknowledgement to the same actor and attempt while native cleanup remains unknown', async () => {
  await acknowledgement(ACTOR, 'operation_completed', 'success');
  const result = await getRecoveryRetirementEvidence(ACTOR, null, AS_OF, 'actor');
  expect(result.receipts[0]).toMatchObject({
    server_outcome: 'confirmed',
    browser_outcome: 'confirmed',
    native_cleanup: 'unknown',
    browser_evidence: [expect.stringMatching(/^event:/)]
  });
  expect(await getInspect(ATTEMPT, AS_OF)).toMatchObject({
    last_proven_stage: 'browser_confirmed',
    terminal: null,
    stages: { missing: ['local_complete'] }
  });
});
it('distinguishes committed retirement from a lost browser acknowledgement', async () => {
  await acknowledgement(ACTOR, 'operation_failed', 'failure');
  const result = await getRecoveryRetirementEvidence(ACTOR, null, AS_OF, 'actor');
  expect(result.receipts[0]).toMatchObject({
    server_outcome: 'confirmed',
    browser_outcome: 'unconfirmed',
    browser_reason: 'network',
    native_cleanup: 'unknown'
  });
});
it('does not borrow acknowledgement from another actor, before commit or after the report cutoff', async () => {
  await acknowledgement('e1670000-0000-4000-8000-000000000099', 'operation_completed', 'success');
  await acknowledgement(ACTOR, 'operation_completed', 'success', '2026-10-22T18:59:00Z');
  await acknowledgement(ACTOR, 'operation_completed', 'success', '2026-10-22T20:01:00Z');
  expect(
    (await getRecoveryRetirementEvidence(ACTOR, null, AS_OF, 'actor')).receipts[0]?.browser_outcome
  ).toBe('unknown');
});
it('keeps conflicting browser terminals unknown rather than selecting the convenient result', async () => {
  await acknowledgement(ACTOR, 'operation_completed', 'success');
  await acknowledgement(ACTOR, 'operation_failed', 'failure');
  const result = await getRecoveryRetirementEvidence(ACTOR, null, AS_OF, 'actor');
  expect(result.receipts[0]?.browser_outcome).toBe('unknown');
  expect(result.blind_spots.some(detail => detail.includes('conflicting'))).toBe(true);
});
it('keeps bounded browser detail truncation explicit', async () => {
  await db.exec(`insert into public.analytics_events(user_id,event_name,attempt_id,outcome,properties,created_at)
    select '${ACTOR}','operation_completed','${ATTEMPT}','success','{"flow_step":"recovery_retirement_ack"}'::jsonb,'2026-10-22T19:01:00Z'::timestamptz from generate_series(1,101);`);
  const result = await getRecoveryRetirementEvidence(ACTOR, null, AS_OF, 'actor');
  expect(result.receipts[0]?.browser_outcome).toBe('unknown');
  expect(result.blind_spots.some(detail => detail.includes('truncated'))).toBe(true);
});
