/**
 * A strict read (the one a finished sync waits for) and the background reads
 * a Realtime event starts race for the same screen. The newest read is the
 * one that paints it, so it is the one whose outcome is reported (028).
 */
export type ReadResult = 'ok' | 'superseded' | 'failed';

/**
 * Waits for `attempt`, then — if a newer read took over — for that one, until
 * the read that actually painted the screen has answered. `superseded` comes
 * back only when the component went away mid-read.
 */
export async function settleRead(
  attempt: Promise<ReadResult>,
  latest: { current: Promise<ReadResult> | null }
): Promise<ReadResult> {
  let awaited = attempt;
  let result = await awaited;
  while (result === 'superseded' && latest.current && latest.current !== awaited) {
    awaited = latest.current;
    result = await awaited;
  }
  return result;
}
