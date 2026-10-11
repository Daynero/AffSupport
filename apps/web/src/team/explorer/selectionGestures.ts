/**
 * The file manager's selection grammar, as pure functions (the owner, 2026-10: "select several
 * files by dragging a rectangle, the way Finder and Explorer do").
 *
 * Two states live side by side in the explorer: the focused row (the one the pane describes and
 * the arrows move from) and the checked set (what a batch acts on). A plain press focuses and
 * leaves the checked set alone; ⌘/Ctrl adds or removes one; Shift takes the run from the anchor;
 * a rectangle drawn over empty space checks what it touches; a press on empty space lets go.
 *
 * Nothing here touches the DOM: the hooks measure, these decide, and the tests read these.
 */

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Point {
  x: number;
  y: number;
}

/** A press that moves less than this is a click, not a rectangle (Finder uses about the same). */
export const MARQUEE_THRESHOLD_PX = 4;

export function boxFromPoints(a: Point, b: Point): Box {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y)
  };
}

/**
 * Whether two boxes overlap. Touching edges do not count, so a rectangle that stops exactly at a
 * tile's border leaves it alone; a flat rectangle (a horizontal drag) still takes what it crosses.
 */
export function intersects(a: Box, b: Box): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export function exceedsThreshold(start: Point, current: Point, threshold = MARQUEE_THRESHOLD_PX) {
  return Math.hypot(current.x - start.x, current.y - start.y) >= threshold;
}

export function clamp(value: number, min: number, max: number): number {
  // An inverted range (a container scrolled entirely under the sticky header) settles on `max`.
  return Math.min(Math.max(value, min), max);
}

export interface Modifiers {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

/** ⌘ on a Mac (where Ctrl+press is the context menu), Ctrl elsewhere. */
export function hasToggleModifier(modifiers: Modifiers, apple: boolean): boolean {
  return apple ? modifiers.metaKey : modifiers.ctrlKey || modifiers.metaKey;
}

export type MarqueeMode = 'replace' | 'add' | 'toggle';

/** ⌘/Ctrl wins over Shift, as in Finder: both held, the rectangle flips what it touches. */
export function marqueeMode(modifiers: Modifiers, apple: boolean): MarqueeMode {
  if (hasToggleModifier(modifiers, apple)) return 'toggle';
  if (modifiers.shiftKey) return 'add';
  return 'replace';
}

/**
 * The checked set while a rectangle is drawn, from the set as it was when the press began. It is
 * recomputed from that starting set on every frame, so shrinking the rectangle gives back what it
 * no longer covers — toggled items flip back, added ones drop out again.
 */
export function mergeSelection(
  start: ReadonlySet<string>,
  hit: Iterable<string>,
  mode: MarqueeMode
): Set<string> {
  if (mode === 'replace') return new Set(hit);
  const next = new Set(start);
  for (const id of hit) {
    if (mode === 'add') next.add(id);
    else if (start.has(id)) next.delete(id);
    else next.add(id);
  }
  return next;
}

export function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** The run between two ids in the order the reader sees, both ends included; empty if either is gone. */
export function rangeBetween(order: readonly string[], fromId: string, toId: string): string[] {
  const from = order.indexOf(fromId);
  const to = order.indexOf(toId);
  if (from < 0 || to < 0) return [];
  return order.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/**
 * Where a Shift+press measures from, and what was checked before the run began — so a second
 * Shift+press re-draws the run from the same anchor instead of piling one run on another.
 */
export interface SelectionAnchor {
  id: string;
  base: readonly string[];
}

export type PressKind = 'plain' | 'toggle' | 'range';

export function pressKind(modifiers: Modifiers, apple: boolean): PressKind {
  if (hasToggleModifier(modifiers, apple)) return 'toggle';
  if (modifiers.shiftKey) return 'range';
  return 'plain';
}

export interface PressInput {
  kind: PressKind;
  clickedId: string;
  /** The rows in the order the reader sees them — the order the arrow keys walk. */
  order: readonly string[];
  checked: ReadonlySet<string>;
  focusedId: string | null;
  anchor: SelectionAnchor | null;
}

export interface PressResult {
  checked: Set<string>;
  focusId: string;
  anchor: SelectionAnchor;
}

/**
 * One press on a row or a tile.
 *
 * - plain: focuses it and leaves the checked set as it is. Finder would let go of the others here,
 *   and this explorer deliberately does not: the set is built across folders (a double-click on a
 *   folder is a plain press first, and must not drop what was gathered on the way in), and the
 *   selection bar above the list leaves with the set — the list jumped by the bar's height between
 *   the two presses of a double-click, and the second press landed on another row. Letting go is
 *   a press on empty space, Escape, or the bar's cross.
 * - toggle (⌘/Ctrl): adds or removes it. With nothing checked yet, the row focused by the previous
 *   plain press joins it, as Finder's ⌘-press keeps the item already selected.
 * - range (Shift): checks the run from the anchor to it, on top of what was checked before the
 *   run; without an anchor in view it is added on its own.
 */
export function applyPress(input: PressInput): PressResult {
  const { kind, clickedId, order, checked, focusedId } = input;
  const inView = (id: string | null | undefined): id is string =>
    Boolean(id) && order.includes(id as string);

  if (kind === 'plain') {
    const next = new Set(checked);
    return { checked: next, focusId: clickedId, anchor: { id: clickedId, base: [...next] } };
  }

  if (kind === 'toggle') {
    const next = new Set(checked);
    if (next.size === 0 && inView(focusedId) && focusedId !== clickedId) {
      next.add(focusedId);
      next.add(clickedId);
    } else if (next.has(clickedId)) {
      next.delete(clickedId);
    } else {
      next.add(clickedId);
    }
    return { checked: next, focusId: clickedId, anchor: { id: clickedId, base: [...next] } };
  }

  const anchor: SelectionAnchor | null = inView(input.anchor?.id)
    ? input.anchor
    : inView(focusedId)
      ? { id: focusedId, base: [...checked] }
      : null;
  if (!anchor) {
    const next = new Set(checked);
    next.add(clickedId);
    return { checked: next, focusId: clickedId, anchor: { id: clickedId, base: [...checked] } };
  }
  const next = new Set(anchor.base);
  for (const id of rangeBetween(order, anchor.id, clickedId)) next.add(id);
  return { checked: next, focusId: clickedId, anchor };
}

/**
 * Pixels to scroll this frame while a rectangle is drawn: zero in the middle of the window,
 * growing as the pointer nears (or passes) the visible top — the bottom of the sticky header —
 * or the window's bottom edge.
 */
export function autoScrollStep(
  pointerY: number,
  topBound: number,
  bottomBound: number,
  edge = 48,
  max = 22
): number {
  if (bottomBound - topBound <= edge * 2) return 0;
  if (pointerY < topBound + edge) {
    const depth = Math.min(1, (topBound + edge - pointerY) / edge);
    return -Math.ceil(max * depth);
  }
  if (pointerY > bottomBound - edge) {
    const depth = Math.min(1, (pointerY - (bottomBound - edge)) / edge);
    return Math.ceil(max * depth);
  }
  return 0;
}
