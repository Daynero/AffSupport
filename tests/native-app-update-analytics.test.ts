// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { DiagnosticsLog } from '../apps/agent/src/server/diagnostics-log';
import { isForwardableRecord } from '../apps/web/src/analytics/journal-forwarder';
import { diagnoseNativeUpdates } from '../scripts/analytics/native-app-updates';
import { lookupCodeLocations } from '../scripts/analytics/code-map';
import { NATIVE_UPDATE_CODES } from '../packages/shared/src/native-app-updates';
import { nativeSnapshot } from './support/native-app-updates';
describe('native update producer through the journal privacy boundary', () => {
  it('preserves native/UI distinction without paths, identity credentials or contents', async () => {
    const state = nativeSnapshot();
    const now = Date.parse('2026-11-12T10:00:00Z');
    const log = new DiagnosticsLog({
      instanceId: '10000000-0000-4000-8000-000000000010',
      now: () => now
    });
    expect(
      log.record('update', 'native_update_stage', {
        stage: 'native_ready',
        last_proven_stage: 'native_ready',
        revision: 3,
        operation_id: state.operationId!,
        attempt_id: state.attemptId!,
        installation_id: state.installationId,
        target: 'macos-arm64',
        artifact_sha256: 'a'.repeat(64),
        native_success: true,
        ui_success: false,
        receipt_readback: true,
        native_at_ms: now - 1000
      })
    ).toBe(true);
    const record = log.since(0)[0]!;
    expect(isForwardableRecord(record, now)).toBe(true);
    const diagnosis = diagnoseNativeUpdates([
      { props: record.props!, recorded_at: new Date(record.at).toISOString() }
    ]);
    expect(diagnosis.attempts[0]?.outcome).toBe('native_success_ui_unconfirmed');
    expect(
      log.record('update', 'native_update_stage', {
        stage: 'failed',
        detail: '/Users/private/video.mov'
      })
    ).toBe(false);
    for (const code of NATIVE_UPDATE_CODES)
      expect(lookupCodeLocations(`update:native:${code}`)).toBeTruthy();
    await log.close();
  });
});
