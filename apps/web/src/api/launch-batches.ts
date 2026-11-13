import {
  parseDurableLaunchBatch,
  parseDurableLaunchBatchList,
  parseLaunchBatchCommand,
  type DurableLaunchBatch,
  type LaunchBatchCommand
} from '@video-compressor/shared';
import { requireSupabaseClient, withFreshSession } from '../lib/supabase.js';
import { privateCacheActor, privateCacheActorEpoch } from '../team/private-cache-scope.js';
import { invokeTeamFunction, TeamApiError, throwRpc } from './team.js';

export function batchMatchesCommand(batch: DurableLaunchBatch, command: LaunchBatchCommand) {
  return (
    batch.teamId === command.teamId &&
    batch.requestKey === command.requestKey &&
    batch.items.length === command.items.length &&
    command.items.every((item, index) => {
      const accepted = batch.items[index];
      return (
        accepted?.launchId === item.launchId &&
        accepted.expectedVersion === item.expectedVersion &&
        accepted.childRequestKey === item.childRequestKey
      );
    })
  );
}
const receipt = (value: unknown, teamId: string, requestKey: string) => {
  const parsed = parseDurableLaunchBatch(value);
  if (!parsed || parsed.teamId !== teamId || parsed.requestKey !== requestKey)
    throw new TeamApiError('INVALID_RESPONSE', false);
  return parsed;
};
export const launchBatchApi = {
  async submit(command: LaunchBatchCommand, signal?: AbortSignal) {
    const parsed = parseLaunchBatchCommand(command);
    if (!parsed) throw new TeamApiError('INVALID_INPUT', false);
    if (parsed.expectedActorId !== privateCacheActor())
      throw new TeamApiError('PERMISSION_DENIED', false);
    const value = await invokeTeamFunction(
      'drive-ops/launches/batch',
      { ...parsed },
      (data: unknown): data is DurableLaunchBatch => parseDurableLaunchBatch(data) !== null,
      { signal }
    );
    const batch = receipt(value, parsed.teamId, parsed.requestKey);
    if (!batchMatchesCommand(batch, parsed)) throw new TeamApiError('INVALID_RESPONSE', false);
    return batch;
  },
  async read(teamId: string, requestKey: string, signal?: AbortSignal) {
    const { data, error } = await withFreshSession(() => {
      const query = requireSupabaseClient().rpc('get_launch_batch', {
        p_team: teamId,
        p_key: requestKey
      });
      return signal ? query.abortSignal(signal) : query;
    });
    throwRpc(error);
    return data === null ? null : receipt(data, teamId, requestKey);
  },
  async list(
    teamId: string,
    cursor?: { createdAt: string; id: string } | null,
    signal?: AbortSignal
  ) {
    const { data, error } = await withFreshSession(() => {
      const query = requireSupabaseClient().rpc('list_launch_batches', {
        p_team: teamId,
        p_limit: 10,
        ...(cursor ? { p_before: cursor.createdAt, p_before_id: cursor.id } : {})
      });
      return signal ? query.abortSignal(signal) : query;
    });
    throwRpc(error);
    const parsed = parseDurableLaunchBatchList(data);
    if (!parsed || parsed.items.some(batch => batch.teamId !== teamId))
      throw new TeamApiError('INVALID_RESPONSE', false);
    return parsed;
  },
  async cancel(
    teamId: string,
    requestKey: string,
    cancelKey: string,
    actorId: string,
    signal?: AbortSignal
  ) {
    const epoch = privateCacheActorEpoch();
    const { data, error } = await withFreshSession(() => {
      if (privateCacheActor() !== actorId || privateCacheActorEpoch() !== epoch)
        throw new TeamApiError('PERMISSION_DENIED', false);
      const query = requireSupabaseClient().rpc('cancel_launch_batch', {
        p_team: teamId,
        p_key: requestKey,
        p_cancel_key: cancelKey,
        p_expected_actor: actorId
      });
      return signal ? query.abortSignal(signal) : query;
    });
    throwRpc(error);
    return receipt(data, teamId, requestKey);
  }
};
