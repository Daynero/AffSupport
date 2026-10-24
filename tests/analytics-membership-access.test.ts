import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
import { getMembershipAccessEvidence } from '../scripts/analytics/membership-access';
import { getInvestigation } from '../scripts/analytics/investigate';
import { resolvePeriod } from '../scripts/analytics/periods';
import { investigateOutputIsPrivate } from '../scripts/analytics/types';
const user = '36000000-0000-4000-8000-000000000001';
const team = '36000000-0000-4000-8000-000000000002';
let db: AnalyticsTestDb;
beforeEach(async () => {
  db = await createAnalyticsDb();
});
afterEach(async () => {
  await db?.close();
});
describe('membership signal diagnosis', () => {
  it('reports missing projection as unknown, never zero permission changes', async () => {
    expect(await getMembershipAccessEvidence(user, null, '2026-10-21T00:00:00Z')).toMatchObject({
      supported: false,
      signals: [],
      blind_spots: [expect.stringContaining('unavailable')]
    });
  });
  it('bounds evidence to subject/as-of and keeps browser delivery unknown', async () => {
    await db.exec(`create table public.analytics_membership_access_signals(team_id uuid,user_id uuid,revision bigint,changed_at timestamptz);
    insert into public.analytics_membership_access_signals values('${team}','${user}',2,'2026-10-20T10:00Z'),('${user}','${team}',8,'2026-10-20T10:00Z');
    insert into public.analytics_users(id,email,email_normalized,display_name,account_status,registered_at) values('${user}','synthetic@membership.test','synthetic@membership.test','Synthetic','active','2026-10-01');`);
    const result = await getMembershipAccessEvidence(user, null, '2026-10-20T12:00:00Z');
    expect(result.signals).toEqual([
      { team_id: team, revision: '2', changed_at: expect.any(String), browser_delivery: 'unknown' }
    ]);
    const investigation = await getInvestigation(
      'synthetic@membership.test',
      resolvePeriod('30d', undefined, '2026-10-20T12:00:00Z')
    );
    expect(investigation.membership_access?.signals).toHaveLength(1);
    expect(investigateOutputIsPrivate(investigation)).toBe(true);
    await db.exec("update public.analytics_membership_access_signals set changed_at='2026-10-21'");
    expect((await getMembershipAccessEvidence(user, null, '2026-10-20T12:00:00Z')).signals).toEqual(
      []
    );
  });
});
