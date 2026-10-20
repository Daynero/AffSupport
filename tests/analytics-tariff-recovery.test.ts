import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
import { getRecoveryEvidence } from '../scripts/analytics/tariff-recovery';
import { getInspect, getAudit } from '../scripts/analytics/queries';
import { getInvestigation } from '../scripts/analytics/investigate';
import { resolvePeriod } from '../scripts/analytics/periods';
import { investigateOutputIsPrivate } from '../scripts/analytics/types';
const USER = '34000000-0000-4000-8000-000000000001';
const CYCLE = '34000000-0000-4000-8000-000000000002';
const ITEM = '34000000-0000-4000-8000-000000000003';
const END = '2026-10-20T12:00:00Z';
let db: AnalyticsTestDb;
beforeEach(async () => {
  db = await createAnalyticsDb();
  await db.exec(`create table public.analytics_workspace_recovery(recovery_id uuid,item_id uuid,team_id uuid,kind text,state text,stage text,reason_code text,
 registered_at timestamptz,updated_at timestamptz,operation_id uuid,attempt_id uuid,delivered_at timestamptz,actor_id uuid,member_ids uuid[]);
 insert into public.analytics_workspace_recovery values('${CYCLE}','${ITEM}','${CYCLE}','catalog_schedule','waiting_dependency','queued','waiting_drive',
 '2026-10-20T10:00:00Z','2026-10-20T10:01:00Z',null,null,null,'${USER}',array['${USER}']::uuid[]);
 insert into public.analytics_users(id,email,email_normalized,display_name,account_status,registered_at) values('${USER}','synthetic@recovery.test','synthetic@recovery.test','Synthetic','active','2026-10-01');`);
});
afterEach(async () => db?.close());
describe('authoritative recovery diagnosis', () => {
  it('inspect finds recovery without a browser event and does not invent start or delivery', async () => {
    const value = await getInspect(CYCLE, END);
    expect(value).toMatchObject({
      found: true,
      capability: 'team.tariff_recovery',
      last_proven_stage: 'queued',
      terminal: null
    });
    if (value.found) {
      expect(value.stages.missing).toContain('started');
      expect(value.recovery?.items[0].delivery).toBe('unknown');
    }
  });
  it('investigate reports a proven dependency and names the unknown delivery', async () => {
    const value = await getInvestigation(
      'synthetic@recovery.test',
      resolvePeriod('30d', undefined, END)
    );
    expect(value.findings.find(f => f.rule === 'tariff_recovery_state')).toMatchObject({
      kind: 'fact',
      fingerprint: 'tariff:recovery:waiting_drive'
    });
    expect(value.recovery?.items).toHaveLength(1);
    expect(value.coverage.blind_spots.some(g => g.kind === 'tariff_recovery_gap')).toBe(true);
    expect(investigateOutputIsPrivate(value)).toBe(true);
  });
  it('audit uses recovery evidence rather than unrelated sync rows', async () => {
    const value = await getAudit(resolvePeriod('30d', undefined, END));
    const capability = value.capabilities.find(c => c.id === 'team.tariff_recovery');
    expect(capability).toMatchObject({ status: 'partial', samples: 1 });
    expect(capability?.missing).toContain('output_delivery_unknown');
  });
  it('does not reconstruct rows modified after as-of or expose unknown provider values', async () => {
    await db.exec(
      "update public.analytics_workspace_recovery set reason_code='https://private.example/secret'"
    );
    const value = await getRecoveryEvidence(USER, null, END);
    expect(value.items[0].reason).toBe('unknown');
    expect(JSON.stringify(value)).not.toContain('private.example');
    await db.exec("update public.analytics_workspace_recovery set updated_at='2026-10-21'");
    expect((await getRecoveryEvidence(USER, null, END)).items).toEqual([]);
  });
});
