import {
  SCREEN_SELECTION_BOUNDS,
  type ScreenTransferReservation
} from '../../../packages/shared/dist/team/restitch-selection.js';
import type { ServiceRpcClient } from '../_shared/credentials.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';
import { readRestitchSelectionSource } from './restitch-range-authority.ts';
import { readRestitchSelectionRange } from './restitch-range-reader.ts';
import {
  createRestitchRangeOpener,
  type RestitchRangeSourceCredentials
} from './restitch-range-source.ts';
import {
  RestitchSelectionSlotStore,
  restitchSelectionRpcFailure,
  type RestitchSelectionSlotScope
} from './restitch-selection-store.ts';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const uncertain = () =>
  new TeamFunctionError('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN', { retryable: true });
interface ConsumedRange {
  scope: RestitchSelectionSlotScope & { executor: { id: string; epoch: number } };
  versionId: string;
  acquisition: number;
  requestId: string;
  reservation: ScreenTransferReservation;
}
export function parseConsumedRestitchScreenRange(value: unknown): ConsumedRange {
  if (
    !isRecord(value) ||
    ![
      'grantId',
      'rootOperationId',
      'teamId',
      'actorId',
      'versionId',
      'requestId',
      'executorId',
      'nativeInstanceId'
    ].every(k => typeof value[k] === 'string' && UUID.test(value[k] as string)) ||
    typeof value.slot !== 'string' ||
    !['start', 'end'].includes(value.slot) ||
    value.state !== 'consumed' ||
    !Number.isSafeInteger(value.epoch) ||
    Number(value.epoch) < 1 ||
    Number(value.epoch) > Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(value.acquisition) ||
    Number(value.acquisition) < 0 ||
    Number(value.acquisition) > 2 ||
    !isRecord(value.reservation)
  )
    throw uncertain();
  const r = value.reservation;
  if (
    r.requestId !== value.requestId ||
    r.candidateVersionId !== value.versionId ||
    r.acquisition !== value.acquisition ||
    r.settlement !== null ||
    !Number.isSafeInteger(r.offset) ||
    Number(r.offset) < 0 ||
    !Number.isSafeInteger(r.bytesReserved) ||
    Number(r.bytesReserved) < 1 ||
    Number(r.bytesReserved) > SCREEN_SELECTION_BOUNDS.rangeBytes ||
    !Number.isSafeInteger(r.ioMsReserved) ||
    Number(r.ioMsReserved) < 1 ||
    Number(r.ioMsReserved) > SCREEN_SELECTION_BOUNDS.ioMs ||
    typeof r.retry !== 'boolean'
  )
    throw uncertain();
  return {
    scope: {
      rootOperationId: value.rootOperationId as string,
      teamId: value.teamId as string,
      actorId: value.actorId as string,
      slot: value.slot as 'start' | 'end',
      executor: { id: value.executorId as string, epoch: value.epoch as number }
    },
    versionId: value.versionId as string,
    acquisition: value.acquisition as number,
    requestId: value.requestId as string,
    reservation: {
      requestId: value.requestId as string,
      candidateVersionId: value.versionId as string,
      acquisition: value.acquisition as number,
      offset: r.offset as number,
      bytesReserved: r.bytesReserved as number,
      ioMsReserved: r.ioMsReserved as number,
      retry: r.retry,
      settlement: null
    }
  };
}
/** One fresh server invocation, never an invocation ID supplied by native/browser.
 * Readback may resolve this invocation's lost ACK, but cannot authorize another
 * invocation or turn an already-consumed ticket into permission to retry I/O.
 */
export async function consumeRestitchScreenRange(
  service: ServiceRpcClient,
  ticket: string
): Promise<ConsumedRange> {
  if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(ticket))
    throw new TeamFunctionError('PERMISSION_DENIED');
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ticket))
  );
  const p_ticket_hash = '\\x' + Array.from(hash, b => b.toString(16).padStart(2, '0')).join('');
  const p_dispatch = crypto.randomUUID();
  let reply: Awaited<ReturnType<ServiceRpcClient['rpc']>>;
  try {
    reply = await service.rpc('service_consume_restitch_screen_range', {
      p_ticket_hash,
      p_dispatch,
      p_purpose: 'restitch_screen_range_v1'
    });
  } catch {
    reply = { data: null, error: { message: 'TRANSPORT_UNKNOWN' } };
  }
  if (!reply.error) {
    if (!isRecord(reply.data) || reply.data.dispatch !== true) throw uncertain();
    return parseConsumedRestitchScreenRange(reply.data.grant);
  }
  // Known refusals remain refusals. Unknown transport/ACK loss is a read, never
  // another consume mutation, with this original closure's unexposed nonce.
  try {
    restitchSelectionRpcFailure(reply.error);
  } catch (error) {
    if (
      !(error instanceof TeamFunctionError) ||
      error.code !== 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
    )
      throw error;
  }
  let read: Awaited<ReturnType<ServiceRpcClient['rpc']>>;
  try {
    read = await service.rpc('service_read_restitch_screen_range_consumption', {
      p_ticket_hash,
      p_dispatch
    });
  } catch {
    throw uncertain();
  }
  if (read.error || !isRecord(read.data) || read.data.consumedByInvocation !== true)
    throw uncertain();
  return parseConsumedRestitchScreenRange(read.data.grant);
}
/** Private service bridge. No endpoint/capability is exposed by this module. */
export async function dispatchRestitchScreenRange(
  input: { service: ServiceRpcClient; ticket: string; signal?: AbortSignal },
  deps: {
    fetch: typeof fetch;
    readCredentials: (id: string) => Promise<RestitchRangeSourceCredentials>;
    now?: () => number;
  }
): Promise<Response> {
  const { service, ticket, signal } = input;
  if (signal?.aborted) throw new TeamFunctionError('PROCESS_CANCELED');
  const grant = await consumeRestitchScreenRange(service, ticket);
  const context = await readRestitchSelectionSource(
    service,
    grant.scope,
    grant.versionId,
    grant.acquisition
  );
  const credentials = await deps.readCredentials(context.credentialId);
  const store = new RestitchSelectionSlotStore(service, grant.scope);
  let used = false;
  return readRestitchSelectionRange(
    {
      store: {
        reserve: async (versionId, requestId, offset, acquisition) => {
          if (
            used ||
            versionId !== grant.versionId ||
            requestId !== grant.requestId ||
            offset !== grant.reservation.offset ||
            acquisition !== grant.acquisition
          )
            throw uncertain();
          used = true;
          return { kind: 'dispatch', reservation: grant.reservation };
        },
        settle: (requestId, measurement) => store.settle(requestId, measurement)
      },
      versionId: grant.versionId,
      requestId: grant.requestId,
      acquisition: grant.acquisition,
      offset: grant.reservation.offset,
      sourceFileId: context.source.fileId,
      sourceBytes: context.source.sizeBytes,
      mimeType: context.source.mimeType,
      signal
    },
    {
      fetch: deps.fetch,
      now: deps.now,
      open: createRestitchRangeOpener(context.source, credentials)
    }
  );
}
