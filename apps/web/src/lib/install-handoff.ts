import { useEffect } from 'react';
import type { ConnectionState } from '../connection';
import { teamResolverRoute } from '../team/routes';
import { navigateTo } from './navigation';

/**
 * The tab Soty was downloaded from follows it into the space (070, owner 2026-11-24).
 *
 * The first start of the app opens the site by itself, on the spaces route. The tab the
 * installer came from used to stay where it was — on the home page under the "you need
 * Soty" panel or dialog — so a newcomer ended up with two tabs saying different things and
 * did not know which one was Soty. Now that tab notices the app answering, through the
 * connection watcher it already runs, and moves on to the same place.
 *
 * Remembered per tab (`sessionStorage`): another tab's download is that tab's business, and
 * the pairing that may reload this page keeps it. A day is the same window the pairing
 * itself waits for an install.
 */
const HANDOFF_KEY = 'soty.install-handoff.v1';
const HANDOFF_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The person asked for the installer here, while the app was not reachable. */
export function markInstallStartedHere(): void {
  try {
    sessionStorage.setItem(HANDOFF_KEY, String(Date.now()));
  } catch {
    // Storage refused: the tab simply stays where it is, as it always did.
  }
}

/** Whether this tab is waiting for the app it downloaded; reading it ends the wait. */
export function takeInstallHandoff(now = Date.now()): boolean {
  try {
    const started = Number(sessionStorage.getItem(HANDOFF_KEY));
    sessionStorage.removeItem(HANDOFF_KEY);
    return Number.isFinite(started) && started > 0 && now - started <= HANDOFF_WINDOW_MS;
  } catch {
    return false;
  }
}

/**
 * Moves the download tab on once the app it fetched connects.
 *
 * Only from the home page, which is where the install panel and dialog live: a tool page
 * already opens the tool by itself when the app connects, and any other page is somewhere
 * the person chose to be. The spaces route opens the space this browser used last, or the
 * list of spaces — the same address the app's first start opens.
 */
export function useInstallHandoff(connection: ConnectionState, path: string): void {
  useEffect(() => {
    if (connection !== 'connected' || !takeInstallHandoff()) return;
    if (path === '/') navigateTo(teamResolverRoute());
  }, [connection, path]);
}
