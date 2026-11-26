import { expect, it } from 'vitest';
import { LAUNCH_GENERATION_STATES, launchInputsLocked } from '../packages/shared/src/team/launches';
import { launchDeleteLocked } from '../apps/web/src/team/launches/launchPresentation';

// Production 2026-11-26: a cancelled launch that was still removing its leftovers had no Cancel
// (it was cancelled already) and a Delete that the card kept disabled and the server refused.
it('lets a cancelled launch that is only cleaning up be deleted, and nothing else unfinished', () => {
  expect(launchDeleteLocked(null)).toBe(false);
  for (const state of LAUNCH_GENERATION_STATES)
    expect([state, launchDeleteLocked(state)]).toEqual([
      state,
      state === 'canceled_with_cleanup_pending' ? false : launchInputsLocked(state)
    ]);
  // Its inputs stay closed: only deleting is let through.
  expect(launchInputsLocked('canceled_with_cleanup_pending')).toBe(true);
  expect(launchDeleteLocked('cancel_requested')).toBe(true);
  expect(launchDeleteLocked('running')).toBe(true);
  expect(launchDeleteLocked('interrupted')).toBe(true);
});
