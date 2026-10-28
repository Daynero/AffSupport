import { financeRecord, parseTeamAgentAvailability } from '@video-compressor/shared';
import { requireSupabaseClient, withFreshSession } from '../lib/supabase';
import { TeamApiError, throwRpc } from './team';
import { LAUNCH_ASSIGNMENTS_CHANGED_EVENT } from './team-launch-assignments';
export interface ReleaseAgentRequest {
  teamId: string;
  agentRowId: string;
  expectedVersion: string;
  requestKey: string;
}
function result(value: unknown, agentRowId: string) {
  if (
    !financeRecord(value) ||
    value.agentRowId !== agentRowId ||
    typeof value.version !== 'string' ||
    !value.version ||
    !parseTeamAgentAvailability(value.availability)
  )
    throw new TeamApiError('INVALID_RESPONSE', false);
  return value;
}
export const agentReleaseApi = {
  async read(teamId: string, agentRowId: string) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('get_team_agent_assignment_state', {
        p_team: teamId,
        p_agent: agentRowId
      })
    );
    throwRpc(error);
    return result(data, agentRowId);
  },
  async release(input: ReleaseAgentRequest) {
    const validate = (data: unknown) => {
      const receipt = result(data, input.agentRowId);
      if (
        receipt.requestKey !== input.requestKey ||
        typeof receipt.operationId !== 'string' ||
        !financeRecord(receipt.availability) ||
        receipt.availability.status !== 'free' ||
        !Number.isSafeInteger(receipt.releasedCount) ||
        Number(receipt.releasedCount) < 0 ||
        !Number.isSafeInteger(receipt.clearedManualCount) ||
        Number(receipt.clearedManualCount) < 0
      )
        throw new TeamApiError('INVALID_RESPONSE', false);
      if (typeof window !== 'undefined')
        window.dispatchEvent(
          new CustomEvent(LAUNCH_ASSIGNMENTS_CHANGED_EVENT, { detail: { teamId: input.teamId } })
        );
      return receipt;
    };
    try {
      const { data, error } = await withFreshSession(() =>
        requireSupabaseClient().rpc('release_team_agent_assignments', {
          p_team: input.teamId,
          p_agent: input.agentRowId,
          p_expected_version: input.expectedVersion,
          p_key: input.requestKey
        })
      );
      throwRpc(error);
      return validate(data);
    } catch (error) {
      if (
        error instanceof TeamApiError &&
        [
          'LAUNCH_VERSION_CONFLICT',
          'WRONG_STATE',
          'NOT_FOUND',
          'PERMISSION_DENIED',
          'INVALID_INPUT'
        ].includes(error.code)
      )
        throw error;
      try {
        const { data, error: readError } = await withFreshSession(() =>
          requireSupabaseClient().rpc('get_launch_assignment_mutation', {
            p_team: input.teamId,
            p_key: input.requestKey
          })
        );
        throwRpc(readError);
        if (data !== null) return validate(data);
      } catch {
        /* No receipt is not proof of a rejected write. Keep the same request. */
      }
      throw new TeamApiError('LAUNCH_RESULT_UNCERTAIN', true);
    }
  }
};
