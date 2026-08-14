import type { ZoomMode } from './types';

const VIEWER_PREFERENCES_KEY = 'wishly:landing-preview:viewer-preferences';

export interface ViewerPreferences {
  sidebarOpen: boolean;
  zoomMode: ZoomMode;
  customScale: number;
}

export function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function readViewerPreferences(): ViewerPreferences {
  const fallback: ViewerPreferences = {
    sidebarOpen: true,
    zoomMode: 'fit-width',
    customScale: 1
  };
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const stored = JSON.parse(localStorage.getItem(VIEWER_PREFERENCES_KEY) ?? '{}') as Record<
      string,
      unknown
    >;
    return {
      sidebarOpen: typeof stored.sidebarOpen === 'boolean' ? stored.sidebarOpen : true,
      zoomMode: ['fit-width', 'fit-page', 'custom'].includes(String(stored.zoomMode))
        ? (stored.zoomMode as ZoomMode)
        : 'fit-width',
      customScale:
        typeof stored.customScale === 'number' && Number.isFinite(stored.customScale)
          ? clamp(stored.customScale, 0.25, 3)
          : 1
    };
  } catch {
    return fallback;
  }
}

export function writeViewerPreferences(preferences: ViewerPreferences) {
  try {
    localStorage.setItem(VIEWER_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // The viewer still works when browser storage is disabled.
  }
}
