/**
 * Fetches a module and everything it imports again, past the browser's cache.
 *
 * During a deploy the host can answer a chunk that has not reached its edge yet with the app's
 * HTML, and the browser keeps that answer for hours. Fetching the failed module alone did not
 * heal it when the poisoned file was one of its imports (next 2026-11-21: ProtectedSoty loaded,
 * its dependency PfMHdMvx2.js was the page's HTML, and every reload failed the same way). So
 * the whole graph under the failed module is fetched again — its static imports and the
 * chunks Vite's preload map names — which replaces any bad copy before the page reloads.
 *
 * Bounded: same-origin `/assets/` files only, a fixed number of files and a time limit, so a
 * real outage cannot keep the page busy.
 */
export const HEAL_MODULE_LIMIT = 400;
export const HEAL_TIME_LIMIT_MS = 10_000;
const PARALLEL = 6;

/** Every module path a built chunk names: relative imports and the preload map's entries. */
export function moduleReferences(source: string, from: string, origin: string): string[] {
  const found = new Set<string>();
  const relative = /["'`](\.{1,2}\/[^"'`\s]+?\.(?:js|css))["'`]/gu;
  const fromBase = /["'`]\/?(assets\/[^"'`\s]+?\.(?:js|css))["'`]/gu;
  for (const match of source.matchAll(relative)) found.add(new URL(match[1]!, from).href);
  for (const match of source.matchAll(fromBase)) found.add(new URL(`/${match[1]!}`, origin).href);
  return [...found].filter(href => {
    const url = new URL(href);
    return url.origin === origin && url.pathname.startsWith('/assets/');
  });
}

export async function healModuleGraph(
  start: string,
  options: {
    origin?: string;
    fetchImpl?: typeof fetch;
    limit?: number;
    timeLimitMs?: number;
  } = {}
): Promise<number> {
  const origin = options.origin ?? window.location.origin;
  const fetchImpl = options.fetchImpl ?? fetch.bind(window);
  const limit = options.limit ?? HEAL_MODULE_LIMIT;
  const deadline = Date.now() + (options.timeLimitMs ?? HEAL_TIME_LIMIT_MS);
  const seen = new Set<string>();
  const queue: string[] = [];
  const enqueue = (href: string) => {
    if (seen.has(href) || seen.size >= limit) return;
    seen.add(href);
    queue.push(href);
  };
  try {
    const first = new URL(start, origin);
    if (first.origin !== origin) return 0;
    enqueue(first.href);
  } catch {
    return 0;
  }
  const visit = async (href: string) => {
    try {
      const response = await fetchImpl(href, { cache: 'reload', credentials: 'same-origin' });
      if (!response.ok || !href.endsWith('.js')) return;
      const text = await response.text();
      // A fresh answer that is still HTML has nothing to follow; the reload will tell.
      if (text.trimStart().startsWith('<')) return;
      for (const next of moduleReferences(text, href, origin)) enqueue(next);
    } catch {
      // One file that will not come is no reason to stop healing the others.
    }
  };
  while (queue.length && Date.now() < deadline)
    await Promise.all(queue.splice(0, PARALLEL).map(visit));
  return seen.size;
}
