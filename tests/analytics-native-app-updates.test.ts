import { describe, expect, it } from 'vitest';
import {
  diagnoseNativeUpdates,
  inspectNativeUpdate
} from '../scripts/analytics/native-app-updates';
import { nativeSnapshot } from './support/native-app-updates';
const snap = nativeSnapshot();
const row = (stage: string, revision: number, native = false, ui = false) => ({
  recorded_at: '2026-11-12T10:00:00Z',
  props: {
    installation_id: snap.installationId,
    attempt_id: snap.attemptId,
    operation_id: snap.operationId,
    stage,
    revision,
    native_success: native,
    ui_success: ui,
    target: 'macos-arm64',
    artifact_sha256: 'a'.repeat(64)
  }
});
describe('native receipt diagnosis', () => {
  it('orders delayed receipts by native revision and deduplicates cross-boot replay', () => {
    const data = diagnoseNativeUpdates([
      row('native_ready', 3, true),
      row('consented', 1),
      row('target_started', 2),
      row('native_ready', 3, true)
    ]);
    expect(data.attempts[0]?.observed_stages).toEqual([
      'consented',
      'target_started',
      'native_ready'
    ]);
    expect(data.attempts[0]?.outcome).toBe('native_success_ui_unconfirmed');
    expect(inspectNativeUpdate(snap.attemptId!, data)?.terminal?.outcome).toBe(
      'native_success_ui_unconfirmed'
    );
  });
  it('needs the explicit UI receipt and never infers success from target start', () => {
    expect(diagnoseNativeUpdates([row('target_started', 2)]).attempts[0]?.native_success).toBe(
      false
    );
    const data = diagnoseNativeUpdates([row('ui_visible', 4, true, true)]);
    expect(data.attempts[0]?.ui_success).toBe(true);
    expect(diagnoseNativeUpdates([row('ui_visible', 4, false, true)]).invalid_records).toBe(1);
  });
  it('keeps unsupported, absent, invalid and truncated evidence explicit', () => {
    expect(diagnoseNativeUpdates([], false).supported).toBe(false);
    expect(diagnoseNativeUpdates([]).blind_spots.join(' ')).toContain('does not prove');
    expect(diagnoseNativeUpdates([row('magic', 1)]).invalid_records).toBe(1);
    expect(
      diagnoseNativeUpdates(Array.from({ length: 1001 }, () => row('consented', 1))).truncated
    ).toBe(true);
  });
});
