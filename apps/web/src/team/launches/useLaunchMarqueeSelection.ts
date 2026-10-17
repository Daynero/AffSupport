import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import {
  boxFromPoints,
  exceedsThreshold,
  intersects,
  mergeSelection,
  sameSet,
  type Point
} from '../explorer/selectionGestures';

type LaunchRow = { id: string };
type Session = {
  start: Point;
  current: Point;
  initial: Set<string>;
  applied: Set<string>;
  additive: boolean;
  active: boolean;
  band: HTMLDivElement | null;
  teardown: () => void;
};

/** Drag from the gaps in the launch grid to select every card the rectangle touches. */
export function useLaunchMarqueeSelection(
  rows: readonly LaunchRow[],
  selectedIds: ReadonlySet<string>,
  setSelectedIds: (ids: ReadonlySet<string>) => void
) {
  const latest = useRef({ rows, selectedIds, setSelectedIds });
  latest.current = { rows, selectedIds, setSelectedIds };
  const session = useRef<Session | null>(null);
  const finish = useCallback((restore = false) => {
    const current = session.current;
    if (!current) return;
    session.current = null;
    current.teardown();
    if (restore && current.active) latest.current.setSelectedIds(current.initial);
  }, []);
  useEffect(() => () => finish(), [finish]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || event.pointerType !== 'mouse' || session.current) return;
      const target = event.target instanceof Element ? event.target : null;
      if (
        !target ||
        target.closest('[data-launch-id],button,a,input,[role="button"],[data-no-marquee]')
      )
        return;
      const container = event.currentTarget;
      const initial = new Set(latest.current.selectedIds);
      const state: Session = {
        start: { x: event.clientX, y: event.clientY },
        current: { x: event.clientX, y: event.clientY },
        initial,
        applied: initial,
        additive: event.shiftKey || event.ctrlKey || event.metaKey,
        active: false,
        band: null,
        teardown: () => undefined
      };
      const update = () => {
        const bounds = boxFromPoints(state.start, state.current);
        const hit: string[] = [];
        const byId = new Map(latest.current.rows.map(row => [row.id, row]));
        container.querySelectorAll<HTMLElement>('[data-launch-id]').forEach(card => {
          const id = card.dataset.launchId;
          if (!id || !byId.has(id)) return;
          const r = card.getBoundingClientRect();
          if (intersects(bounds, { left: r.left, top: r.top, right: r.right, bottom: r.bottom }))
            hit.push(id);
        });
        const next = mergeSelection(state.initial, hit, state.additive ? 'add' : 'replace');
        if (!sameSet(next, state.applied)) {
          state.applied = next;
          latest.current.setSelectedIds(next);
        }
        if (state.band) {
          state.band.style.transform = `translate(${bounds.left}px, ${bounds.top}px)`;
          state.band.style.width = `${bounds.right - bounds.left}px`;
          state.band.style.height = `${bounds.bottom - bounds.top}px`;
        }
      };
      const onMove = (move: PointerEvent) => {
        if (move.pointerId !== event.pointerId) return;
        state.current = { x: move.clientX, y: move.clientY };
        if (!state.active && exceedsThreshold(state.start, state.current)) {
          state.active = true;
          document.documentElement.classList.add('is-marquee-selecting');
          window.getSelection()?.removeAllRanges();
          const band = document.createElement('div');
          band.className = 'team-explorer-marquee';
          band.setAttribute('aria-hidden', 'true');
          document.body.appendChild(band);
          state.band = band;
        }
        if (state.active) update();
      };
      const onUp = (up: PointerEvent) => {
        if (up.pointerId !== event.pointerId) return;
        state.current = { x: up.clientX, y: up.clientY };
        if (state.active) update();
        else if (!state.additive && state.initial.size) latest.current.setSelectedIds(new Set());
        finish();
      };
      const onKey = (key: KeyboardEvent) => {
        if (key.key !== 'Escape') return;
        key.preventDefault();
        finish(true);
      };
      const onBlur = () => finish();
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onBlur);
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('blur', onBlur);
      state.teardown = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onBlur);
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('blur', onBlur);
        state.band?.remove();
        document.documentElement.classList.remove('is-marquee-selecting');
      };
      session.current = state;
    },
    [finish]
  );
  return { onPointerDown };
}
