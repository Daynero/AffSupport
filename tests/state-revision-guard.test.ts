import { describe, expect, it } from 'vitest';
import { isNewerSnapshot } from '../packages/shared/src/types.js';

/**
 * FR-037 / D3 / SC-013. The interface must never move backwards.
 *
 * The race is ordinary and easy to miss: a state request is in flight when an
 * event fires, the event lands first, the request resolves second and
 * overwrites it. What the user sees is a job running that has already
 * finished — and nothing corrects it until the next event, which may be
 * minutes away or never, because the job is done.
 *
 * The guard is one comparison in one place. What makes it worth a test is the
 * two cases where the obvious version is wrong.
 */

describe('a snapshot that lost the race', () => {
  it('cannot overwrite a newer one', () => {
    expect(isNewerSnapshot({ revision: 4 }, { revision: 7 })).toBe(false);
  });

  it('wins when it is newer', () => {
    expect(isNewerSnapshot({ revision: 8 }, { revision: 7 })).toBe(true);
  });

  it('is allowed through when the revision is unchanged', () => {
    // A manual refresh re-fetches the same state. Refusing it would make the
    // refresh button appear to do nothing, and it costs nothing to apply.
    expect(isNewerSnapshot({ revision: 7 }, { revision: 7 })).toBe(true);
  });

  it('is allowed through when there is nothing shown yet', () => {
    expect(isNewerSnapshot({ revision: 0 }, null)).toBe(true);
  });
});

describe('an agent that predates the field', () => {
  it('is treated as revision zero rather than rejected', () => {
    // An older local app omits `revision` entirely. Normalising to zero makes
    // the guard degrade to the behaviour that existed before it, instead of
    // making every snapshot from an old agent unusable.
    expect(isNewerSnapshot({}, {})).toBe(true);
    expect(isNewerSnapshot({}, { revision: 3 })).toBe(false);
    expect(isNewerSnapshot({ revision: 3 }, {})).toBe(true);
  });
});

describe('a local app that restarted', () => {
  it('is not rejected for counting from zero again', () => {
    // The counter is per-run. A restart resets it, so the first snapshot of the
    // new run is numerically older than the last snapshot of the old one —
    // and rejecting it would freeze the interface on a dead run's final state.
    // The caller says "different instance"; the guard does not guess.
    expect(isNewerSnapshot({ revision: 0 }, { revision: 91 }, { sameInstance: false })).toBe(true);
  });

  it('still applies the comparison within one run', () => {
    expect(isNewerSnapshot({ revision: 0 }, { revision: 91 }, { sameInstance: true })).toBe(false);
  });
});
