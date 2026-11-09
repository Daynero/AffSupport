import { parseRestitchScreens, isRecord, type RestitchScreen } from '@video-compressor/shared';
import {
  ScreenCacheError,
  captureProtectedScreenBinding,
  type ProtectedScreenCacheBinding,
  type TeamScreenCache
} from './screen-cache.js';
import type { DownloadedTeamSource } from './transfer.js';
import type { ScreenRecoveryCandidate, ScreenRecoveryProvider } from './screen-recovery.js';
export type NativeScreenRecoveryScope = Pick<
  ProtectedScreenCacheBinding,
  | 'rootOperationId'
  | 'teamId'
  | 'actorId'
  | 'poolNamespaceId'
  | 'executorId'
  | 'epoch'
  | 'nativeInstanceId'
>;
export interface NativeScreenRecoveryOptions {
  scope: NativeScreenRecoveryScope;
  /** Private native transport, already bound to its enrolled control credential. */
  call: (action: string, body: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
  cache: Pick<TeamScreenCache, 'resolveProtected' | 'refusedProtected'>;
  download: (
    binding: ProtectedScreenCacheBinding,
    signal: AbortSignal
  ) => Promise<DownloadedTeamSource>;
  /** Own original persisted range/refresh IDs; no fresh retry after an unknown ACK. */
  refresh: (
    binding: ProtectedScreenCacheBinding,
    requestId: string,
    signal: AbortSignal
  ) => Promise<unknown>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const invalid = () => new ScreenCacheError('INVALID_RESPONSE');
const uncertain = () => new ScreenCacheError('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN');
/** Connect the real coordinator to control-bound selection and protected cache.
 * Scope and loader come from the native controller, never HTTP request options. */
export function createNativeScreenRecoveryProvider(
  options: NativeScreenRecoveryOptions
): ScreenRecoveryProvider {
  const scope = {
    rootOperationId: options.scope.rootOperationId,
    teamId: options.scope.teamId,
    actorId: options.scope.actorId,
    poolNamespaceId: options.scope.poolNamespaceId,
    executorId: options.scope.executorId,
    epoch: options.scope.epoch,
    nativeInstanceId: options.scope.nativeInstanceId
  };
  for (const field of [
    'rootOperationId',
    'teamId',
    'actorId',
    'poolNamespaceId',
    'executorId',
    'nativeInstanceId'
  ] as const) {
    if (typeof scope[field] !== 'string' || !UUID.test(scope[field])) throw invalid();
    scope[field] = scope[field].toLowerCase();
  }
  if (!Number.isSafeInteger(scope.epoch) || scope.epoch < 1) throw invalid();
  Object.freeze(scope);
  const call = options.call.bind(options),
    download = options.download.bind(options),
    refresh = options.refresh.bind(options),
    cache = options.cache;
  const bindings = new Map<string, Readonly<ProtectedScreenCacheBinding>>(),
    failedRequests = new Map<string, string>();
  const key = (slot: RestitchScreen['slot'], version: string) => slot + ':' + version.toLowerCase();
  const payload = (b: ProtectedScreenCacheBinding) => ({
    slot: b.slot,
    versionId: b.versionId,
    acquisition: b.acquisition
  });
  function remember(value: unknown, slot: RestitchScreen['slot']): ScreenRecoveryCandidate {
    if (!isRecord(value) || value.kind !== 'candidate' || !isRecord(value.candidate))
      throw invalid();
    const binding = captureProtectedScreenBinding(value.binding as ProtectedScreenCacheBinding);
    if (
      binding.slot !== slot ||
      Object.entries(scope).some(
        ([field, expected]) => binding[field as keyof ProtectedScreenCacheBinding] !== expected
      )
    )
      throw invalid();
    const c = value.candidate,
      parsed = parseRestitchScreens([c.screen]);
    if (
      typeof c.versionId !== 'string' ||
      c.versionId.toLowerCase() !== binding.versionId ||
      c.acquisition !== binding.acquisition ||
      !parsed.ok ||
      !parsed.value?.[0]
    )
      throw invalid();
    const screen = parsed.value[0];
    if (
      screen.transfer !== null ||
      (['slot', 'materialId', 'checksum', 'mimeType', 'sizeBytes'] as const).some(
        field => screen[field] !== binding[field]
      )
    )
      throw invalid();
    const id = key(slot, binding.versionId);
    if (!bindings.has(id) && bindings.size >= 64) throw uncertain();
    bindings.set(id, binding);
    return { versionId: binding.versionId, acquisition: binding.acquisition, screen };
  }
  function bindingFor(candidate: ScreenRecoveryCandidate) {
    const binding = bindings.get(key(candidate.screen.slot, candidate.versionId));
    if (
      !binding ||
      binding.acquisition !== candidate.acquisition ||
      (['slot', 'materialId', 'checksum', 'mimeType', 'sizeBytes'] as const).some(
        field => candidate.screen[field] !== binding[field]
      )
    )
      throw invalid();
    return binding;
  }
  return {
    next: async (slot, signal) => {
      signal.throwIfAborted();
      const refused = await cache.refusedProtected(scope.teamId, scope.poolNamespaceId);
      signal.throwIfAborted();
      const excludeVersions = [
        ...new Set(refused.filter(item => item.slot === slot).map(item => item.versionId))
      ].slice(0, 500);
      const value = await call('next', { slot, excludeVersions }, signal);
      signal.throwIfAborted();
      if (isRecord(value) && value.kind === 'exhausted') {
        if (
          typeof value.complete !== 'boolean' ||
          !['empty', 'unusable', 'remembered', 'limit'].includes(String(value.reason))
        )
          throw invalid();
        return {
          kind: 'exhausted',
          complete: value.complete,
          reason: value.reason as 'empty' | 'unusable' | 'remembered' | 'limit'
        };
      }
      return { kind: 'candidate', candidate: remember(value, slot) };
    },
    resolve: async (candidate, signal) => {
      const binding = bindingFor(candidate);
      signal.throwIfAborted();
      try {
        const resolved = await cache.resolveProtected(
          binding,
          {
            authorize: async () => call('authorize', payload(binding), signal),
            download: async () => download(binding, signal)
          },
          signal
        );
        return { candidate, resolved };
      } catch (error) {
        if (
          error instanceof ScreenCacheError &&
          typeof error.requestId === 'string' &&
          UUID.test(error.requestId)
        )
          failedRequests.set(key(binding.slot, binding.versionId), error.requestId.toLowerCase());
        throw error;
      }
    },
    reject: async (candidate, defect, signal) => {
      const binding = bindingFor(candidate);
      if ((await call('reject', { ...payload(binding), defect }, signal)) !== true)
        throw uncertain();
    },
    accept: async (candidate, signal) => {
      const binding = bindingFor(candidate);
      if ((await call('accept', payload(binding), signal)) !== true) throw uncertain();
    },
    refresh: async (candidate, signal) => {
      const binding = bindingFor(candidate),
        request = failedRequests.get(key(binding.slot, binding.versionId));
      if (!request) throw uncertain();
      const value = await refresh(binding, request, signal);
      signal.throwIfAborted();
      return remember(value, binding.slot);
    }
  };
}
