import {
  verifySpaceReadGrant,
  type SpaceGrantEnvironment
} from '../../../packages/shared/src/team/space-read-grant.js';
import { SPACE_KEY_PATTERN } from '../../../packages/shared/src/team/space-storage.js';

/**
 * 057 `space-read` (contracts/storage-api.md «Worker `space-read`», research R4): private
 * bytes of an R2 space on the files host. Every request proves a read grant (signature and
 * expiry, the team in the path, the space's current `access_epoch`) before the cache or R2
 * is touched; the cache key never carries the grant. The grant rides in `?g=`, so nothing
 * here logs the URL, the query or the key.
 */

/** The subset of R2 object metadata this Worker reads. */
export interface SpaceReadObject {
  size: number;
  httpEtag: string;
  httpMetadata?: { contentType?: string };
}
export interface SpaceReadObjectBody extends SpaceReadObject {
  body: ReadableStream<Uint8Array>;
}
/** The subset of the Workers `R2Bucket` this Worker calls. It never writes. */
export interface SpaceReadBucket {
  head(key: string): Promise<SpaceReadObject | null>;
  get(
    key: string,
    options?: { range?: { offset: number; length: number } }
  ): Promise<SpaceReadObjectBody | null>;
}
/** The subset of the Workers Cache API (`caches.default`) this Worker calls. */
export interface SpaceReadCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}
export interface SpaceReadDeps {
  environment: SpaceGrantEnvironment;
  /** `files.soty.pp.ua` / `files-beta.soty.pp.ua`; any other host is never served. */
  filesHost: string;
  keys: ReadonlyMap<number, CryptoKey>;
  bucket: SpaceReadBucket;
  /** The space's current `access_epoch`, already cached ≤30 s by the caller; null = not an active R2 space. */
  epoch: (teamId: string) => Promise<bigint | null>;
  /** Origins that may read responses with CORS (the web app). */
  allowedOrigins: readonly string[];
  cache?: SpaceReadCache;
  nowSeconds: () => number;
}
export interface SpaceReadContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Responses larger than this go straight from R2 every time instead of into the edge cache. */
const CACHE_MAX_BYTES = 256 * 1024 * 1024;
const MAX_PATH = 200;
const MAX_DOWNLOAD_NAME = 180;
const IMMUTABLE = 'private, max-age=31536000, immutable';
const CSP =
  "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox";
const EXPOSE = 'Content-Length, Content-Range, Accept-Ranges, ETag';
const CLEAR_PATH = '/clear-site-data';

type ErrorCode =
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'GRANT_INVALID'
  | 'GRANT_EXPIRED'
  | 'FORBIDDEN'
  | 'ACCESS_REVOKED'
  | 'RANGE_NOT_SATISFIABLE'
  | 'STORAGE_UNAVAILABLE';

function corsHeaders(request: Request, deps: SpaceReadDeps): Record<string, string> {
  const origin = request.headers.get('origin');
  if (origin === null || !deps.allowedOrigins.includes(origin)) return {};
  return { 'access-control-allow-origin': origin, 'access-control-expose-headers': EXPOSE };
}

function failure(
  request: Request,
  deps: SpaceReadDeps,
  status: number,
  code: ErrorCode,
  extra: Record<string, string> = {}
): Response {
  const headers = new Headers({
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    vary: 'Origin',
    ...corsHeaders(request, deps),
    ...extra
  });
  if (request.method === 'HEAD') return new Response(null, { status, headers });
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify({ error: code }), { status, headers });
}

/** RFC 6266 / 5987 attachment header; the name is the user's, so nothing in it is trusted. */
export function safeDownloadDisposition(raw: string): string {
  const cleaned = Array.from(
    raw
      .normalize('NFC')
      // eslint-disable-next-line no-control-regex -- stripping control characters is the point
      .replace(/[\u0000-\u001f\u007f-\u009f"\\/\u2028\u2029]/gu, '')
      .replace(/\s+/gu, ' ')
      .trim()
      .replace(/^[.\s]+/u, '')
  )
    .slice(0, MAX_DOWNLOAD_NAME)
    .join('')
    .trim();
  const name = cleaned || 'download';
  const ascii = name.replace(/[^\x20-\x7e]|%/gu, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/gu,
    c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

type RangeVerdict =
  { kind: 'none' } | { kind: 'bad' } | { kind: 'ok'; offset: number; length: number };
/** One `bytes=` range; anything else (several ranges, other units, out of bounds) is refused. */
function parseRange(header: string | null, size: number): RangeVerdict {
  if (header === null) return { kind: 'none' };
  const match = /^bytes=(\d{0,16})-(\d{0,16})$/u.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return { kind: 'bad' };
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (suffix < 1 || size < 1) return { kind: 'bad' };
    const length = Math.min(suffix, size);
    return { kind: 'ok', offset: size - length, length };
  }
  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (start >= size || (match[2] !== '' && Number(match[2]) < start)) return { kind: 'bad' };
  return { kind: 'ok', offset: start, length: end - start + 1 };
}

function successHeaders(
  request: Request,
  deps: SpaceReadDeps,
  object: { contentType: string; etag: string | null; length: number },
  download: string | null
): Headers {
  const headers = new Headers({
    'cache-control': IMMUTABLE,
    'accept-ranges': 'bytes',
    'content-type': object.contentType,
    'content-length': String(object.length),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': CSP,
    'content-disposition': download === null ? 'inline' : safeDownloadDisposition(download),
    vary: 'Origin',
    ...corsHeaders(request, deps)
  });
  if (object.etag !== null) headers.set('etag', object.etag);
  return headers;
}

const contentTypeOf = (object: SpaceReadObject): string => {
  const type = object.httpMetadata?.contentType?.trim();
  return type && type.length <= 200 && !/[\r\n]/u.test(type) ? type : 'application/octet-stream';
};
const etagOf = (value: string | null | undefined): string | null =>
  value && value.length <= 256 && /^(?:W\/)?"[^"\r\n]*"$/u.test(value) ? value : null;

export async function handleSpaceRead(
  request: Request,
  deps: SpaceReadDeps,
  context?: SpaceReadContext
): Promise<Response> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return failure(request, deps, 404, 'NOT_FOUND');
  }
  if (url.host !== deps.filesHost) return failure(request, deps, 404, 'NOT_FOUND');
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return failure(request, deps, 405, 'METHOD_NOT_ALLOWED', { allow: 'GET, HEAD' });

  if (url.pathname === CLEAR_PATH)
    return new Response(null, {
      status: 204,
      headers: {
        'clear-site-data': '"cache"',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        vary: 'Origin',
        ...corsHeaders(request, deps)
      }
    });

  // The R2 key is the path; staging keys (`u/`) are never readable.
  const key = url.pathname.slice(1);
  const parts = key.split('/');
  if (url.pathname.length > MAX_PATH || !SPACE_KEY_PATTERN.test(key) || parts[2] === 'u')
    return failure(request, deps, 404, 'NOT_FOUND');
  const teamId = parts[1]!;

  const grants = url.searchParams.getAll('g');
  const downloads = url.searchParams.getAll('dl');
  if (grants.length !== 1 || downloads.length > 1)
    return failure(request, deps, 401, 'GRANT_INVALID');
  const download = downloads[0] ?? null;

  // 1. Signature and expiry, 2. the team in the path (verified together, in that order).
  const verdict = await verifySpaceReadGrant(grants[0]!, {
    environment: deps.environment,
    keys: deps.keys,
    teamId,
    nowSeconds: deps.nowSeconds()
  });
  if (!verdict.ok) {
    if (verdict.reason === 'expired') return failure(request, deps, 401, 'GRANT_EXPIRED');
    if (verdict.reason === 'team') return failure(request, deps, 403, 'FORBIDDEN');
    return failure(request, deps, 401, 'GRANT_INVALID');
  }
  // 3. The space's current epoch: raising it revokes every grant already issued.
  let current: bigint | null;
  try {
    current = await deps.epoch(teamId);
  } catch {
    return failure(request, deps, 503, 'STORAGE_UNAVAILABLE');
  }
  if (current === null) return failure(request, deps, 403, 'FORBIDDEN');
  if (current !== verdict.claims.accessEpoch) return failure(request, deps, 403, 'ACCESS_REVOKED');

  // Authorized. Only now may the cache or R2 answer.
  try {
    const rangeHeader = request.headers.get('range');
    if (request.method === 'HEAD' || rangeHeader !== null) {
      const object = await deps.bucket.head(key);
      if (!object) return failure(request, deps, 404, 'NOT_FOUND');
      const range = parseRange(rangeHeader, object.size);
      if (range.kind === 'bad')
        return failure(request, deps, 416, 'RANGE_NOT_SATISFIABLE', {
          'content-range': `bytes */${object.size}`
        });
      const meta = { contentType: contentTypeOf(object), etag: etagOf(object.httpEtag) };
      if (range.kind === 'none') {
        return new Response(null, {
          status: 200,
          headers: successHeaders(request, deps, { ...meta, length: object.size }, download)
        });
      }
      const headers = successHeaders(request, deps, { ...meta, length: range.length }, download);
      headers.set(
        'content-range',
        `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`
      );
      if (request.method === 'HEAD') return new Response(null, { status: 206, headers });
      const body = await deps.bucket.get(key, {
        range: { offset: range.offset, length: range.length }
      });
      if (!body) return failure(request, deps, 404, 'NOT_FOUND');
      return new Response(body.body, { status: 206, headers });
    }

    // Full GET: the edge cache first, under the grant-free key.
    const cacheKey = new Request(`https://${deps.filesHost}/${key}`, { method: 'GET' });
    if (deps.cache) {
      let hit: Response | undefined;
      try {
        hit = await deps.cache.match(cacheKey);
      } catch {
        hit = undefined;
      }
      const length = hit?.headers.get('content-length');
      if (hit && hit.status === 200 && hit.body && length && /^\d{1,16}$/u.test(length)) {
        const headers = successHeaders(
          request,
          deps,
          {
            contentType: hit.headers.get('content-type') ?? 'application/octet-stream',
            etag: etagOf(hit.headers.get('etag')),
            length: Number(length)
          },
          download
        );
        return new Response(hit.body, { status: 200, headers });
      }
      await hit?.body?.cancel();
    }

    const object = await deps.bucket.get(key);
    if (!object) return failure(request, deps, 404, 'NOT_FOUND');
    const meta = {
      contentType: contentTypeOf(object),
      etag: etagOf(object.httpEtag),
      length: object.size
    };
    const headers = successHeaders(request, deps, meta, download);
    if (!deps.cache || object.size > CACHE_MAX_BYTES)
      return new Response(object.body, { status: 200, headers });

    const [toClient, toCache] = object.body.tee();
    // The stored copy carries no per-request header (CORS, disposition) and a cacheable
    // Cache-Control; what the browser sees is rebuilt above on every hit.
    const stored = new Headers({
      'cache-control': 'public, max-age=31536000, immutable',
      'content-type': meta.contentType,
      'content-length': String(meta.length)
    });
    if (meta.etag !== null) stored.set('etag', meta.etag);
    const put = deps.cache
      .put(cacheKey, new Response(toCache, { status: 200, headers: stored }))
      .catch(() => undefined);
    if (context) context.waitUntil(put);
    return new Response(toClient, { status: 200, headers });
  } catch {
    return failure(request, deps, 503, 'STORAGE_UNAVAILABLE');
  }
}

/**
 * In-isolate cache of `access_epoch` per space: trusted for at most `ttlSeconds`
 * (`SPACE_STORAGE_LIMITS.epochCacheSeconds`), so a revocation is seen within that window.
 * Failures are never cached; concurrent reads of one space share one load.
 */
export function createCachedEpochReader(options: {
  load: (teamId: string) => Promise<bigint | null>;
  nowMs: () => number;
  ttlSeconds: number;
  maxEntries?: number;
}): (teamId: string) => Promise<bigint | null> {
  const maxEntries = options.maxEntries ?? 1000;
  const ttlMs = options.ttlSeconds * 1000;
  const entries = new Map<string, { at: number; value: Promise<bigint | null> }>();
  return teamId => {
    const now = options.nowMs();
    const cached = entries.get(teamId);
    if (cached && now - cached.at < ttlMs && now >= cached.at) return cached.value;
    entries.delete(teamId);
    while (entries.size >= maxEntries) entries.delete(entries.keys().next().value!);
    const value = options.load(teamId);
    const entry = { at: now, value };
    entries.set(teamId, entry);
    value.catch(() => {
      if (entries.get(teamId) === entry) entries.delete(teamId);
    });
    return value;
  };
}

/**
 * `service_space_read_epoch(p_team)` over PostgREST with the service key: a JSON string of
 * decimal digits, or null when the space is not an active R2 space. Anything else throws.
 */
export function supabaseEpochLoader(input: {
  supabaseUrl: string;
  serviceKey: string;
  fetcher: (input: Request) => Promise<Response>;
}): (teamId: string) => Promise<bigint | null> {
  const endpoint = new URL('/rest/v1/rpc/service_space_read_epoch', input.supabaseUrl).toString();
  return async teamId => {
    const response = await input.fetcher(
      new Request(endpoint, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          apikey: input.serviceKey,
          authorization: `Bearer ${input.serviceKey}`,
          'content-type': 'application/json',
          accept: 'application/json'
        },
        body: JSON.stringify({ p_team: teamId }),
        signal: AbortSignal.timeout(5_000)
      })
    );
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(`Epoch lookup failed: ${response.status}`);
    }
    const text = await response.text();
    if (text.length > 64) throw new Error('Epoch lookup malformed');
    const value: unknown = JSON.parse(text);
    if (value === null) return null;
    if (typeof value === 'string' && /^(?:0|[1-9][0-9]{0,18})$/u.test(value)) {
      const epoch = BigInt(value);
      if (epoch <= 9_223_372_036_854_775_807n) return epoch;
    }
    throw new Error('Epoch lookup malformed');
  };
}
