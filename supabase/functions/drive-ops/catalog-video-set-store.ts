import { TeamFunctionError } from '../_shared/errors.ts';
import type { ServiceRpcClient } from '../_shared/credentials.ts';
import { isRecord } from '../_shared/validation.ts';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
/** Service-only authority; no route accepts these identities from an arbitrary body. */
export function catalogVideoSetStore(
  service: ServiceRpcClient,
  identity: {
    setId: string;
    teamId: string;
    actorId: string;
    executorId: string;
    epoch: number;
  }
) {
  const captured = { ...identity };
  const scope = () => ({
    p_set: captured.setId,
    p_team: captured.teamId,
    p_actor: captured.actorId,
    p_executor: captured.executorId,
    p_epoch: captured.epoch
  });
  const call = async (name: string, body: Record<string, unknown>) => {
    const result = await service.rpc(name, body);
    if (result.error) {
      switch (result.error.message) {
        case 'PERMISSION_DENIED':
        case 'AUTH_REQUIRED':
        case 'AGENT_UPDATE_REQUIRED':
        case 'WRONG_STATE':
        case 'REQUEST_REUSE_CONFLICT':
        case 'SOURCE_CHANGED':
          throw new TeamFunctionError(result.error.message, { retryable: false });
        default:
          throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN', { retryable: false });
      }
    }
    return result.data;
  };
  return {
    async load() {
      const value = await call('service_read_catalog_video_set', scope());
      if (
        !isRecord(value) ||
        value.setId !== captured.setId ||
        typeof value.revision !== 'number' ||
        !Number.isSafeInteger(value.revision) ||
        value.revision < 0 ||
        !Array.isArray(value.children) ||
        value.children.length < 1 ||
        value.children.length > 400
      )
        throw new TeamFunctionError('INVALID_RESPONSE');
      const requests = new Set<string>(),
        outputs = new Set<string>();
      const children = value.children.map((child, index) => {
        if (
          !isRecord(child) ||
          child.index !== index ||
          typeof child.requestId !== 'string' ||
          !UUID.test(child.requestId) ||
          requests.has(child.requestId) ||
          (child.operationId !== null &&
            (typeof child.operationId !== 'string' || !UUID.test(child.operationId))) ||
          !['queued', 'working', 'unknown', 'registered'].includes(String(child.state)) ||
          (child.state === 'registered'
            ? typeof child.outputId !== 'string' ||
              !UUID.test(child.outputId) ||
              child.operationId === null
            : child.outputId !== null)
        )
          throw new TeamFunctionError('INVALID_RESPONSE');
        requests.add(child.requestId);
        if (typeof child.outputId === 'string') {
          if (outputs.has(child.outputId)) throw new TeamFunctionError('INVALID_RESPONSE');
          outputs.add(child.outputId);
        }
        return {
          index,
          requestId: child.requestId,
          operationId: child.operationId as string | null,
          state: child.state as 'queued' | 'working' | 'unknown' | 'registered',
          outputId: child.outputId as string | null
        };
      });
      return { setId: captured.setId, revision: value.revision, children };
    },
    /** `retry` asks, on an unknown answer, whether the variant's operation is
     * provably failed without output; a granted retry rides on the same
     * `unknown` kind so an agent that predates it behaves exactly as before and
     * simply finds the variant queued on its next run. A heartbeat never asks. */
    async reconcile(index: number, requestId: string, options: { retry?: boolean } = {}) {
      const value = await call('service_reconcile_catalog_video_variant', {
        ...scope(),
        p_index: index,
        p_request: requestId
      });
      if (!isRecord(value)) throw new TeamFunctionError('INVALID_RESPONSE');
      if (value.kind === 'unknown' && options.retry) {
        // A refused or failed retry leaves the honest answer: unknown.
        const retried = await call('service_retry_catalog_video_variant', {
          ...scope(),
          p_index: index,
          p_request: requestId
        }).catch(() => null);
        if (
          isRecord(retried) &&
          retried.kind === 'retry' &&
          typeof retried.attempt === 'number' &&
          Number.isSafeInteger(retried.attempt) &&
          retried.attempt >= 1 &&
          retried.attempt <= 2
        )
          return { kind: 'unknown' as const, retry: { attempt: retried.attempt } };
        return { kind: 'unknown' as const };
      }
      if (value.kind === 'absent' || value.kind === 'unknown') return { kind: value.kind };
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
      if (
        value.kind === 'admitted' &&
        typeof value.operationId === 'string' &&
        uuid.test(value.operationId)
      )
        return { kind: 'admitted' as const, operationId: value.operationId };
      if (
        value.kind !== 'registered' ||
        typeof value.operationId !== 'string' ||
        !uuid.test(value.operationId) ||
        typeof value.outputId !== 'string' ||
        !uuid.test(value.outputId)
      )
        throw new TeamFunctionError('INVALID_RESPONSE');
      return {
        kind: 'registered' as const,
        operationId: value.operationId,
        outputId: value.outputId
      };
    },
    async save(revision: number, next: { setId: string; revision: number; children: unknown[] }) {
      if (next.setId !== captured.setId || next.revision !== revision + 1)
        throw new TeamFunctionError('INVALID_INPUT');
      const value = await call('service_checkpoint_catalog_video_set', {
        ...scope(),
        p_revision: revision,
        p_children: next.children
      });
      if (typeof value !== 'boolean') throw new TeamFunctionError('INVALID_RESPONSE');
      return value;
    },
    async checkpoint(revision: number, children: unknown[]) {
      const value = await call('service_checkpoint_catalog_video_set', {
        ...scope(),
        p_revision: revision,
        p_children: children
      });
      if (typeof value !== 'boolean') throw new TeamFunctionError('INVALID_RESPONSE');
      return value;
    }
  };
}
