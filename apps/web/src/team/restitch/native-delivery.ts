import { request, requestBody, cancelTeamDownload } from '../../api/client';
import { invokeTeamFunction, teamApi } from '../../api/team';
import { privateCacheActor } from '../private-cache-scope';

type RecordValue = Record<string, unknown>;
const record = (v: unknown): v is RecordValue => !!v && typeof v === 'object' && !Array.isArray(v);
const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(v);
interface Input {
  teamId: string;
  sourceMaterialId: string;
  operationId: string;
  transferUrl: string;
  transferGrant: unknown;
  fileName: string;
  destination?: string | null;
  signal?: AbortSignal;
}
interface Dependencies {
  edge(path: string, body: RecordValue): Promise<unknown>;
  local(path: string, body: RecordValue): Promise<unknown>;
  cancel(teamId: string, rootId: string): Promise<unknown>;
  currentActor(): string | null;
  cancelLocal?(operationId: string): Promise<unknown>;
}
const defaults: Dependencies = {
  edge: (path, body) =>
    invokeTeamFunction(
      path,
      body,
      (value): value is RecordValue | null =>
        record(value) || (path === 'drive-ops/restitch/manual/read' && value === null)
    ),
  local: (path, body) => requestBody(path, body),
  cancel: (teamId, rootId) => teamApi.cancelOperation(teamId, rootId),
  currentActor: privateCacheActor,
  cancelLocal: cancelTeamDownload
};
export async function nativeManualRestitchSupported(): Promise<boolean> {
  try {
    const value = await request<unknown>('/api/team/restitch/native/capabilities');
    if (
      !record(value) ||
      typeof value.available !== 'boolean' ||
      ![0, 1].includes(value.protocolVersion as number)
    )
      throw Error('INVALID_RESPONSE');
    return value.available && value.protocolVersion === 1;
  } catch (error) {
    if (record(error) && (error.status === 404 || error.status === 501)) return false;
    throw error;
  }
}
/** Cloud admission receives only operation identities; local credentials stay local. */
export async function runNativeManualRestitch(raw: Input, deps: Dependencies = defaults) {
  const input = { ...raw },
    actor = deps.currentActor();
  if (!uuid(actor) || ![input.teamId, input.sourceMaterialId, input.operationId].every(uuid))
    throw Error('PERMISSION_DENIED');
  let rootId: string | null = null,
    handedOff = false;
  const current = () => {
    if (input.signal?.aborted) throw Error('PROCESS_CANCELED');
    if (deps.currentActor() !== actor) throw Error('PERMISSION_DENIED');
  };
  const admission = {
    protocolVersion: 1,
    teamId: input.teamId,
    sourceMaterialId: input.sourceMaterialId,
    clientOperationId: input.operationId,
    idempotencyKey: `manual:${input.operationId}`
  };
  try {
    if (input.signal?.aborted) throw Error('PROCESS_CANCELED');
    let root: unknown;
    try {
      root = await deps.edge('drive-ops/restitch/manual/accept', admission);
    } catch (error) {
      // A lost admission reply is resolved by an exact read, never another mutation.
      root = await deps.edge('drive-ops/restitch/manual/read', admission);
      if (!root) throw error;
    }
    if (
      !record(root) ||
      !uuid(root.operationId) ||
      root.teamId !== input.teamId ||
      root.actorId !== actor ||
      root.sourceMaterialId !== input.sourceMaterialId
    )
      throw Error('INVALID_RESPONSE');
    rootId = root.operationId;
    current();
    if (root.operationState !== 'pending' && root.operationState !== 'running')
      throw Error('PROCESS_RESULT_UNCERTAIN');
    const prepared = await deps.local('/api/team/restitch/native/prepare', {
      rootOperationId: rootId,
      teamId: input.teamId
    });
    current();
    if (
      !record(prepared) ||
      prepared.rootOperationId !== rootId ||
      prepared.teamId !== input.teamId ||
      prepared.actorId !== actor ||
      !uuid(prepared.enrollmentId) ||
      !uuid(prepared.nativeInstanceId) ||
      typeof prepared.proofDigest !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(prepared.proofDigest)
    )
      throw Error('INVALID_RESPONSE');
    const enrolled = await deps.edge('drive-ops/restitch/control/enroll', {
      protocolVersion: 1,
      rootOperationId: rootId,
      teamId: input.teamId,
      enrollmentId: prepared.enrollmentId,
      nativeInstanceId: prepared.nativeInstanceId,
      proofDigest: prepared.proofDigest
    });
    current();
    if (
      !record(enrolled) ||
      enrolled.grantId !== prepared.enrollmentId ||
      enrolled.enrollmentId !== prepared.enrollmentId ||
      enrolled.rootOperationId !== rootId ||
      enrolled.actorId !== actor ||
      enrolled.teamId !== input.teamId ||
      enrolled.nativeInstanceId !== prepared.nativeInstanceId
    )
      throw Error('INVALID_RESPONSE');
    const redeemed = await deps.local('/api/team/restitch/native/redeem', {
      enrollmentId: prepared.enrollmentId
    });
    current();
    if (!record(redeemed) || redeemed.ready !== true) throw Error('INVALID_RESPONSE');
    handedOff = true;
    const cancel = () => {
      void deps.cancel(input.teamId, rootId!).catch(() => {});
      void deps.cancelLocal?.(input.operationId).catch(() => {});
    };
    input.signal?.addEventListener('abort', cancel, { once: true });
    let result: unknown;
    try {
      result = await deps.local('/api/team/restitch/native/download', {
        enrollmentId: prepared.enrollmentId,
        request: {
          operationId: input.operationId,
          transferUrl: input.transferUrl,
          transferGrant: input.transferGrant,
          fileName: input.fileName,
          destination: input.destination,
          process: null
        }
      });
    } finally {
      input.signal?.removeEventListener('abort', cancel);
    }
    if (
      !record(result) ||
      result.saved !== true ||
      typeof result.fileName !== 'string' ||
      typeof result.sizeBytes !== 'number' ||
      !Number.isSafeInteger(result.sizeBytes) ||
      result.sizeBytes < 0 ||
      (result.destination != null && typeof result.destination !== 'string')
    )
      throw Error('INVALID_RESPONSE');
    return {
      ...result,
      fileName: result.fileName,
      destination: result.destination as string | undefined
    };
  } catch (error) {
    if (rootId && !handedOff) await deps.cancel(input.teamId, rootId).catch(() => {});
    throw error;
  }
}
