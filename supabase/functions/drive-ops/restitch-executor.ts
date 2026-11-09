import type { ServiceRpcClient } from '../_shared/credentials.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';
import { restitchSelectionRpcFailure } from './restitch-selection-store.ts';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const uncertain = () =>
  new TeamFunctionError('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN', { retryable: true });
export interface RestitchExecutorClaimRequest {
  rootOperationId: string;
  teamId: string;
  /** Original verified actor, never a body-selected substitute. */
  actorId: string;
  claimId: string;
  nativeInstanceId: string;
  /** Actual installed executor declaration, not a server-side default. */
  installedContract: number;
}
export interface RestitchExecutorReceipt {
  rootOperationId: string;
  executorId: string;
  epoch: number;
  claimId: string;
  nativeInstanceId: string;
  /** Historical claims stay inactive. This flag itself never grants range I/O. */
  active: boolean;
}
function capture(input: RestitchExecutorClaimRequest): RestitchExecutorClaimRequest {
  const value = { ...input };
  if (
    ![
      value.rootOperationId,
      value.teamId,
      value.actorId,
      value.claimId,
      value.nativeInstanceId
    ].every(id => typeof id === 'string' && UUID.test(id))
  )
    throw new TeamFunctionError('INVALID_INPUT');
  if (value.installedContract !== 1) throw new TeamFunctionError('RESTITCH_CLIENT_OUTDATED');
  return {
    ...value,
    rootOperationId: value.rootOperationId.toLowerCase(),
    teamId: value.teamId.toLowerCase(),
    actorId: value.actorId.toLowerCase(),
    claimId: value.claimId.toLowerCase(),
    nativeInstanceId: value.nativeInstanceId.toLowerCase()
  };
}
function args(input: RestitchExecutorClaimRequest) {
  return {
    p_root_operation: input.rootOperationId,
    p_team: input.teamId,
    p_actor: input.actorId,
    p_claim: input.claimId,
    p_native_instance: input.nativeInstanceId
  };
}
function parsed(value: unknown, input: RestitchExecutorClaimRequest): RestitchExecutorReceipt {
  if (
    !isRecord(value) ||
    value.rootOperationId !== input.rootOperationId ||
    value.claimId !== input.claimId ||
    value.nativeInstanceId !== input.nativeInstanceId ||
    typeof value.executorId !== 'string' ||
    !UUID.test(value.executorId) ||
    typeof value.epoch !== 'number' ||
    !Number.isSafeInteger(value.epoch) ||
    value.epoch < 1 ||
    typeof value.active !== 'boolean'
  )
    throw uncertain();
  return {
    rootOperationId: input.rootOperationId,
    claimId: input.claimId,
    nativeInstanceId: input.nativeInstanceId,
    executorId: value.executorId.toLowerCase(),
    epoch: value.epoch,
    active: value.active
  };
}
async function read(
  service: ServiceRpcClient,
  input: RestitchExecutorClaimRequest
): Promise<RestitchExecutorReceipt | null> {
  let reply: Awaited<ReturnType<ServiceRpcClient['rpc']>>;
  try {
    reply = await service.rpc('service_read_restitch_executor_claim', args(input));
  } catch {
    throw uncertain();
  }
  if (reply.error) restitchSelectionRpcFailure(reply.error);
  return reply.data === null ? null : parsed(reply.data, input);
}
/** Service-only acceptance. Missing acknowledgement permits exact readback only. */
export async function claimRestitchExecutor(
  service: ServiceRpcClient,
  input: RestitchExecutorClaimRequest
): Promise<RestitchExecutorReceipt> {
  input = capture(input);
  let reply: Awaited<ReturnType<ServiceRpcClient['rpc']>> | undefined;
  try {
    reply = await service.rpc('service_claim_restitch_executor', {
      ...args(input),
      p_contract: input.installedContract
    });
  } catch {
    /* read-only recovery below */
  }
  if (reply?.error) {
    try {
      restitchSelectionRpcFailure(reply.error);
    } catch (error) {
      if (
        !(error instanceof TeamFunctionError) ||
        error.code !== 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
      )
        throw error;
      // Supabase can return a transport failure as an error value after commit.
      // Resolve only this original claim through one read, never another mutation.
      reply = undefined;
    }
  }
  if (reply) {
    try {
      return parsed(reply.data, input);
    } catch {
      /* exact readback, never another claim */
    }
  }
  const receipt = await read(service, input);
  if (!receipt) throw uncertain();
  return receipt;
}
export function readRestitchExecutorClaim(
  service: ServiceRpcClient,
  input: RestitchExecutorClaimRequest
) {
  return read(service, capture(input));
}

export interface RestitchExecutorClosureRequest extends RestitchExecutorClaimRequest {
  executorId: string;
  epoch: number;
  quiescenceId: string;
}
/** Trusted native-control adapter only. The caller must derive the scope from its
 * private enrolled grant and observe joined native activity before calling this.
 * Browser bodies, generic transfer grants and terminal UI states are not proof.
 * A lost response remains unknown; no automatic close replay or new claim. */
export async function quiesceRestitchExecutor(
  service: ServiceRpcClient,
  request: RestitchExecutorClosureRequest
): Promise<true> {
  const input = capture(request);
  if (
    typeof request.executorId !== 'string' ||
    !UUID.test(request.executorId) ||
    typeof request.quiescenceId !== 'string' ||
    !UUID.test(request.quiescenceId) ||
    !Number.isSafeInteger(request.epoch) ||
    request.epoch < 1
  )
    throw new TeamFunctionError('INVALID_INPUT');
  const executorId = request.executorId.toLowerCase();
  const epoch = request.epoch;
  const quiescenceId = request.quiescenceId.toLowerCase();
  // An exact read also rejects a foreign native instance or substituted claim.
  // Inactive historical receipts can only acknowledge their original close nonce
  // through the SQL primitive; they never close a later owner.
  const receipt = await read(service, input);
  if (!receipt || receipt.executorId !== executorId || receipt.epoch !== epoch) throw uncertain();
  let reply: Awaited<ReturnType<ServiceRpcClient['rpc']>>;
  try {
    reply = await service.rpc('service_quiesce_restitch_executor', {
      p_root_operation: input.rootOperationId,
      p_team: input.teamId,
      p_actor: input.actorId,
      p_executor: executorId,
      p_epoch: epoch,
      p_quiescence: quiescenceId
    });
  } catch {
    throw uncertain();
  }
  if (reply.error) restitchSelectionRpcFailure(reply.error);
  if (reply.data !== true) throw uncertain();
  return true;
}
