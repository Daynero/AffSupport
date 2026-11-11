import { isRecord, parseTeamProcessStartResult, RECOVERY_BUDGET } from '@video-compressor/shared';
import {
  CatalogVariantExecutor,
  type CatalogVariantSnapshot,
  type CatalogVariantChild
} from './catalog-variant-executor.js';
import { catalogVariantProcessAdapter } from './catalog-variant-process.js';
import type { NativeRestitchEnrollment } from './native-restitch-controller.js';
import type { TeamFileOperationResult } from '@video-compressor/shared';
import type { TeamProcessBridge, TeamProcessRequest } from './process.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
/** One native delegation drives one set at a time. The existing recovery
 * transport owns credential rotation and endpoint validation. */
export async function runCatalogVariantRecovery(input: {
  nativeInstanceId: string;
  /** This agent's own functions base (`<backend origin>/functions/v1`). The
   * transfer and finalize URLs are derived from it, never taken from the server
   * response: 1.4.1 production issued beta loopback URLs and the native source
   * guard refused every download locally. */
  functionsBase?: string;
  /** Exact foreground set; never invokes the background global claim. */
  initialSetId?: string;
  call: (action: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  process: Pick<TeamProcessBridge, 'process' | 'cancel'>;
  closureCall?: (action: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  signal: AbortSignal;
  protectedProcess?: (
    request: TeamProcessRequest,
    enroll: (local: NativeRestitchEnrollment) => Promise<Record<string, unknown>>,
    signal: AbortSignal,
    authorize: () => Promise<void>,
    complete: (outcome: 'canceled' | 'failed', code: string) => Promise<Record<string, unknown>>,
    cancellationRequested: () => Promise<boolean>
  ) => Promise<TeamFileOperationResult>;
  progress?: (setId: string, ready: number, total: number) => void;
}): Promise<string | null> {
  const current = () => {
    if (input.signal.aborted)
      throw new Error(
        input.signal.reason instanceof Error &&
          ['PROCESS_RESULT_UNCERTAIN', 'PERMISSION_DENIED'].includes(input.signal.reason.message)
          ? input.signal.reason.message
          : 'PROCESS_CANCELED'
      );
  };
  const invoke = async (action: string, body: Record<string, unknown>) => {
    current();
    const result = await input.call(action, {
      ...body,
      nativeInstanceId: input.nativeInstanceId,
      variantProtocolVersion: 1
    });
    current();
    return result;
  };
  const claim =
    input.initialSetId === undefined
      ? await invoke('variant_claim', {})
      : { setId: input.initialSetId };
  if (claim.setId === null) return null;
  if (typeof claim.setId !== 'string' || !UUID.test(claim.setId))
    throw new Error('INVALID_RESPONSE');
  const setId = claim.setId;
  const body = (child: Readonly<CatalogVariantChild>) => ({
    setId,
    index: child.index,
    requestId: child.requestId,
    operationId: child.operationId
  });
  let activeChild: Readonly<CatalogVariantChild> | null = null;
  const process = catalogVariantProcessAdapter({
    bridge: {
      cancel: operationId => input.process.cancel(operationId),
      process: async request => {
        const child = activeChild;
        if (!child || child.operationId !== request.operationId)
          throw new Error('PROCESS_RESULT_UNCERTAIN');
        if (
          !input.protectedProcess &&
          isRecord(request.options) &&
          typeof request.options.restitchSelectionRootId === 'string'
        )
          throw new Error('AGENT_UPDATE_REQUIRED');
        const local = new AbortController(),
          signal = AbortSignal.any([input.signal, local.signal]);
        let busy = false,
          closed = false,
          interruption: 'PROCESS_CANCELED' | 'PROCESS_RESULT_UNCERTAIN' | null = null;
        const interrupt = (code: 'PROCESS_CANCELED' | 'PROCESS_RESULT_UNCERTAIN') => {
          if (closed) return;
          interruption = code;
          local.abort(new Error(code));
          if (!input.protectedProcess) input.process.cancel(request.operationId);
        };
        const heartbeat = setInterval(() => {
          if (busy || closed) return;
          busy = true;
          void invoke('variant_heartbeat', body(child))
            .then(value => {
              if (closed) return;
              if (value.registered === true) {
                clearInterval(heartbeat);
                return;
              }
              if (value.continue !== true)
                interrupt(
                  value.reason === 'canceled' ? 'PROCESS_CANCELED' : 'PROCESS_RESULT_UNCERTAIN'
                );
            })
            .catch(() => interrupt('PROCESS_RESULT_UNCERTAIN'))
            .finally(() => {
              busy = false;
            });
        }, RECOVERY_BUDGET.heartbeatMs);
        heartbeat.unref();
        const complete = async (outcome: 'canceled' | 'failed', code: string) => {
          const result = await (input.closureCall ?? input.call)('variant_complete', {
            ...body(child),
            nativeInstanceId: input.nativeInstanceId,
            variantProtocolVersion: 1,
            outcome,
            failureCode: code
          });
          if (
            result.operationId !== request.operationId ||
            !['registered', 'terminal', 'unknown'].includes(String(result.kind))
          )
            throw new Error('INVALID_RESPONSE');
          if (
            result.kind === 'registered' &&
            (typeof result.outputId !== 'string' || !UUID.test(result.outputId))
          )
            throw new Error('INVALID_RESPONSE');
          return result;
        };
        try {
          return await (input.protectedProcess
            ? input.protectedProcess(
                request,
                async localEnrollment => {
                  if (
                    localEnrollment.rootOperationId !== request.operationId ||
                    localEnrollment.nativeInstanceId !== input.nativeInstanceId
                  )
                    throw new Error('INVALID_RESPONSE');
                  return invoke('variant_enroll', {
                    ...body(child),
                    enrollment: {
                      enrollmentId: localEnrollment.enrollmentId,
                      proofDigest: localEnrollment.proofDigest
                    }
                  });
                },
                signal,
                async () => {
                  const result = await invoke('variant_authorize', body(child));
                  if (result.authorized !== true) throw new Error('PERMISSION_DENIED');
                },
                complete,
                async () => {
                  try {
                    const value = await (input.closureCall ?? input.call)('variant_heartbeat', {
                      ...body(child),
                      nativeInstanceId: input.nativeInstanceId,
                      variantProtocolVersion: 1
                    });
                    return (
                      value.continue === false &&
                      value.reason === 'canceled' &&
                      value.registered !== true
                    );
                  } catch {
                    return false;
                  }
                }
              )
            : input.process.process(request));
        } catch (error) {
          if (interruption === 'PROCESS_RESULT_UNCERTAIN')
            throw new Error('PROCESS_RESULT_UNCERTAIN', { cause: error });
          throw error;
        } finally {
          closed = true;
          clearInterval(heartbeat);
        }
      }
    },
    authorizeExecution: async child => {
      const result = await invoke('variant_dispatch', body(child));
      if (typeof result.executionAllowed !== 'boolean') throw new Error('INVALID_RESPONSE');
      return result.executionAllowed;
    },
    claim: async child => {
      activeChild = child;
      const result = await invoke('variant_process', body(child));
      const parsed = parseTeamProcessStartResult(result);
      if (
        !parsed ||
        parsed.operationId !== child.operationId ||
        typeof result.transferUrl !== 'string' ||
        typeof result.cloudBaseUrl !== 'string' ||
        !isRecord(result.options)
      )
        throw new Error('INVALID_RESPONSE');
      return {
        operationId: parsed.operationId,
        toolId: 'restitch',
        sourceGrant: parsed.sourceGrant,
        finalizeGrant: parsed.finalizeGrant,
        transferUrl: input.functionsBase
          ? input.functionsBase + '/drive-transfer/range'
          : result.transferUrl,
        cloudBaseUrl: input.functionsBase
          ? input.functionsBase + '/drive-ops'
          : result.cloudBaseUrl,
        options: result.options
      } as TeamProcessRequest;
    }
  });
  const executor = new CatalogVariantExecutor({
    load: async () =>
      (await invoke('variant_load', { setId })) as unknown as CatalogVariantSnapshot,
    save: async (expectedRevision, snapshot) => {
      const result = await invoke('variant_save', { setId, expectedRevision, snapshot });
      if (typeof result.saved !== 'boolean') throw new Error('INVALID_RESPONSE');
      return result.saved;
    },
    reconcile: async child => {
      const result = await invoke('variant_reconcile', body(child));
      if (
        result.kind === 'unknown' &&
        isRecord(result.retry) &&
        typeof result.retry.attempt === 'number' &&
        Number.isSafeInteger(result.retry.attempt) &&
        result.retry.attempt >= 1 &&
        result.retry.attempt <= 2
      )
        return { kind: 'unknown', retry: { attempt: result.retry.attempt } };
      if (result.kind === 'absent' || result.kind === 'unknown') return { kind: result.kind };
      if (
        (result.kind === 'registered' || result.kind === 'admitted') &&
        typeof result.operationId === 'string' &&
        UUID.test(result.operationId)
      ) {
        if (result.kind === 'admitted')
          return { kind: 'admitted', operationId: result.operationId };
        if (typeof result.outputId === 'string' && UUID.test(result.outputId))
          return { kind: 'registered', operationId: result.operationId, outputId: result.outputId };
      }
      throw new Error('INVALID_RESPONSE');
    },
    admit: async child => {
      const result = await invoke('variant_admit', body(child));
      if (typeof result.operationId !== 'string' || !UUID.test(result.operationId))
        throw new Error('INVALID_RESPONSE');
      return { operationId: result.operationId };
    },
    execute: process
  });
  await executor.run(input.signal, (ready, total) => input.progress?.(setId, ready, total));
  return setId;
}
