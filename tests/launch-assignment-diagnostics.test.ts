import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
import { getInspect } from '../scripts/analytics/queries';
import { getLaunchAssignmentEvidence } from '../scripts/analytics/launches';
import { launchMutation, launchAssignmentVisible } from '../apps/web/src/team/launches/analytics';
import { sanitizeTeamAnalyticsProperties } from '../packages/shared/src/team/analytics';
const LAUNCH = '78700000-0000-4000-8000-000000000001';
const RK = '78700000-0000-4000-8000-000000000002';
const ACTOR = '78700000-0000-4000-8000-000000000003';
const FLOW = '78700000-0000-4000-8000-000000000004';
const ASOF = '2026-10-26T20:00:00Z';
let db: AnalyticsTestDb;
beforeAll(async () => {
  db = await createAnalyticsDb();
  await db.exec(`create table public.analytics_launch_assignments(launch_id uuid,agent_row_id uuid,actor_id uuid,state text,version bigint,updated_at timestamptz,manual_hold_count integer,current_assignment_count integer);
    create table public.analytics_launch_assignment_events(launch_id uuid,agent_row_id uuid,previous_agent_row_id uuid,actor_id uuid,occurred_at timestamptz);
    insert into public.analytics_launch_assignments values('${LAUNCH}','${RK}','${ACTOR}','assigned',2,'2026-10-26T19:00:00Z',0,2);`);
  const files = (await readdir('supabase/migrations')).sort().reverse();
  for (const file of files) {
    const sql = await readFile(`supabase/migrations/${file}`, 'utf8');
    const guard =
      /create or replace function public\.analytics_properties_are_safe_v2\s*\(payload jsonb\)[\s\S]*?\$\$;/.exec(
        sql
      );
    if (!guard) continue;
    await db.exec(guard[0]);
    break;
  }
}, 30000);
afterAll(async () => {
  await db?.close();
});
it('explains current holds independently of generation and never claims browser delivery from commit', async () => {
  const result = await getInspect(LAUNCH, ASOF);
  expect(result.found).toBe(true);
  if (!result.found) throw new Error('fixture');
  expect(result.last_proven_stage).toBe('accepted');
  expect(result.stages.missing).toContain('result_visible');
  expect(result.launches?.assignments?.[0]).toMatchObject({
    current_assignment_count: 2,
    counts_scope: 'current_read_not_as_of'
  });
});
it('legacy observations never become successful accepted assignments', async () => {
  await db.exec(`update public.analytics_launch_assignments set state='legacy_unknown';`);
  const result = await getInspect(LAUNCH, ASOF);
  if (!result.found) throw new Error('fixture');
  expect(result.terminal).toBeNull();
  expect(result.last_proven_stage).toBe('legacy_observed');
  expect(result.stages.missing).toContain('accepted');
  await db.exec(`update public.analytics_launch_assignments set state='assigned';`);
});
it('keeps released RK provenance discoverable without treating it as a current assignment', async () => {
  await db.exec(
    `insert into public.analytics_launch_assignment_events values('${LAUNCH}',null,'${RK}','${ACTOR}','2026-10-26T19:01:00Z'); update public.analytics_launch_assignments set state='released',agent_row_id=null;`
  );
  const result = await getLaunchAssignmentEvidence(RK, ASOF);
  expect(result[0]).toMatchObject({ state: 'released', agent_row_id: null });
  expect(await getLaunchAssignmentEvidence(RK, '2026-10-26T18:00:00Z')).toEqual([]);
});
it('persists typed assignment signals through the actual guard and joins flow inspection via Launch identity', async () => {
  const collected: { name: string; properties: Record<string, unknown> }[] = [];
  const tracker = {
    track: (name: string, properties: object) => {
      collected.push({ name, properties: { ...properties } });
    }
  };
  await launchMutation(
    { flowId: FLOW, launchId: LAUNCH },
    'release_account',
    async () => undefined,
    tracker
  );
  let index = 0;
  const persist = async () => {
    for (const event of collected.splice(0)) {
      const props = sanitizeTeamAnalyticsProperties(event.properties);
      const safe = await db.db.query<{ safe: boolean }>(
        'select public.analytics_properties_are_safe_v2($1::jsonb) safe',
        [JSON.stringify(props)]
      );
      expect(safe.rows[0].safe).toBe(true);
      await db.db.query(
        'insert into public.analytics_events(event_name,flow_id,properties,occurred_at,created_at) values($1,$2,$3,$4,$4)',
        [event.name, FLOW, props, `2026-10-26T19:02:0${index++}Z`]
      );
    }
  };
  await persist();
  let result = await getInspect(FLOW, ASOF);
  if (!result.found) throw new Error('fixture');
  expect(result.launches?.assignments?.[0].launch_id).toBe(LAUNCH);
  expect(result.stages.observed).toEqual(['intent', 'accepted']);
  expect(result.stages.missing).toEqual(['result_visible']);
  launchAssignmentVisible({ flowId: FLOW, launchId: LAUNCH }, 'release_account', tracker);
  await persist();
  result = await getInspect(FLOW, ASOF);
  if (!result.found) throw new Error('fixture');
  expect(result.last_proven_stage).toBe('result_visible');
  const unsafe = await db.db.query<{ safe: boolean }>(
    'select public.analytics_properties_are_safe_v2($1::jsonb) safe',
    [JSON.stringify({ launch_action: 'release_account', originalUrl: 'private-content' })]
  );
  expect(unsafe.rows[0].safe).toBe(false);
});
