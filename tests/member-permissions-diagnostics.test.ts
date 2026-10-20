import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
import { getAudit, getInspect } from '../scripts/analytics/queries';
import { resolvePeriod } from '../scripts/analytics/periods';
import { analytics } from '../apps/web/src/analytics/service';
import { sanitizeAnalyticsProperties } from '../apps/web/src/analytics/events';
import { memberAttempt } from '../apps/web/src/team/members/diagnostics';
import { lookupCodeLocations } from '../scripts/analytics/code-map';
import { TeamApiError } from '../apps/web/src/api/team';

let db: AnalyticsTestDb;
const flow = '60000000-0000-4000-8000-000000000080';
const attempts: ReturnType<typeof memberAttempt>[] = [];
beforeAll(async () => {
  db = await createAnalyticsDb();
  const pending: Promise<unknown>[] = [];
  vi.spyOn(analytics, 'track').mockImplementation((event, properties) => {
    const props = sanitizeAnalyticsProperties(properties ?? {}, event);
    expect(JSON.stringify(props)).not.toMatch(/member@example|private-file|secret/);
    pending.push(
      db.db.query(
        `insert into public.analytics_events(user_id,event_name,attempt_id,flow_id,properties,occurred_at,created_at) values($1,$2,$3,$4,$5::jsonb,$6,$6)`,
        [
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          event,
          props.attempt_id,
          props.flow_id,
          JSON.stringify(props),
          '2026-10-01T10:00:00Z'
        ]
      )
    );
  });
  const saved = memberAttempt('member_permissions_save', flow);
  attempts.push(saved);
  saved.accepted();
  saved.finish('success');
  const refused = memberAttempt('member_permissions_save', flow);
  attempts.push(refused);
  refused.finish('failure', new TeamApiError('PERMISSION_DENIED', false));
  const cancelled = memberAttempt('members_list', flow);
  attempts.push(cancelled);
  cancelled.finish('cancelled');
  const missing = memberAttempt('member_permissions_save', flow);
  attempts.push(missing);
  missing.accepted();
  const unsafe = memberAttempt('members_list', flow);
  attempts.push(unsafe);
  unsafe.finish('failure', new Error('secret member@example private-file'));
  const removed = memberAttempt('member_remove', flow);
  attempts.push(removed);
  removed.accepted();
  removed.finish('success');
  await Promise.all(pending);
  vi.restoreAllMocks();
}, 30_000);
afterAll(async () => {
  vi.restoreAllMocks();
  await db?.close();
});
it('connects real producer signals through sanitizer, storage and CLI without mixing list and save attempts', async () => {
  for (const [index, capability, terminal] of [
    [0, 'members.permissions', 'operation_completed'],
    [1, 'members.permissions', 'operation_failed'],
    [2, 'members.list', 'operation_cancelled'],
    [5, 'members.remove', 'operation_completed']
  ] as const) {
    const found = await getInspect(attempts[index].properties.attempt_id);
    if (!found.found) throw Error('Expected attempt');
    expect(found.capability).toBe(capability);
    expect(found.terminal?.event).toBe(terminal);
  }
  const refused = await getInspect(attempts[1].properties.attempt_id);
  if (!refused.found) throw Error('Expected refused save');
  expect(
    refused.events.find(row => row.event_name === 'operation_failed')?.properties.error_code
  ).toBe('PERMISSION_DENIED');
});
it('retains a lost reply or browser interruption as unknown rather than success', async () => {
  const found = await getInspect(attempts[3].properties.attempt_id);
  if (!found.found) throw Error('Expected unfinished save');
  expect(found.terminal).toBeNull();
  expect(found.stages.observed).toEqual(['requested', 'accepted']);
  const audit = await getAudit(resolvePeriod('all', undefined, '2026-10-02T00:00:00Z'));
  expect(audit.capabilities.find(row => row.id === 'members.permissions')).toMatchObject({
    samples: 3,
    correlated_pairs: 2,
    orphan_starts: 1
  });
});
it('takes a safe failure fingerprint back to the producing UI, API and authority check', async () => {
  const found = await getInspect(attempts[1].properties.attempt_id);
  if (!found.found) throw Error('Expected refusal');
  const error = found.events.find(row => row.event_name === 'error_occurred');
  const locations = lookupCodeLocations(String(error?.properties.error_fingerprint));
  expect(locations?.files).toContain('apps/web/src/team/members/MemberList.tsx');
  expect(locations?.files).toContain(
    'supabase/migrations/20260801100000_team_membership_actions.sql'
  );
});
it('does not turn raw exceptions into diagnostic content', async () => {
  const found = await getInspect(attempts[4].properties.attempt_id);
  if (!found.found) throw Error('Expected list failure');
  expect(
    found.events.find(row => row.event_name === 'operation_failed')?.properties.error_code
  ).toBe('unknown');
});
