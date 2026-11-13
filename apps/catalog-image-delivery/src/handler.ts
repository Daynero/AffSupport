import {
  verifyGlobalImageAlias,
  type GlobalAliasEnvironment
} from '../../../packages/shared/src/team/catalog-global-alias.js';

export interface GlobalImageDeliveryDeps {
  environment: GlobalAliasEnvironment;
  canonicalOrigin: string;
  keys: ReadonlyMap<number, CryptoKey>;
  fetcher: typeof fetch;
}
const MAX_BYTES = 8_000_000;
const failure = (status: number): Response =>
  new Response(null, {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  });

/** Public, read-only delivery: one canonical cache key, no tenant lookup or content transformation. */
export async function handleGlobalImageDelivery(
  request: Request,
  deps: GlobalImageDeliveryDeps
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return failure(405);
  const url = new URL(request.url);
  if (url.origin !== deps.canonicalOrigin || url.search || url.hash || url.pathname.length > 600)
    return failure(404);
  const route = /^\/g\/([A-Za-z0-9_-]{82})\.(jpg|png)$/u.exec(url.pathname);
  if (!route) return failure(404);
  const claims = await verifyGlobalImageAlias(route[1]!, deps.environment, deps.keys);
  if (!claims || (route[2] === 'jpg' ? 'image/jpeg' : 'image/png') !== claims.mime)
    return failure(404);
  try {
    const canonical = new URL(`/g1/${claims.imageId}`, deps.canonicalOrigin);
    const response = await deps.fetcher(
      new Request(canonical, {
        method: request.method,
        redirect: 'error',
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)])
      })
    );
    if (response.status !== 200) {
      await response.body?.cancel();
      return failure(response.status === 404 ? 404 : 503);
    }
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    const length = response.headers.get('content-length');
    if (
      mime !== claims.mime ||
      (length !== null &&
        (!/^\d{1,8}$/u.test(length) || Number(length) < 1 || Number(length) > MAX_BYTES))
    ) {
      await response.body?.cancel();
      return failure(502);
    }
    const headers = new Headers({
      'content-type': claims.mime,
      'x-content-type-options': 'nosniff',
      'cache-control': 'public,max-age=31536000,immutable'
    });
    for (const name of ['content-length', 'etag', 'last-modified']) {
      const value = response.headers.get(name);
      if (value !== null && value.length <= 256) headers.set(name, value);
    }
    if (request.method === 'HEAD') {
      await response.body?.cancel();
      return new Response(null, { status: 200, headers });
    }
    if (!response.body) return failure(502);
    let size = 0;
    const bounded = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > MAX_BYTES) controller.error(new Error('Global image delivery limit'));
        else controller.enqueue(chunk);
      }
    });
    return new Response(response.body.pipeThrough(bounded), { status: 200, headers });
  } catch {
    return failure(503);
  }
}
