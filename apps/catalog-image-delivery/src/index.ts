import {
  importGlobalAliasKey,
  type GlobalAliasEnvironment
} from '../../../packages/shared/src/team/catalog-global-alias.js';
import { importSpaceReadGrantKey } from '../../../packages/shared/src/team/space-read-grant.js';
import { SPACE_STORAGE_LIMITS } from '../../../packages/shared/src/team/space-storage.js';
import { handleGlobalImageDelivery, type GlobalImageDeliveryDeps } from './handler.js';
import {
  createCachedEpochReader,
  handleSpaceRead,
  supabaseEpochLoader,
  type SpaceReadBucket,
  type SpaceReadCache,
  type SpaceReadContext,
  type SpaceReadDeps
} from './space-read.js';

export interface GlobalImageDeliveryEnv {
  CATALOG_IMAGES_ENVIRONMENT: string;
  R2_CATALOG_PUBLIC_ORIGIN: string;
  CATALOG_GLOBAL_ALIAS_KEYS: string;
  CATALOG_GLOBAL_ROUTING_REVISION: string;
  CATALOG_GLOBAL_DELIVERY_CONFIRMATION: string;
  /** 057 files host (`space-read`). Absent: every request is the alias path. */
  SPACE_FILES_HOST?: string;
  SPACE_BUCKET?: SpaceReadBucket;
  /** Worker secret, JSON `{"<version>": "<base64 32..128 bytes>"}`; equals the Supabase secret. */
  SPACE_READ_GRANT_KEYS?: string;
  /** Comma-separated web origins allowed to read files with CORS. */
  SPACE_ALLOWED_ORIGINS?: string;
  SUPABASE_URL?: string;
  /** Worker secret: reads `access_epoch` through `service_space_read_epoch`. */
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

const environmentOf = (value: string): GlobalAliasEnvironment => {
  if (value !== 'dev' && value !== 'beta' && value !== 'production')
    throw new Error('Media environment unavailable');
  return value;
};

async function importKeyring(
  json: string,
  importer: (raw: Uint8Array) => Promise<CryptoKey>
): Promise<Map<number, CryptoKey>> {
  const raw: unknown = JSON.parse(json);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Media keys unavailable');
  const entries = Object.entries(raw);
  if (entries.length < 1 || entries.length > 8) throw new Error('Media keys unavailable');
  const keys = new Map<number, CryptoKey>();
  for (const [version, value] of entries) {
    if (
      !/^[1-9][0-9]{0,4}$/u.test(version) ||
      Number(version) > 65535 ||
      typeof value !== 'string' ||
      value.length > 172
    )
      throw new Error('Media key unavailable');
    const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
    keys.set(Number(version), await importer(bytes));
  }
  return keys;
}

const runtimes = new WeakMap<GlobalImageDeliveryEnv, Promise<GlobalImageDeliveryDeps>>();
async function runtime(env: GlobalImageDeliveryEnv): Promise<GlobalImageDeliveryDeps> {
  const environment = environmentOf(env.CATALOG_IMAGES_ENVIRONMENT);
  const origin = new URL(env.R2_CATALOG_PUBLIC_ORIGIN);
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== env.R2_CATALOG_PUBLIC_ORIGIN ||
    origin.username ||
    origin.password
  )
    throw new Error('Media origin unavailable');
  const keys = await importKeyring(env.CATALOG_GLOBAL_ALIAS_KEYS, raw => importGlobalAliasKey(raw));
  const versions = [...keys.keys()].sort((a, b) => a - b).join(',');
  if (
    !/^[A-Za-z0-9_-]{1,100}$/u.test(env.CATALOG_GLOBAL_ROUTING_REVISION) ||
    env.CATALOG_GLOBAL_DELIVERY_CONFIRMATION !==
      `${environment}:${origin.origin}:${env.CATALOG_GLOBAL_ROUTING_REVISION}:${versions}`
  )
    throw new Error('Media target unavailable');
  return {
    environment,
    canonicalOrigin: origin.origin,
    keys,
    // Called as deps.fetcher(...): a bare `fetch` would get `this` = deps, which the Workers
    // runtime rejects with "Illegal invocation" (every alias answered 503 on next).
    fetcher: (input, init) => fetch(input, init)
  };
}

const spaceRuntimes = new WeakMap<GlobalImageDeliveryEnv, Promise<SpaceReadDeps>>();
async function spaceRuntime(env: GlobalImageDeliveryEnv): Promise<SpaceReadDeps> {
  const environment = environmentOf(env.CATALOG_IMAGES_ENVIRONMENT);
  // Each name is read off `env` directly so the env registry scan (config/environments.json)
  // sees all of them.
  const filesHost = env.SPACE_FILES_HOST;
  const bucket = env.SPACE_BUCKET;
  const grantKeys = env.SPACE_READ_GRANT_KEYS;
  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!filesHost || !bucket || !grantKeys || !supabaseUrl || !serviceKey)
    throw new Error('Space files unavailable');
  const supabase = new URL(supabaseUrl);
  if (
    (supabase.protocol !== 'https:' && !(environment === 'dev' && supabase.protocol === 'http:')) ||
    supabase.username ||
    supabase.password
  )
    throw new Error('Space files unavailable');
  const keys = await importKeyring(grantKeys, raw => importSpaceReadGrantKey(raw));
  const allowedOrigins = (env.SPACE_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(value => {
      try {
        return value !== '' && new URL(value).origin === value;
      } catch {
        return false;
      }
    });
  const epoch = createCachedEpochReader({
    load: supabaseEpochLoader({
      supabaseUrl: supabase.origin,
      serviceKey,
      // Unbound, for the same "Illegal invocation" reason as the alias fetcher above.
      fetcher: request => fetch(request)
    }),
    nowMs: () => Date.now(),
    ttlSeconds: SPACE_STORAGE_LIMITS.epochCacheSeconds,
    maxEntries: 1000
  });
  const cache = (globalThis as { caches?: { default?: SpaceReadCache } }).caches?.default;
  return {
    environment,
    filesHost,
    keys,
    bucket,
    epoch,
    allowedOrigins,
    ...(cache ? { cache } : {}),
    nowSeconds: () => Math.floor(Date.now() / 1000)
  };
}

function memo<T>(
  map: WeakMap<GlobalImageDeliveryEnv, Promise<T>>,
  env: GlobalImageDeliveryEnv,
  build: (env: GlobalImageDeliveryEnv) => Promise<T>
): Promise<T> {
  let deps = map.get(env);
  if (!deps) {
    deps = build(env);
    map.set(env, deps);
  }
  return deps;
}

const unavailable = (): Response =>
  new Response(null, {
    status: 503,
    headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }
  });

export default {
  async fetch(
    request: Request,
    env: GlobalImageDeliveryEnv,
    context?: SpaceReadContext
  ): Promise<Response> {
    let host: string;
    try {
      host = new URL(request.url).host;
    } catch {
      return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
    }
    if (env.SPACE_FILES_HOST && host === env.SPACE_FILES_HOST) {
      let deps: SpaceReadDeps;
      try {
        deps = await memo(spaceRuntimes, env, spaceRuntime);
      } catch {
        return unavailable();
      }
      return handleSpaceRead(request, deps, context);
    }
    try {
      return await handleGlobalImageDelivery(request, await memo(runtimes, env, runtime));
    } catch {
      return new Response(null, { status: 503, headers: { 'cache-control': 'no-store' } });
    }
  }
};
