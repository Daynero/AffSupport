/**
 * The light a pointer carries over a card (058).
 *
 * Surfaces that can be picked up — a tool, a task, a file — answer the pointer
 * before it presses: a soft light under the cursor that follows it across the
 * card. The stylesheet draws it (`--glow-x` / `--glow-y`, components.css); this
 * only says where the pointer is, once per frame, for the one card under it.
 *
 * Nothing is installed for a coarse pointer or under reduced motion: there is
 * no hover to answer, or the reader asked for stillness.
 */
const GLOW_SELECTOR = '.home-tile, .team-task-card, .team-explorer-tile, [data-glow]';

let installed = false;

export function installPointerGlow() {
  if (installed || typeof window === 'undefined' || typeof document === 'undefined') return;
  if (typeof window.matchMedia !== 'function') return;
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  installed = true;
  let queued = false;
  let x = 0;
  let y = 0;
  let target: EventTarget | null = null;
  document.addEventListener(
    'pointermove',
    event => {
      x = event.clientX;
      y = event.clientY;
      target = event.target;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (!(target instanceof Element)) return;
        const card = target.closest<HTMLElement>(GLOW_SELECTOR);
        if (!card) return;
        const rect = card.getBoundingClientRect();
        card.style.setProperty('--glow-x', `${Math.round(x - rect.left)}px`);
        card.style.setProperty('--glow-y', `${Math.round(y - rect.top)}px`);
      });
    },
    { passive: true }
  );
}
