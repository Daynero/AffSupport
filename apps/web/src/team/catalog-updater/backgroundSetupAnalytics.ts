import type { RecoverySetupObservation } from '../../api/recovery.js';
import { analytics } from '../../analytics/service.js';
import { TEAM_ERROR_CODES } from '@video-compressor/shared';

const SETUP_CODES = new Set<string>([
  ...TEAM_ERROR_CODES,
  'ENTITLEMENT_SIGNIN_REQUIRED',
  'ENTITLEMENT_BLOCKED',
  'AUTH_REQUIRED',
  'INVALID_RESPONSE'
]);

/** Only closed stages/outcomes and an opaque flow ID; never tickets or provider data. */
export function observeBackgroundSetup(event: RecoverySetupObservation) {
  const step = `background_setup_${event.stage}`;
  const properties = { flow_id: event.flowId, flow_step: step };
  try {
    analytics.track(
      event.outcome === 'started'
        ? 'operation_started'
        : event.outcome === 'succeeded'
          ? 'operation_completed'
          : event.outcome === 'canceled'
            ? 'operation_cancelled'
            : 'operation_failed',
      {
        ...properties,
        ...(event.errorCode
          ? { error_code: SETUP_CODES.has(event.errorCode) ? event.errorCode : 'UNKNOWN' }
          : {}),
        ...(event.outcome === 'started'
          ? {}
          : {
              outcome:
                event.outcome === 'succeeded'
                  ? 'success'
                  : event.outcome === 'canceled'
                    ? 'cancelled'
                    : 'failure'
            })
      }
    );
  } catch {
    /* Optional telemetry cannot change credential ownership. */
  }
}
