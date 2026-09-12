import { vi } from 'vitest';

/**
 * Intercepts the one thing jsdom cannot do: leave the page.
 *
 * A cross-origin jump — a Google consent screen, an Agent handoff — is a real
 * navigation, and jsdom answers it with "Not implemented: navigation to another
 * Document" on stderr while the assertion silently passes for the wrong reason.
 * Replacing only `assign` keeps the live Location for everything else, so
 * `history.replaceState` and every `location.pathname` read still behave.
 *
 * This lived inside one test file until three of them needed it. One copy, so a
 * change to how the app leaves the page is a change in one place.
 */
export function interceptCrossOriginNavigation(): {
  assign: ReturnType<typeof vi.fn>;
  restore: () => void;
} {
  const real = window.location;
  const assign = vi.fn();
  const view: Record<string, unknown> = { assign };
  for (const key of [
    'href',
    'origin',
    'protocol',
    'host',
    'hostname',
    'port',
    'pathname',
    'search',
    'hash'
  ]) {
    Object.defineProperty(view, key, { get: () => real[key as 'href'], enumerable: true });
  }
  Object.defineProperty(window, 'location', { configurable: true, value: view });
  return {
    assign,
    restore: () => Object.defineProperty(window, 'location', { configurable: true, value: real })
  };
}
