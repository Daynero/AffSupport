/**
 * `GET|HEAD /files/t/{team}/…` — the space read route for beta and dev (057, lead decision
 * 2026-11-28, amends T027).
 *
 * On next and production the `space-read` Worker on the files host is the read path. A beta
 * stack's Supabase API listens only on `127.0.0.1:54321`, so a Worker can never read the epoch
 * there and every read would answer 503. Beta therefore reads through this function: the very
 * same handler (`packages/shared/src/team/space-read.ts`) with the same grant checks, Range/206,
 * HEAD, `Referrer-Policy: no-referrer` and caching headers, streaming from the space bucket over
 * S3. Nothing is cached here: the Worker's edge cache has no equivalent in the edge runtime.
 *
 * Enabled only by a non-production server config, and fail closed: production, a missing or
 * unknown environment, `SPACE_FILES_ORIGIN` naming anything but this route, missing keys or a
 * missing bucket — each leaves the route absent (404, as any unknown path). The grant config in
 * `read.ts` refuses this base in production too, so the web never even gets such a URL there.
 * The grant rides in `?g=`, so nothing here logs the URL or the query.
 */
// @deno-types="../../../packages/shared/dist/team/space-read.d.ts"
import {
  createCachedEpochReader,
  handleSpaceRead,
  type SpaceReadBucket,
  type SpaceReadDeps
} from '../../../packages/shared/dist/team/space-read.js';
// @deno-types="../../../packages/shared/dist/team/space-read-grant.d.ts"
import {
  importSpaceReadGrantKey,
  type SpaceGrantEnvironment
} from '../../../packages/shared/dist/team/space-read-grant.js';
// @deno-types="../../../packages/shared/dist/team/space-storage.d.ts"
import {
  isSpaceFilesBase,
  SPACE_LOCAL_FILES_PATH,
  SPACE_STORAGE_LIMITS
} from '../../../packages/shared/dist/team/space-storage.js';
import type { SpaceR2 } from '../_shared/r2-space.ts';

/** The route segment after `/space-storage`. */
export const SPACE_FILES_ROUTE = '/files';

export interface LocalSpaceReadConfig {
  environment: Exclude<SpaceGrantEnvironment, 'production'>;
  /** Every key version in `SPACE_READ_GRANT_KEYS`: a grant signed before a rotation still reads. */
  keys: ReadonlyMap<number, CryptoKey>;
}

/**
 * The route's config, or null when it must stay absent. Requires all of:
 * `CATALOG_IMAGES_ENVIRONMENT` = `beta` or `dev`, `SPACE_FILES_ORIGIN` = this route
 * (`<API origin>/functions/v1/space-storage/files`), and a well-formed `SPACE_READ_GRANT_KEYS`.
 */
export async function readLocalSpaceReadConfig(
  env: (key: string) => string | undefined
): Promise<LocalSpaceReadConfig | null> {
  const environment = env('CATALOG_IMAGES_ENVIRONMENT');
  if (environment !== 'beta' && environment !== 'dev') return null;
  const base = env('SPACE_FILES_ORIGIN');
  if (!isSpaceFilesBase(base, { allowLocalRoute: true }) || !base.endsWith(SPACE_LOCAL_FILES_PATH))
    return null;
  const raw = env('SPACE_READ_GRANT_KEYS');
  if (!raw || raw.length > 4096) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed);
    if (entries.length < 1 || entries.length > 8) return null;
    const keys = new Map<number, CryptoKey>();
    for (const [version, value] of entries) {
      if (
        !/^[1-9][0-9]{0,4}$/u.test(version) ||
        Number(version) > 65535 ||
        typeof value !== 'string' ||
        value.length > 172
      )
        return null;
      keys.set(
        Number(version),
        await importSpaceReadGrantKey(Uint8Array.from(atob(value), c => c.charCodeAt(0)))
      );
    }
    return { environment, keys };
  } catch {
    return null;
  }
}

/** The space bucket as the read core sees it: HEAD, GET and one range, streamed over S3. */
export function spaceReadBucket(r2: Pick<SpaceR2, 'open'>, signal: AbortSignal): SpaceReadBucket {
  const meta = (object: { size: number; etag: string; contentType: string | null }) => ({
    size: object.size,
    httpEtag: object.etag,
    httpMetadata: object.contentType === null ? {} : { contentType: object.contentType }
  });
  return {
    async head(key) {
      const object = await r2.open(key, { method: 'HEAD' }, signal);
      return object ? meta(object) : null;
    },
    async get(key, options) {
      const object = await r2.open(
        key,
        options?.range ? { method: 'GET', range: options.range } : { method: 'GET' },
        signal
      );
      if (!object) return null;
      if (!object.body) throw new Error('Space object has no body');
      return { ...meta(object), body: object.body };
    }
  };
}

export interface LocalSpaceReadDeps {
  config: LocalSpaceReadConfig | null;
  bucket: SpaceReadBucket | null;
  /** `service_space_read_epoch(p_team)` with the service key; null = not an active R2 space. */
  epoch: (teamId: string) => Promise<bigint | null>;
  allowedOrigins: readonly string[];
  nowSeconds: () => number;
}

const absent = (): Response =>
  new Response(JSON.stringify({ error: 'NOT_FOUND' }), {
    status: 404,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff'
    }
  });

/**
 * Serves one read. `prefix` is the request's path up to and including `/space-storage/files`
 * (the edge runtime may or may not keep `/functions/v1` in front of it).
 */
export function serveLocalSpaceRead(
  request: Request,
  prefix: string,
  deps: LocalSpaceReadDeps
): Promise<Response> | Response {
  if (!deps.config || !deps.bucket) return absent();
  const read: SpaceReadDeps = {
    environment: deps.config.environment,
    filesHost: null,
    pathPrefix: prefix,
    keys: deps.config.keys,
    bucket: deps.bucket,
    epoch: deps.epoch,
    allowedOrigins: deps.allowedOrigins,
    nowSeconds: deps.nowSeconds
  };
  return handleSpaceRead(request, read);
}

/** The path prefix of a files-route request, or null when the path is not one. */
export function localSpaceReadPrefix(url: URL): string | null {
  const marker = `/space-storage${SPACE_FILES_ROUTE}`;
  const index = url.pathname.indexOf(`${marker}/`);
  return index < 0 ? null : url.pathname.slice(0, index + marker.length);
}

/** `access_epoch` per space, trusted ≤30 s exactly as the Worker does. */
export function localEpochReader(
  load: (teamId: string) => Promise<bigint | null>
): (teamId: string) => Promise<bigint | null> {
  return createCachedEpochReader({
    load,
    nowMs: () => Date.now(),
    ttlSeconds: SPACE_STORAGE_LIMITS.epochCacheSeconds,
    maxEntries: 1000
  });
}

/** The RPC's answer: a JSON string of decimal digits, or null. Anything else throws. */
export function parseEpoch(value: unknown): bigint | null {
  if (value === null) return null;
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]{0,18})$/u.test(value)) {
    const epoch = BigInt(value);
    if (epoch <= 9_223_372_036_854_775_807n) return epoch;
  }
  throw new Error('Epoch lookup malformed');
}
