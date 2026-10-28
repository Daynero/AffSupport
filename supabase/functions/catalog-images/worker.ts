// @deno-types="../../../packages/shared/dist/team/catalog-images.d.ts"
import {
  isCatalogImageClassification,
  type CatalogImageClassification
} from '../../../packages/shared/dist/team/catalog-images.js';
import {
  catalogImageId,
  catalogImageInteger,
  catalogImageObject,
  catalogImageRpc,
  catalogImageString,
  createCatalogImagePermit,
  type CatalogImageRpc
} from '../_shared/catalog-images.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import {
  readCatalogImageBytes,
  validateCatalogImage
} from '../_shared/catalog-image-validation.ts';
import type { CatalogImageR2 } from '../_shared/r2-catalog-images.ts';
import { optimizeCatalogImage } from '../_shared/catalog-image-optimization.ts';

const PERMIT = createCatalogImagePermit();

export interface CatalogDriveEnumeration {
  entries: Record<string, unknown>[];
  cursor: unknown[];
  complete: boolean;
  more: boolean;
}
export interface CatalogImageWorkerDeps {
  service: CatalogImageRpc;
  r2: CatalogImageR2;
  enabled: boolean;
  readDrive(
    source: Record<string, unknown>,
    actorId: string,
    teamId: string,
    signal: AbortSignal
  ): Promise<Uint8Array>;
  enumerateDrive(
    claim: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<CatalogDriveEnumeration>;
}

interface Candidate {
  id: string;
  key: string;
  fence: number;
  ready: boolean;
  sha256: string;
  size: number;
  mime: string;
}
function candidateOf(raw: unknown): Candidate {
  const value = catalogImageObject(raw);
  const sha256 = catalogImageString(value.sha256);
  if (!/^[0-9a-f]{64}$/u.test(sha256) || typeof value.ready !== 'boolean')
    throw new TeamFunctionError('INVALID_RESPONSE');
  return {
    id: catalogImageId(value.id),
    key: catalogImageString(value.key),
    fence: catalogImageInteger(value.fence),
    ready: value.ready,
    sha256,
    size: catalogImageInteger(value.size, 50_000_000),
    mime: catalogImageString(value.mime, 100)
  };
}

export async function runCatalogImageWorker(deps: CatalogImageWorkerDeps): Promise<unknown> {
  const release = PERMIT.acquire();
  if (!release) return { busy: true, retryAfterSeconds: 5 };
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), 60_000);
  const worker = `catalog-images:${crypto.randomUUID()}`;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let renewal: Promise<void> | null = null;
  let claim: Record<string, unknown> | null = null;
  let candidate: Candidate | null = null;
  let putUncertain = false;
  const rpc = (name: string, parameters: Record<string, unknown>) =>
    catalogImageRpc(deps.service, name, parameters);
  try {
    // Revocation/team deletion remains available when new imports are disabled.
    const purgeRaw = await rpc('service_catalog_image_purge_claim_v2', {});
    if (purgeRaw !== null) {
      const purge = catalogImageObject(purgeRaw);
      const id = catalogImageId(purge.id);
      const fence = catalogImageInteger(purge.fence);
      let success = false;
      try {
        if (purge.kind !== 'public' && purge.kind !== 'staging')
          throw new TeamFunctionError('INVALID_RESPONSE');
        await deps.r2.remove(purge.kind, catalogImageString(purge.key), abort.signal);
        success = true;
      } finally {
        await rpc('service_catalog_image_purge_finish_v2', {
          p_id: id,
          p_fence: fence,
          p_success: success
        });
      }
      return { purge: success ? 'observed_deleted' : 'unknown' };
    }
    if (!deps.enabled) return { disabled: true };
    const raw = await rpc('service_catalog_image_claim_v2', { p_worker: worker });
    if (raw === null) return { idle: true };
    claim = catalogImageObject(raw);
    const fence = catalogImageInteger(claim.fence);
    const jobId = catalogImageId(claim.jobId);
    if (claim.kind === 'enumerate') {
      try {
        const enumeration = await deps.enumerateDrive(claim, abort.signal);
        await rpc('service_catalog_image_enumeration_v2', {
          p_job: jobId,
          p_worker: worker,
          p_fence: fence,
          p_entries: enumeration.entries,
          p_cursor: enumeration.cursor,
          p_complete: enumeration.complete,
          p_more: enumeration.more
        });
        return {
          enumerated: enumeration.entries.length,
          complete: enumeration.complete,
          hasMore: enumeration.more
        };
      } catch (error) {
        const code = error instanceof TeamFunctionError ? error.code : 'IMAGE_PROVIDER_UNAVAILABLE';
        await rpc('service_catalog_image_enumeration_error_v2', {
          p_job: jobId,
          p_worker: worker,
          p_fence: fence,
          p_code: code
        });
        return { enumeration: 'failed', code };
      }
    }
    const entry = catalogImageId(claim.id);
    const actor = catalogImageId(claim.actorId);
    const team = catalogImageId(claim.teamId);
    if (!isCatalogImageClassification(claim.classification))
      throw new TeamFunctionError('INVALID_RESPONSE');
    const classification: CatalogImageClassification = claim.classification;
    const params = { p_entry: entry, p_worker: worker, p_fence: fence };
    const progress = async (stage: string) => {
      await rpc('service_catalog_image_progress_v2', { ...params, p_stage: stage });
    };
    heartbeat = setInterval(() => {
      if (renewal) return;
      renewal = rpc('service_catalog_image_renew_v2', params)
        .then(value => {
          if (value !== true) abort.abort();
        })
        .catch(() => abort.abort())
        .finally(() => {
          renewal = null;
        });
    }, 20_000);
    let bytes: Uint8Array;
    if (claim.state === 'awaiting_reconciliation') {
      candidate = candidateOf(await rpc('service_catalog_image_candidate_v2', params));
      const origin = await deps.r2.get('public', candidate.key, abort.signal);
      if (!origin) {
        await rpc('service_catalog_image_release_v2', {
          ...params,
          p_code: 'IMAGE_WRITE_UNCERTAIN',
          p_unknown: true
        });
        return { outcome: 'unknown' };
      }
      bytes = await readCatalogImageBytes(origin, candidate.size);
      const checked = await validateCatalogImage(bytes, candidate.mime);
      if (checked.sha256 !== candidate.sha256) throw new TeamFunctionError('IMAGE_CONTENT_INVALID');
    } else {
      await progress('validating');
      const source = catalogImageObject(claim.source);
      if (Object.keys(source).length)
        bytes = await deps.readDrive(source, actor, team, abort.signal);
      else {
        const staged = await deps.r2.readStaging(
          catalogImageString(claim.stagingKey),
          catalogImageInteger(claim.size, 50_000_000),
          abort.signal
        );
        if (!staged) {
          if (claim.state === 'waiting_source') {
            await rpc('service_catalog_image_release_v2', { ...params, p_wait: true });
            return { waiting: true };
          }
          throw new TeamFunctionError('IMAGE_SOURCE_UNAVAILABLE', { retryable: true });
        }
        bytes = staged;
      }
      await rpc('service_catalog_image_optimization_v2', { ...params, p_phase: 'started' });
      const optimized = await optimizeCatalogImage(
        bytes,
        typeof claim.mime === 'string' ? claim.mime : undefined,
        abort.signal
      );
      bytes = optimized.bytes;
      const image = optimized.image;
      await rpc('service_catalog_image_optimization_v2', { ...params, p_phase: 'completed' });
      await progress('deduplicating');
      const reserved = catalogImageObject(
        await rpc('service_catalog_image_reserve_v2', { ...params, p_image: image })
      );
      if (reserved.wait === true) {
        await rpc('service_catalog_image_release_v2', { ...params, p_wait: true });
        return { waiting: true };
      }
      candidate = candidateOf(reserved);
      if (!candidate.ready) {
        await progress('publishing');
        await rpc('service_catalog_image_publication_v2', {
          ...params,
          p_publication: candidate.id,
          p_publication_fence: candidate.fence,
          p_state: 'put_unknown'
        });
        putUncertain = true;
        await deps.r2.putFinal(
          candidate.key,
          bytes,
          candidate.mime,
          abort.signal,
          candidate.sha256
        );
        putUncertain = false;
        await rpc('service_catalog_image_publication_v2', {
          ...params,
          p_publication: candidate.id,
          p_publication_fence: candidate.fence,
          p_state: 'candidate'
        });
      }
    }
    if (!candidate.ready) {
      await progress('verifying_origin');
      await deps.r2.verify(candidate.key, bytes, candidate.mime, abort.signal, false);
      await rpc('service_catalog_image_publication_v2', {
        ...params,
        p_publication: candidate.id,
        p_publication_fence: candidate.fence,
        p_state: 'origin_verified'
      });
      await progress('verifying_public');
      await deps.r2.verify(candidate.key, bytes, candidate.mime, abort.signal, true);
      await rpc('service_catalog_image_publication_v2', {
        ...params,
        p_publication: candidate.id,
        p_publication_fence: candidate.fence,
        p_state: 'public_verified'
      });
    }
    await progress('committing');
    await rpc('service_catalog_image_commit_v2', {
      ...params,
      p_publication: candidate.id,
      p_publication_fence: candidate.fence,
      p_url: deps.r2.publicUrl(candidate.key)
    });
    return {
      outcome: candidate.ready ? 'reused' : 'ready',
      classificationMode: classification.mode
    };
  } catch (error) {
    const code = error instanceof TeamFunctionError ? error.code : 'IMAGE_PROVIDER_UNAVAILABLE';
    if (claim?.kind === 'file') {
      await rpc('service_catalog_image_release_v2', {
        p_entry: claim.id,
        p_worker: worker,
        p_fence: claim.fence,
        p_code: code,
        p_unknown:
          putUncertain ||
          code === 'IMAGE_WRITE_UNCERTAIN' ||
          claim.state === 'awaiting_reconciliation'
      }).catch(() => undefined);
    }
    return { outcome: putUncertain ? 'unknown' : 'failed', code };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    clearTimeout(deadline);
    abort.abort();
    if (renewal) await renewal;
    release();
    if (claim) await rpc('service_catalog_image_kick_v2', {}).catch(() => undefined);
  }
}
