import {
  importGlobalAliasKey,
  signGlobalImageAlias,
  type GlobalAliasEnvironment
} from '../../../packages/shared/dist/team/catalog-global-alias.js';
import {
  catalogImageRpc,
  catalogImageObject,
  catalogImageString,
  createCatalogImagePermit,
  type CatalogImageRpc
} from '../_shared/catalog-images.ts';
import { optimizeCatalogImage } from '../_shared/catalog-image-optimization.ts';
import {
  readCatalogImageBytes,
  validateCatalogImage
} from '../_shared/catalog-image-validation.ts';
import type { CatalogImageR2 } from '../_shared/r2-catalog-images.ts';
import { keepLease } from '../_shared/lease-keeper.ts';
import { TeamFunctionError } from '../_shared/errors.ts';

const permit = createCatalogImagePermit();
export interface GlobalWorkerDeps {
  service: CatalogImageRpc;
  r2: CatalogImageR2;
  keys: ReadonlyMap<number, CryptoKey>;
  fetcher?: typeof fetch;
}
export async function readGlobalWorkerKeys(value: string): Promise<ReadonlyMap<number, CryptoKey>> {
  const parsed: unknown = JSON.parse(value),
    keys = new Map<number, CryptoKey>();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new TeamFunctionError('GLOBAL_IMAGE_READINESS_UNKNOWN');
  for (const [version, raw] of Object.entries(parsed)) {
    const n = Number(version);
    if (
      !Number.isInteger(n) ||
      n < 1 ||
      n > 65535 ||
      typeof raw !== 'string' ||
      raw.length > 172 ||
      keys.size >= 8
    )
      throw new TeamFunctionError('GLOBAL_IMAGE_READINESS_UNKNOWN');
    keys.set(n, await importGlobalAliasKey(Uint8Array.from(atob(raw), c => c.charCodeAt(0))));
  }
  return keys;
}
export async function runGlobalImageWorker(deps: GlobalWorkerDeps): Promise<unknown> {
  const release = permit.acquire();
  if (!release) return { busy: true };
  const worker = `global:${crypto.randomUUID()}`,
    abort = new AbortController(),
    timer = setTimeout(() => abort.abort(), 60_000);
  const rpc = (action: string, data: Record<string, unknown> = {}) =>
    catalogImageRpc(deps.service, 'service_catalog_global_work', {
      p_action: action,
      p_worker: worker,
      p_data: data
    });
  const fetcher = deps.fetcher ?? fetch;
  let claim: Record<string, unknown> | null = null;
  let stop: ReturnType<typeof keepLease> | undefined;
  const probe = async (item: Record<string, unknown>) => {
    const id = catalogImageString(item.id),
      mime = catalogImageString(item.mime),
      sha = catalogImageString(item.sha256),
      revision = catalogImageString(item.revision);
    const origin = catalogImageString(item.origin),
      environment = item.environment as GlobalAliasEnvironment;
    if (
      origin !== deps.r2.config.publicOrigin ||
      !['dev', 'beta', 'production'].includes(environment)
    )
      throw new TeamFunctionError('GLOBAL_IMAGE_POLICY_CONFLICT');
    const response = await deps.r2.get('public', catalogImageString(item.key), abort.signal);
    if (!response) throw new TeamFunctionError('IMAGE_WRITE_UNCERTAIN');
    const checked = await validateCatalogImage(
      await readCatalogImageBytes(response, Number(item.size)),
      mime
    );
    if (checked.sha256 !== sha) throw new TeamFunctionError('IMAGE_CONTENT_INVALID');
    const plan = await catalogImageRpc(deps.service, 'service_catalog_global_alias_plan', {
      p_image: id
    });
    if (!Array.isArray(plan)) throw new TeamFunctionError('INVALID_RESPONSE');
    for (const raw of plan) {
      const a = catalogImageObject(raw),
        generation = Number(a.generation),
        keyVersion = Number(a.keyVersion ?? item.keyVersion);
      const key = deps.keys.get(keyVersion);
      if (!key) throw new TeamFunctionError('GLOBAL_IMAGE_READINESS_UNKNOWN');
      const token = await signGlobalImageAlias(
        {
          environment,
          imageId: id,
          generation,
          keyVersion,
          mime: mime as 'image/jpeg' | 'image/png'
        },
        key
      );
      const url =
        typeof a.url === 'string'
          ? a.url
          : `${origin}/g/${token}.${mime === 'image/jpeg' ? 'jpg' : 'png'}`;
      if (!url.startsWith(`${origin}/g/`))
        throw new TeamFunctionError('GLOBAL_IMAGE_POLICY_CONFLICT');
      const served = await fetcher(url, { signal: abort.signal, redirect: 'error' });
      if (
        served.status !== 200 ||
        served.headers.get('content-type')?.split(';')[0] !== mime ||
        served.headers.get('x-content-type-options') !== 'nosniff'
      ) {
        await served.body?.cancel();
        throw new TeamFunctionError('GLOBAL_IMAGE_READINESS_UNKNOWN');
      }
      const publicBytes = await readCatalogImageBytes(served, Number(item.size));
      if ((await validateCatalogImage(publicBytes, mime)).sha256 !== sha)
        throw new TeamFunctionError('IMAGE_CONTENT_INVALID');
      if (a.historical !== true)
        await rpc('alias', { imageId: id, generation, keyVersion, url, revision });
    }
    await rpc('probe', { imageId: id, sha256: sha, environment, revision, success: true });
  };
  try {
    // Health and ahead-alias maintenance must run even while a large/failed import queue exists.
    const candidates = await rpc('probe_candidates', { dueOnly: true });
    if (!Array.isArray(candidates)) throw new TeamFunctionError('INVALID_RESPONSE');
    for (const rawItem of candidates) {
      const item = catalogImageObject(rawItem);
      try {
        await probe(item);
      } catch {
        await rpc('probe', {
          imageId: item.id,
          sha256: item.sha256,
          environment: item.environment,
          revision: item.revision,
          success: false
        });
      }
    }
    const raw = await rpc('claim');
    if (raw === null) return { probed: candidates.length };
    claim = catalogImageObject(raw);
    const base = { entryId: claim.id, fence: claim.fence };
    stop = keepLease({
      renew: async () => {
        await rpc('renew', base);
        return true;
      },
      onLost: () => abort.abort(),
      since: Date.now()
    });
    const bytes = await deps.r2.readStaging(
      catalogImageString(claim.stagingKey),
      Number(claim.size),
      abort.signal
    );
    if (!bytes) throw new TeamFunctionError('IMAGE_LOCAL_SOURCE_REQUIRED');
    const optimized = await optimizeCatalogImage(
      bytes,
      catalogImageString(claim.mime),
      abort.signal
    );
    const candidate = catalogImageObject(
      await rpc('reserve', {
        ...base,
        sha256: optimized.image.sha256,
        mime: optimized.image.mime,
        size: optimized.image.size,
        width: optimized.image.width,
        height: optimized.image.height
      })
    );
    // Create-only PUT plus full authenticated and anonymous readback reconciles a lost PUT reply.
    if (candidate.ready !== true)
      await deps.r2.putFinal(
        catalogImageString(candidate.key),
        optimized.bytes,
        optimized.image.mime,
        abort.signal,
        optimized.image.sha256
      );
    await probe({
      ...candidate,
      ...claim,
      id: candidate.id,
      key: candidate.key,
      sha256: optimized.image.sha256,
      mime: optimized.image.mime,
      size: optimized.image.size
    });
    await rpc('finish', { ...base, success: true });
    return { imported: true };
  } catch (error) {
    const code = error instanceof TeamFunctionError ? error.code : 'IMAGE_WRITE_UNCERTAIN';
    if (claim)
      await rpc('finish', { entryId: claim.id, fence: claim.fence, success: false, code }).catch(
        () => undefined
      );
    return { outcome: 'unknown', code };
  } finally {
    await stop?.stop();
    clearTimeout(timer);
    release();
    if (claim)
      await catalogImageRpc(deps.service, 'service_catalog_global_kick', {}).catch(() => undefined);
  }
}
