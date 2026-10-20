/** Shared by native-title hints and component tooltips. Panels own their hover context. */
export const OVERLAY_OPEN_EVENT = 'soty:overlay-open';

export function tooltipAnchorAllowed(host: HTMLElement): boolean {
  const layers = document.querySelectorAll(
    '[role="dialog"]:not([aria-hidden="true"]), [role="alertdialog"]:not([aria-hidden="true"]), [role="menu"], [role="listbox"]'
  );
  const top = layers[layers.length - 1];
  return host.isConnected && (!top || top.contains(host));
}
