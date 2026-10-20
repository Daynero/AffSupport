/** Focus belongs to the visible table even when an adjacent deferred group grows.
 * A real scroll gesture releases the guard; it must never pull a scroller back.
 */
interface Guard {
  refs: number;
  target: HTMLElement | null;
  frame: number | null;
  dispose: () => void;
}
const guards = new WeakMap<HTMLElement, Guard>();

export function scheduleAccountFocusReveal(table: HTMLElement): void {
  const guard = guards.get(table);
  if (!guard || guard.frame !== null) return;
  guard.frame = requestAnimationFrame(() => {
    guard.frame = null;
    const target = guard.target;
    if (
      !target ||
      target !== document.activeElement ||
      !table.contains(target) ||
      !table.clientHeight
    )
      return;
    const box = table.getBoundingClientRect();
    const field = target.getBoundingClientRect();
    const captions =
      table.querySelector('.team-accounts-columns')?.getBoundingClientRect().height ?? 0;
    const top = box.top + captions;
    const bottom = box.top + table.clientHeight;
    if (field.top < top) table.scrollTop += field.top - top;
    else if (field.bottom > bottom) table.scrollTop += field.bottom - bottom;
    // Native focus scrolling can preserve a former identity-column inset.
    // Reveal a fitting control completely without moving the outer page.
    const wrapper = target.closest('.team-accounts-field')?.getBoundingClientRect();
    const horizontal = wrapper && wrapper.width <= table.clientWidth ? wrapper : field;
    if (table.clientWidth && horizontal.width <= table.clientWidth) {
      const right = box.left + table.clientWidth;
      if (horizontal.left < box.left) table.scrollLeft += horizontal.left - box.left;
      else if (horizontal.right > right) table.scrollLeft += horizontal.right - right;
    }
  });
}

export function retainAccountFocusAnchor(table: HTMLElement): () => void {
  let guard = guards.get(table);
  if (!guard) {
    const next: Guard = {
      refs: 0,
      target: table.contains(document.activeElement)
        ? (document.activeElement as HTMLElement)
        : null,
      frame: null,
      dispose: () => {}
    };
    const focus = (event: FocusEvent) => {
      next.target = event.target instanceof HTMLElement ? event.target : null;
      scheduleAccountFocusReveal(table);
    };
    const release = () => {
      next.target = null;
    };
    const key = (event: KeyboardEvent) => {
      if (['PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) release();
    };
    table.addEventListener('focusin', focus);
    table.addEventListener('wheel', release, { passive: true });
    table.addEventListener('touchmove', release, { passive: true });
    table.addEventListener('pointerdown', release);
    table.addEventListener('keydown', key);
    next.dispose = () => {
      if (next.frame !== null) cancelAnimationFrame(next.frame);
      table.removeEventListener('focusin', focus);
      table.removeEventListener('wheel', release);
      table.removeEventListener('touchmove', release);
      table.removeEventListener('pointerdown', release);
      table.removeEventListener('keydown', key);
    };
    guard = next;
    guards.set(table, guard);
  }
  guard.refs += 1;
  scheduleAccountFocusReveal(table);
  return () => {
    guard.refs -= 1;
    if (guard.refs === 0) {
      guard.dispose();
      guards.delete(table);
    }
  };
}
