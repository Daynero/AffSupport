import { afterEach, beforeEach, expect, it } from 'vitest';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
import { getAudit } from '../scripts/analytics/queries';
import { resolvePeriod } from '../scripts/analytics/periods';
const A = 'e1670000-0000-4000-8000-000000000001';
const B = 'e1670000-0000-4000-8000-000000000002';
const ATTEMPT = 'e1670000-0000-4000-8000-000000000003';
const AS_OF = '2026-10-22T20:00:00Z';
let db: AnalyticsTestDb;
beforeEach(async () => {
  db = await createAnalyticsDb();
});
afterEach(async () => db?.close());
async function event(actor: string, name: string, attempt = ATTEMPT) {
  await db.exec(`insert into public.analytics_events(user_id,event_name,attempt_id,properties,created_at,occurred_at)
    values('${actor}','${name}','${attempt}','{"flow_step":"recovery_retirement_ack"}','2026-10-22T19:00:00Z','2026-10-22T19:00:00Z')`);
}
it('separates browser acknowledgement observability from server revocation and native cleanup', async () => {
  await event(A, 'operation_started');
  await event(A, 'operation_completed');
  const audit = await getAudit(resolvePeriod('30d', undefined, AS_OF));
  expect(audit.capabilities.find(x => x.id === 'team.recovery_retirement_ack')).toMatchObject({
    status: 'covered',
    samples: 1
  });
  expect(audit.capabilities.find(x => x.id === 'team.recovery_retirement')).toMatchObject({
    status: 'uncovered'
  });
});
it('does not join a start and terminal across different actors sharing an attempt nonce', async () => {
  await event(A, 'operation_started');
  await event(B, 'operation_completed');
  const audit = await getAudit(resolvePeriod('30d', undefined, AS_OF));
  expect(audit.capabilities.find(x => x.id === 'team.recovery_retirement_ack')).toMatchObject({
    status: 'partial',
    correlated_pairs: 0,
    orphan_starts: 1
  });
});
it('keeps a missing terminal visible even when another attempt completed', async () => {
  await event(A, 'operation_started');
  await event(A, 'operation_completed');
  await event(A, 'operation_started', 'e1670000-0000-4000-8000-000000000004');
  const audit = await getAudit(resolvePeriod('30d', undefined, AS_OF));
  expect(audit.capabilities.find(x => x.id === 'team.recovery_retirement_ack')).toMatchObject({
    status: 'partial',
    samples: 2,
    orphan_starts: 1,
    missing: expect.arrayContaining(['orphan_starts'])
  });
});

it('distinguishes available browser server receipts from unobserved native cleanup without claiming native coverage', async () => {
  await db.exec(
    `create table public.analytics_recovery_retirement(actor_id uuid,attempt_id uuid,installation_id uuid,retired_count integer,confirmed_at timestamptz)`
  );
  const audit = await getAudit(resolvePeriod('30d', undefined, AS_OF));
  const native = audit.capabilities.find(item => item.id === 'team.recovery_retirement');
  expect(native?.missing).not.toContain('browser_only_retirement_unobserved');
  expect(native?.missing).toContain('browser_only_native_cleanup_unobserved');
  expect(native?.status).not.toBe('covered');
});
