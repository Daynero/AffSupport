import { afterAll, beforeAll, expect, it } from 'vitest';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
import { getAudit, getInspect } from '../scripts/analytics/queries';
import { resolvePeriod } from '../scripts/analytics/periods';
import {
  sanitizeAnalyticsProperties,
  type AnalyticsEventName
} from '../apps/web/src/analytics/events';
import { lookupCodeLocations } from '../scripts/analytics/code-map';
let db: AnalyticsTestDb;
const flow = '30000000-0000-4000-8000-000000000080';
const attempts = [
  '10000000-0000-4000-8000-000000000080',
  '10000000-0000-4000-8000-000000000081',
  '10000000-0000-4000-8000-000000000082'
];
const other = '10000000-0000-4000-8000-000000000083';
const sessionAttempts = [
  '10000000-0000-4000-8000-000000000090',
  '10000000-0000-4000-8000-000000000091',
  '10000000-0000-4000-8000-000000000092'
];
beforeAll(async () => {
  db = await createAnalyticsDb();
  const insert = async (
    event: AnalyticsEventName,
    attempt: string,
    step: string,
    outcome?: string
  ) => {
    const failureCode =
      step === 'launch_detail_session' ? 'LAUNCH_SESSION_LOAD_FAILED' : 'LAUNCH_EDITOR_LOAD_FAILED';
    const props = sanitizeAnalyticsProperties(
      {
        flow_id: flow,
        attempt_id: attempt,
        flow_step: step,
        ...(outcome ? { outcome } : {}),
        ...(event === 'error_occurred'
          ? {
              error_code: failureCode,
              error_stage: 'library',
              error_fingerprint: `team:library:${failureCode}`
            }
          : {})
      },
      event
    );
    await db.db.query(
      `insert into public.analytics_events(user_id,event_name,attempt_id,flow_id,properties,occurred_at,created_at) values($1,$2,$3,$4,$5::jsonb,$6,$6)`,
      [
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        event,
        attempt,
        flow,
        JSON.stringify(props),
        '2026-10-01T10:00:00Z'
      ]
    );
  };
  for (const [index, event] of (
    ['operation_completed', 'operation_failed', 'operation_cancelled'] as const
  ).entries()) {
    await insert('operation_started', attempts[index], 'launch_settings_editor');
    await insert(
      event,
      attempts[index],
      'launch_settings_editor',
      ['success', 'failure', 'cancelled'][index]
    );
    if (event === 'operation_failed')
      await insert('error_occurred', attempts[index], 'launch_settings_editor', 'failure');
  }
  for (const [index, event] of (
    ['operation_completed', 'operation_failed', 'operation_cancelled'] as const
  ).entries()) {
    await insert('operation_started', sessionAttempts[index], 'launch_detail_session');
    await insert(
      event,
      sessionAttempts[index],
      'launch_detail_session',
      ['success', 'failure', 'cancelled'][index]
    );
    if (event === 'operation_failed')
      await insert('error_occurred', sessionAttempts[index], 'launch_detail_session', 'failure');
  }
  await insert('operation_started', other, 'another_settings_surface');
  await insert('operation_completed', other, 'another_settings_surface', 'success');
}, 30_000);
afterAll(async () => {
  await db.close();
});
it.each(['operation_completed', 'operation_failed', 'operation_cancelled'] as const)(
  'inspects the editor attempt with its own %s terminal',
  async event => {
    const index = ['operation_completed', 'operation_failed', 'operation_cancelled'].indexOf(event);
    const found = await getInspect(attempts[index]);
    if (!found.found) throw new Error('Expected stored editor attempt');
    expect(found.capability).toBe('launches.editor');
    expect(found.terminal?.event).toBe(event);
    expect(found.stages.observed).toEqual(['requested', 'terminal']);
    expect(found.events.every(row => row.properties.flow_step === 'launch_settings_editor')).toBe(
      true
    );
    if (event === 'operation_failed') {
      const error = found.events.find(row => row.event_name === 'error_occurred');
      expect(lookupCodeLocations(String(error?.properties.error_fingerprint))?.files).toContain(
        'apps/web/src/team/launches/DeferredLaunchEditor.tsx'
      );
    }
  }
);
it('never classifies another generic flow step as the editor or counts it in its audit', async () => {
  const found = await getInspect(other);
  if (!found.found) throw new Error('Expected other generic attempt');
  expect(found.capability).not.toBe('launches.editor');
  const audit = await getAudit(resolvePeriod('all', undefined, '2026-10-02T00:00:00Z'));
  const editor = audit.capabilities.find(row => row.id === 'launches.editor');
  expect(editor).toMatchObject({ samples: 3, correlated_pairs: 3, orphan_starts: 0 });
  expect(editor?.observed.find(row => row.event === 'operation_started')?.events).toBe(3);
  expect(editor?.observed.find(row => row.event === 'error_occurred')?.events).toBe(1);
});

it.each(['operation_completed', 'operation_failed', 'operation_cancelled'] as const)(
  'inspects a detail session %s without misclassifying it as the settings editor',
  async event => {
    const index = ['operation_completed', 'operation_failed', 'operation_cancelled'].indexOf(event);
    const found = await getInspect(sessionAttempts[index]);
    if (!found.found) throw new Error('Expected stored session attempt');
    expect(found.capability).toBe('launches.session');
    expect(found.terminal?.event).toBe(event);
    expect(found.stages.observed).toEqual(['requested', 'terminal']);
    expect(found.events.every(row => row.properties.flow_step === 'launch_detail_session')).toBe(
      true
    );
    if (event === 'operation_failed') {
      const error = found.events.find(row => row.event_name === 'error_occurred');
      expect(lookupCodeLocations(String(error?.properties.error_fingerprint))?.files).toContain(
        'apps/web/src/team/launches/DeferredLaunchSession.tsx'
      );
    }
  }
);
it('keeps session, editor and unrelated generic attempts separate in audit', async () => {
  const audit = await getAudit(resolvePeriod('all', undefined, '2026-10-02T00:00:00Z'));
  for (const id of ['launches.editor', 'launches.session']) {
    const capability = audit.capabilities.find(row => row.id === id);
    expect(capability).toMatchObject({ samples: 3, correlated_pairs: 3, orphan_starts: 0 });
    expect(capability?.observed.find(row => row.event === 'operation_started')?.events).toBe(3);
    expect(capability?.observed.find(row => row.event === 'error_occurred')?.events).toBe(1);
  }
  const generic = await getInspect(other);
  if (!generic.found) throw new Error('Expected other generic attempt');
  expect(generic.capability).not.toBe('launches.session');
});
