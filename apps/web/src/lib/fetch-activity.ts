/**
 * Which requests are under way, for transitions that wait for an answer (058).
 *
 * A filter or a sort changes the screen twice — once at the press, and again
 * when the server answers. A transition can hold the old picture across both
 * only if it knows an answer is still coming, and the page's own requests are
 * the one signal every list shares. This wraps `fetch` once, before anything
 * captures it, and remembers what has started and not yet answered. It changes
 * nothing about a request.
 */
interface Flight {
  startedAt: number;
}

const flights = new Set<Flight>();
let installed = false;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function installFetchActivity() {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = (...args: Parameters<typeof fetch>) => {
    const flight: Flight = { startedAt: now() };
    flights.add(flight);
    const done = () => {
      flights.delete(flight);
    };
    const response = original(...args);
    response.then(done, done);
    return response;
  };
}

/** Whether a request that began at or after `since` (a `performance.now()` time) is unanswered. */
export function fetchPendingSince(since: number): boolean {
  for (const flight of flights) if (flight.startedAt >= since) return true;
  return false;
}
