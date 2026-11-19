/**
 * The part of the explorer that another folder changes: the list of files.
 *
 * Returned only while the start of the list is on screen. Scrolled past it,
 * the new folder has to open from its top, and that is a move of the whole
 * page — the section's transition, not a change within the list (058).
 */
export function explorerListAtRest(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  for (const main of document.querySelectorAll<HTMLElement>('.team-explorer-main')) {
    // A section kept mounted while hidden has no box.
    if (main.offsetParent === null) continue;
    const header = main.parentElement?.querySelector<HTMLElement>(':scope > .team-explorer-header');
    const floor = header ? header.getBoundingClientRect().bottom : 0;
    return main.getBoundingClientRect().top >= floor - 1 ? main : null;
  }
  return null;
}
