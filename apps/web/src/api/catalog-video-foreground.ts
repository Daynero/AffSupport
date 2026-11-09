import { isCatalogCommandUuid, parseCatalogVideoForegroundBinding } from '@video-compressor/shared';

/** Public enrollment evidence only. Private native proof never enters browser state. */
export interface CatalogForegroundExecutor {
  protocolVersion: 1;
  enrollmentId: string;
  nativeInstanceId: string;
  proofDigest: string;
}
export interface CatalogForegroundExecutorSnapshot {
  mode: 'paired_session';
  enrollmentId: string;
  nativeInstanceId: string;
}
export function isCatalogForegroundExecutorSnapshot(
  value: unknown
): value is CatalogForegroundExecutorSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    row.mode === 'paired_session' &&
    isCatalogCommandUuid(row.enrollmentId) &&
    isCatalogCommandUuid(row.nativeInstanceId)
  );
}

export type CatalogForegroundBinding =
  | {
      kind: 'launch';
      teamId: string;
      launchId: string;
      sourceMaterialId: string;
      requestKey: string;
      expectedVersion: string;
    }
  | { kind: 'create'; teamId: string; sourceMaterialId: string; idempotencyKey: string }
  | {
      kind: 'updater';
      teamId: string;
      sourceMaterialId: string;
      catalogMaterialId: string;
      requestId: string;
      profileVersion: number;
    };

export interface CatalogForegroundDependencies {
  capability(): Promise<unknown>;
  entitlement(signal?: AbortSignal): Promise<unknown>;
  local(path: string, body: unknown, signal?: AbortSignal): Promise<unknown>;
  actor(): string | null;
  epoch(): number;
  enabled(): boolean;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const receipt = (value: unknown): value is CatalogForegroundExecutor =>
  object(value) &&
  value.protocolVersion === 1 &&
  isCatalogCommandUuid(value.enrollmentId) &&
  isCatalogCommandUuid(value.nativeInstanceId) &&
  typeof value.proofDigest === 'string' &&
  /^[a-f0-9]{64}$/u.test(value.proofDigest);

/** One browser coordinator, no background delegation and no browser credentials in local arguments. */
export function createCatalogForegroundCoordinator(deps: CatalogForegroundDependencies) {
  const prepared = new Map<string, Promise<CatalogForegroundExecutor | undefined>>();
  const attached = new Map<string, Promise<void>>();
  const scope = (teamId: string, signal?: AbortSignal) => {
    const actor = deps.actor(),
      epoch = deps.epoch();
    return {
      key: JSON.stringify([teamId, actor, epoch]),
      current: () => {
        if (signal?.aborted) throw Error('PROCESS_CANCELED');
        if (!isCatalogCommandUuid(actor) || actor !== deps.actor() || epoch !== deps.epoch())
          throw Error('PERMISSION_DENIED');
      }
    };
  };
  return {
    async prepare(binding: CatalogForegroundBinding, signal?: AbortSignal) {
      if (!deps.enabled() || !isCatalogCommandUuid(deps.actor())) return undefined;
      const owner = scope(binding.teamId, signal);
      owner.current();
      const key = JSON.stringify([owner.key, binding]);
      let pending = prepared.get(key);
      if (!pending) {
        pending = (async () => {
          let capability: unknown;
          try {
            capability = await deps.capability();
          } catch {
            owner.current();
            return undefined;
          }
          owner.current();
          if (
            !object(capability) ||
            capability.available !== true ||
            capability.protocolVersion !== 1
          )
            return undefined;
          await deps.entitlement(signal);
          owner.current();
          const nativeBinding = parseCatalogVideoForegroundBinding({
            protocolVersion: 1,
            teamId: binding.teamId,
            sourceMaterialId: binding.sourceMaterialId,
            requestKey:
              binding.kind === 'create'
                ? binding.idempotencyKey
                : binding.kind === 'updater'
                  ? binding.requestId
                  : binding.requestKey,
            ...(binding.kind === 'launch'
              ? { expectedVersion: Number(binding.expectedVersion) }
              : binding.kind === 'updater'
                ? { expectedVersion: binding.profileVersion }
                : {})
          });
          if (!nativeBinding) throw Error('INVALID_INPUT');
          const value = await deps.local(
            '/api/team/catalog-video/foreground/prepare',
            nativeBinding,
            signal
          );
          owner.current();
          if (!receipt(value)) throw Error('INVALID_RESPONSE');
          // Copy a closed public shape: never retain any extra local response fields.
          return {
            protocolVersion: 1 as const,
            enrollmentId: value.enrollmentId,
            nativeInstanceId: value.nativeInstanceId,
            proofDigest: value.proofDigest
          };
        })();
        prepared.set(key, pending);
        if (prepared.size > 128) prepared.delete(prepared.keys().next().value!);
        void pending.catch(() => {
          if (prepared.get(key) === pending) prepared.delete(key);
        });
      }
      const value = await pending;
      owner.current();
      return value;
    },
    async attach(teamId: string, value: unknown, signal?: AbortSignal) {
      if (!deps.enabled() || !object(value)) return;
      const progress = object(value.videoGenerationObservation)
        ? value.videoGenerationObservation
        : object(value.videoGeneration)
          ? value.videoGeneration
          : value;
      const setId = progress.setId ?? progress.videoSetId;
      if (
        !isCatalogCommandUuid(setId) ||
        !isCatalogForegroundExecutorSnapshot(progress.executor) ||
        !['accepted', 'preparing'].includes(String(progress.state))
      )
        return;
      const owner = scope(teamId, signal);
      owner.current();
      const executor = progress.executor;
      const key = JSON.stringify([
        owner.key,
        setId,
        executor.enrollmentId,
        executor.nativeInstanceId
      ]);
      let pending = attached.get(key);
      if (!pending) {
        pending = (async () => {
          const result = await deps.local(
            '/api/team/catalog-video/foreground/attach',
            {
              protocolVersion: 1,
              teamId,
              setId,
              enrollmentId: executor.enrollmentId,
              nativeInstanceId: executor.nativeInstanceId
            },
            signal
          );
          owner.current();
          if (
            !object(result) ||
            result.protocolVersion !== 1 ||
            result.setId !== setId ||
            result.enrollmentId !== executor.enrollmentId ||
            !['running', 'ready', 'unknown'].includes(String(result.state))
          )
            throw Error('INVALID_RESPONSE');
          if (result.state === 'unknown') throw Error('PROCESS_RESULT_UNCERTAIN');
        })();
        attached.set(key, pending);
        if (attached.size > 128) attached.delete(attached.keys().next().value!);
        void pending.then(
          () => {
            if (attached.get(key) === pending) attached.delete(key);
          },
          () => {
            if (attached.get(key) === pending) attached.delete(key);
          }
        );
      }
      await pending;
      owner.current();
    }
  };
}

/** A proved pre-admission refusal is editable; a timeout/unknown outcome keeps its original key. */
export function isCatalogForegroundAdmissionRefused(value: unknown): boolean {
  return object(value) && value.code === 'AGENT_REQUIRED' && value.retryable === false;
}

const localPreparationFailures = new WeakSet<object>();
/** Created only around local prepare, before the API invokes canonical admission. */
export function catalogForegroundPreparationFailure(cause: unknown): Error {
  const error = new Error(cause instanceof Error ? cause.message : 'INVALID_RESPONSE', { cause });
  localPreparationFailures.add(error);
  return error;
}
export function isCatalogForegroundPreparationFailure(value: unknown): boolean {
  return object(value) && localPreparationFailures.has(value);
}

/** Optional native work must not prevent the server from proving READY reuse. */
export async function admitCatalogForeground<T>(input: {
  prepare(): Promise<CatalogForegroundExecutor | undefined>;
  admit(executor: CatalogForegroundExecutor | undefined): Promise<T>;
  current(): void;
}): Promise<T> {
  let executor: CatalogForegroundExecutor | undefined;
  let preparationFailure: unknown;
  input.current();
  try {
    executor = await input.prepare();
  } catch (error) {
    input.current();
    const code =
      object(error) && typeof error.code === 'string'
        ? error.code
        : error instanceof Error
          ? error.message
          : '';
    if (
      ['PROCESS_CANCELED', 'PERMISSION_DENIED', 'PRIVATE_CACHE_SUPERSEDED'].includes(code) ||
      (error instanceof Error && error.name === 'AbortError')
    )
      throw error;
    preparationFailure = error;
  }
  input.current();
  try {
    const result = await input.admit(executor);
    input.current();
    return result;
  } catch (error) {
    input.current();
    if (preparationFailure !== undefined && isCatalogForegroundAdmissionRefused(error))
      throw catalogForegroundPreparationFailure(preparationFailure);
    throw error;
  }
}
