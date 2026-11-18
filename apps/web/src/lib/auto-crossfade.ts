/**
 * Every control that changes what a screen shows, crossfaded (058).
 *
 * A filter, a toggle, a tab, a row that folds, an option picked from a menu:
 * each redraws part of the screen, and each used to do it in a single frame —
 * or in two, when the answer came from the server a moment later. Wiring a
 * transition into every such handler does not last; the next control is
 * written without one. So this is done once, from outside:
 *
 * at the press, before any handler runs, the part of the screen the control
 * belongs to is copied as it stands and laid over itself. The handlers then
 * change whatever they change underneath. When the screen has stopped
 * changing — nothing marked as loading, no request begun since the press still
 * unanswered, the page untouched for a few frames — the copy fades away and
 * the new state is what was under it. One move, however many steps it took.
 *
 * The copy is inert and hidden from assistive technology; it keeps what was
 * typed and how far things were scrolled; nothing in it animates. Where a
 * route or layout transition takes over (`lib/navigation.ts`), it removes the
 * copy inside its own update, so the two never stack. Reduced motion, a
 * hidden tab and an engine without Web Animations get no copy at all.
 */
import { fetchPendingSince } from './fetch-activity';

/** What says "pressing me changes what is shown". A plain button is an action and is left alone. */
const CONTROLS = [
  '[aria-pressed]',
  '[role="tab"]',
  '[role="switch"]',
  '[role="radio"]',
  '[aria-expanded]',
  'summary',
  '.task-quick-range',
  '.toggle-button',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
  '[role="option"]',
  'input[type="checkbox"]',
  'input[type="radio"]',
  '[data-crossfade]'
].join(', ');

/** Surfaces that float over the page: a press in one changes the page under it, or itself. */
const FLOATING = '[role="menu"], [role="listbox"], .ui-popover, .ui-menu';
const DIALOG = '.ui-modal, .modal';
const BUSY = '.ui-route-skeleton, .ui-skeleton, [aria-busy="true"]';
const OPT_OUT = '[data-crossfade="off"]';

/** Past this the copy costs more than the jump it hides. */
const MAX_NODES = 7000;
const HOLD_MAX_MS = 350;
/** How long the in-between state is kept for an answer that is late. */
const LATE_HOLD_MAX_MS = 2_500;
const QUIET_MS = 32;
const POLL_MS = 16;

let installed = false;
const ghosts = new Set<() => void>();

const now = () => Date.now();

function durationOf(token: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return fallback;
  return raw.endsWith('ms') ? value : value * 1000;
}

/** The part of the screen a press on `control` can change. */
function scopeOf(control: Element): HTMLElement | null {
  if (control.closest(OPT_OUT)) return null;
  const floating = control.closest(FLOATING);
  const dialog = control.closest<HTMLElement>(DIALOG);
  // Inside a dialog (and not in a menu opened from it): the dialog redraws itself. A tick box
  // in a form is not a redraw — and the copy would sit over the field typed in next.
  if (dialog && !floating) {
    const tick = control.matches('input[type="checkbox"], input[type="radio"]');
    return tick && control.getAttribute('role') !== 'switch' ? null : dialog;
  }
  if (!floating && !control.closest('.page-viewport')) return null;
  // On the page, or in a menu over it: the section on screen, else the page.
  if (dialog) return dialog;
  return (
    document.querySelector<HTMLElement>(
      '.team-space-shell-body > [data-section-panel]:not([hidden])'
    ) ?? document.querySelector<HTMLElement>('.page-viewport > main')
  );
}

/**
 * Carries over what a clone does not: what was typed, what was drawn, and —
 * returned for after the copy is in the page — how far things were scrolled.
 * Both trees are still the same shape here; `prune` comes after.
 */
function copyState(from: HTMLElement, to: HTMLElement): Array<() => void> {
  const source = from.querySelectorAll<HTMLElement>('*');
  const target = to.querySelectorAll<HTMLElement>('*');
  const count = Math.min(source.length, target.length);
  const scrolls: Array<() => void> = [];
  for (let index = 0; index < count; index += 1) {
    const a = source[index]!;
    const b = target[index]!;
    const { scrollTop, scrollLeft } = a;
    if (scrollTop || scrollLeft)
      scrolls.push(() => {
        b.scrollTop = scrollTop;
        b.scrollLeft = scrollLeft;
      });
    if (a instanceof HTMLInputElement && b instanceof HTMLInputElement) {
      b.value = a.value;
      b.checked = a.checked;
    } else if (a instanceof HTMLTextAreaElement && b instanceof HTMLTextAreaElement)
      b.value = a.value;
    else if (a instanceof HTMLSelectElement && b instanceof HTMLSelectElement)
      b.selectedIndex = a.selectedIndex;
    else if (a instanceof HTMLCanvasElement && b instanceof HTMLCanvasElement) {
      try {
        b.getContext('2d')?.drawImage(a, 0, 0);
      } catch {
        // A canvas that cannot be read stays blank in the copy.
      }
    }
    // A picture, not a second set of controls: nothing in it answers to an id or a test hook.
    if (b.id) b.removeAttribute('id');
    if (b.dataset.testid) b.removeAttribute('data-testid');
  }
  return scrolls;
}

/** How far past the window a block still counts as on screen. */
const OFFSCREEN_MARGIN = 240;
const PRUNE_DEPTH = 7;

/**
 * The blocks of `scope` that are wholly outside the window, as paths of child
 * indexes, with their heights.
 *
 * A board is mostly off screen, and laying out a copy of all of it was most of
 * what a press cost — 50–120ms on a full section, before the handler had even
 * run. The copy keeps those blocks as empty boxes of the same height: the
 * visible part is exact, the rest is never laid out, and the copy costs what
 * the window shows.
 */
function offscreen(scope: HTMLElement): Array<{ path: number[]; height: number }> {
  const top = -OFFSCREEN_MARGIN;
  const bottom = window.innerHeight + OFFSCREEN_MARGIN;
  const found: Array<{ path: number[]; height: number }> = [];
  const walk = (node: Element, path: number[], depth: number) => {
    for (let index = 0; index < node.children.length; index += 1) {
      const child = node.children[index]!;
      if (child.children.length === 0) continue;
      const rect = child.getBoundingClientRect();
      if (rect.height === 0) continue;
      if (rect.top > bottom || rect.bottom < top)
        found.push({ path: [...path, index], height: rect.height });
      else if (depth < PRUNE_DEPTH && (rect.bottom > bottom || rect.top < top))
        walk(child, [...path, index], depth + 1);
    }
  };
  walk(scope, [], 0);
  return found;
}

function prune(copy: HTMLElement, blocks: Array<{ path: number[]; height: number }>) {
  for (const { path, height } of blocks) {
    let node: Element | undefined = copy;
    for (const index of path) node = node?.children[index];
    if (!(node instanceof HTMLElement)) continue;
    node.replaceChildren();
    node.style.height = `${height}px`;
    node.style.boxSizing = 'border-box';
  }
}

/** Removes every copy at once. Called by a transition that takes the change over. */
export function dropAutoGhost() {
  for (const cancel of [...ghosts]) cancel();
}

function copyOf(scope: HTMLElement): HTMLElement | null {
  if (scope.getElementsByTagName('*').length > MAX_NODES) return null;
  // A playing picture cannot be copied; a still of it would be the flicker. A canvas can:
  // its pixels are drawn across by `copyState`.
  if (scope.querySelector('video, iframe')) return null;
  const copy = scope.cloneNode(true) as HTMLElement;
  if (typeof copy.animate !== 'function') return null;
  copy.removeAttribute('id');
  copy.setAttribute('aria-hidden', 'true');
  copy.setAttribute('inert', '');
  copy.setAttribute('data-auto-ghost', '');
  copy.classList.add('auto-ghost');
  // To the fraction of a pixel: `offsetTop` is rounded, and a copy a third of a pixel off its
  // original made every line of text under it step by one when it arrived and again when it
  // left — a jiggle on each press.
  const rect = scope.getBoundingClientRect();
  const anchor = scope.offsetParent instanceof HTMLElement ? scope.offsetParent : null;
  const base = anchor?.getBoundingClientRect();
  const left = base
    ? rect.left - base.left - anchor!.clientLeft + anchor!.scrollLeft
    : rect.left + window.scrollX;
  const top = base
    ? rect.top - base.top - anchor!.clientTop + anchor!.scrollTop
    : rect.top + window.scrollY;
  copy.style.left = `${left}px`;
  copy.style.top = `${top}px`;
  copy.style.width = `${rect.width}px`;
  copy.style.height = `${rect.height}px`;
  for (const image of copy.querySelectorAll('img')) {
    image.loading = 'eager';
    image.decoding = 'sync';
  }
  return copy;
}

function inGhost(node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  return Boolean(element?.closest('[data-auto-ghost]'));
}

function begin(scope: HTMLElement) {
  dropAutoGhost();
  // Requests are stamped on the page's own clock (lib/fetch-activity.ts).
  hold(scope, performance.now(), HOLD_MAX_MS, null);
}

/**
 * Lays a copy of `scope` over it and fades it once the screen under it is
 * quiet, or after `holdMs`.
 *
 * If the hold runs out with an answer still on its way, what is on screen at
 * that moment is an in-between state — a placeholder, a list not yet
 * re-read. A second copy, of that state, goes *under* the first before the
 * first fades: the old screen dissolves into the in-between one, and that one
 * stays until the answer lands and dissolves into it in turn. A slow answer
 * is then two soft changes instead of a soft one and a cut.
 */
function hold(scope: HTMLElement, sincePage: number, holdMs: number, above: HTMLElement | null) {
  const parent = scope.parentElement;
  const copy = parent ? copyOf(scope) : null;
  if (!parent || !copy) return;
  const scrolls = copyState(scope, copy);
  prune(copy, offscreen(scope));
  if (above?.isConnected && above.parentElement === parent) parent.insertBefore(copy, above);
  else parent.append(copy);
  for (const scroll of scrolls) scroll();

  const since = now();
  let lastChange = since;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fading: Animation | null = null;
  const observer = new MutationObserver(records => {
    // A copy arriving or leaving, and anything inside one, is not the screen changing.
    const real = records.some(record => {
      if (inGhost(record.target)) return false;
      if (record.type !== 'childList') return true;
      return [...record.addedNodes, ...record.removedNodes].some(node => !inGhost(node));
    });
    if (real) lastChange = now();
  });
  observer.observe(parent, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    // Not `style`: the pointer's light writes it on every move (lib/pointer-glow.ts).
    attributeFilter: ['class', 'hidden', 'aria-busy', 'aria-pressed', 'aria-expanded', 'src']
  });

  const remove = () => {
    observer.disconnect();
    if (timer) clearTimeout(timer);
    fading?.cancel();
    copy.remove();
    ghosts.delete(remove);
  };
  const fade = () => {
    observer.disconnect();
    fading = copy.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: durationOf('--motion-fast', 150),
      easing:
        getComputedStyle(document.documentElement).getPropertyValue('--ease-fade').trim() ||
        'linear',
      fill: 'forwards'
    });
    fading.finished.then(remove, remove);
  };
  const check = () => {
    const at = now();
    const live = scope.isConnected ? scope : parent;
    const waiting = Boolean(live.querySelector(BUSY)) || fetchPendingSince(sincePage);
    if (!waiting && at - lastChange >= QUIET_MS) {
      timer = null;
      fade();
      return;
    }
    if (at - since >= holdMs) {
      timer = null;
      if (waiting && above === null && scope.isConnected)
        hold(scope, sincePage, LATE_HOLD_MAX_MS, copy);
      fade();
      return;
    }
    timer = setTimeout(check, POLL_MS);
  };
  timer = setTimeout(check, POLL_MS);
  ghosts.add(remove);
}

function reduced(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** The control a pointer has just been released on, so its click does not copy again. */
let released: { control: Element; at: number } | null = null;

function eligible(event: Event): Element | null {
  if (document.visibilityState === 'hidden' || reduced()) return null;
  if (document.documentElement.classList.contains('is-theming')) return null;
  if (event instanceof MouseEvent && (event.button !== 0 || event.metaKey || event.ctrlKey))
    return null;
  const target = event.target;
  if (!(target instanceof Element) || target.closest('[data-auto-ghost]')) return null;
  const control = target.closest(CONTROLS);
  // A link is the router's: it has a transition of its own.
  if (!control || control.closest('a[href]')) return null;
  return control;
}

function copyFor(control: Element) {
  const scope = scopeOf(control);
  if (scope) begin(scope);
}

/*
 * Taken when the pointer is released, not at the click: a control built on
 * press events (the component library's) has already changed the screen by
 * the time `click` is dispatched.
 */
function onRelease(event: PointerEvent) {
  const control = eligible(event);
  if (!control) return;
  released = { control, at: now() };
  copyFor(control);
}

/** A click with no pointer behind it: the keyboard, or a label passing the press on. */
function onClick(event: MouseEvent) {
  const control = eligible(event);
  if (!control) return;
  if (released && released.control === control && now() - released.at < 700) return;
  copyFor(control);
}

function onChange(event: Event) {
  if (!(event.target instanceof HTMLSelectElement)) return;
  const control = eligible(event) ?? event.target;
  if (!control.closest(OPT_OUT)) copyFor(control);
}

/** Installed once, at the root. Capture phase: the copy is taken before any handler runs. */
export function installAutoCrossfade() {
  if (installed || typeof document === 'undefined') return;
  if (typeof Element === 'undefined' || typeof Element.prototype.animate !== 'function') return;
  installed = true;
  document.addEventListener('pointerup', onRelease, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('change', onChange, true);
}
