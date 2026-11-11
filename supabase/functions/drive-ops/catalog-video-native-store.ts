import { parseTeamRestitchDefaults } from '../../../packages/shared/dist/team/restitch.js';
import type { ServiceRpcClient } from '../_shared/credentials.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';
import { catalogVideoSetStore } from './catalog-video-set-store.ts';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
interface Child {
  index: number;
  requestId: string;
  operationId: string | null;
}
/** Trusted team-recovery handler supplies the existing credential hash. This
 * factory never accepts service credentials or delegated identity from a body. */
export function catalogVideoNativeStore(
  service: ServiceRpcClient,
  original: {
    setId: string;
    nativeInstanceId: string;
    claimHash: string;
    protocolVersion: 1;
  }
) {
  const input = { ...original };
  let captured: {
    setId: string;
    teamId: string;
    actorId: string;
    executorId: string;
    epoch: number;
  } | null = null;
  const native = () => ({
    p_set: input.setId,
    p_hash: input.claimHash,
    p_native: input.nativeInstanceId,
    p_protocol: input.protocolVersion
  });
  const call = async (name: string, body: Record<string, unknown>) => {
    const value = await service.rpc(name, body);
    if (value.error) {
      switch (value.error.message) {
        case 'PERMISSION_DENIED':
        case 'AUTH_REQUIRED':
        case 'AGENT_UPDATE_REQUIRED':
        case 'WRONG_STATE':
        case 'REQUEST_REUSE_CONFLICT':
        case 'SOURCE_CHANGED':
          throw new TeamFunctionError(value.error.message, { retryable: false });
        default:
          throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN', { retryable: false });
      }
    }
    return value.data;
  };
  const authorize = async () => {
    const value = await call('service_authorize_catalog_video_executor', native());
    if (
      !isRecord(value) ||
      value.setId !== input.setId ||
      value.nativeInstanceId !== input.nativeInstanceId ||
      typeof value.teamId !== 'string' ||
      !UUID.test(value.teamId) ||
      typeof value.actorId !== 'string' ||
      !UUID.test(value.actorId) ||
      typeof value.executorId !== 'string' ||
      !UUID.test(value.executorId) ||
      typeof value.epoch !== 'number' ||
      !Number.isSafeInteger(value.epoch) ||
      value.epoch < 1
    )
      throw new TeamFunctionError('INVALID_RESPONSE');
    const scope = {
      setId: value.setId as string,
      teamId: value.teamId,
      actorId: value.actorId,
      executorId: value.executorId,
      epoch: value.epoch
    };
    if (captured && JSON.stringify(captured) !== JSON.stringify(scope))
      throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
    captured = scope;
    return catalogVideoSetStore(service, scope);
  };
  const childScope = (child: Child) => ({
    ...native(),
    p_index: child.index,
    p_request: child.requestId,
    p_operation: child.operationId
  });
  return {
    async load() {
      return (await authorize()).load();
    },
    async save(revision: number, next: { setId: string; revision: number; children: unknown[] }) {
      return (await authorize()).save(revision, next);
    },
    async reconcile(child: Child, options: { retry?: boolean } = { retry: true }) {
      return (await authorize()).reconcile(child.index, child.requestId, options);
    },
    async dispatch(child: Child) {
      await authorize();
      if (!child.operationId) throw new TeamFunctionError('INVALID_INPUT');
      const result = await call('service_dispatch_catalog_video_variant', childScope(child));
      if (
        !isRecord(result) ||
        result.operationId !== child.operationId ||
        result.requestId !== child.requestId ||
        typeof result.executionAllowed !== 'boolean'
      )
        throw new TeamFunctionError('INVALID_RESPONSE');
      return result.executionAllowed;
    },
    async heartbeat(child: Child) {
      // The server's only proof that the executor is alive: silence lets a
      // restarted agent take the variant over and a cancellation settle. Best
      // effort — a heartbeat never fails because the note could not be written.
      try {
        await service.rpc('service_note_catalog_video_variant_heartbeat', childScope(child));
      } catch {
        // Recorded on the next heartbeat.
      }
      const observed = await this.reconcile(child, { retry: false });
      if (observed.kind === 'registered') return { continue: true, registered: true };
      await authorize();
      const accepted = await call('service_read_catalog_video_acceptance', {
        p_set: captured!.setId,
        p_team: captured!.teamId,
        p_actor: captured!.actorId
      });
      if (
        !isRecord(accepted) ||
        !isRecord(accepted.snapshot) ||
        !Array.isArray(accepted.snapshot.children)
      )
        throw new TeamFunctionError('INVALID_RESPONSE');
      const original = accepted.snapshot.children[child.index];
      if (
        !isRecord(original) ||
        original.requestId !== child.requestId ||
        original.operationId !== child.operationId
      )
        throw new TeamFunctionError('PERMISSION_DENIED');
      if (accepted.parentState === 'cancel_requested' || accepted.parentState === 'canceled')
        return { continue: false, registered: false, reason: 'canceled' };
      await this.processContext(child);
      return { continue: true, registered: false };
    },
    async complete(child: Child, outcome: 'canceled' | 'failed', code: string) {
      const result = await call('service_complete_catalog_video_variant', {
        ...childScope(child),
        p_outcome: outcome,
        p_code: code
      });
      if (
        !isRecord(result) ||
        result.operationId !== child.operationId ||
        !['registered', 'terminal', 'unknown'].includes(String(result.kind))
      )
        throw new TeamFunctionError('INVALID_RESPONSE');
      return result;
    },
    async processContext(child: Child) {
      await authorize();
      const result = await call('service_read_catalog_video_process_context', childScope(child));
      if (
        !isRecord(result) ||
        result.operationId !== child.operationId ||
        !['pending', 'running'].includes(String(result.operationState)) ||
        result.teamId !== captured?.teamId ||
        result.actorId !== captured?.actorId ||
        (result.destinationFolderId !== null &&
          (typeof result.destinationFolderId !== 'string' ||
            !UUID.test(result.destinationFolderId))) ||
        typeof result.materialId !== 'string' ||
        !UUID.test(result.materialId) ||
        typeof result.sourceVersion !== 'string' ||
        !isRecord(result.settings) ||
        typeof result.settingsDigest !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(result.settingsDigest) ||
        typeof result.sourceSizeBytes !== 'number' ||
        !Number.isSafeInteger(result.sourceSizeBytes) ||
        result.sourceSizeBytes <= 0
      )
        throw new TeamFunctionError('INVALID_RESPONSE');
      const parsed = parseTeamRestitchDefaults(result.settings);
      if (!parsed.ok) throw new TeamFunctionError('RESTITCH_INVALID');
      const range = result.settings.finalDurationRangeSeconds;
      if (
        range !== undefined &&
        (!Array.isArray(range) ||
          range.length !== 2 ||
          parsed.value.finalDurationMode !== 'random-centered' ||
          range.some(
            value =>
              typeof value !== 'number' ||
              !Number.isInteger(value) ||
              value < 60 ||
              value > 3600 ||
              value % 60 !== 0
          ) ||
          range[0] > range[1])
      )
        throw new TeamFunctionError('RESTITCH_INVALID');
      const settings =
        range === undefined
          ? parsed.value
          : { ...parsed.value, finalDurationRangeSeconds: [...range] as [number, number] };
      return {
        operationId: child.operationId!,
        operationState: result.operationState as 'pending' | 'running',
        teamId: captured!.teamId,
        actorId: captured!.actorId,
        materialId: result.materialId,
        destinationFolderId: result.destinationFolderId as string | null,
        sourceVersion: result.sourceVersion,
        sourceSizeBytes: result.sourceSizeBytes,
        settings,
        settingsDigest: result.settingsDigest
      };
    }
  };
}
