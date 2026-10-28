import {
  parseLaunchAssignmentState,
  parseLaunchAssignmentReceipt,
  type LaunchAssignmentReceipt
} from '@video-compressor/shared';
import { requireSupabaseClient, withFreshSession } from '../lib/supabase';
import { TeamApiError, throwRpc } from './team';

export const LAUNCH_ASSIGNMENTS_CHANGED_EVENT = 'soty:launch-assignments-changed';
export interface SetLaunchAssignment {
  teamId: string;
  launchId: string;
  agentRowId: string | null;
  expectedVersion: string;
  requestKey: string;
}
const definitive = new Set([
  'LAUNCH_VERSION_CONFLICT',
  'ACCOUNT_ARCHIVED',
  'NOT_FOUND',
  'PERMISSION_DENIED',
  'INVALID_INPUT'
]);
export function isDefinitiveAssignmentError(error: unknown): boolean {
  return error instanceof TeamApiError && definitive.has(error.code);
}
function receiptMatches(receipt: LaunchAssignmentReceipt, input: SetLaunchAssignment) {
  return (
    receipt.launchId === input.launchId &&
    receipt.requestKey === input.requestKey &&
    receipt.agentRowId === input.agentRowId &&
    receipt.state === (input.agentRowId === null ? 'released' : 'assigned')
  );
}
function changed(teamId: string) {
  if (typeof window !== 'undefined')
    window.dispatchEvent(new CustomEvent(LAUNCH_ASSIGNMENTS_CHANGED_EVENT, { detail: { teamId } }));
}

export const launchAssignmentsApi = {
  async read(teamId: string, launchId: string) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('get_launch_assignment', { p_team: teamId, p_launch: launchId })
    );
    throwRpc(error);
    const result = parseLaunchAssignmentState(data);
    if (!result || result.launchId !== launchId) throw new TeamApiError('INVALID_RESPONSE', false);
    return result;
  },
  async readMutation(teamId: string, requestKey: string) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('get_launch_assignment_mutation', {
        p_team: teamId,
        p_key: requestKey
      })
    );
    throwRpc(error);
    if (data === null) return null;
    const result = parseLaunchAssignmentReceipt(data);
    if (!result || result.requestKey !== requestKey)
      throw new TeamApiError('INVALID_RESPONSE', false);
    return result;
  },
  async set(input: SetLaunchAssignment): Promise<LaunchAssignmentReceipt> {
    try {
      const { data, error } = await withFreshSession(() =>
        requireSupabaseClient().rpc('set_launch_assignment', {
          p_team: input.teamId,
          p_launch: input.launchId,
          p_agent: input.agentRowId,
          p_expected_version: input.expectedVersion,
          p_key: input.requestKey
        })
      );
      throwRpc(error);
      const result = parseLaunchAssignmentReceipt(data);
      if (!result || !receiptMatches(result, input))
        throw new TeamApiError('INVALID_RESPONSE', false);
      changed(input.teamId);
      return result;
    } catch (error) {
      if (isDefinitiveAssignmentError(error)) throw error;
      // A lost response is not a rejected write. Read the actor-scoped durable
      // receipt before allowing a retry; callers keep this exact request key.
      try {
        const result = await launchAssignmentsApi.readMutation(input.teamId, input.requestKey);
        if (result && receiptMatches(result, input)) {
          changed(input.teamId);
          return result;
        }
      } catch {
        // A failed readback cannot establish whether the write committed.
      }
      throw new TeamApiError('LAUNCH_RESULT_UNCERTAIN', true);
    }
  }
};
