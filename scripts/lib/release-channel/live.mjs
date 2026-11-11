/**
 * Reads what an origin is serving right now, past every cache that could lie.
 *
 * `index.html` names every chunk by content hash, so equal index bytes mean the
 * same build; together with the signed manifest they identify both the site and
 * the agent channel a visitor is offered.
 */
import { randomUUID } from 'node:crypto';
import { ChannelError, INDEX_PATH, MANIFEST_PATH } from './state.mjs';

const MAX_BYTES = 2 * 1024 * 1024;

/**
 * @param {string} origin
 * @param {string} relative
 * @param {typeof fetch} fetcher
 */
export async function fetchLive(origin, relative, fetcher = fetch) {
  // Pages serves `/index.html` as a redirect to `/`; ask for `/` itself. The
  // query only defeats an intermediate cache -- Pages ignores it.
  const pathname = relative === INDEX_PATH ? '/' : `/${relative}`;
  const url = new URL(pathname, origin);
  url.searchParams.set('soty-channel-probe', randomUUID());
  let response;
  try {
    response = await fetcher(url, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000)
    });
  } catch (error) {
    throw new ChannelError('CHANNEL_LIVE_UNREACHABLE', `${origin}${pathname} did not answer`, {
      cause: error
    });
  }
  if (!response.ok || !response.body)
    throw new ChannelError(
      'CHANNEL_LIVE_UNREACHABLE',
      `${origin}${pathname} answered HTTP ${response.status}`
    );
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_BYTES)
        throw new ChannelError('CHANNEL_LIVE_UNREACHABLE', `${origin}${pathname} is too large`);
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

/** @param {string} origin @param {typeof fetch} [fetcher] */
export async function liveIdentity(origin, fetcher = fetch) {
  const [index, manifest] = await Promise.all([
    fetchLive(origin, INDEX_PATH, fetcher),
    fetchLive(origin, MANIFEST_PATH, fetcher)
  ]);
  return { index, manifest };
}
