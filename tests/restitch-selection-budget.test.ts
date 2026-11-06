import { expect, it } from 'vitest';
import {
  createScreenSelectionBudget,
  parseScreenSelectionBudget,
  selectScreenCandidate,
  reserveScreenTransfer,
  settleScreenTransfer,
  rejectScreenCandidate,
  refreshScreenCandidateGrant,
  acceptScreenCandidate,
  reacquireScreenCandidate,
  SCREEN_SELECTION_BOUNDS as bounds
} from '../packages/shared/src/team/restitch-selection';
const id = (n: number) => `47000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
it('retains a discarded prefix and prevents replay or restart from authorizing fresh I/O', () => {
  let state = selectScreenCandidate(createScreenSelectionBudget(), id(1), 10);
  const first = reserveScreenTransfer(state, id(1), id(101), 0);
  state = first.state;
  expect(reserveScreenTransfer(state, id(1), id(101), 0).created).toBe(false);
  const restarted = parseScreenSelectionBudget(JSON.parse(JSON.stringify(state)))!;
  expect(restarted).not.toBeNull();
  expect(() => reserveScreenTransfer(restarted, id(1), id(102), 0)).toThrow(
    'accounting_unconfirmed'
  );
  expect(() => rejectScreenCandidate(restarted, id(1), 0)).toThrow('accounting_unconfirmed');
  state = settleScreenTransfer(restarted, id(101), { bytes: 3, ioMs: 20, complete: false });
  state = reserveScreenTransfer(state, id(1), id(102), 0).state;
  state = settleScreenTransfer(state, id(102), { bytes: 10, ioMs: 30, complete: true });
  expect(state.transfers.map(t => t.settlement?.bytes)).toEqual([3, 10]);
  expect(parseScreenSelectionBudget(state)).toEqual(state);
});
it('never selects a rejected version again and keeps the finite candidate window', () => {
  let state = createScreenSelectionBudget();
  for (let n = 1; n <= bounds.candidates; n++) {
    state = selectScreenCandidate(state, id(n), 1);
    state = rejectScreenCandidate(state, id(n), 0);
  }
  expect(() => selectScreenCandidate(state, id(1), 1)).toThrow('candidate_rejected');
  expect(() => selectScreenCandidate(state, id(99), 1)).toThrow('candidate_limit');
});
it('charges every failed candidate to the same byte budget', () => {
  let state = createScreenSelectionBudget(),
    request = 100;
  for (let n = 1; n <= 5; n++) {
    state = selectScreenCandidate(state, id(n), bounds.screenBytes);
    for (let offset = 0; offset < bounds.screenBytes; offset += bounds.rangeBytes) {
      const transfer = reserveScreenTransfer(state, id(n), id(request++), offset);
      state = settleScreenTransfer(transfer.state, transfer.reservation.requestId, {
        bytes: transfer.reservation.bytesReserved,
        ioMs: 1,
        complete: true
      });
    }
    state = rejectScreenCandidate(state, id(n), 0);
  }
  state = selectScreenCandidate(state, id(6), 1);
  expect(() => reserveScreenTransfer(state, id(6), id(request), 0)).toThrow('byte_limit');
});
it('retains a real I/O deadline overrun and never silently clamps observed time', () => {
  let state = selectScreenCandidate(createScreenSelectionBudget(), id(1), 10);
  state = reserveScreenTransfer(state, id(1), id(101), 0).state;
  state = settleScreenTransfer(state, id(101), {
    bytes: 1,
    ioMs: bounds.ioMs + 1,
    complete: false
  });
  expect(state.transfers[0]!.settlement!.ioMs).toBe(bounds.ioMs + 1);
  expect(parseScreenSelectionBudget(state)).toEqual(state);
  expect(() => reserveScreenTransfer(state, id(1), id(102), 0)).toThrow('io_limit');
  expect(
    settleScreenTransfer(state, id(101), { bytes: 1, ioMs: bounds.ioMs + 1, complete: false })
  ).toBe(state);
  expect(() =>
    settleScreenTransfer(state, id(101), { bytes: 2, ioMs: 1, complete: false })
  ).toThrow('settlement_conflict');
});
it('bounds retries across candidates and grant refreshes without resetting identity', () => {
  let state = createScreenSelectionBudget(),
    request = 100;
  for (let n = 1; n <= 3; n++) {
    state = selectScreenCandidate(state, id(n), 10);
    for (let retry = 0; retry < 3; retry++) {
      const t = reserveScreenTransfer(state, id(n), id(request++), 0);
      state = settleScreenTransfer(t.state, t.reservation.requestId, {
        bytes: 1,
        ioMs: 1,
        complete: false
      });
    }
    expect(() => reserveScreenTransfer(state, id(n), id(request++), 0)).toThrow('retry_limit');
    state = rejectScreenCandidate(state, id(n), 0);
  }
  state = selectScreenCandidate(state, id(4), 10);
  const t = reserveScreenTransfer(state, id(4), id(request++), 0);
  state = settleScreenTransfer(t.state, t.reservation.requestId, {
    bytes: 1,
    ioMs: 1,
    complete: false
  });
  expect(() => reserveScreenTransfer(state, id(4), id(request++), 0)).toThrow('retry_limit');
  state = refreshScreenCandidateGrant(state, id(4), id(201));
  expect(refreshScreenCandidateGrant(state, id(4), id(201))).toBe(state);
  expect(() => refreshScreenCandidateGrant(state, id(4), id(202))).toThrow('refresh_limit');
});
it('reacquires an evicted accepted slot under the same budget and rejects stale acquisition reports', () => {
  let state = selectScreenCandidate(createScreenSelectionBudget(), id(1), 10);
  state = acceptScreenCandidate(state, id(1), 0);
  expect(() => reserveScreenTransfer(state, id(1), id(101), 0)).toThrow('slot_already_validated');
  state = reacquireScreenCandidate(state, id(1));
  expect(state.acceptedVersionId).toBe(id(1));
  const transfer = reserveScreenTransfer(state, id(1), id(101), 0);
  state = settleScreenTransfer(transfer.state, id(101), { bytes: 10, ioMs: 5, complete: true });
  expect(() => rejectScreenCandidate(state, id(1), 0)).toThrow('acquisition_mismatch');
  state = acceptScreenCandidate(state, id(1), 1);
  expect(() => selectScreenCandidate(state, id(2), 10)).toThrow('slot_already_accepted');
  state = reacquireScreenCandidate(state, id(1));
  state = acceptScreenCandidate(state, id(1), 2);
  expect(() => reacquireScreenCandidate(state, id(1))).toThrow('retry_limit');
  expect(parseScreenSelectionBudget(state)).toEqual(state);
});
it('rejects corrupt persisted accounting instead of accepting reset counters or forged reservations', () => {
  let state = selectScreenCandidate(createScreenSelectionBudget(), id(1), 10);
  state = reserveScreenTransfer(state, id(1), id(101), 0).state;
  state = settleScreenTransfer(state, id(101), { bytes: 1, ioMs: 5, complete: false });
  state = reserveScreenTransfer(state, id(1), id(102), 0).state;
  const corrupt = JSON.parse(JSON.stringify(state));
  corrupt.transfers[1].retry = false;
  expect(parseScreenSelectionBudget(corrupt)).toBeNull();
  corrupt.transfers[1].retry = true;
  corrupt.transfers[1].bytesReserved = 1;
  expect(parseScreenSelectionBudget(corrupt)).toBeNull();
  expect(parseScreenSelectionBudget({ ...state, schemaVersion: 2 })).toBeNull();
  expect(parseScreenSelectionBudget({ ...state, acceptedVersionId: id(99) })).toBeNull();
});
it('keeps old reservation readback idempotent after a later cache acquisition without authorizing another fetch', () => {
  let state = selectScreenCandidate(createScreenSelectionBudget(), id(1), 10);
  state = reserveScreenTransfer(state, id(1), id(101), 0).state;
  state = settleScreenTransfer(state, id(101), { bytes: 10, ioMs: 1, complete: true });
  state = acceptScreenCandidate(state, id(1), 0);
  state = reacquireScreenCandidate(state, id(1));
  const replay = reserveScreenTransfer(state, id(1), id(101), 0);
  expect(replay.created).toBe(false);
  expect(replay.reservation.acquisition).toBe(0);
  expect(replay.state).toBe(state);
});
it('does not accept reset revisions or history that returns to a retired acquisition', () => {
  let state = selectScreenCandidate(createScreenSelectionBudget(), id(1), 10);
  state = reserveScreenTransfer(state, id(1), id(101), 0).state;
  state = settleScreenTransfer(state, id(101), { bytes: 10, ioMs: 1, complete: true });
  state = acceptScreenCandidate(state, id(1), 0);
  state = reacquireScreenCandidate(state, id(1));
  state = reserveScreenTransfer(state, id(1), id(102), 0).state;
  state = settleScreenTransfer(state, id(102), { bytes: 10, ioMs: 1, complete: true });
  expect(parseScreenSelectionBudget({ ...state, revision: 0 })).toBeNull();
  const corrupt = structuredClone(state);
  corrupt.transfers[0]!.acquisition = 1;
  corrupt.transfers[1]!.acquisition = 0;
  expect(parseScreenSelectionBudget(corrupt)).toBeNull();
});

it.each([
  [
    'two active candidates',
    () => {
      let state = selectScreenCandidate(createScreenSelectionBudget(), id(1), 10);
      state = rejectScreenCandidate(state, id(1), 0);
      state = selectScreenCandidate(state, id(2), 10);
      state.candidates[0]!.rejected = false;
      return state;
    }
  ],
  [
    'an active candidate behind a retired later candidate',
    () => {
      let state = selectScreenCandidate(createScreenSelectionBudget(), id(1), 10);
      state = rejectScreenCandidate(state, id(1), 0);
      state = selectScreenCandidate(state, id(2), 10);
      state = rejectScreenCandidate(state, id(2), 0);
      state.candidates[0]!.rejected = false;
      return state;
    }
  ],
  [
    'a cache reacquisition that skipped its preceding validation',
    () => {
      let state = selectScreenCandidate(createScreenSelectionBudget(), id(1), 10);
      state = acceptScreenCandidate(state, id(1), 0);
      state = reacquireScreenCandidate(state, id(1));
      state = acceptScreenCandidate(state, id(1), 1);
      state = reacquireScreenCandidate(state, id(1));
      state.candidates[0]!.validatedAcquisition = 0;
      return state;
    }
  ],
  [
    'a rejected candidate with an unsettled transfer',
    () => {
      const state = reserveScreenTransfer(
        selectScreenCandidate(createScreenSelectionBudget(), id(1), 10),
        id(1),
        id(101),
        0
      ).state;
      state.candidates[0]!.rejected = true;
      state.revision++;
      return state;
    }
  ],
  [
    'an unsettled transfer from a retired cache acquisition',
    () => {
      let state = selectScreenCandidate(createScreenSelectionBudget(), id(1), 10);
      state = acceptScreenCandidate(state, id(1), 0);
      state = reacquireScreenCandidate(state, id(1));
      state = reserveScreenTransfer(state, id(1), id(101), 0).state;
      state.candidates[0]!.acquisition = 2;
      state.revision += 2;
      return state;
    }
  ],
  [
    'validation before the current transfer was settled',
    () => {
      const state = reserveScreenTransfer(
        selectScreenCandidate(createScreenSelectionBudget(), id(1), 10),
        id(1),
        id(101),
        0
      ).state;
      state.acceptedVersionId = id(1);
      state.candidates[0]!.validatedAcquisition = 0;
      state.revision++;
      return state;
    }
  ]
] as const)('refuses impossible persisted history: %s', (_name, corrupt) => {
  expect(parseScreenSelectionBudget(corrupt())).toBeNull();
});

it('reacquires unavailable unvalidated prefixes without inventing validation or resetting cost', () => {
  const size = 2 * bounds.rangeBytes + 4,
    version = id(1);
  let state = selectScreenCandidate(createScreenSelectionBudget(), version, size);
  let request = 300;
  for (const offset of [0, bounds.rangeBytes]) {
    const transfer = reserveScreenTransfer(state, version, id(request++), offset);
    state = settleScreenTransfer(transfer.state, transfer.reservation.requestId, {
      bytes: transfer.reservation.bytesReserved,
      ioMs: 1,
      complete: true
    });
  }
  expect(() => reserveScreenTransfer(state, version, id(request++), 0)).toThrow(
    'unexpected_offset'
  );
  state = reacquireScreenCandidate(state, version);
  expect(state.acceptedVersionId).toBeNull();
  expect(state.candidates[0]?.validatedAcquisition).toBeNull();
  expect(parseScreenSelectionBudget(JSON.parse(JSON.stringify(state)))).toEqual(state);
  for (let offset = 0; offset < size; offset += bounds.rangeBytes) {
    const transfer = reserveScreenTransfer(state, version, id(request++), offset);
    state = settleScreenTransfer(transfer.state, transfer.reservation.requestId, {
      bytes: transfer.reservation.bytesReserved,
      ioMs: 1,
      complete: true
    });
  }
  state = acceptScreenCandidate(state, version, 1);
  expect(parseScreenSelectionBudget(state)).toEqual(state);
  expect(state.transfers.reduce((sum, t) => sum + (t.settlement?.bytes ?? 0), 0)).toBe(
    4 * bounds.rangeBytes + 4
  );
  expect(state.candidates[0]?.acquisition).toBe(1);
});
it('retains the per-file reacquisition bound across repeated unvalidated restarts', () => {
  let state = selectScreenCandidate(createScreenSelectionBudget(), id(1), 10);
  for (let acquisition = 0; acquisition < 3; acquisition++) {
    const transfer = reserveScreenTransfer(state, id(1), id(400 + acquisition), 0);
    state = settleScreenTransfer(transfer.state, transfer.reservation.requestId, {
      bytes: 2,
      ioMs: 5,
      complete: false
    });
    if (acquisition < 2) {
      state = reacquireScreenCandidate(state, id(1));
      expect(parseScreenSelectionBudget(state)).toEqual(state);
    }
  }
  expect(() => reacquireScreenCandidate(state, id(1))).toThrow('retry_limit');
  expect(state.transfers).toHaveLength(3);
  expect(state.acceptedVersionId).toBeNull();
});
it('does not create an unvalidated acquisition before work or skip missing attempt history', () => {
  const initial = selectScreenCandidate(createScreenSelectionBudget(), id(1), 10);
  expect(() => reacquireScreenCandidate(initial, id(1))).toThrow('candidate_not_active');
  const transfer = reserveScreenTransfer(initial, id(1), id(500), 0);
  expect(() => reacquireScreenCandidate(transfer.state, id(1))).toThrow('accounting_unconfirmed');
  const forged = settleScreenTransfer(transfer.state, id(500), {
    bytes: 2,
    ioMs: 5,
    complete: false
  });
  forged.candidates[0]!.acquisition = 2;
  forged.revision += 2;
  expect(parseScreenSelectionBudget(forged)).toBeNull();
});
