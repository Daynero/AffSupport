import {
  parseTeamRestitchDefaults,
  type TeamRestitchDefaults
} from '../../../packages/shared/dist/team/restitch.js';
import { issueRestitchScreenRange } from './restitch-range-issue.ts';
import { readRestitchSelectionSource } from './restitch-range-authority.ts';
import {
  parseScreenSelectionBudget,
  refreshScreenCandidateGrant,
  ScreenSelectionBudgetError,
  SCREEN_SELECTION_BOUNDS,
  type ScreenSelectionBudget
} from '../../../packages/shared/dist/team/restitch-selection.js';
import type { ServiceRpcClient } from '../_shared/credentials.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord, parseUuid } from '../_shared/validation.ts';
import {
  RestitchSelectionSlotStore,
  restitchSelectionRpcFailure
} from './restitch-selection-store.ts';
const uncertain = () =>
  new TeamFunctionError('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN', { retryable: true });
function uuid(value: unknown): string {
  const result = parseUuid(value);
  if (!result.ok) throw new TeamFunctionError('INVALID_INPUT');
  return result.value;
}
type Candidate = {
  versionId: string;
  materialId: string;
  sizeBytes: number;
  checksum: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
};
type Context = {
  rootOperationId: string;
  teamId: string;
  actorId: string;
  poolNamespaceId: string;
  executorId: string;
  nativeInstanceId: string;
  epoch: number;
  slot: 'start' | 'end';
  complete: boolean;
  budget: ScreenSelectionBudget;
  candidates: Candidate[];
  defaults: TeamRestitchDefaults;
  source: {
    materialId: string;
    version: string;
    checksum: string;
    sizeBytes: number;
    mimeType: string;
  };
};
function context(value: unknown, grant: string, slot: 'start' | 'end'): Context {
  try {
    if (
      !isRecord(value) ||
      value.controlGrantId !== grant ||
      value.slot !== slot ||
      typeof value.complete !== 'boolean' ||
      !Number.isSafeInteger(value.epoch) ||
      Number(value.epoch) < 1 ||
      !Array.isArray(value.candidates) ||
      value.candidates.length > 500
    )
      throw uncertain();
    const parsedDefaults = parseTeamRestitchDefaults(value.defaults),
      source = value.source;
    if (
      !parsedDefaults.ok ||
      !parsedDefaults.value.configured ||
      parsedDefaults.value.sourceMode !== 'drive' ||
      !isRecord(source) ||
      typeof source.version !== 'string' ||
      source.version.length > 1024 ||
      typeof source.checksum !== 'string' ||
      !/^[0-9a-f]{32}$/u.test(source.checksum) ||
      !Number.isSafeInteger(source.sizeBytes) ||
      Number(source.sizeBytes) < 1 ||
      typeof source.mimeType !== 'string' ||
      source.mimeType.length > 128
    )
      throw uncertain();
    const sourceMaterialId = uuid(source.materialId);
    const budget = parseScreenSelectionBudget(value.budget);
    if (!budget) throw uncertain();
    const candidates: Candidate[] = value.candidates.map(row => {
      if (
        !isRecord(row) ||
        !Number.isSafeInteger(row.sizeBytes) ||
        Number(row.sizeBytes) < 1 ||
        Number(row.sizeBytes) > SCREEN_SELECTION_BOUNDS.screenBytes ||
        typeof row.checksum !== 'string' ||
        !/^[0-9a-f]{32}$/u.test(row.checksum) ||
        !['image/jpeg', 'image/png', 'image/webp'].includes(String(row.mimeType))
      )
        throw uncertain();
      return {
        versionId: uuid(row.versionId),
        materialId: uuid(row.materialId),
        sizeBytes: row.sizeBytes as number,
        checksum: row.checksum,
        mimeType: row.mimeType as Candidate['mimeType']
      };
    });
    if (new Set(candidates.map(row => row.versionId)).size !== candidates.length) throw uncertain();
    return {
      rootOperationId: uuid(value.rootOperationId),
      teamId: uuid(value.teamId),
      actorId: uuid(value.actorId),
      poolNamespaceId: uuid(value.poolNamespaceId),
      executorId: uuid(value.executorId),
      nativeInstanceId: uuid(value.nativeInstanceId),
      epoch: value.epoch as number,
      slot,
      complete: value.complete,
      budget,
      candidates,
      defaults: parsedDefaults.value,
      source: {
        materialId: sourceMaterialId,
        version: source.version,
        checksum: source.checksum,
        sizeBytes: source.sizeBytes as number,
        mimeType: source.mimeType
      }
    };
  } catch {
    throw uncertain();
  }
}
async function rpc(
  service: ServiceRpcClient,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  let reply: Awaited<ReturnType<ServiceRpcClient['rpc']>>;
  try {
    reply = await service.rpc(name, args);
  } catch {
    throw uncertain();
  }
  if (!isRecord(reply) || !Object.hasOwn(reply, 'data') || !Object.hasOwn(reply, 'error'))
    throw uncertain();
  if (reply.error) restitchSelectionRpcFailure(reply.error);
  return reply.data;
}
function selected(c: Context, candidate: Candidate, state: ScreenSelectionBudget) {
  const current = state.candidates.find(row => row.versionId === candidate.versionId);
  if (!current || current.rejected) throw uncertain();
  return {
    kind: 'candidate' as const,
    candidate: {
      versionId: candidate.versionId,
      acquisition: current.acquisition,
      screen: {
        slot: c.slot,
        materialId: candidate.materialId,
        checksum: candidate.checksum,
        mimeType: candidate.mimeType,
        sizeBytes: candidate.sizeBytes,
        fileName:
          'screen' +
          (candidate.mimeType === 'image/jpeg'
            ? '.jpg'
            : candidate.mimeType === 'image/webp'
              ? '.webp'
              : '.png'),
        transfer: null
      }
    },
    binding: {
      selectionProtocol: 1 as const,
      rootOperationId: c.rootOperationId,
      teamId: c.teamId,
      actorId: c.actorId,
      poolNamespaceId: c.poolNamespaceId,
      executorId: c.executorId,
      epoch: c.epoch,
      nativeInstanceId: c.nativeInstanceId,
      versionId: candidate.versionId,
      acquisition: current.acquisition,
      slot: c.slot,
      materialId: candidate.materialId,
      checksum: candidate.checksum,
      mimeType: candidate.mimeType,
      sizeBytes: candidate.sizeBytes
    }
  };
}
/** Native-only selection adapter over the existing ledger. No caller-selected
 * actor/root/epoch or generic RPC fallback. Unknown CAS stops this invocation. */
export async function handleRestitchNativeSelection(
  request: Request,
  action: string,
  body: unknown,
  deps: { service: ServiceRpcClient; secret?: string }
): Promise<unknown> {
  if (request.method !== 'POST' || request.headers.has('origin'))
    throw new TeamFunctionError('PERMISSION_DENIED');
  if (
    !isRecord(body) ||
    ![
      'next',
      'reject',
      'accept',
      'reacquire',
      'range',
      'authorize',
      'context',
      'abandon',
      'refresh'
    ].includes(action)
  )
    throw new TeamFunctionError('INVALID_INPUT');
  const input: Record<string, unknown> = {
    ...body,
    ...(Array.isArray(body.excludeVersions) ? { excludeVersions: [...body.excludeVersions] } : {})
  };
  if (input.protocolVersion !== 1) throw new TeamFunctionError('RESTITCH_CLIENT_OUTDATED');
  const grant = uuid(input.grantId),
    slot = input.slot;
  if (slot !== 'start' && slot !== 'end') throw new TeamFunctionError('INVALID_INPUT');
  const ticket = request.headers.get('x-restitch-control-ticket');
  if (!ticket || !/^[A-Za-z0-9_-]{43}$/u.test(ticket)) throw new TeamFunctionError('AUTH_REQUIRED');
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ticket))
  );
  const scope = {
    p_control: grant,
    p_control_hash: '\\x' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''),
    p_slot: slot
  };
  const c = context(
    await rpc(deps.service, 'service_read_restitch_control_selection', {
      ...scope,
      p_active: action !== 'abandon'
    }),
    grant,
    slot
  );
  if (action === 'abandon') {
    const value = await rpc(deps.service, 'service_abandon_restitch_control_screen_range', {
      ...scope,
      p_request: uuid(input.requestId),
      p_grant: uuid(input.rangeGrantId)
    });
    if (typeof value !== 'boolean') throw uncertain();
    return value;
  }
  if (action === 'context')
    return {
      selectionProtocol: 1,
      rootOperationId: c.rootOperationId,
      teamId: c.teamId,
      actorId: c.actorId,
      poolNamespaceId: c.poolNamespaceId,
      executorId: c.executorId,
      epoch: c.epoch,
      nativeInstanceId: c.nativeInstanceId,
      defaults: c.defaults,
      source: c.source
    };
  if (c.defaults[slot === 'start' ? 'startEnabled' : 'endEnabled'] === false)
    throw new TeamFunctionError('RESTITCH_SOURCES_INVALID');
  // Both existing kernel reads and CAS now derive the same scope inside SQL,
  // including a fresh Auth-session check in the mutation transaction.
  const bound: ServiceRpcClient = {
    rpc: async (name, args) => {
      if (
        name === 'service_read_active_restitch_selection_slot' ||
        name === 'service_read_restitch_selection_slot'
      )
        return deps.service.rpc('service_read_restitch_control_selection', {
          ...scope,
          p_active: name === 'service_read_active_restitch_selection_slot'
        });
      if (name === 'service_cas_restitch_selection_slot_owned')
        return deps.service.rpc('service_cas_restitch_control_selection', {
          ...scope,
          p_expected_budget: args.p_expected_budget,
          p_next_budget: args.p_next_budget
        });
      if (name === 'service_read_restitch_screen_range_issue')
        return deps.service.rpc('service_read_restitch_control_screen_range_issue', {
          ...scope,
          p_request: args.p_request,
          p_grant: args.p_grant
        });
      if (name === 'service_issue_restitch_screen_range')
        return deps.service.rpc('service_issue_restitch_control_screen_range', {
          ...scope,
          p_version: args.p_version,
          p_acquisition: args.p_acquisition,
          p_request: args.p_request,
          p_expected_budget: args.p_expected_budget,
          p_next_budget: args.p_next_budget,
          p_grant: args.p_grant,
          p_ticket_hash: args.p_ticket_hash
        });
      throw new TeamFunctionError('INVALID_INPUT');
    }
  };
  const store = new RestitchSelectionSlotStore(bound, {
    rootOperationId: c.rootOperationId,
    teamId: c.teamId,
    actorId: c.actorId,
    slot,
    executor: { id: c.executorId, epoch: c.epoch }
  });
  if (action === 'next') {
    const raw = input.excludeVersions ?? [];
    if (!Array.isArray(raw) || raw.length > 500) throw new TeamFunctionError('INVALID_INPUT');
    const excluded = new Set(raw.map(uuid));
    const active = c.budget.candidates.find(row => !row.rejected);
    if (active) {
      const item = c.candidates.find(row => row.versionId === active.versionId);
      if (!item) throw uncertain();
      return selected(c, item, c.budget);
    }
    const item = c.candidates.find(
      row =>
        !excluded.has(row.versionId) &&
        !c.budget.candidates.some(used => used.versionId === row.versionId)
    );
    if (!item)
      return {
        kind: 'exhausted',
        reason: !c.complete
          ? 'limit'
          : c.candidates.length === 0
            ? 'empty'
            : excluded.size && c.budget.candidates.length === 0
              ? 'remembered'
              : 'unusable',
        complete: c.complete
      };
    const changed = await store.select(item.versionId, item.sizeBytes);
    return selected(c, item, changed.state);
  }
  const version = uuid(input.versionId),
    acquisition = input.acquisition;
  if (
    typeof acquisition !== 'number' ||
    !Number.isSafeInteger(acquisition) ||
    acquisition < 0 ||
    acquisition > 2
  )
    throw new TeamFunctionError('INVALID_INPUT');
  if (!c.candidates.some(row => row.versionId === version))
    throw new TeamFunctionError('INVALID_INPUT');
  if (action === 'refresh') {
    const requestId = uuid(input.requestId),
      rangeGrantId = uuid(input.rangeGrantId),
      refreshId = uuid(input.refreshId);
    const receiptArgs = { ...scope, p_request: requestId, p_grant: rangeGrantId };
    const readReceipt = async () => {
      const value = await rpc(
        deps.service,
        'service_read_restitch_control_screen_range_issue',
        receiptArgs
      );
      if (
        !isRecord(value) ||
        value.grantId !== rangeGrantId ||
        value.requestId !== requestId ||
        value.rootOperationId !== c.rootOperationId ||
        value.teamId !== c.teamId ||
        value.actorId !== c.actorId ||
        value.slot !== slot ||
        value.versionId !== version ||
        value.acquisition !== acquisition ||
        value.executorId !== c.executorId ||
        value.epoch !== c.epoch ||
        value.nativeInstanceId !== c.nativeInstanceId ||
        typeof value.expiresAt !== 'string' ||
        !Number.isFinite(Date.parse(value.expiresAt))
      )
        throw uncertain();
      return value;
    };
    let receipt = await readReceipt();
    if (Date.parse(receipt.expiresAt as string) > Date.now())
      throw new TeamFunctionError('WRONG_STATE');
    if (receipt.refreshRequestId != null && receipt.refreshRequestId !== refreshId)
      throw new TeamFunctionError('REQUEST_REUSE_CONFLICT');
    if (receipt.refreshRequestId == null) {
      if (
        (await rpc(deps.service, 'service_abandon_restitch_control_screen_range', receiptArgs)) !==
        true
      )
        throw uncertain();
      const before = context(
        await rpc(deps.service, 'service_read_restitch_control_selection', {
          ...scope,
          p_active: true
        }),
        grant,
        slot
      );
      let next: ScreenSelectionBudget;
      try {
        next = refreshScreenCandidateGrant(before.budget, version, refreshId);
      } catch (error) {
        if (error instanceof ScreenSelectionBudgetError && error.reason === 'refresh_limit')
          throw new TeamFunctionError('RESTITCH_SCREEN_SELECTION_LIMIT');
        throw uncertain();
      }
      try {
        if (
          (await rpc(deps.service, 'service_refresh_restitch_control_screen_range', {
            ...receiptArgs,
            p_acquisition: acquisition,
            p_refresh: refreshId,
            p_expected_budget: before.budget,
            p_next_budget: next
          })) !== true
        )
          throw uncertain();
      } catch (error) {
        if (
          error instanceof TeamFunctionError &&
          error.code !== 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
        )
          throw error;
        // An unknown acknowledgement permits only the exact original receipt read.
        receipt = await readReceipt();
        if (receipt.refreshRequestId !== refreshId) throw uncertain();
      }
    }
    const after = context(
      await rpc(deps.service, 'service_read_restitch_control_selection', {
        ...scope,
        p_active: true
      }),
      grant,
      slot
    );
    if (
      !after.budget.refreshes.some(
        r => r.requestId === refreshId && r.candidateVersionId === version
      )
    )
      throw uncertain();
    return selected(
      after,
      after.candidates.find(row => row.versionId === version)!,
      after.budget
    );
  }
  if (action === 'range' || action === 'authorize') {
    const candidate = c.candidates.find(row => row.versionId === version)!;
    const active = c.budget.candidates.find(row => row.versionId === version);
    if (!active || active.rejected || active.acquisition !== acquisition)
      throw new TeamFunctionError('WRONG_STATE');
    const binding = selected(c, candidate, c.budget).binding;
    if (action === 'authorize') {
      await readRestitchSelectionSource(
        deps.service,
        {
          rootOperationId: c.rootOperationId,
          teamId: c.teamId,
          actorId: c.actorId,
          slot,
          executor: { id: c.executorId, epoch: c.epoch }
        },
        version,
        acquisition
      );
      return binding;
    }
    const requestId = uuid(input.requestId),
      rangeGrantId = uuid(input.rangeGrantId),
      offset = input.offset;
    if (
      typeof offset !== 'number' ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset >= candidate.sizeBytes
    )
      throw new TeamFunctionError('INVALID_INPUT');
    const permit = await issueRestitchScreenRange(bound, deps.secret ?? '', {
      scope: {
        rootOperationId: c.rootOperationId,
        teamId: c.teamId,
        actorId: c.actorId,
        slot,
        executor: { id: c.executorId, epoch: c.epoch }
      },
      nativeInstanceId: c.nativeInstanceId,
      versionId: version,
      acquisition,
      requestId,
      grantId: rangeGrantId,
      offset
    });
    return {
      purpose: 'restitch_screen_range_v1',
      requestId,
      grantId: rangeGrantId,
      ticket: permit.ticket,
      expiresAt: permit.expiresAt,
      binding,
      offset,
      bytes: permit.reservation.bytesReserved
    };
  }
  if (action === 'reject') {
    if (
      !['unsupported', 'checksum_mismatch', 'source_missing', 'source_changed'].includes(
        String(input.defect)
      )
    )
      throw new TeamFunctionError('INVALID_INPUT');
    await store.reject(version, acquisition);
    return true;
  }
  if (action === 'accept') {
    await store.accept(version, acquisition);
    return true;
  }
  const changed = await store.reacquire(version, acquisition);
  return selected(
    c,
    c.candidates.find(row => row.versionId === version)!,
    changed.state
  );
}
