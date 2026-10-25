import { analytics } from '../analytics/service';
import { requireSupabaseClient, withFreshSession } from '../lib/supabase';
import { TeamApiError, throwRpc } from './team';
export interface LaunchCopyScope {
  teamId: string;
  launchId: string;
  revisionId: string;
  actorId: string;
}
/** Values travel only in a protected request, never browser storage or analytics. */
function signal(
  event: 'operation_started' | 'operation_completed' | 'operation_failed',
  step: string,
  id: string
) {
  try {
    analytics.track(event, { flow_step: step, flow_id: id, attempt_id: id });
  } catch {
    /* Persistence is independent of telemetry delivery. */
  }
}
export const launchCopyMarksApi = {
  async read(scope: LaunchCopyScope, values: Record<string, string>): Promise<string[]> {
    const id = crypto.randomUUID();
    const step = 'launch_copy_marks_read';
    signal('operation_started', step, id);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const { data, error } = await withFreshSession(() =>
        requireSupabaseClient()
          .rpc('get_launch_copy_marks', {
            p_team: scope.teamId,
            p_launch: scope.launchId,
            p_revision: scope.revisionId,
            p_actor: scope.actorId,
            p_values: values
          })
          .abortSignal(controller.signal)
      );
      throwRpc(error);
      if (
        !Array.isArray(data) ||
        !data.every(field => typeof field === 'string' && Object.hasOwn(values, field))
      )
        throw new TeamApiError('INVALID_RESPONSE', false);
      signal('operation_completed', step, id);
      return data.filter((field): field is string => typeof field === 'string');
    } catch (error) {
      signal('operation_failed', step, id);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  },
  async write(
    scope: LaunchCopyScope,
    values: Record<string, string>,
    copied: boolean
  ): Promise<void> {
    const id = crypto.randomUUID();
    const step = 'launch_copy_marks_write';
    signal('operation_started', step, id);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const { error } = await withFreshSession(() =>
        requireSupabaseClient()
          .rpc('set_launch_copy_marks', {
            p_team: scope.teamId,
            p_launch: scope.launchId,
            p_revision: scope.revisionId,
            p_actor: scope.actorId,
            p_values: values,
            p_copied: copied
          })
          .abortSignal(controller.signal)
      );
      throwRpc(error);
      signal('operation_completed', step, id);
    } catch (error) {
      signal('operation_failed', step, id);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
};
