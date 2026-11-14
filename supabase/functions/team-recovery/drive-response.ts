import { isRecord } from '../_shared/validation.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { parseTeamEdgeResult } from '../../../packages/shared/dist/team/transport.js';

export async function recoveryDriveResult(response: Response): Promise<unknown> {
  const value: unknown = await response.json().catch(() => null);
  const parsed = parseTeamEdgeResult(value);
  // Preserve only closed, structured failures. In particular, the claim handler
  // must see RESTITCH_CLIENT_OUTDATED to settle its proven no-job reservation.
  // Unreadable/unknown replies still leave the mutation's outcome uncertain.
  if (
    !parsed.ok &&
    isRecord(value) &&
    value.ok === false &&
    isRecord(value.error) &&
    value.error.code === parsed.error.code &&
    typeof value.error.retryable === 'boolean'
  ) {
    throw new TeamFunctionError(parsed.error.code, {
      retryable: parsed.error.retryable,
      details: parsed.error.details
    });
  }
  if (!response.ok || !parsed.ok) throw new TeamFunctionError('DRIVE_UNAVAILABLE');
  return parsed.value;
}
