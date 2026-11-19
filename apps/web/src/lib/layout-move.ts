/**
 * Things that a change of layout moves travel to their new place (058).
 *
 * A card that arrives beside a list narrows it; a note above it that wraps to a
 * second line pushes it down. Each tile and row is then somewhere else in the
 * very next frame. Dissolving the list hides that — and with it the thing the
 * eye was on, which reappears a little lower (owner, beta: "it fades and comes
 * back below; it should just slide down, so the eye keeps its place").
 *
 * So the places are remembered before the change and, once the page has been
 * laid out again, each thing that moved starts from where it stood and travels
 * to where it now stands. Nothing is copied and nothing fades: these are the
 * live elements, and they answer to the pointer the whole way.
 *
 * Only position is carried. A thing that also changed size takes its new size
 * at once — stretching a row of text across the move would smear it.
 *
 *   rememberPlaces(scope, selector)   before the change (not yet committed)
 *   moveFromPlaces(scope)             after it, before the frame is painted
 */

/** Past this many a list is mostly off screen, and only what is near the window is measured. */
const MAX_MOVERS = 600;
/** How far past the window a thing may start or end and still be worth moving. */
const OFFSCREEN_MARGIN = 160;
/** A stale memory — the change never came — is not played against a later one. */
const MEMORY_MS = 1_000;
/** Less than this is not a move. */
const MIN_SHIFT = 0.5;

interface Places {
  at: number;
  rects: Map<HTMLElement, DOMRect>;
}

const remembered = new WeakMap<HTMLElement, Places>();
const moving = new WeakMap<HTMLElement, Animation>();

function still(): boolean {
  if (typeof document === 'undefined' || document.visibilityState === 'hidden') return true;
  if (typeof Element.prototype.animate !== 'function') return true;
  if (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
    return true;
  const classes = document.documentElement.classList;
  // A transition of the whole screen is a picture of it: nothing under it is seen to move.
  return (
    classes.contains('is-theming') ||
    classes.contains('wishly-page-transition') ||
    classes.contains('wishly-section-transition')
  );
}

function near(rect: DOMRect): boolean {
  return rect.bottom > -OFFSCREEN_MARGIN && rect.top < window.innerHeight + OFFSCREEN_MARGIN;
}

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function milliseconds(raw: string, fallback: number): number {
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return fallback;
  return raw.endsWith('ms') ? value : value * 1000;
}

/**
 * Notes where everything in `scope` that matches `selector` stands. Call it
 * before the change reaches the page: from `getSnapshotBeforeUpdate`
 * (`BeforeChange`), or a ref's cleanup.
 */
export function rememberPlaces(scope: HTMLElement | null | undefined, selector: string) {
  if (!scope?.isConnected || still()) return;
  const found = scope.querySelectorAll<HTMLElement>(selector);
  const rects = new Map<HTMLElement, DOMRect>();
  const all = found.length <= MAX_MOVERS;
  for (const node of found) {
    // Something already on its way is measured where it is seen, not where it is headed.
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (all || near(rect)) rects.set(node, rect);
  }
  if (rects.size) remembered.set(scope, { at: performance.now(), rects });
}

/**
 * Starts everything remembered in `scope` from where it stood, on its way to
 * where it stands now. Call it once the change is in the page and before the
 * frame is painted (a layout effect). Returns how many things moved.
 */
export function moveFromPlaces(scope: HTMLElement | null | undefined): number {
  if (!scope) return 0;
  const places = remembered.get(scope);
  remembered.delete(scope);
  if (!places || !scope.isConnected || still()) return 0;
  if (performance.now() - places.at > MEMORY_MS) return 0;

  // Every running move is ended first, so that what is read below is where things now belong.
  for (const node of places.rects.keys()) moving.get(node)?.cancel();

  const shifts = new Map<HTMLElement, { x: number; y: number; from: DOMRect; to: DOMRect }>();
  for (const [node, from] of places.rects) {
    if (!node.isConnected) continue;
    const to = node.getBoundingClientRect();
    if (to.width === 0 && to.height === 0) continue;
    shifts.set(node, { x: from.left - to.left, y: from.top - to.top, from, to });
  }

  const duration = milliseconds(token('--motion-base'), 220);
  const easing = token('--ease-soft-out') || 'ease-out';
  let moved = 0;
  for (const [node, shift] of shifts) {
    // A thing inside another that moves is carried by it: only the rest of its own way is its.
    let x = shift.x;
    let y = shift.y;
    for (let up = node.parentElement; up && up !== scope; up = up.parentElement) {
      const carrier = shifts.get(up);
      if (!carrier) continue;
      x -= carrier.x;
      y -= carrier.y;
      break;
    }
    if (Math.abs(x) < MIN_SHIFT && Math.abs(y) < MIN_SHIFT) continue;
    if (!near(shift.from) && !near(shift.to)) continue;
    // `translate`, not `transform`: a tile's own press and hover are written in `transform`.
    const animation = node.animate([{ translate: `${x}px ${y}px` }, { translate: '0px 0px' }], {
      duration,
      easing
    });
    moving.set(node, animation);
    const done = () => {
      if (moving.get(node) === animation) moving.delete(node);
    };
    animation.finished.then(done, done);
    moved += 1;
  }
  return moved;
}
