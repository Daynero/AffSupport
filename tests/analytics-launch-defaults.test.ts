import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
import { getAudit, getInspect } from '../scripts/analytics/queries';
import { resolvePeriod } from '../scripts/analytics/periods';
import { sanitizeAnalyticsProperties } from '../apps/web/src/analytics/events';
import { observeLaunchDefaults } from '../apps/web/src/analytics/launch-defaults';
const track = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/analytics/service', () => ({ analytics: { track } }));
let db: AnalyticsTestDb;
const attempts: { id: string; action: string; scope: string; outcome: string }[] = [];
beforeAll(async () => {
  db = await createAnalyticsDb();
  for (const action of ['read', 'save', 'apply'] as const)
    for (const scope of ['offer', 'workspace'] as const) {
      for (const outcome of ['success', 'failure', 'cancelled', 'unknown'] as const) {
        track.mockClear();
        const observation = observeLaunchDefaults(action, scope);
        if (outcome !== 'unknown')
          observation.finish(outcome, {
            code: 'LAUNCH_VERSION_CONFLICT',
            message: 'PRIVATE_SETTINGS'
          });
        const id = track.mock.calls[0][1].attempt_id;
        attempts.push({ id, action, scope, outcome });
        for (const [event, values] of track.mock.calls) {
          const props = sanitizeAnalyticsProperties(values, event);
          expect(props.flow_step).toBe(`launch_defaults_${action}_${scope}`);
          expect(JSON.stringify(props)).not.toContain('PRIVATE_SETTINGS');
          await db.db.query(
            'insert into public.analytics_events(user_id,event_name,attempt_id,flow_id,properties,occurred_at,created_at) values($1,$2,$3,$4,$5::jsonb,$6,$6)',
            [
              'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              event,
              id,
              props.flow_id,
              JSON.stringify(props),
              '2026-10-01T10:00:00Z'
            ]
          );
        }
      }
    }
}, 60000);
afterAll(async () => db?.close());
it('reads real sanitized producer events through the CLI with scope and failure codes intact', async () => {
  for (const row of attempts) {
    const found = await getInspect(row.id);
    if (!found.found) throw new Error('Expected stored defaults attempt');
    expect(found.capability).toBe(`launches.defaults.${row.action}`);
    expect(
      found.events.every(
        event => event.properties.flow_step === `launch_defaults_${row.action}_${row.scope}`
      )
    ).toBe(true);
    if (row.outcome === 'unknown') expect(found.terminal).toBeNull();
    else
      expect(found.terminal?.event).toBe(
        row.outcome === 'success'
          ? 'operation_completed'
          : row.outcome === 'failure'
            ? 'operation_failed'
            : 'operation_cancelled'
      );
    if (row.outcome === 'failure')
      expect(
        found.events.some(event => event.properties.error_code === 'LAUNCH_VERSION_CONFLICT')
      ).toBe(true);
  }
});
it('keeps incomplete attempts explicit in the capability audit', async () => {
  const audit = await getAudit(resolvePeriod('all', undefined, '2026-10-02T00:00:00Z'));
  for (const action of ['read', 'save', 'apply']) {
    expect(audit.capabilities.find(row => row.id === `launches.defaults.${action}`)).toMatchObject({
      samples: 8,
      correlated_pairs: 6,
      orphan_starts: 2
    });
  }
});
it('does not let telemetry persistence failure break defaults or emit two terminals', () => {
  track.mockReset();
  const observation = observeLaunchDefaults('save', 'offer');
  observation.finish('success');
  observation.finish('failure');
  expect(track).toHaveBeenCalledTimes(2);
  track.mockImplementation(() => {
    throw new Error('quota');
  });
  expect(() => observeLaunchDefaults('read', 'workspace').finish('success')).not.toThrow();
});
