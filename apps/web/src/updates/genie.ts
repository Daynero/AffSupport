/**
 * 074 — the «What's new» window drawn into the header's update button.
 *
 * A real genie bends the window along a curve; CSS cannot warp a box. What reads
 * as one is three things at once: the window accelerates toward the button, it
 * narrows much faster than it shortens, and its far edge stays wide while the
 * edge nearest the button pinches — a funnel, by `clip-path`. Durations and the
 * curve are the tokens `--motion-genie` / `--ease-genie`; under reduced motion
 * the token is 1ms and the caller fades instead.
 */

/** A duration token read from the root, in milliseconds (`620ms`, `0.62s`). */
export function tokenDuration(name: string): number {
  if (typeof window === 'undefined') return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const match = /^(-?\d*\.?\d+)(ms|s)$/u.exec(raw);
  if (!match) return 0;
  const value = Number(match[1]);
  return match[2] === 's' ? value * 1000 : value;
}

export function tokenValue(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * The funnel's narrow end points at the target: if the button is above the window
 * (the header), the top edge pinches toward the button's x and the bottom stays wide.
 */
function funnel(from: DOMRect, to: DOMRect, pinch: number): string {
  const targetX = ((to.left + to.width / 2 - from.left) / from.width) * 100;
  const x = Math.max(0, Math.min(100, targetX));
  // At pinch 0 the narrow edge is the full width; at 1 it is a point at the target's x.
  const narrowLeft = x * pinch;
  const narrowRight = 100 - (100 - x) * pinch;
  const above = to.top + to.height / 2 < from.top + from.height / 2;
  return above
    ? `polygon(${narrowLeft}% 0%, ${narrowRight}% 0%, 100% 100%, 0% 100%)`
    : `polygon(0% 0%, 100% 0%, ${narrowRight}% 100%, ${narrowLeft}% 100%)`;
}

/**
 * Runs the genie on `panel` toward `target`. Resolves when it has finished (or at
 * once, when there is nothing to animate toward); never rejects.
 */
export async function genieInto(panel: HTMLElement, target: HTMLElement | null): Promise<boolean> {
  const duration = tokenDuration('--motion-genie');
  if (!target || prefersReducedMotion() || duration <= 1 || typeof panel.animate !== 'function')
    return false;
  const from = panel.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  if (from.width === 0 || from.height === 0 || to.width === 0) return false;
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const scaleX = Math.max(0.02, to.width / from.width);
  const scaleY = Math.max(0.02, to.height / from.height);
  const above = dy < 0;
  try {
    const animation = panel.animate(
      [
        {
          transform: 'translate(0px, 0px) scale(1, 1)',
          clipPath: funnel(from, to, 0),
          opacity: 1,
          offset: 0
        },
        {
          transform: `translate(${dx * 0.18}px, ${dy * 0.12}px) scale(0.62, 0.94)`,
          clipPath: funnel(from, to, 0.55),
          opacity: 1,
          offset: 0.38
        },
        {
          transform: `translate(${dx * 0.62}px, ${dy * 0.55}px) scale(0.18, 0.5)`,
          clipPath: funnel(from, to, 0.85),
          opacity: 0.9,
          offset: 0.72
        },
        {
          transform: `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`,
          clipPath: funnel(from, to, 1),
          opacity: 0.25,
          offset: 1
        }
      ],
      {
        duration,
        easing: tokenValue('--ease-genie', 'ease-in'),
        fill: 'forwards'
      }
    );
    panel.style.transformOrigin = above ? '50% 0%' : '50% 100%';
    await animation.finished;
    return true;
  } catch {
    return false;
  }
}
