import { afterAll, beforeAll, expect, it } from 'vitest';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
import { executeCommand, parseArgs } from '../scripts/analytics/cli';
import type { InvestigateData } from '../scripts/analytics/types';

const id = (n: number) => `74000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const WORKFLOW = id(1);
const COPY_FLOW = id(2);
const SAVE_FLOW = id(3);
interface Event {
  name: string;
  action?: string;
  flow?: string;
  outcome?: string;
  run?: string;
}
const copy: Event = {
  name: 'team_launch_action',
  action: 'copy_launch',
  flow: COPY_FLOW,
  outcome: 'success'
};
const intent: Event = { name: 'team_launch_intent', action: 'save_draft', flow: SAVE_FLOW };
const saved: Event = { ...intent, name: 'team_launch_action', outcome: 'success' };
const cases: Array<{ name: string; events: Event[]; complete: boolean }> = [
  {
    name: 'successful copy and saved draft are not unfinished processing runs',
    events: [copy, intent, saved],
    complete: true
  },
  { name: 'a separate pending save remains visible', events: [copy, intent], complete: false },
  {
    name: 'a failed save remains visible',
    events: [copy, intent, { ...saved, outcome: 'failure' }],
    complete: false
  },
  {
    name: 'copy success cannot complete native processing',
    events: [{ name: 'operation_started', run: WORKFLOW }, copy],
    complete: false
  },
  {
    name: 'a later intent on the same flow remains unresolved',
    events: [copy, { name: 'team_launch_intent', action: 'copy_launch', flow: COPY_FLOW }],
    complete: false
  },
  {
    name: 'missing flow correlation remains unknown',
    events: [{ ...copy, flow: undefined }],
    complete: false
  },
  {
    name: 'a different action cannot close an intent',
    events: [{ ...intent, flow: COPY_FLOW }, copy],
    complete: false
  },
  {
    name: 'generation acceptance is not processing completion',
    events: [{ ...copy, action: 'generate' }],
    complete: false
  }
];

let db: AnalyticsTestDb;
beforeAll(async () => {
  db = await createAnalyticsDb();
  for (const [index, scenario] of cases.entries()) {
    const user = id(10 + index);
    const email = `launch-fixture-${index}@example.test`;
    await db.exec(`insert into public.analytics_users (id, email, email_normalized)
      values ('${user}', '${email}', '${email}');`);
    for (const [position, event] of scenario.events.entries()) {
      const at = `2026-11-13T09:00:${String(position).padStart(2, '0')}Z`;
      const properties = { workflow_id: WORKFLOW, launch_action: event.action };
      await db.exec(`insert into public.analytics_events
        (user_id, event_name, flow_id, run_id, tool, outcome, properties, occurred_at, created_at)
        values ('${user}', '${event.name}', ${event.flow ? `'${event.flow}'` : 'null'},
          ${event.run ? `'${event.run}'` : 'null'}, ${event.run ? "'stitcher'" : 'null'},
          ${event.outcome ? `'${event.outcome}'` : 'null'}, '${JSON.stringify(properties)}', '${at}', '${at}');`);
    }
  }
}, 60_000);
afterAll(async () => {
  await db.close();
});

it.each(cases.map((scenario, index) => ({ ...scenario, index })))(
  '$name',
  async ({ index, complete }) => {
    const result = await executeCommand(
      parseArgs([
        'investigate',
        `launch-fixture-${index}@example.test`,
        '--as-of',
        '2026-11-13T10:00:00Z',
        '--json'
      ])
    );
    const data = result.data as InvestigateData;
    expect(data.operations.some(operation => operation.id === WORKFLOW)).toBe(!complete);
    expect(data.findings.some(finding => finding.evidence.includes(`run:${WORKFLOW}`))).toBe(
      !complete
    );
  }
);
