import type { ProcessTableRow } from '../platform/platform.js';

/**
 * Descendants of `roots`, from a process-table snapshot.
 *
 * FFmpeg and whisper are leaves, but Playwright launches a Chromium tree, so
 * measuring only the direct child would under-report what Soty is actually
 * consuming — and throttling only the direct child would leave the renderers
 * running at full speed.
 */
export function descendantsOf(
  rows: readonly ProcessTableRow[],
  roots: readonly number[]
): number[] {
  return walk(childIndex(rows), roots);
}

/**
 * The same walk, once per root, over ONE index of the table.
 *
 * The governor tracks several children at a time and needs each one's own
 * descendants. Calling `descendantsOf` in a loop would rebuild the index —
 * every row of the process table — for each of them, on every refresh.
 */
export function descendantsByRoot(
  rows: readonly ProcessTableRow[],
  roots: readonly number[]
): Map<number, number[]> {
  const index = childIndex(rows);
  const result = new Map<number, number[]>();
  for (const root of roots) result.set(root, walk(index, [root]));
  return result;
}

function childIndex(rows: readonly ProcessTableRow[]): Map<number, number[]> {
  const childrenByParent = new Map<number, number[]>();
  for (const row of rows) {
    // A process is never its own parent in a sane table, but a malformed row
    // would otherwise make the walk below loop forever.
    if (row.pid === row.ppid) continue;
    const siblings = childrenByParent.get(row.ppid);
    if (siblings) siblings.push(row.pid);
    else childrenByParent.set(row.ppid, [row.pid]);
  }
  return childrenByParent;
}

function walk(childrenByParent: Map<number, number[]>, roots: readonly number[]): number[] {
  const found = new Set<number>();
  const queue = [...roots];
  while (queue.length > 0) {
    const pid = queue.pop() as number;
    for (const child of childrenByParent.get(pid) ?? []) {
      // `found` doubles as the cycle guard: a table captured mid-reparenting
      // can contain a loop, and re-walking it would never terminate.
      if (found.has(child) || roots.includes(child)) continue;
      found.add(child);
      queue.push(child);
    }
  }
  return [...found];
}

/**
 * What a set of processes consumed between two readings of a cumulative counter (CPU
 * seconds, GPU nanoseconds), differenced PER PROCESS.
 *
 * Summing first and differencing the totals looks equivalent and is not: the set of PIDs
 * changes between readings, so the difference of two sums silently includes processes that
 * exist in only one of them. A descendant discovered seconds after it started arrives
 * carrying everything it has ever used — Chromium's renderers do exactly this — and that
 * whole lifetime would land in one tick as a spike toward 100%. A child that exited would
 * make the sum drop, and a clamp would turn the tick into a flat 0% while work was running.
 *
 * So a PID present in only one reading contributes nothing: a new one starts counting from
 * its next reading, and a departed one is simply gone. A PID the OS recycled onto something
 * else can report less than it did a moment ago; that is not negative consumption.
 */
export function consumedPerProcess(
  previous: ReadonlyMap<number, number>,
  current: ReadonlyMap<number, number>
): number {
  let consumed = 0;
  for (const [pid, value] of current) {
    const before = previous.get(pid);
    if (before === undefined) continue;
    consumed += Math.max(0, value - before);
  }
  return consumed;
}
