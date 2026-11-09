import type { ServiceRpcClient } from '../_shared/credentials.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';
import { parseConsumedRestitchScreenRange } from './restitch-range-dispatch.ts';
import {
  RestitchSelectionSlotStore,
  restitchSelectionRpcFailure
} from './restitch-selection-store.ts';
import { readRestitchSelectionSource } from './restitch-range-authority.ts';
import { readRestitchSelectionRange } from './restitch-range-reader.ts';
import {
  createRestitchRangeOpener,
  type RestitchRangeSourceCredentials
} from './restitch-range-source.ts';
const uncertain = () =>
  new TeamFunctionError('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN', { retryable: true });
type Consumed = ReturnType<typeof parseConsumedRestitchScreenRange>;
function captured(value: unknown): { grant: Consumed; identity: string } {
  const grant = parseConsumedRestitchScreenRange(value);
  if (!isRecord(value)) throw uncertain();
  return {
    grant,
    identity: JSON.stringify({
      grantId: value.grantId,
      nativeInstanceId: value.nativeInstanceId,
      grant
    })
  };
}
export type ControlledConsumedScreenRange = Readonly<Consumed> & {
  /** Server-only closure: original invocation/hash never enter a native response. */
  checkAuthority(): Promise<void>;
};
/** Internal control-bound transport. Never falls back to an unbound grant. The
 * eventual HTTP host must mint this invocation here, never accept one in a body,
 * and recheck authority immediately before every protected upstream request. */
export async function consumeControlledRestitchScreenRange(
  service: ServiceRpcClient,
  ticket: string
): Promise<ControlledConsumedScreenRange> {
  if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(ticket))
    throw new TeamFunctionError('PERMISSION_DENIED');
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ticket))
  );
  const p_ticket_hash = '\\x' + Array.from(hash, b => b.toString(16).padStart(2, '0')).join('');
  const p_dispatch = crypto.randomUUID();
  let reply: Awaited<ReturnType<ServiceRpcClient['rpc']>>;
  try {
    reply = await service.rpc('service_consume_restitch_control_screen_range', {
      p_ticket_hash,
      p_dispatch,
      p_purpose: 'restitch_screen_range_v1'
    });
  } catch {
    reply = { data: null, error: { message: 'TRANSPORT_UNKNOWN' } };
  }
  let original: ReturnType<typeof captured>;
  if (!reply.error) {
    if (!isRecord(reply.data) || reply.data.dispatch !== true) throw uncertain();
    original = captured(reply.data.grant);
  } else {
    try {
      restitchSelectionRpcFailure(reply.error);
    } catch (cause) {
      if (
        !(cause instanceof TeamFunctionError) ||
        cause.code !== 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
      )
        throw cause;
    }
    let read: Awaited<ReturnType<ServiceRpcClient['rpc']>>;
    try {
      read = await service.rpc('service_read_restitch_control_screen_range_consumption', {
        p_ticket_hash,
        p_dispatch
      });
    } catch {
      throw uncertain();
    }
    if (read.error || !isRecord(read.data) || read.data.consumedByInvocation !== true)
      throw uncertain();
    original = captured(read.data.grant);
  }
  // Capture the canonical original before exposing any object or awaiting another
  // callback. A retained caller cannot substitute owner, range or reservation.
  const { grant, identity: expected } = original;
  Object.freeze(grant.scope.executor);
  Object.freeze(grant.scope);
  Object.freeze(grant.reservation);
  return Object.freeze({
    ...grant,
    checkAuthority: async () => {
      let checked: Awaited<ReturnType<ServiceRpcClient['rpc']>>;
      try {
        checked = await service.rpc('service_check_restitch_control_screen_range', {
          p_ticket_hash,
          p_dispatch
        });
      } catch {
        throw uncertain();
      }
      if (checked.error) restitchSelectionRpcFailure(checked.error);
      if (
        !isRecord(checked.data) ||
        checked.data.consumedByInvocation !== true ||
        captured(checked.data.grant).identity !== expected
      )
        throw uncertain();
    }
  });
}

/** Internal native-control transport, not a public route. Consumption is unique;
 * each protected fetch is authorized again after any intervening async work.
 * A failed current-authority read cannot fall back to the generic transport.
 */
export async function dispatchControlledRestitchScreenRange(
  input: { service: ServiceRpcClient; ticket: string; signal?: AbortSignal },
  deps: {
    fetch: typeof fetch;
    readCredentials: (id: string) => Promise<RestitchRangeSourceCredentials>;
    now?: () => number;
  }
): Promise<Response> {
  const { service, ticket, signal } = input;
  const checkCancellation = () => {
    if (signal?.aborted) throw new TeamFunctionError('PROCESS_CANCELED');
  };
  checkCancellation();
  const grant = await consumeControlledRestitchScreenRange(service, ticket);
  await grant.checkAuthority();
  checkCancellation();
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
      now: deps.now,
      open: createRestitchRangeOpener(context.source, credentials),
      fetch: async (target, init) => {
        checkCancellation();
        await grant.checkAuthority();
        checkCancellation();
        if (init?.signal?.aborted || (target instanceof Request && target.signal.aborted))
          throw new TeamFunctionError('PROCESS_CANCELED');
        return deps.fetch(target, init);
      }
    }
  );
}
