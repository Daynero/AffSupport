import { useEffect, useState } from 'react';

export interface StatusStage<Key extends string> {
  key: Key;
  /** How long this stage is shown before the next one takes over. */
  ms: number;
}

/**
 * Which of a long request's steps to name right now (024, US30).
 *
 * Making a catalog is one request that does seven things on the server — and
 * for twenty seconds the form showed a spinner and one unchanging sentence,
 * which is exactly what a hung page shows. The server does not report its
 * progress and one request cannot, so this walks the same steps in the same
 * order on an estimate: each stage holds for about as long as the server spends
 * on it, and the last one holds until the answer arrives. It never finishes on
 * its own and never claims a percentage — it says what is being done, not how
 * much is left.
 *
 * Returns the index of the stage to show, or -1 when idle.
 */
export function useStagedStatus<Key extends string>(
  active: boolean,
  stages: ReadonlyArray<StatusStage<Key>>
): number {
  const [index, setIndex] = useState(-1);
  // The timings, not the array: a caller builds the stages inline on every
  // render, and a new identity must not restart the walk.
  const timing = stages.map(stage => stage.ms).join(',');

  useEffect(() => {
    if (!active) {
      setIndex(-1);
      return;
    }
    const durations = timing.split(',').map(Number);
    let current = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setIndex(0);
    const advance = () => {
      if (current >= durations.length - 1) return;
      timer = setTimeout(() => {
        current += 1;
        setIndex(current);
        advance();
      }, durations[current]);
    };
    advance();
    return () => clearTimeout(timer);
  }, [active, timing]);

  return index;
}
