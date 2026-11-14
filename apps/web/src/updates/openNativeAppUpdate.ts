/** UI intent only. The single mounted update owner still validates every native action. */
export const OPEN_NATIVE_APP_UPDATE = 'soty:app-update:open';

export function openNativeAppUpdate(): void {
  window.dispatchEvent(new Event(OPEN_NATIVE_APP_UPDATE));
}
