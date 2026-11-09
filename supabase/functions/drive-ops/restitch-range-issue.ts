import {
  reserveScreenTransfer,
  ScreenSelectionBudgetError,
  SCREEN_SELECTION_BOUNDS,
  type ScreenTransferReservation
} from '../../../packages/shared/dist/team/restitch-selection.js';
import type { ServiceRpcClient } from '../_shared/credentials.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';
import { restitchTicket } from '../drive-transfer/restitch-ticket.ts';
import {
  RestitchSelectionSlotStore,
  restitchSelectionRpcFailure,
  type RestitchSelectionSlotScope
} from './restitch-selection-store.ts';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const uncertain = () =>
  new TeamFunctionError('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN', { retryable: true });
export interface RestitchScreenRangeIssue {
  scope: RestitchSelectionSlotScope & { executor: { id: string; epoch: number } };
  nativeInstanceId: string;
  versionId: string;
  acquisition: number;
  requestId: string;
  grantId: string;
  offset: number;
}
function capture(input: RestitchScreenRangeIssue): RestitchScreenRangeIssue {
  const x = { ...input, scope: { ...input.scope, executor: { ...input.scope?.executor } } };
  new RestitchSelectionSlotStore({ rpc: async () => ({ data: null, error: null }) }, x.scope);
  if (
    ![x.nativeInstanceId, x.versionId, x.requestId, x.grantId].every(
      v => typeof v === 'string' && UUID.test(v)
    ) ||
    !x.scope.executor.id ||
    !Number.isSafeInteger(x.acquisition) ||
    x.acquisition < 0 ||
    x.acquisition > 2 ||
    !Number.isSafeInteger(x.offset) ||
    x.offset < 0 ||
    x.offset >= SCREEN_SELECTION_BOUNDS.screenBytes
  )
    throw new TeamFunctionError('INVALID_INPUT');
  return {
    ...x,
    nativeInstanceId: x.nativeInstanceId.toLowerCase(),
    versionId: x.versionId.toLowerCase(),
    requestId: x.requestId.toLowerCase(),
    grantId: x.grantId.toLowerCase(),
    scope: {
      rootOperationId: x.scope.rootOperationId.toLowerCase(),
      teamId: x.scope.teamId.toLowerCase(),
      actorId: x.scope.actorId.toLowerCase(),
      slot: x.scope.slot,
      executor: { id: x.scope.executor.id.toLowerCase(), epoch: x.scope.executor.epoch }
    }
  };
}
function args(x: RestitchScreenRangeIssue) {
  return {
    p_root_operation: x.scope.rootOperationId,
    p_team: x.scope.teamId,
    p_actor: x.scope.actorId,
    p_slot: x.scope.slot,
    p_request: x.requestId,
    p_grant: x.grantId,
    p_executor: x.scope.executor.id,
    p_epoch: x.scope.executor.epoch
  };
}
function parse(
  value: unknown,
  x: RestitchScreenRangeIssue
): { expiresAt: string; reservation: ScreenTransferReservation } {
  if (
    !isRecord(value) ||
    value.grantId !== x.grantId ||
    value.rootOperationId !== x.scope.rootOperationId ||
    value.teamId !== x.scope.teamId ||
    value.actorId !== x.scope.actorId ||
    value.slot !== x.scope.slot ||
    value.requestId !== x.requestId ||
    value.versionId !== x.versionId ||
    value.acquisition !== x.acquisition ||
    value.executorId !== x.scope.executor.id ||
    value.epoch !== x.scope.executor.epoch ||
    value.nativeInstanceId !== x.nativeInstanceId ||
    typeof value.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    !isRecord(value.reservation)
  )
    throw uncertain();
  if (value.state !== 'issued') throw uncertain();
  const r = value.reservation;
  if (
    r.requestId !== x.requestId ||
    r.candidateVersionId !== x.versionId ||
    r.acquisition !== x.acquisition ||
    r.offset !== x.offset ||
    r.settlement !== null ||
    typeof r.retry !== 'boolean' ||
    !Number.isSafeInteger(r.bytesReserved) ||
    Number(r.bytesReserved) < 1 ||
    Number(r.bytesReserved) > SCREEN_SELECTION_BOUNDS.rangeBytes ||
    !Number.isSafeInteger(r.ioMsReserved) ||
    Number(r.ioMsReserved) < 1 ||
    Number(r.ioMsReserved) > SCREEN_SELECTION_BOUNDS.ioMs
  )
    throw uncertain();
  return {
    expiresAt: value.expiresAt,
    reservation: {
      requestId: x.requestId,
      candidateVersionId: x.versionId,
      acquisition: x.acquisition,
      offset: x.offset,
      bytesReserved: r.bytesReserved as number,
      ioMsReserved: r.ioMsReserved as number,
      retry: r.retry,
      settlement: null
    }
  };
}
async function read(service: ServiceRpcClient, x: RestitchScreenRangeIssue): Promise<unknown> {
  let r: Awaited<ReturnType<ServiceRpcClient['rpc']>>;
  try {
    r = await service.rpc('service_read_restitch_screen_range_issue', args(x));
  } catch {
    throw uncertain();
  }
  if (r.error) restitchSelectionRpcFailure(r.error);
  return r.data;
}
/** Request and grant UUIDs must be persisted by the native controller before its
 * first request. Unknown issue outcomes permit only exact readback, never fresh
 * UUIDs, another reservation or a ticket returned before committed authority.
 */
export async function issueRestitchScreenRange(
  service: ServiceRpcClient,
  secret: string,
  input: RestitchScreenRangeIssue
): Promise<{ ticket: string; expiresAt: string; reservation: ScreenTransferReservation }> {
  const x = capture(input),
    ticket = await restitchTicket(secret, x.grantId, 'screen_range');
  const original = await read(service, x);
  if (original !== null) return { ticket, ...parse(original, x) };
  const before = await new RestitchSelectionSlotStore(service, x.scope).read();
  let next: ReturnType<typeof reserveScreenTransfer>;
  try {
    next = reserveScreenTransfer(before, x.versionId, x.requestId, x.offset);
  } catch (error) {
    if (error instanceof ScreenSelectionBudgetError) {
      const code =
        error.reason === 'byte_limit'
          ? 'RESTITCH_SCREEN_BYTE_LIMIT'
          : error.reason === 'io_limit'
            ? 'RESTITCH_SCREEN_IO_LIMIT'
            : ['retry_limit', 'candidate_limit', 'refresh_limit'].includes(error.reason)
              ? 'RESTITCH_SCREEN_SELECTION_LIMIT'
              : 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN';
      throw new TeamFunctionError(code);
    }
    throw uncertain();
  }
  if (!next.created || next.reservation.acquisition !== x.acquisition) throw uncertain();
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ticket))
  );
  let reply: Awaited<ReturnType<ServiceRpcClient['rpc']>> | undefined;
  try {
    reply = await service.rpc('service_issue_restitch_screen_range', {
      ...args(x),
      p_version: x.versionId,
      p_acquisition: x.acquisition,
      p_expected_budget: before,
      p_next_budget: next.state,
      p_ticket_hash: '\\x' + Array.from(hash, b => b.toString(16).padStart(2, '0')).join('')
    });
  } catch {
    /* Exact readback below. */
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
      reply = undefined;
    }
  }
  let value: ReturnType<typeof parse> | undefined;
  if (reply) {
    try {
      value = parse(reply.data, x);
    } catch {
      /* Missing/malformed ACK is not permission. */
    }
  }
  value ??= parse(await read(service, x), x);
  if (JSON.stringify(value.reservation) !== JSON.stringify(next.reservation)) throw uncertain();
  return { ticket, ...value };
}
