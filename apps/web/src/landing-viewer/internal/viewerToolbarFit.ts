import type { ToolbarStage } from '../../components/ui/index';

/**
 * The viewer's top bar gives up four things, in this order (070 T034: the measurement
 * itself is the inventory's `useToolbarStages`; what is here is only what is the viewer's).
 *
 * Words go first (`.is-compact`), then the file identity (`.is-compact-2`), then the fit
 * buttons and the zoom stepper (`.is-compact-3`), and on a phone the folder name, the view
 * toggle and the full-screen button (`.is-compact-4`) — everything past the words lives in
 * the "more" menu too, so nothing is lost.
 */
export const VIEWER_TOOLBAR_STAGES: ReadonlyArray<ToolbarStage | string> = [
  'is-compact',
  'is-compact-2',
  'is-compact-3',
  'is-compact-4'
];

/** What a file name reasonably needs before it ellipsizes. */
const FLEXIBLE_MAX = 140;

/**
 * How wide a group wants to be.
 *
 * The groups sit in `1fr` tracks and always fill them, so their own widths say nothing;
 * what is summed is their contents. A control keeps its natural width. The one flexible
 * child — the file identity, marked `data-flexible` — ellipsizes rather than overflow, so
 * it is asked for the width of its text, capped at what a name reasonably needs.
 */
function wanted(group: HTMLElement): number {
  const gap = Number.parseFloat(getComputedStyle(group).columnGap) || 0;
  const children = Array.from(group.children) as HTMLElement[];
  let visible = 0;
  const total = children.reduce((sum, child) => {
    const width = child.hasAttribute('data-flexible')
      ? Math.min(
          FLEXIBLE_MAX,
          Math.max(0, ...Array.from(child.children, inner => (inner as HTMLElement).scrollWidth))
        )
      : child.getBoundingClientRect().width;
    if (width > 0) visible += 1;
    return sum + width;
  }, 0);
  return total + gap * Math.max(0, visible - 1);
}

/** Whether the bar's groups fit the room its box leaves them, less its own padding. */
export function viewerToolbarFits(row: HTMLElement): boolean {
  const style = getComputedStyle(row);
  const gap = Number.parseFloat(style.columnGap) || 0;
  // A group the stylesheet hides (the page counter on a phone) takes no gap either.
  const groups = (Array.from(row.children) as HTMLElement[]).filter(
    group => getComputedStyle(group).display !== 'none'
  );
  const required =
    groups.reduce((total, group) => total + wanted(group), 0) +
    gap * Math.max(0, groups.length - 1);
  const available =
    row.clientWidth -
    (Number.parseFloat(style.paddingLeft) || 0) -
    (Number.parseFloat(style.paddingRight) || 0);
  return required <= available;
}
