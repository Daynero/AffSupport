// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CATALOG_SYNC_WAKE_INTERVAL_MS,
  resetCatalogSyncWakes,
  useWakeCatalogSync
} from '../apps/web/src/team/useWakeCatalogSync';

/** perf 1.4.3: an open space wakes its idle Drive feed, at most every 2 minutes. */
let visibility: DocumentVisibilityState = 'visible';
beforeEach(() => {
  resetCatalogSyncWakes();
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const becomeVisible = () => {
  visibility = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
};

describe('useWakeCatalogSync', () => {
  it('wakes the space when it opens, and again on return only after the interval', () => {
    let clock = 1_000_000;
    const wake = vi.fn(async () => undefined);
    const now = () => clock;
    renderHook(() => useWakeCatalogSync('team-1', wake, now));
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith('team-1');

    clock += 30_000;
    becomeVisible();
    expect(wake).toHaveBeenCalledTimes(1);

    clock += CATALOG_SYNC_WAKE_INTERVAL_MS;
    becomeVisible();
    expect(wake).toHaveBeenCalledTimes(2);
  });

  it('does nothing without a space or while the tab is hidden, and survives a failing wake', () => {
    const wake = vi.fn(async () => {
      throw new Error('offline');
    });
    renderHook(() => useWakeCatalogSync(null, wake));
    expect(wake).not.toHaveBeenCalled();

    visibility = 'hidden';
    const { unmount } = renderHook(() => useWakeCatalogSync('team-2', wake));
    expect(wake).not.toHaveBeenCalled();
    becomeVisible();
    expect(wake).toHaveBeenCalledTimes(1);
    unmount();
    becomeVisible();
    expect(wake).toHaveBeenCalledTimes(1);
  });
});
