import {
  useCallback,
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from 'react';
import type { TeamMaterialRow } from '@video-compressor/shared';
import { isApple } from '../palette/shortcuts';
import { useExplorer } from './ExplorerProvider';
import {
  applyPress,
  autoScrollStep,
  boxFromPoints,
  clamp,
  exceedsThreshold,
  intersects,
  marqueeMode,
  mergeSelection,
  pressKind,
  sameSet,
  type MarqueeMode,
  type Modifiers,
  type Point,
  type SelectionAnchor
} from './selectionGestures';

/**
 * A press on a row or a tile, in the file manager's grammar (see `applyPress`): plain focuses,
 * ⌘/Ctrl toggles, Shift takes the run from the anchor in the order the rows are drawn.
 */
export function useRowPress(rows: readonly TeamMaterialRow[]) {
  const { selectedId, select, selectedRows, replaceSelection } = useExplorer();
  const anchor = useRef<SelectionAnchor | null>(null);
  const latest = useRef({ rows, selectedId, selectedRows });
  latest.current = { rows, selectedId, selectedRows };

  return useCallback(
    (row: TeamMaterialRow, event: Modifiers) => {
      const { rows: current, selectedId: focusedId, selectedRows: checkedRows } = latest.current;
      const kind = pressKind(event, isApple());
      const result = applyPress({
        kind,
        clickedId: row.id,
        order: current.map(item => item.id),
        checked: new Set(checkedRows.keys()),
        focusedId,
        anchor: anchor.current
      });
      anchor.current = result.anchor;
      if (kind === 'range') window.getSelection?.()?.removeAllRanges();
      select(result.focusId);
      if (!sameSet(result.checked, new Set(checkedRows.keys()))) {
        const byId = new Map(current.map(item => [item.id, item]));
        replaceSelection(
          [...result.checked]
            .map(id => byId.get(id) ?? checkedRows.get(id))
            .filter((item): item is TeamMaterialRow => Boolean(item))
        );
      }
    },
    [replaceSelection, select]
  );
}

/** Shift+press extends the selection, not the page's text selection. */
export function suppressShiftTextSelection(event: ReactMouseEvent) {
  if (event.shiftKey) event.preventDefault();
}

/** What a press on empty space must not start from: an item, a control, a menu, the column heads. */
const NOT_EMPTY_SPACE = [
  '[data-material-id]',
  'button',
  'a[href]',
  'input',
  'textarea',
  'select',
  'label',
  'summary',
  '[role="button"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="dialog"]',
  '[role="listbox"]',
  '[contenteditable]:not([contenteditable="false"])',
  'thead',
  '.ui-table-header',
  '[data-no-marquee]'
].join(',');

/** Parts of the panel that are not the file area: the tree, the header, the detail pane. */
const OUTSIDE_CONTENT = '.team-explorer-tree, .team-explorer-header, .team-explorer-pane';

const ITEM_SELECTOR = '.team-explorer-tile[data-material-id], .team-explorer-row[data-material-id]';

/** The sticky bands a rectangle must stay below: the explorer header, the bar under it, the list's column heads. */
const STICKY_SELECTOR =
  '.team-explorer > .team-explorer-header, .team-explorer-list-header, .team-explorer-rows .ui-table-header';

const ROOT_CLASS = 'is-marquee-selecting';

interface Latest {
  rows: readonly TeamMaterialRow[];
  selectedRows: ReadonlyMap<string, TeamMaterialRow>;
  replaceSelection: (rows: readonly TeamMaterialRow[]) => void;
}

interface Session {
  pointerId: number;
  container: HTMLElement;
  /** The press, relative to the content's own top-left: immune to page scroll and to a bar appearing above. */
  start: Point;
  client: Point;
  mode: MarqueeMode;
  startIds: ReadonlySet<string>;
  startRows: ReadonlyMap<string, TeamMaterialRow>;
  applied: ReadonlySet<string>;
  active: boolean;
  band: HTMLDivElement | null;
  frame: number;
  teardown: () => void;
}

/**
 * The rubber band (the owner, 2026-10): press on empty space in the folder and drag, and every
 * tile or row the rectangle touches is checked as it goes. Mouse and pen only — on touch a drag
 * is a scroll and stays one.
 *
 * The rectangle is kept in the content's own coordinates, so it holds still on the files while
 * the page scrolls under it (the edges of the window scroll it) and while the selection bar
 * appears above the list and pushes the list down. It never reaches under the sticky header: the
 * pointer is held below it, and the drawn band is clipped to what can be seen.
 *
 * Escape puts back what was checked when the press began; letting go anywhere — outside the
 * window, on another app — keeps what the rectangle took.
 */
export function useMarqueeSelection({
  containerRef,
  zoneRef,
  rows,
  resetKey
}: {
  containerRef: RefObject<HTMLElement | null>;
  /** Where a press may start a rectangle; the content area when absent. */
  zoneRef?: RefObject<HTMLElement | null>;
  rows: readonly TeamMaterialRow[];
  /** A new folder, view or filter: a rectangle in progress ends there. */
  resetKey: string;
}) {
  const { selectedRows, replaceSelection } = useExplorer();
  const latest = useRef<Latest>({ rows, selectedRows, replaceSelection });
  latest.current = { rows, selectedRows, replaceSelection };
  const session = useRef<Session | null>(null);

  const finish = useCallback((restore: boolean) => {
    const current = session.current;
    if (!current) return;
    session.current = null;
    current.teardown();
    if (restore && current.active && !sameSet(current.applied, current.startIds)) {
      latest.current.replaceSelection([...current.startRows.values()]);
    }
  }, []);

  useEffect(() => () => finish(false), [finish, resetKey]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const container = containerRef.current;
      if (!container || session.current) return;
      if (event.button !== 0 || (event.pointerType !== 'mouse' && event.pointerType !== 'pen')) {
        return;
      }
      const apple = isApple();
      // Ctrl+press on a Mac is the context menu.
      if (apple && event.ctrlKey && !event.metaKey) return;
      const target = event.target instanceof Element ? event.target : null;
      const zone = zoneRef?.current ?? container;
      if (
        !target ||
        !zone.contains(target) ||
        target.closest(NOT_EMPTY_SPACE) ||
        target.closest(OUTSIDE_CONTENT)
      ) {
        return;
      }
      if (onScrollbar(target, event.nativeEvent)) return;

      const rect = container.getBoundingClientRect();
      const { selectedRows: checked } = latest.current;
      const state: Session = {
        pointerId: event.pointerId,
        container,
        start: { x: event.clientX - rect.left, y: event.clientY - rect.top },
        client: { x: event.clientX, y: event.clientY },
        mode: marqueeMode(event, apple),
        startIds: new Set(checked.keys()),
        startRows: new Map(checked),
        applied: new Set(checked.keys()),
        active: false,
        band: null,
        frame: 0,
        teardown: () => undefined
      };

      const tick = () => {
        state.frame = 0;
        if (session.current !== state || !state.active) return;
        update(state, latest.current);
        state.frame = window.requestAnimationFrame(tick);
      };

      const activate = () => {
        state.active = true;
        document.documentElement.classList.add(ROOT_CLASS);
        window.getSelection?.()?.removeAllRanges();
        try {
          container.setPointerCapture(state.pointerId);
        } catch {
          // A pointer the browser no longer tracks: the window listeners still end it.
        }
        const band = document.createElement('div');
        band.className = 'team-explorer-marquee';
        band.setAttribute('aria-hidden', 'true');
        document.body.appendChild(band);
        state.band = band;
        tick();
      };

      const onMove = (move: PointerEvent) => {
        if (move.pointerId !== state.pointerId) return;
        state.client = { x: move.clientX, y: move.clientY };
        if (!state.active) {
          const pressed = { x: state.start.x + rect.left, y: state.start.y + rect.top };
          if (exceedsThreshold(pressed, state.client)) activate();
        }
      };
      const onUp = (up: PointerEvent) => {
        if (up.pointerId !== state.pointerId) return;
        if (state.active) {
          state.client = { x: up.clientX, y: up.clientY };
          update(state, latest.current);
        } else if (state.mode === 'replace' && state.startIds.size > 0) {
          // A press on empty space with nothing held is a click there: nothing stays checked.
          latest.current.replaceSelection([]);
        }
        finish(false);
      };
      const onCancel = (cancel: PointerEvent) => {
        if (cancel.pointerId === state.pointerId) finish(false);
      };
      const onKey = (key: KeyboardEvent) => {
        if (key.key !== 'Escape') return;
        if (!state.active) {
          finish(false);
          return;
        }
        key.preventDefault();
        key.stopPropagation();
        finish(true);
      };
      const onBlur = () => finish(false);
      const onSelectStart = (selectStart: Event) => selectStart.preventDefault();

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('blur', onBlur);
      document.addEventListener('selectstart', onSelectStart, true);
      container.addEventListener('lostpointercapture', onCancel);

      state.teardown = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('blur', onBlur);
        document.removeEventListener('selectstart', onSelectStart, true);
        container.removeEventListener('lostpointercapture', onCancel);
        if (state.frame) window.cancelAnimationFrame(state.frame);
        state.band?.remove();
        document.documentElement.classList.remove(ROOT_CLASS);
        if (state.active) {
          try {
            if (container.hasPointerCapture(state.pointerId)) {
              container.releasePointerCapture(state.pointerId);
            }
          } catch {
            // Already released.
          }
        }
      };
      session.current = state;
      // Keys (arrows, Escape, ⌘A) keep working after a press on empty space.
      container.focus({ preventScroll: true });
    },
    [containerRef, zoneRef, finish]
  );

  return { onPointerDown };
}

/** One frame of a rectangle in progress: scroll at the edges, measure, check, draw. */
function update(state: Session, latest: Latest) {
  const { container } = state;
  let rect = container.getBoundingClientRect();
  const top = stickyBottom(container);
  const bottom = window.innerHeight;

  const step = autoScrollStep(state.client.y, top, bottom);
  if (step !== 0) {
    const before = window.scrollY;
    window.scrollBy(0, step);
    if (window.scrollY !== before) rect = container.getBoundingClientRect();
  }

  const pointer = {
    x: clamp(state.client.x, rect.left, rect.right),
    y: clamp(state.client.y, Math.max(top, rect.top), Math.min(bottom, rect.bottom))
  };
  const box = boxFromPoints(state.start, { x: pointer.x - rect.left, y: pointer.y - rect.top });

  const { rows: current, replaceSelection: replace } = latest;
  const byId = new Map(current.map(row => [row.id, row]));
  const hit: string[] = [];
  for (const element of container.querySelectorAll<HTMLElement>(ITEM_SELECTOR)) {
    const id = element.dataset.materialId;
    if (!id || !byId.has(id)) continue;
    const item = element.getBoundingClientRect();
    if (item.width === 0 && item.height === 0) continue;
    const local = {
      left: item.left - rect.left,
      top: item.top - rect.top,
      right: item.right - rect.left,
      bottom: item.bottom - rect.top
    };
    if (intersects(box, local)) hit.push(id);
  }
  const next = mergeSelection(state.startIds, hit, state.mode);
  if (!sameSet(next, state.applied)) {
    state.applied = next;
    replace(
      [...next]
        .map(id => byId.get(id) ?? state.startRows.get(id))
        .filter((row): row is TeamMaterialRow => Boolean(row))
    );
  }

  if (state.band) {
    const left = box.left + rect.left;
    const right = box.right + rect.left;
    const shownTop = Math.max(box.top + rect.top, top);
    const shownBottom = Math.min(box.bottom + rect.top, bottom);
    const height = shownBottom - shownTop;
    state.band.style.display = height > 0 ? '' : 'none';
    state.band.style.transform = `translate(${left}px, ${shownTop}px)`;
    state.band.style.width = `${Math.max(0, right - left)}px`;
    state.band.style.height = `${Math.max(0, height)}px`;
  }
}

/** The lowest edge of the sticky bands over the content, in the window's coordinates. */
function stickyBottom(container: HTMLElement): number {
  const surface = container.closest('.team-explorer') ?? document;
  let bottom = 0;
  for (const element of surface.querySelectorAll<HTMLElement>(STICKY_SELECTOR)) {
    const rect = element.getBoundingClientRect();
    if (rect.height > 0 && rect.bottom > bottom) bottom = rect.bottom;
  }
  return Math.min(bottom, window.innerHeight);
}

/** A press on a scrollbar of something inside the content is a scroll, not a rectangle. */
function onScrollbar(target: Element, event: PointerEvent): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const scrollsX = target.scrollWidth > target.clientWidth;
  const scrollsY = target.scrollHeight > target.clientHeight;
  if (!scrollsX && !scrollsY) return false;
  return (
    (scrollsY && event.offsetX >= target.clientWidth) ||
    (scrollsX && event.offsetY >= target.clientHeight)
  );
}
