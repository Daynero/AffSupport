import {
  parseTeamRestitchDefaults,
  type TeamRestitchDefaults
} from '../../../packages/shared/dist/team/restitch.js';
import type { ServiceRpcClient } from '../_shared/credentials.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';
import { restitchSelectionRpcFailure } from './restitch-selection-store.ts';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const uncertain = () =>
  new TeamFunctionError('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN', { retryable: true });
export interface ManualRestitchRootRequest {
  teamId: string;
  /** Captured from verified authentication, never from a request-body actor selector. */
  actorId: string;
  sourceMaterialId: string;
  idempotencyKey: string;
  clientOperationId: string;
}
export interface RestitchPoolObservation {
  complete: boolean;
  truncated: boolean;
  eligibleObserved: number;
  ineligibleObserved: number;
  unknownObserved: number;
  sourceCount: number;
  unknownSourceCount: number;
}
/** Admission receipt only. This is not a grant, native claim, validation or delivery. */
export interface ManualRestitchRoot {
  operationId: string;
  operationState: 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled';
  teamId: string;
  actorId: string;
  sourceMaterialId: string;
  sourceVersion: string;
  poolNamespaceId: string;
  reused: boolean;
  recipe: {
    schemaVersion: 1;
    selectionProtocol: 1;
    seed: string;
    clientOperationId: string;
    defaults: TeamRestitchDefaults;
    sourceIdentity: {
      connectionId: string;
      fileId: string;
      checksum: string;
      mimeType: string;
      sizeBytes: number;
    };
    poolObservations: { start: RestitchPoolObservation; end: RestitchPoolObservation };
  };
}
const whole = (v: unknown, max: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;
function observation(value: unknown): RestitchPoolObservation | null {
  if (
    !isRecord(value) ||
    typeof value.complete !== 'boolean' ||
    typeof value.truncated !== 'boolean' ||
    !whole(value.eligibleObserved, 5001) ||
    !whole(value.ineligibleObserved, 5001) ||
    !whole(value.unknownObserved, 5001) ||
    !whole(value.sourceCount, 1000) ||
    !whole(value.unknownSourceCount, 1000) ||
    value.unknownSourceCount > value.sourceCount ||
    value.eligibleObserved + value.ineligibleObserved + value.unknownObserved > 5001 ||
    (value.complete &&
      (value.truncated ||
        value.unknownObserved !== 0 ||
        value.unknownSourceCount !== 0 ||
        value.eligibleObserved > 500))
  )
    return null;
  return {
    complete: value.complete,
    truncated: value.truncated,
    eligibleObserved: value.eligibleObserved,
    ineligibleObserved: value.ineligibleObserved,
    unknownObserved: value.unknownObserved,
    sourceCount: value.sourceCount,
    unknownSourceCount: value.unknownSourceCount
  };
}
function captured(input: ManualRestitchRootRequest): ManualRestitchRootRequest {
  const request = { ...input };
  if (
    ![request.teamId, request.actorId, request.sourceMaterialId, request.clientOperationId].every(
      v => typeof v === 'string' && UUID.test(v)
    ) ||
    typeof request.idempotencyKey !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u.test(request.idempotencyKey)
  )
    throw new TeamFunctionError('INVALID_INPUT');
  return {
    ...request,
    teamId: request.teamId.toLowerCase(),
    actorId: request.actorId.toLowerCase(),
    sourceMaterialId: request.sourceMaterialId.toLowerCase(),
    clientOperationId: request.clientOperationId.toLowerCase()
  };
}
function args(input: ManualRestitchRootRequest): Record<string, unknown> {
  return {
    p_team: input.teamId,
    p_actor: input.actorId,
    p_material: input.sourceMaterialId,
    p_key: input.idempotencyKey,
    p_client_operation: input.clientOperationId
  };
}
function parsed(value: unknown, request: ManualRestitchRootRequest): ManualRestitchRoot {
  if (
    !isRecord(value) ||
    typeof value.operationId !== 'string' ||
    !UUID.test(value.operationId) ||
    typeof value.operationState !== 'string' ||
    !['pending', 'running', 'succeeded', 'failed', 'canceled'].includes(value.operationState) ||
    value.teamId !== request.teamId ||
    value.actorId !== request.actorId ||
    value.sourceMaterialId !== request.sourceMaterialId ||
    typeof value.sourceVersion !== 'string' ||
    !value.sourceVersion ||
    value.sourceVersion.length > 1024 ||
    typeof value.poolNamespaceId !== 'string' ||
    !UUID.test(value.poolNamespaceId) ||
    typeof value.reused !== 'boolean' ||
    !isRecord(value.recipe)
  )
    throw uncertain();
  const r = value.recipe;
  if (
    r.schemaVersion !== 1 ||
    r.selectionProtocol !== 1 ||
    typeof r.seed !== 'string' ||
    !UUID.test(r.seed) ||
    r.clientOperationId !== request.clientOperationId ||
    !isRecord(r.defaults) ||
    !isRecord(r.sourceIdentity) ||
    !isRecord(r.poolObservations)
  )
    throw uncertain();
  const d = r.defaults;
  if (
    d.configured !== true ||
    d.sourceMode !== 'drive' ||
    typeof d.operation !== 'string' ||
    !['stitch', 'restitch'].includes(d.operation) ||
    typeof d.fitMode !== 'string' ||
    !['cover', 'contain', 'stretch'].includes(d.fitMode) ||
    typeof d.startEnabled !== 'boolean' ||
    typeof d.endEnabled !== 'boolean' ||
    (!d.startEnabled && !d.endEnabled) ||
    d.finalDurationMode !== 'custom' ||
    !whole(d.customFinalDurationSeconds, 3600) ||
    d.customFinalDurationSeconds < 1 ||
    typeof d.startDurationMode !== 'string' ||
    !['one-frame', 'ms-2', 'ms-5', 'ms-10', 'custom'].includes(d.startDurationMode) ||
    !whole(d.customStartDurationMs, 60000) ||
    d.customStartDurationMs < 1
  )
    throw uncertain();
  const defaults = parseTeamRestitchDefaults(d);
  const source = r.sourceIdentity,
    start = observation(r.poolObservations.start),
    end = observation(r.poolObservations.end);
  if (
    !defaults.ok ||
    !start ||
    !end ||
    typeof source.connectionId !== 'string' ||
    !UUID.test(source.connectionId) ||
    typeof source.fileId !== 'string' ||
    !source.fileId ||
    source.fileId.length > 1024 ||
    typeof source.checksum !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(source.checksum) ||
    typeof source.mimeType !== 'string' ||
    !source.mimeType ||
    source.mimeType.length > 255 ||
    !whole(source.sizeBytes, Number.MAX_SAFE_INTEGER) ||
    source.sizeBytes < 1
  )
    throw uncertain();
  return {
    operationId: value.operationId.toLowerCase(),
    operationState: value.operationState as ManualRestitchRoot['operationState'],
    teamId: request.teamId,
    actorId: request.actorId,
    sourceMaterialId: request.sourceMaterialId,
    sourceVersion: value.sourceVersion,
    poolNamespaceId: value.poolNamespaceId.toLowerCase(),
    reused: value.reused,
    recipe: {
      schemaVersion: 1,
      selectionProtocol: 1,
      seed: r.seed.toLowerCase(),
      clientOperationId: request.clientOperationId,
      defaults: defaults.value,
      sourceIdentity: {
        connectionId: source.connectionId.toLowerCase(),
        fileId: source.fileId,
        checksum: source.checksum,
        mimeType: source.mimeType,
        sizeBytes: source.sizeBytes
      },
      poolObservations: { start, end }
    }
  };
}
async function readCaptured(
  service: ServiceRpcClient,
  request: ManualRestitchRootRequest
): Promise<ManualRestitchRoot | null> {
  let reply: Awaited<ReturnType<ServiceRpcClient['rpc']>>;
  try {
    reply = await service.rpc('service_read_manual_restitch_download', args(request));
  } catch {
    throw uncertain();
  }
  if (reply.error) restitchSelectionRpcFailure(reply.error);
  return reply.data === null ? null : parsed(reply.data, request);
}
export function readManualRestitchRoot(
  service: ServiceRpcClient,
  input: ManualRestitchRootRequest
): Promise<ManualRestitchRoot | null> {
  return readCaptured(service, captured(input));
}
/** Never repeats the mutation after a missing/malformed reply. Exact readback only;
 * no row, a failed read or a substituted actor/source remains unconfirmed.
 */
export async function acceptManualRestitchRoot(
  service: ServiceRpcClient,
  input: ManualRestitchRootRequest
): Promise<ManualRestitchRoot> {
  const request = captured(input);
  try {
    const reply = await service.rpc('service_accept_manual_restitch_download', args(request));
    if (reply.error) restitchSelectionRpcFailure(reply.error);
    return parsed(reply.data, request);
  } catch (error) {
    if (error instanceof TeamFunctionError && error.code !== 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN')
      throw error;
    const confirmed = await readCaptured(service, request);
    if (!confirmed) throw uncertain();
    return confirmed;
  }
}
