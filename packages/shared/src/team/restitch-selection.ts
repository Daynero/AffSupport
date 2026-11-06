import { isRecord } from './contract.js';
import {
  RESTITCH_SCREEN_MAX_BYTES,
  RESTITCH_SCREEN_SELECTION_MAX_CANDIDATES
} from './restitch-screen-policy.js';

/** One operation/slot. Persistence and authorization belong to the service boundary. */
export const SCREEN_SELECTION_BOUNDS = Object.freeze({
  candidates: RESTITCH_SCREEN_SELECTION_MAX_CANDIDATES,
  candidateRetries: 2,
  retries: 6,
  candidateRefreshes: 1,
  refreshes: 2,
  screenBytes: RESTITCH_SCREEN_MAX_BYTES,
  bytes: 5 * RESTITCH_SCREEN_MAX_BYTES,
  ioMs: 120_000,
  rangeBytes: 2 * 1024 * 1024,
  transferRecords:
    (RESTITCH_SCREEN_SELECTION_MAX_CANDIDATES + 6) *
      Math.ceil(RESTITCH_SCREEN_MAX_BYTES / (2 * 1024 * 1024)) +
    6
});
export interface ScreenSelectionCandidate {
  versionId: string;
  sizeBytes: number;
  acquisition: number;
  validatedAcquisition: number | null;
  rejected: boolean;
}
export interface ScreenTransferMeasurement {
  bytes: number;
  ioMs: number;
  complete: boolean;
}
export interface ScreenTransferReservation {
  requestId: string;
  candidateVersionId: string;
  acquisition: number;
  offset: number;
  bytesReserved: number;
  ioMsReserved: number;
  retry: boolean;
  settlement: ScreenTransferMeasurement | null;
}
export interface ScreenSelectionBudget {
  schemaVersion: 1;
  revision: number;
  candidates: ScreenSelectionCandidate[];
  transfers: ScreenTransferReservation[];
  refreshes: Array<{ requestId: string; candidateVersionId: string }>;
  acceptedVersionId: string | null;
}
export type ScreenSelectionBudgetReason =
  | 'invalid_state'
  | 'invalid_candidate'
  | 'invalid_range'
  | 'invalid_measurement'
  | 'candidate_missing'
  | 'candidate_limit'
  | 'candidate_rejected'
  | 'candidate_not_settled'
  | 'candidate_not_active'
  | 'accounting_unconfirmed'
  | 'request_identity_conflict'
  | 'unexpected_offset'
  | 'retry_limit'
  | 'refresh_limit'
  | 'byte_limit'
  | 'io_limit'
  | 'slot_already_accepted'
  | 'slot_already_validated'
  | 'acquisition_mismatch'
  | 'reservation_missing'
  | 'settlement_conflict';
export class ScreenSelectionBudgetError extends Error {
  constructor(public readonly reason: ScreenSelectionBudgetReason) {
    super(reason);
  }
}
const fail = (reason: ScreenSelectionBudgetReason): never => {
  throw new ScreenSelectionBudgetError(reason);
};
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const whole = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const candidate = (state: ScreenSelectionBudget, id: string) =>
  state.candidates.find(c => c.versionId === id) ?? fail('candidate_missing');
const pending = (state: ScreenSelectionBudget) => {
  if (state.transfers.some(t => t.settlement === null)) fail('accounting_unconfirmed');
};
const retryCount = (state: ScreenSelectionBudget, id?: string) =>
  state.candidates.filter(c => !id || c.versionId === id).reduce((n, c) => n + c.acquisition, 0) +
  state.transfers.filter(t => t.retry && (!id || t.candidateVersionId === id)).length;
function changed(state: ScreenSelectionBudget): ScreenSelectionBudget {
  if (!whole(state.revision, 0, Number.MAX_SAFE_INTEGER - 1)) fail('invalid_state');
  const copy = structuredClone(state);
  copy.revision++;
  return copy;
}
export function createScreenSelectionBudget(): ScreenSelectionBudget {
  return {
    schemaVersion: 1,
    revision: 0,
    candidates: [],
    transfers: [],
    refreshes: [],
    acceptedVersionId: null
  };
}

/** Strict persisted-state boundary. Never turn corrupt accounting into a fresh budget. */
export function parseScreenSelectionBudget(value: unknown): ScreenSelectionBudget | null {
  const b = SCREEN_SELECTION_BOUNDS;
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !whole(value.revision) ||
    !Array.isArray(value.candidates) ||
    value.candidates.length > b.candidates ||
    !Array.isArray(value.transfers) ||
    value.transfers.length > b.transferRecords ||
    !Array.isArray(value.refreshes) ||
    value.refreshes.length > b.refreshes ||
    (value.acceptedVersionId !== null && !uuid(value.acceptedVersionId))
  )
    return null;
  const state = createScreenSelectionBudget();
  state.revision = value.revision;
  state.acceptedVersionId =
    value.acceptedVersionId === null ? null : value.acceptedVersionId.toLowerCase();
  for (const c of value.candidates) {
    if (
      !isRecord(c) ||
      !uuid(c.versionId) ||
      !whole(c.sizeBytes, 1, b.screenBytes) ||
      !whole(c.acquisition, 0, b.candidateRetries) ||
      typeof c.rejected !== 'boolean' ||
      (c.validatedAcquisition !== null && !whole(c.validatedAcquisition, 0, c.acquisition)) ||
      state.candidates.some(p => p.versionId === String(c.versionId).toLowerCase())
    )
      return null;
    state.candidates.push({
      versionId: c.versionId.toLowerCase(),
      sizeBytes: c.sizeBytes,
      acquisition: c.acquisition,
      validatedAcquisition: c.validatedAcquisition,
      rejected: c.rejected
    });
  }
  // Selection advances only after retiring the previous candidate. A cache
  // reacquisition always retains the immediately preceding validation.
  const active = state.candidates.filter(c => !c.rejected);
  if (active.length > 1 || (active.length === 1 && active[0] !== state.candidates.at(-1)))
    return null;
  if (
    active.some(
      c =>
        c.acquisition > 0 &&
        (state.acceptedVersionId !== c.versionId ||
          c.validatedAcquisition === null ||
          c.validatedAcquisition < c.acquisition - 1)
    )
  )
    return null;
  const requestIds = new Set<string>();
  let usedBytes = 0,
    usedIo = 0;
  const positions = new Map<string, { next: number; last: number | null }>();
  const lastAcquisitions = new Map<string, number>();
  for (const raw of value.transfers) {
    if (
      !isRecord(raw) ||
      !uuid(raw.requestId) ||
      !uuid(raw.candidateVersionId) ||
      !whole(raw.acquisition, 0, b.candidateRetries) ||
      !whole(raw.offset) ||
      !whole(raw.bytesReserved, 1, b.rangeBytes) ||
      !whole(raw.ioMsReserved, 1, b.ioMs) ||
      typeof raw.retry !== 'boolean'
    )
      return null;
    const id = raw.candidateVersionId.toLowerCase(),
      requestId = raw.requestId.toLowerCase();
    const c = state.candidates.find(c => c.versionId === id);
    if (
      !c ||
      raw.acquisition > c.acquisition ||
      raw.acquisition < (lastAcquisitions.get(id) ?? 0) ||
      raw.offset >= c.sizeBytes ||
      raw.bytesReserved !== Math.min(b.rangeBytes, c.sizeBytes - raw.offset) ||
      requestIds.has(requestId) ||
      state.transfers.some(t => t.settlement === null) ||
      usedBytes + raw.bytesReserved > b.bytes ||
      usedIo >= b.ioMs ||
      raw.ioMsReserved !== b.ioMs - usedIo
    )
      return null;
    let settlement: ScreenTransferMeasurement | null = null;
    if (raw.settlement !== null) {
      const m = raw.settlement;
      if (
        !isRecord(m) ||
        !whole(m.bytes, 0, raw.bytesReserved) ||
        !whole(m.ioMs) ||
        typeof m.complete !== 'boolean' ||
        (m.complete && m.bytes !== raw.bytesReserved)
      )
        return null;
      settlement = { bytes: m.bytes, ioMs: m.ioMs, complete: m.complete };
    }
    if (
      settlement === null &&
      (c.rejected || raw.acquisition !== c.acquisition || c.validatedAcquisition === c.acquisition)
    )
      return null;
    const key = id + ':' + raw.acquisition;
    const position = positions.get(key) ?? { next: 0, last: null };
    if (
      (raw.offset !== position.next && raw.offset !== position.last) ||
      raw.retry !== (raw.offset === position.last)
    )
      return null;
    position.last = raw.offset;
    if (settlement?.complete)
      position.next = Math.max(position.next, raw.offset + settlement.bytes);
    positions.set(key, position);
    requestIds.add(requestId);
    lastAcquisitions.set(id, raw.acquisition);
    state.transfers.push({
      requestId,
      candidateVersionId: id,
      acquisition: raw.acquisition,
      offset: raw.offset,
      bytesReserved: raw.bytesReserved,
      ioMsReserved: raw.ioMsReserved,
      retry: raw.retry,
      settlement
    });
    usedBytes += settlement?.bytes ?? raw.bytesReserved;
    usedIo += settlement?.ioMs ?? raw.ioMsReserved;
    if (!whole(usedBytes) || !whole(usedIo)) return null;
  }
  for (const raw of value.refreshes) {
    if (!isRecord(raw) || !uuid(raw.requestId) || !uuid(raw.candidateVersionId)) return null;
    const requestId = raw.requestId.toLowerCase(),
      id = raw.candidateVersionId.toLowerCase();
    if (
      requestIds.has(requestId) ||
      !state.candidates.some(c => c.versionId === id) ||
      state.refreshes.some(r => r.candidateVersionId === id)
    )
      return null;
    requestIds.add(requestId);
    state.refreshes.push({ requestId, candidateVersionId: id });
  }
  if (
    retryCount(state) > b.retries ||
    state.candidates.some(c => retryCount(state, c.versionId) > b.candidateRetries)
  )
    return null;
  if (
    state.acceptedVersionId !== null &&
    !state.candidates.some(
      c => c.versionId === state.acceptedVersionId && !c.rejected && c.validatedAcquisition !== null
    )
  )
    return null;
  if (
    state.candidates.some(
      c => c.versionId !== state.acceptedVersionId && c.validatedAcquisition !== null
    )
  )
    return null;
  const acquisitions = state.candidates.reduce((n, c) => n + c.acquisition, 0);
  const minimumValidations = state.candidates.reduce(
    (n, c) => n + c.acquisition + (c.validatedAcquisition === c.acquisition ? 1 : 0),
    0
  );
  const minimumRevision =
    state.candidates.length +
    state.transfers.length +
    state.transfers.filter(t => t.settlement !== null).length +
    state.refreshes.length +
    state.candidates.filter(c => c.rejected).length +
    acquisitions +
    minimumValidations;
  const maximumRevision = 3 * b.candidates + 2 * b.transferRecords + b.refreshes + 2 * b.retries;
  if (state.revision < minimumRevision || state.revision > maximumRevision) return null;
  return state;
}
export function selectScreenCandidate(
  state: ScreenSelectionBudget,
  versionId: string,
  sizeBytes: number
): ScreenSelectionBudget {
  if (!uuid(versionId) || !whole(sizeBytes, 1, SCREEN_SELECTION_BOUNDS.screenBytes))
    fail('invalid_candidate');
  versionId = versionId.toLowerCase();
  if (state.acceptedVersionId !== null) fail('slot_already_accepted');
  pending(state);
  const found = state.candidates.find(c => c.versionId === versionId);
  if (found) {
    if (found.sizeBytes !== sizeBytes) fail('request_identity_conflict');
    if (found.rejected) fail('candidate_rejected');
    return state;
  }
  if (state.candidates.length >= SCREEN_SELECTION_BOUNDS.candidates) fail('candidate_limit');
  if (state.candidates.some(c => !c.rejected)) fail('candidate_not_settled');
  const next = changed(state);
  next.candidates.push({
    versionId,
    sizeBytes,
    acquisition: 0,
    validatedAcquisition: null,
    rejected: false
  });
  return next;
}
export function reserveScreenTransfer(
  state: ScreenSelectionBudget,
  versionId: string,
  requestId: string,
  offset: number
): { state: ScreenSelectionBudget; created: boolean; reservation: ScreenTransferReservation } {
  if (!uuid(versionId) || !uuid(requestId) || !whole(offset)) fail('invalid_range');
  versionId = versionId.toLowerCase();
  requestId = requestId.toLowerCase();
  const c = candidate(state, versionId),
    repeated = state.transfers.find(t => t.requestId === requestId);
  if (repeated) {
    if (repeated.candidateVersionId !== versionId || repeated.offset !== offset)
      fail('request_identity_conflict');
    return { state, created: false, reservation: structuredClone(repeated) };
  }
  if (state.refreshes.some(r => r.requestId === requestId)) fail('request_identity_conflict');
  pending(state);
  if (c.rejected) fail('candidate_rejected');
  if (state.acceptedVersionId !== null && state.acceptedVersionId !== versionId)
    fail('slot_already_accepted');
  if (c.validatedAcquisition === c.acquisition) fail('slot_already_validated');
  const transfers = state.transfers.filter(
    t => t.candidateVersionId === versionId && t.acquisition === c.acquisition
  );
  const nextOffset = transfers.reduce(
    (n, t) => (t.settlement?.complete ? Math.max(n, t.offset + t.settlement.bytes) : n),
    0
  );
  const lastOffset = transfers.at(-1)?.offset ?? null;
  if (offset >= c.sizeBytes || (offset !== nextOffset && offset !== lastOffset))
    fail('unexpected_offset');
  const retry = offset === lastOffset,
    b = SCREEN_SELECTION_BOUNDS;
  if (
    retry &&
    (retryCount(state, versionId) >= b.candidateRetries || retryCount(state) >= b.retries)
  )
    fail('retry_limit');
  const usedBytes = state.transfers.reduce(
    (n, t) => n + (t.settlement?.bytes ?? t.bytesReserved),
    0
  );
  const usedIo = state.transfers.reduce((n, t) => n + (t.settlement?.ioMs ?? t.ioMsReserved), 0);
  const bytesReserved = Math.min(b.rangeBytes, c.sizeBytes - offset);
  if (usedBytes + bytesReserved > b.bytes) fail('byte_limit');
  if (usedIo >= b.ioMs) fail('io_limit');
  if (state.transfers.length >= b.transferRecords) fail('invalid_state');
  const reservation: ScreenTransferReservation = {
    requestId,
    candidateVersionId: versionId,
    acquisition: c.acquisition,
    offset,
    bytesReserved,
    ioMsReserved: b.ioMs - usedIo,
    retry,
    settlement: null
  };
  const next = changed(state);
  next.transfers.push(reservation);
  return { state: next, created: true, reservation: structuredClone(reservation) };
}
export function settleScreenTransfer(
  state: ScreenSelectionBudget,
  requestId: string,
  measurement: ScreenTransferMeasurement
): ScreenSelectionBudget {
  const t =
    state.transfers.find(t => t.requestId === requestId.toLowerCase()) ??
    fail('reservation_missing');
  if (
    !whole(measurement.bytes, 0, t.bytesReserved) ||
    !whole(measurement.ioMs) ||
    typeof measurement.complete !== 'boolean' ||
    (measurement.complete && measurement.bytes !== t.bytesReserved)
  )
    fail('invalid_measurement');
  if (t.settlement !== null) {
    if (
      t.settlement.bytes !== measurement.bytes ||
      t.settlement.ioMs !== measurement.ioMs ||
      t.settlement.complete !== measurement.complete
    )
      fail('settlement_conflict');
    return state;
  }
  const next = changed(state);
  next.transfers.find(r => r.requestId === t.requestId)!.settlement = { ...measurement };
  return next;
}
export function rejectScreenCandidate(
  state: ScreenSelectionBudget,
  versionId: string,
  acquisition: number
): ScreenSelectionBudget {
  const c = candidate(state, versionId.toLowerCase());
  if (c.acquisition !== acquisition) fail('acquisition_mismatch');
  pending(state);
  if (c.rejected) return state;
  const next = changed(state),
    rejected = candidate(next, c.versionId);
  rejected.rejected = true;
  rejected.validatedAcquisition = null;
  if (next.acceptedVersionId === c.versionId) next.acceptedVersionId = null;
  return next;
}
export function refreshScreenCandidateGrant(
  state: ScreenSelectionBudget,
  versionId: string,
  requestId: string
): ScreenSelectionBudget {
  if (!uuid(requestId)) fail('invalid_range');
  versionId = versionId.toLowerCase();
  requestId = requestId.toLowerCase();
  const c = candidate(state, versionId),
    repeated = state.refreshes.find(r => r.requestId === requestId);
  if (repeated) {
    if (repeated.candidateVersionId !== versionId) fail('request_identity_conflict');
    return state;
  }
  pending(state);
  if (c.rejected) fail('candidate_rejected');
  if (state.transfers.some(t => t.requestId === requestId)) fail('request_identity_conflict');
  if (
    state.refreshes.length >= SCREEN_SELECTION_BOUNDS.refreshes ||
    state.refreshes.some(r => r.candidateVersionId === versionId)
  )
    fail('refresh_limit');
  const next = changed(state);
  next.refreshes.push({ requestId, candidateVersionId: versionId });
  return next;
}
export function acceptScreenCandidate(
  state: ScreenSelectionBudget,
  versionId: string,
  acquisition: number
): ScreenSelectionBudget {
  const c = candidate(state, versionId.toLowerCase());
  if (c.acquisition !== acquisition) fail('acquisition_mismatch');
  pending(state);
  if (c.rejected || (state.acceptedVersionId !== null && state.acceptedVersionId !== c.versionId))
    fail('candidate_not_active');
  if (state.acceptedVersionId === c.versionId && c.validatedAcquisition === acquisition)
    return state;
  const next = changed(state);
  next.acceptedVersionId = c.versionId;
  candidate(next, c.versionId).validatedAcquisition = acquisition;
  return next;
}
export function reacquireScreenCandidate(
  state: ScreenSelectionBudget,
  versionId: string
): ScreenSelectionBudget {
  const c = candidate(state, versionId.toLowerCase());
  pending(state);
  if (
    c.rejected ||
    state.acceptedVersionId !== c.versionId ||
    c.validatedAcquisition !== c.acquisition
  )
    fail('candidate_not_active');
  if (
    retryCount(state, c.versionId) >= SCREEN_SELECTION_BOUNDS.candidateRetries ||
    retryCount(state) >= SCREEN_SELECTION_BOUNDS.retries
  )
    fail('retry_limit');
  const next = changed(state);
  candidate(next, c.versionId).acquisition++;
  return next;
}
