import {
  acceptScreenCandidate,
  SCREEN_SELECTION_BOUNDS,
  parseScreenSelectionBudget,
  reacquireScreenCandidate,
  ScreenSelectionBudgetError,
  refreshScreenCandidateGrant,
  rejectScreenCandidate,
  reserveScreenTransfer,
  selectScreenCandidate,
  settleScreenTransfer,
  type ScreenSelectionBudget,
  type ScreenTransferMeasurement,
  type ScreenTransferReservation
} from '../../../packages/shared/dist/team/restitch-selection.js';
import type { ServiceRpcClient } from '../_shared/credentials.ts';
import { TeamFunctionError } from '../_shared/errors.ts';

export interface RestitchSelectionSlotScope {
  rootOperationId: string;
  teamId: string;
  actorId: string;
  slot: 'start' | 'end';
  executor?: { id: string; epoch: number };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const uncertain = () =>
  new TeamFunctionError('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN', { retryable: true });
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function kernelFailure(error: unknown): never {
  if (!(error instanceof ScreenSelectionBudgetError)) throw uncertain();
  const code =
    error.reason === 'byte_limit'
      ? 'RESTITCH_SCREEN_BYTE_LIMIT'
      : error.reason === 'io_limit'
        ? 'RESTITCH_SCREEN_IO_LIMIT'
        : ['candidate_limit', 'retry_limit', 'refresh_limit'].includes(error.reason)
          ? 'RESTITCH_SCREEN_SELECTION_LIMIT'
          : [
                'invalid_state',
                'invalid_measurement',
                'reservation_missing',
                'accounting_unconfirmed',
                'settlement_conflict',
                'request_identity_conflict'
              ].includes(error.reason)
            ? 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
            : 'INVALID_INPUT';
  throw new TeamFunctionError(code, { details: { budget_reason: error.reason } });
}
export function restitchSelectionRpcFailure(error: unknown): never {
  const message = error && typeof error === 'object' && 'message' in error ? error.message : null;
  const tokens: string[] =
    typeof message === 'string' ? (message.match(/[A-Z][A-Z0-9_]{1,63}/gu) ?? []) : [];

  for (const code of [
    'AUTH_REQUIRED',
    'INVALID_INPUT',
    'REQUEST_REUSE_CONFLICT',
    'PERMISSION_DENIED',
    'SPACE_BLOCKED',
    'WRONG_STATE',
    'SOURCE_CHANGED',
    'RESTITCH_SOURCES_INVALID',
    'RESTITCH_INVALID',
    'RESTITCH_NO_SCREENS',
    'RESTITCH_SOURCES_TOO_MANY',
    'RESTITCH_CLIENT_OUTDATED'
  ] as const)
    if (tokens.includes(code)) throw new TeamFunctionError(code);
  throw uncertain();
}

/** Service-only adapter for an EXISTING accepted logical preparation and slot.
 * No method creates a root, substitutes settings or resets missing accounting.
 * An acknowledged reservation is the only result that permits range dispatch.
 */
export class RestitchSelectionSlotStore {
  #service: ServiceRpcClient;
  #scope: RestitchSelectionSlotScope;
  constructor(service: ServiceRpcClient, scope: RestitchSelectionSlotScope) {
    if (
      ![scope.rootOperationId, scope.teamId, scope.actorId].every(
        id => typeof id === 'string' && UUID.test(id)
      ) ||
      !['start', 'end'].includes(scope.slot) ||
      (scope.executor !== undefined &&
        (!scope.executor ||
          typeof scope.executor.id !== 'string' ||
          !UUID.test(scope.executor.id) ||
          !Number.isSafeInteger(scope.executor.epoch) ||
          scope.executor.epoch < 1))
    )
      throw new TeamFunctionError('INVALID_INPUT');
    this.#service = service;
    this.#scope = {
      rootOperationId: scope.rootOperationId.toLowerCase(),
      teamId: scope.teamId.toLowerCase(),
      actorId: scope.actorId.toLowerCase(),
      slot: scope.slot,
      ...(scope.executor
        ? { executor: { id: scope.executor.id.toLowerCase(), epoch: scope.executor.epoch } }
        : {})
    };
  }
  #args(): Record<string, unknown> {
    return {
      p_root_operation: this.#scope.rootOperationId,
      p_team: this.#scope.teamId,
      p_actor: this.#scope.actorId,
      p_slot: this.#scope.slot
    };
  }
  async #rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    let reply: Awaited<ReturnType<ServiceRpcClient['rpc']>>;
    try {
      reply = await this.#service.rpc(name, args);
    } catch {
      throw uncertain();
    }
    if (reply.error) restitchSelectionRpcFailure(reply.error);
    return reply.data;
  }
  async read(): Promise<ScreenSelectionBudget> {
    return this.#read(false);
  }
  #ownerArgs(): Record<string, unknown> {
    return {
      p_executor: this.#scope.executor?.id ?? null,
      p_epoch: this.#scope.executor?.epoch ?? null
    };
  }
  async #read(active: boolean): Promise<ScreenSelectionBudget> {
    const value = await this.#rpc(
      active
        ? 'service_read_active_restitch_selection_slot'
        : 'service_read_restitch_selection_slot',
      active ? { ...this.#args(), ...this.#ownerArgs() } : this.#args()
    );
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw uncertain();
    const row = value as Record<string, unknown>;
    if (
      row.rootOperationId !== this.#scope.rootOperationId ||
      row.teamId !== this.#scope.teamId ||
      row.actorId !== this.#scope.actorId ||
      row.slot !== this.#scope.slot ||
      (active &&
        this.#scope.executor !== undefined &&
        (row.executorId !== this.#scope.executor.id || row.epoch !== this.#scope.executor.epoch))
    )
      throw uncertain();
    const state = parseScreenSelectionBudget(row.budget);
    if (!state) throw uncertain();
    return state;
  }
  async #cas(before: ScreenSelectionBudget, after: ScreenSelectionBudget): Promise<void> {
    if (!parseScreenSelectionBudget(after) || after.revision !== before.revision + 1)
      throw uncertain();
    const reply = await this.#rpc(
      this.#scope.executor
        ? 'service_cas_restitch_selection_slot_owned'
        : 'service_cas_restitch_selection_slot',
      {
        ...(this.#scope.executor ? this.#ownerArgs() : {}),
        ...this.#args(),
        p_expected_budget: before,
        p_next_budget: after
      }
    );
    // A false or lost response is never retried as another mutation here.
    if (reply !== true) throw uncertain();
  }

  async #change(
    apply: (before: ScreenSelectionBudget) => ScreenSelectionBudget
  ): Promise<{ acknowledgedChange: boolean; state: ScreenSelectionBudget }> {
    const before = await this.#read(true);
    let after: ScreenSelectionBudget;
    try {
      after = apply(before);
    } catch (error) {
      kernelFailure(error);
    }
    if (after === before) return { acknowledgedChange: false, state: before };
    await this.#cas(before, after);
    return { acknowledgedChange: true, state: after };
  }
  select(versionId: string, sizeBytes: number) {
    return this.#change(before => selectScreenCandidate(before, versionId, sizeBytes));
  }
  reject(versionId: string, acquisition: number) {
    return this.#change(before => rejectScreenCandidate(before, versionId, acquisition));
  }
  accept(versionId: string, acquisition: number) {
    return this.#change(before => acceptScreenCandidate(before, versionId, acquisition));
  }
  #requireAcquisition(acquisition: number) {
    if (
      !Number.isSafeInteger(acquisition) ||
      acquisition < 0 ||
      acquisition > SCREEN_SELECTION_BOUNDS.candidateRetries
    )
      throw new TeamFunctionError('INVALID_INPUT');
  }
  #assertAcquisition(before: ScreenSelectionBudget, versionId: string, acquisition: number) {
    if (
      before.candidates.find(c => c.versionId === versionId.toLowerCase())?.acquisition !==
      acquisition
    )
      throw new ScreenSelectionBudgetError('acquisition_mismatch');
  }
  async reacquire(versionId: string, acquisition: number) {
    this.#requireAcquisition(acquisition);
    return this.#change(before => {
      this.#assertAcquisition(before, versionId, acquisition);
      return reacquireScreenCandidate(before, versionId);
    });
  }
  async refresh(versionId: string, requestId: string, acquisition: number) {
    this.#requireAcquisition(acquisition);
    return this.#change(before => {
      this.#assertAcquisition(before, versionId, acquisition);
      return refreshScreenCandidateGrant(before, versionId, requestId);
    });
  }
  async reserve(
    versionId: string,
    requestId: string,
    offset: number,
    acquisition: number
  ): Promise<{
    kind: 'dispatch' | 'readback';
    reservation: ScreenTransferReservation;
  }> {
    this.#requireAcquisition(acquisition);
    const before = await this.#read(true);
    let next: ReturnType<typeof reserveScreenTransfer>;
    try {
      const repeated = before.transfers.find(t => t.requestId === requestId.toLowerCase());
      if (repeated) {
        if (repeated.acquisition !== acquisition)
          throw new ScreenSelectionBudgetError('acquisition_mismatch');
      } else this.#assertAcquisition(before, versionId, acquisition);
      next = reserveScreenTransfer(before, versionId, requestId, offset);
    } catch (error) {
      kernelFailure(error);
    }
    if (!next.created) return { kind: 'readback', reservation: next.reservation };
    await this.#cas(before, next.state);
    return { kind: 'dispatch', reservation: next.reservation };
  }
  /** Measured only by the protected service-side range executor, never a client route. */
  async settle(requestId: string, measurement: ScreenTransferMeasurement): Promise<void> {
    if (typeof requestId !== 'string' || !UUID.test(requestId))
      throw new TeamFunctionError('INVALID_INPUT');
    const before = await this.read();
    let after: ScreenSelectionBudget;
    try {
      after = settleScreenTransfer(before, requestId, measurement);
    } catch (error) {
      kernelFailure(error);
    }
    if (before === after) return;
    const expected = parseScreenSelectionBudget(after)?.transfers.find(
      row => row.requestId === requestId.toLowerCase()
    );
    if (!expected) throw uncertain();
    try {
      // Accounting for a previously issued permit must still settle after cancellation
      // or access revocation. This separate service-only RPC cannot grant new I/O.
      const reply = await this.#rpc('service_settle_restitch_selection_range', {
        ...this.#args(),
        p_request: requestId.toLowerCase(),
        p_expected_reservation: before.transfers.find(
          row => row.requestId === requestId.toLowerCase()
        ),
        p_measurement: measurement
      });
      if (reply !== true) throw uncertain();
    } catch (error) {
      if (
        error instanceof TeamFunctionError &&
        error.code !== 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
      )
        throw error;
      // Settlement may have committed. Confirm exact server measurement read-only;
      // this may release buffered bytes, but never creates another dispatch permit.
      let current: ScreenSelectionBudget;
      try {
        current = await this.read();
      } catch {
        throw uncertain();
      }
      const observed = current.transfers.find(row => row.requestId === requestId.toLowerCase());
      if (!expected || !observed || !equal(expected, observed)) throw uncertain();
    }
  }
}
