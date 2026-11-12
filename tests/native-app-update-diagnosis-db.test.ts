import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
import { getNativeUpdateEvidence } from '../scripts/analytics/native-app-updates';
import { nativeSnapshot } from './support/native-app-updates';
let fixture: AnalyticsTestDb;
const native = nativeSnapshot();
const user = '10000000-0000-4000-8000-000000000099';
beforeAll(async () => {
  fixture = await createAnalyticsDb();
  for (const [seq, stage, nativeSuccess, uiSuccess, received] of [
    [1, 'target_started', false, false, '2026-11-12T10:00:00Z'],
    [2, 'native_ready', true, false, '2026-11-12T10:01:00Z'],
    [3, 'ui_visible', true, true, '2026-11-12T10:05:00Z']
  ] as const) {
    await fixture.db.query(
      'insert into public.agent_journal_records(user_id,agent_instance_id,installation_id,seq,recorded_at,received_at,category,code,props) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        user,
        '10000000-0000-4000-8000-000000000010',
        null,
        seq,
        '2026-11-12T10:00:00Z',
        received,
        'update',
        'native_update_stage',
        JSON.stringify({
          installation_id: native.installationId,
          operation_id: native.operationId,
          attempt_id: native.attemptId,
          stage,
          revision: seq,
          native_success: nativeSuccess,
          ui_success: uiSuccess
        })
      ]
    );
  }
});
afterAll(async () => {
  await fixture?.close();
});
describe('as-of native update diagnosis', () => {
  it('does not use a future-delivered UI receipt to claim earlier user success', async () => {
    const period = { token: 'all', label: 'test', start: null, end: '2026-11-12T10:02:00Z' };
    const before = await getNativeUpdateEvidence(period, { userId: user });
    expect(before.attempts[0]?.outcome).toBe('native_success_ui_unconfirmed');
    const after = await getNativeUpdateEvidence(
      { ...period, end: '2026-11-12T10:06:00Z' },
      { userId: user }
    );
    expect(after.attempts[0]?.outcome).toBe('ui_success');
    expect(
      (await getNativeUpdateEvidence(period, { userId: '10000000-0000-4000-8000-000000000098' }))
        .attempts
    ).toHaveLength(0);
  });
});
