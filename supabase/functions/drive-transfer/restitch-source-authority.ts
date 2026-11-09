import type { ServiceRpcClient } from '../_shared/credentials.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord, parseUuid } from '../_shared/validation.ts';
import { restitchSelectionRpcFailure } from '../drive-ops/restitch-selection-store.ts';
import { parseBoundedRange, type PreviewGrantContext } from './handler.ts';
const uncertain = () =>
  new TeamFunctionError('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN', { retryable: true });
const denied = () => new TeamFunctionError('PERMISSION_DENIED');
function uuid(value: unknown) {
  const parsed = parseUuid(value);
  if (!parsed.ok) throw uncertain();
  return parsed.value;
}
export interface NativeRestitchSourceAuthority {
  bindGrant(grant: PreviewGrantContext): Promise<void>;
  assertSource(source: {
    fileId: string;
    sizeBytes: number;
    mimeType: string;
    sourceChecksum?: string | null;
  }): void;
  fetch: typeof fetch;
}
/** Compound source authority: the ordinary bounded download grant remains
 * mandatory, and the enrolled control binds it to the original frozen video.
 * A restitch process input must additionally name this exact enrolled root.
 * This grants no image reservation and never accepts preview or foreign process grants.
 * Requests and provider bodies still use the existing bounded range relay.
 */
export async function authorizeNativeRestitchSource(
  request: Request,
  service: ServiceRpcClient,
  fetcher: typeof fetch = fetch
): Promise<NativeRestitchSourceAuthority> {
  if (
    request.method !== 'GET' ||
    request.headers.has('origin') ||
    new URL(request.url).search ||
    request.headers.get('x-restitch-source-purpose') !== 'restitch_source_range_v1'
  )
    throw denied();
  const control = uuid(request.headers.get('x-restitch-control-grant')),
    ticket = request.headers.get('x-restitch-control-ticket');
  if (!ticket || !/^[A-Za-z0-9_-]{43}$/u.test(ticket)) throw new TeamFunctionError('AUTH_REQUIRED');
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ticket))
  );
  const hash = '\\x' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  const canceled = () => {
    if (request.signal.aborted) throw new TeamFunctionError('PROCESS_CANCELED');
  };
  async function rpc(name: string, args: Record<string, unknown>) {
    canceled();
    let result: Awaited<ReturnType<ServiceRpcClient['rpc']>>;
    try {
      result = await service.rpc(name, args);
    } catch {
      throw uncertain();
    }
    canceled();
    if (!isRecord(result) || !Object.hasOwn(result, 'data') || !Object.hasOwn(result, 'error'))
      throw uncertain();
    if (result.error) {
      try {
        restitchSelectionRpcFailure(result.error);
      } catch (error) {
        if (error instanceof TeamFunctionError && error.code === 'EXPIRED')
          throw new TeamFunctionError('AUTH_REQUIRED');
        throw error;
      }
    }
    return result.data;
  }
  const row = await rpc('service_read_restitch_control_selection', {
    p_control: control,
    p_control_hash: hash,
    p_slot: 'end',
    p_active: true
  });
  if (
    !isRecord(row) ||
    row.controlGrantId !== control ||
    !isRecord(row.source) ||
    typeof row.source.checksum !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(row.source.checksum) ||
    !Number.isSafeInteger(row.source.sizeBytes) ||
    Number(row.source.sizeBytes) < 1 ||
    typeof row.source.mimeType !== 'string' ||
    !Number.isSafeInteger(row.epoch) ||
    Number(row.epoch) < 1
  )
    throw uncertain();
  const owner = {
    rootOperationId: uuid(row.rootOperationId),
    teamId: uuid(row.teamId),
    actorId: uuid(row.actorId),
    executorId: uuid(row.executorId),
    nativeInstanceId: uuid(row.nativeInstanceId),
    epoch: row.epoch as number
  };
  const source = {
    materialId: uuid(row.source.materialId),
    checksum: row.source.checksum,
    sizeBytes: row.source.sizeBytes as number,
    mimeType: row.source.mimeType
  };
  let bound = false,
    rangeBytes = 0,
    payload: { fileId: string; range: { start: number; end: number } } | null = null;
  async function check() {
    canceled();
    if (!bound) throw denied();
    const live = await rpc('service_authorize_restitch_native_control', {
      p_grant: control,
      p_ticket_hash: hash
    });
    if (
      !isRecord(live) ||
      live.grantId !== control ||
      Object.entries(owner).some(([field, value]) => live[field] !== value)
    )
      throw uncertain();
  }
  return {
    bindGrant: async grant => {
      canceled();
      if (
        bound ||
        !(
          grant.purpose === 'download_range' ||
          (grant.purpose === 'process_input' &&
            grant.toolId === 'restitch' &&
            grant.operationId === owner.rootOperationId)
        ) ||
        grant.teamId !== owner.teamId ||
        grant.actorId !== owner.actorId ||
        grant.materialId !== source.materialId ||
        !Number.isSafeInteger(grant.maxRangeBytes) ||
        grant.maxRangeBytes < 1
      )
        throw denied();
      bound = true;
      rangeBytes = grant.maxRangeBytes;
    },
    assertSource: live => {
      canceled();
      if (!bound) throw denied();
      if (
        typeof live.fileId !== 'string' ||
        !live.fileId ||
        live.fileId.length > 1024 ||
        live.sourceChecksum !== source.checksum ||
        live.sizeBytes !== source.sizeBytes ||
        live.mimeType !== source.mimeType ||
        (payload !== null && payload.fileId !== live.fileId)
      )
        throw new TeamFunctionError('SOURCE_CHANGED');
      payload = {
        fileId: live.fileId,
        range: parseBoundedRange(request.headers.get('range'), source.sizeBytes, rangeBytes)
      };
    },
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === 'https://www.googleapis.com' && url.pathname.endsWith('/export'))
        throw denied();
      if (url.searchParams.get('alt') === 'media') {
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined)
        );
        if (
          !payload ||
          url.origin !== 'https://www.googleapis.com' ||
          url.pathname !== '/drive/v3/files/' + encodeURIComponent(payload.fileId) ||
          (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase() !==
            'GET' ||
          init?.body ||
          (input instanceof Request && input.body) ||
          headers.get('range') !== `bytes=${payload.range.start}-${payload.range.end}`
        )
          throw denied();
      }
      await check();
      canceled();
      const signals = [request.signal];
      if (init?.signal) signals.push(init.signal);
      if (input instanceof Request) signals.push(input.signal);
      return fetcher(input, { ...init, redirect: 'error', signal: AbortSignal.any(signals) });
    }
  };
}
