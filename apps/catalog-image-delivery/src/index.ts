import {
  importGlobalAliasKey,
  type GlobalAliasEnvironment
} from '../../../packages/shared/src/team/catalog-global-alias.js';
import { handleGlobalImageDelivery, type GlobalImageDeliveryDeps } from './handler.js';

export interface GlobalImageDeliveryEnv {
  CATALOG_IMAGES_ENVIRONMENT: string;
  R2_CATALOG_PUBLIC_ORIGIN: string;
  CATALOG_GLOBAL_ALIAS_KEYS: string;
  CATALOG_GLOBAL_ROUTING_REVISION: string;
  CATALOG_GLOBAL_DELIVERY_CONFIRMATION: string;
}
const runtimes = new WeakMap<GlobalImageDeliveryEnv, Promise<GlobalImageDeliveryDeps>>();
async function runtime(env: GlobalImageDeliveryEnv): Promise<GlobalImageDeliveryDeps> {
  const environment = env.CATALOG_IMAGES_ENVIRONMENT;
  if (environment !== 'dev' && environment !== 'beta' && environment !== 'production')
    throw new Error('Media environment unavailable');
  const origin = new URL(env.R2_CATALOG_PUBLIC_ORIGIN);
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== env.R2_CATALOG_PUBLIC_ORIGIN ||
    origin.username ||
    origin.password
  )
    throw new Error('Media origin unavailable');
  const raw: unknown = JSON.parse(env.CATALOG_GLOBAL_ALIAS_KEYS);
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
    keys.set(Number(version), await importGlobalAliasKey(bytes));
  }
  const versions = [...keys.keys()].sort((a, b) => a - b).join(',');
  if (
    !/^[A-Za-z0-9_-]{1,100}$/u.test(env.CATALOG_GLOBAL_ROUTING_REVISION) ||
    env.CATALOG_GLOBAL_DELIVERY_CONFIRMATION !==
      `${environment}:${origin.origin}:${env.CATALOG_GLOBAL_ROUTING_REVISION}:${versions}`
  )
    throw new Error('Media target unavailable');
  return {
    environment: environment satisfies GlobalAliasEnvironment,
    canonicalOrigin: origin.origin,
    keys,
    fetcher: fetch
  };
}
export default {
  async fetch(request: Request, env: GlobalImageDeliveryEnv): Promise<Response> {
    try {
      let deps = runtimes.get(env);
      if (!deps) {
        deps = runtime(env);
        runtimes.set(env, deps);
      }
      return await handleGlobalImageDelivery(request, await deps);
    } catch {
      return new Response(null, { status: 503, headers: { 'cache-control': 'no-store' } });
    }
  }
};
