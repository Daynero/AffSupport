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
  const childrenByParent = new Map<number, number[]>();
  for (const row of rows) {
    // A process is never its own parent in a sane table, but a malformed row
    // would otherwise make the walk below loop forever.
    if (row.pid === row.ppid) continue;
    const siblings = childrenByParent.get(row.ppid);
    if (siblings) siblings.push(row.pid);
    else childrenByParent.set(row.ppid, [row.pid]);
  }

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
