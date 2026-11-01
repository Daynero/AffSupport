import { TEAM_ERROR_CODES } from '@video-compressor/shared';
import { analytics } from '../../analytics/service';
const KEY = 'soty.drive-attempt.v1';
export function beginDriveAttempt(): void {
  try {
    const id = crypto.randomUUID();
    sessionStorage.setItem(KEY, JSON.stringify({ id, at: Date.now() }));
    analytics.track('operation_started', { flow_id: id, attempt_id: id, flow_step: 'drive_oauth' });
  } catch {
    /* Diagnostics never change access. */
  }
}
export function finishDriveAttempt(result: string): void {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return;
    sessionStorage.removeItem(KEY);
    const value = JSON.parse(raw) as { id: string; at: number };
    if (
      typeof value.id !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(value.id) ||
      !Number.isFinite(value.at) ||
      Date.now() - value.at > 15 * 60 * 1000
    )
      return;
    const properties = {
      flow_id: value.id,
      attempt_id: value.id,
      flow_step: 'drive_oauth',
      duration_ms: Math.max(0, Date.now() - value.at)
    };
    if (result === 'connected')
      analytics.track('operation_completed', { ...properties, outcome: 'success' });
    else {
      const code = TEAM_ERROR_CODES.find(code => code === result) ?? 'unknown';
      analytics.track('error_occurred', {
        ...properties,
        outcome: 'failure',
        error_code: code,
        error_stage: 'library',
        error_fingerprint: `team:access:${code}`
      });
      analytics.track('operation_failed', { ...properties, outcome: 'failure', error_code: code });
    }
  } catch {
    /* Missing callback delivery remains unknown. */
  }
}
