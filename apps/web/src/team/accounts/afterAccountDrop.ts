/** Restore expanded content only after Feedback releases its fixed-size source. */
export function afterAccountDrop(element: Element | undefined, restore: () => void): () => void {
  if (!element) {
    restore();
    return () => {};
  }
  let finished = false;
  const observer = new MutationObserver(check);
  function check() {
    if (
      finished ||
      (element!.isConnected &&
        (element!.hasAttribute('data-dnd-dragging') ||
          element!.hasAttribute('data-dnd-dropping') ||
          element!.hasAttribute('popover')))
    )
      return;
    finished = true;
    observer.disconnect();
    restore();
  }
  observer.observe(element, {
    attributes: true,
    attributeFilter: ['data-dnd-dragging', 'data-dnd-dropping', 'popover', 'style']
  });
  const table = element.closest('.team-accounts-table');
  if (table) observer.observe(table, { childList: true, subtree: true });
  check();
  return () => {
    finished = true;
    observer.disconnect();
  };
}
