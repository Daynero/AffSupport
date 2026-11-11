// @deno-types="../../../packages/shared/dist/team/catalog-video-r2.d.ts"
import {
  CATALOG_VIDEO_R2_LIMITS,
  isCatalogVideoR2PartVerification
} from '../../../packages/shared/dist/team/catalog-video-r2.js';
import {
  createCatalogVideoR2Permit,
  videoR2Id,
  videoR2Integer,
  videoR2Object,
  videoR2Rpc,
  videoR2String,
  type CatalogVideoR2Rpc
} from '../_shared/catalog-video-r2.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { Md5 } from '../_shared/md5.ts';
import {
  CATALOG_VIDEO_MIME,
  CATALOG_VIDEO_OBJECT_KEY,
  sha256Hex,
  type CatalogVideoR2
} from '../_shared/r2-catalog-video.ts';

const PERMIT = createCatalogVideoR2Permit();
/** Stop taking new parts this far before the invocation deadline. */
const PART_MARGIN_MS = 12_000;
const PROBE_BYTES = 64 * 1024;

export interface CatalogVideoDriveReader {
  fetchFileRange(input: {
    fileId: string;
    resourceKey?: string | null;
    start: number;
    end: number;
    signal?: AbortSignal;
  }): Promise<Response>;
}

export interface CatalogVideoR2WorkerDeps {
  service: CatalogVideoR2Rpc;
  r2: CatalogVideoR2;
  enabled: boolean;
  route: 'claim' | 'sweep';
  driveFor(credentialId: string, signal: AbortSignal): Promise<CatalogVideoDriveReader>;
  /** Overridable for tests; the real budget is the edge invocation limit. */
  budgetMs?: number;
  random?: () => number;
  now?: () => number;
}

interface Claim {
  copyId: string;
  teamId: string;
  fence: number;
  state: string;
  objectKey: string;
  sizeBytes: number;
  partBytes: number;
  sourceMd5: string | null;
  uploadId: string | null;
  fileId: string;
  resourceKey: string | null;
  credentialId: string;
  parts: Map<
    number,
    {
      sizeBytes: number;
      sha256: string;
      etag: string;
      verifiedBy: 'provider_checksum' | 'readback';
    }
  >;
}

function claimOf(raw: unknown): Claim {
  const value = videoR2Object(raw);
  const objectKey = videoR2String(value.objectKey, 64);
  if (!CATALOG_VIDEO_OBJECT_KEY.test(objectKey)) throw new TeamFunctionError('INVALID_RESPONSE');
  const parts = new Map<
    number,
    {
      sizeBytes: number;
      sha256: string;
      etag: string;
      verifiedBy: 'provider_checksum' | 'readback';
    }
  >();
  if (!Array.isArray(value.parts)) throw new TeamFunctionError('INVALID_RESPONSE');
  for (const raw of value.parts) {
    const part = videoR2Object(raw);
    const sha256 = videoR2String(part.sha256, 64);
    if (!/^[0-9a-f]{64}$/u.test(sha256) || !isCatalogVideoR2PartVerification(part.verifiedBy))
      throw new TeamFunctionError('INVALID_RESPONSE');
    parts.set(videoR2Integer(part.partNumber, CATALOG_VIDEO_R2_LIMITS.maxParts), {
      sizeBytes: videoR2Integer(part.sizeBytes, CATALOG_VIDEO_R2_LIMITS.maxPartBytes),
      sha256,
      etag: videoR2String(part.etag, 255),
      verifiedBy: part.verifiedBy
    });
  }
  const sourceMd5 = typeof value.sourceMd5 === 'string' ? value.sourceMd5 : null;
  if (sourceMd5 !== null && !/^[0-9a-f]{32}$/u.test(sourceMd5))
    throw new TeamFunctionError('INVALID_RESPONSE');
  return {
    copyId: videoR2Id(value.copyId),
    teamId: videoR2Id(value.teamId),
    fence: videoR2Integer(value.fence),
    state: videoR2String(value.state, 32),
    objectKey,
    sizeBytes: videoR2Integer(value.sizeBytes, CATALOG_VIDEO_R2_LIMITS.maxObjectBytes),
    partBytes: videoR2Integer(value.partBytes, CATALOG_VIDEO_R2_LIMITS.maxPartBytes),
    sourceMd5,
    uploadId:
      typeof value.uploadId === 'string' && value.uploadId.length > 0 ? value.uploadId : null,
    fileId: videoR2String(value.fileId, 256),
    resourceKey: typeof value.resourceKey === 'string' ? value.resourceKey : null,
    credentialId: videoR2Id(value.credentialId),
    parts
  };
}

/** Codes after which another attempt cannot succeed without a new plan. */
const TERMINAL = new Set([
  'SOURCE_CHANGED',
  'VIDEO_R2_CHECKSUM_MISMATCH',
  'VIDEO_R2_UNSUPPORTED_FORMAT',
  'VIDEO_R2_SOURCE_UNAVAILABLE',
  'TOO_LARGE',
  'PERMISSION_DENIED',
  'NOT_FOUND',
  'SHARE_NOT_ALLOWED',
  'INVALID_INPUT',
  'INVALID_RESPONSE'
]);

function failureCode(error: unknown, aborted: boolean): { code: string; terminal: boolean } {
  if (aborted) return { code: 'VIDEO_R2_TIMEOUT', terminal: false };
  if (error instanceof TeamFunctionError) {
    if (error.code === 'NOT_FOUND') return { code: 'VIDEO_R2_SOURCE_UNAVAILABLE', terminal: true };
    if (
      error.code === 'DRIVE_UNAVAILABLE' ||
      error.code === 'RATE_LIMITED' ||
      error.code === 'NEEDS_REAUTH'
    )
      return { code: 'VIDEO_R2_SOURCE_UNAVAILABLE', terminal: false };
    return { code: error.code, terminal: TERMINAL.has(error.code) };
  }
  return { code: 'VIDEO_R2_PROVIDER_UNAVAILABLE', terminal: false };
}

async function readRange(
  drive: CatalogVideoDriveReader,
  claim: Claim,
  start: number,
  end: number,
  signal: AbortSignal
): Promise<Uint8Array> {
  const response = await drive.fetchFileRange({
    fileId: claim.fileId,
    resourceKey: claim.resourceKey,
    start,
    end,
    signal
  });
  const expected = end - start + 1;
  if (
    response.status !== 206 &&
    !(
      response.status === 200 &&
      Number(response.headers.get('content-length')) === expected &&
      start === 0 &&
      expected === claim.sizeBytes
    )
  ) {
    await response.body?.cancel();
    if (response.status === 404 || response.status === 403)
      throw new TeamFunctionError('VIDEO_R2_SOURCE_UNAVAILABLE');
    if (response.status === 416) throw new TeamFunctionError('SOURCE_CHANGED');
    throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
  }
  const reader = response.body?.getReader();
  if (!reader) throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
  const out = new Uint8Array(expected);
  let offset = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (offset + part.value.byteLength > expected) throw new TeamFunctionError('SOURCE_CHANGED');
      out.set(part.value, offset);
      offset += part.value.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (offset !== expected) throw new TeamFunctionError('SOURCE_CHANGED');
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

export async function runCatalogVideoR2Worker(deps: CatalogVideoR2WorkerDeps): Promise<unknown> {
  const release = PERMIT.acquire();
  if (!release) return { busy: true, retryAfterSeconds: 5 };
  const abort = new AbortController();
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const budget = deps.budgetMs ?? CATALOG_VIDEO_R2_LIMITS.invocationBudgetMs;
  const deadline = setTimeout(() => abort.abort(), budget);
  const worker = `catalog-video-r2:${crypto.randomUUID()}`;
  const rpc = (name: string, parameters: Record<string, unknown>) =>
    videoR2Rpc(deps.service, name, parameters);
  try {
    if (deps.route === 'sweep') return await sweep(deps, rpc, worker, abort.signal);
    if (!deps.enabled) return { disabled: true };
    return await copyOne(deps, rpc, worker, abort, startedAt, budget, now);
  } finally {
    clearTimeout(deadline);
    abort.abort();
    release();
  }
}

async function copyOne(
  deps: CatalogVideoR2WorkerDeps,
  rpc: (name: string, parameters: Record<string, unknown>) => Promise<unknown>,
  worker: string,
  abort: AbortController,
  startedAt: number,
  budget: number,
  now: () => number
): Promise<unknown> {
  const raw = await rpc('service_catalog_video_r2_claim', { p_worker: worker });
  if (raw === null) return { idle: true };
  const claim = claimOf(raw);
  const params = { p_copy: claim.copyId, p_worker: worker, p_fence: claim.fence };
  let renewal: Promise<void> | null = null;
  const heartbeat = setInterval(() => {
    if (renewal) return;
    renewal = rpc('service_catalog_video_r2_renew', params)
      .then(value => {
        if (value !== true) abort.abort();
      })
      .catch(() => abort.abort())
      .finally(() => {
        renewal = null;
      });
  }, 20_000);
  const signal = abort.signal;
  const key = claim.objectKey;
  const totalParts = Math.ceil(claim.sizeBytes / claim.partBytes);
  let uploadId = claim.uploadId;
  let md5: Md5 | null = null;
  try {
    const drive = await deps.driveFor(claim.credentialId, signal);
    if (claim.state !== 'verifying') {
      // An unknown completion from a previous attempt: the staging object exists already.
      const staged =
        claim.parts.size === totalParts ? await deps.r2.headStaging(key, signal) : null;
      if (!staged) {
        if (!uploadId) {
          uploadId = await deps.r2.createMultipart(key, signal);
          await rpc('service_catalog_video_r2_begin_upload', { ...params, p_upload_id: uploadId });
        }
        md5 = claim.parts.size === 0 && claim.sourceMd5 ? new Md5() : null;
        for (let n = 1; n <= totalParts; n += 1) {
          if (claim.parts.has(n)) {
            md5 = null;
            continue;
          }
          if (now() - startedAt > budget - PART_MARGIN_MS) {
            await rpc('service_catalog_video_r2_yield', params);
            return { outcome: 'yielded', partsDone: claim.parts.size, totalParts };
          }
          const start = (n - 1) * claim.partBytes;
          const end = Math.min(claim.sizeBytes, n * claim.partBytes) - 1;
          const partStarted = now();
          const bytes = await readRange(drive, claim, start, end, signal);
          const sha256 = await sha256Hex(bytes);
          md5?.update(bytes);
          const uploaded = await deps.r2.uploadPart(key, uploadId, n, bytes, sha256, signal);
          const verifiedBy = uploaded.verifiedBy ?? 'readback';
          await rpc('service_catalog_video_r2_part', {
            ...params,
            p_part: n,
            p_size: bytes.byteLength,
            p_sha256: sha256,
            p_etag: uploaded.etag,
            p_verified_by: verifiedBy,
            p_duration_ms: now() - partStarted
          });
          claim.parts.set(n, {
            sizeBytes: bytes.byteLength,
            sha256,
            etag: uploaded.etag,
            verifiedBy
          });
        }
        if (uploadId)
          await deps.r2.completeMultipart(
            key,
            uploadId,
            [...claim.parts.entries()]
              .sort((a, b) => a[0] - b[0])
              .map(([partNumber, part]) => ({ partNumber, etag: part.etag })),
            signal
          );
      }
      await rpc('service_catalog_video_r2_verifying', params);
    }
    // Verification: size, every readback part, full MD5 when this invocation saw it all,
    // then the public copy: HEAD, headers and byte probes against Drive (FR-004).
    const staged = await deps.r2.headStaging(key, signal);
    if (!staged || staged.sizeBytes !== claim.sizeBytes)
      throw new TeamFunctionError('VIDEO_R2_CHECKSUM_MISMATCH');
    let offset = 0;
    for (let n = 1; n <= totalParts; n += 1) {
      const part = claim.parts.get(n);
      if (!part) throw new TeamFunctionError('VIDEO_R2_CHECKSUM_MISMATCH');
      if (part.verifiedBy === 'readback') {
        if (now() - startedAt > budget - PART_MARGIN_MS) {
          await rpc('service_catalog_video_r2_yield', params);
          return { outcome: 'yielded', stage: 'verifying', partsChecked: n - 1, totalParts };
        }
        const bytes = await deps.r2.readStagingRange(
          key,
          offset,
          offset + part.sizeBytes - 1,
          signal
        );
        if ((await sha256Hex(bytes)) !== part.sha256)
          throw new TeamFunctionError('VIDEO_R2_CHECKSUM_MISMATCH');
      }
      offset += part.sizeBytes;
    }
    if (offset !== claim.sizeBytes) throw new TeamFunctionError('VIDEO_R2_CHECKSUM_MISMATCH');
    let fullHashVerified = false;
    if (md5 && claim.sourceMd5) {
      if (md5.digest() !== claim.sourceMd5)
        throw new TeamFunctionError('VIDEO_R2_CHECKSUM_MISMATCH');
      fullHashVerified = true;
    }
    await deps.r2.promote(key, signal);
    const head = await deps.r2.publicHead(key, signal);
    if (
      head.sizeBytes !== claim.sizeBytes ||
      head.contentType !== CATALOG_VIDEO_MIME ||
      !head.nosniff ||
      !head.acceptRanges
    )
      throw new TeamFunctionError('VIDEO_R2_PUBLIC_UNREACHABLE', { retryable: true });
    const random = deps.random ?? Math.random;
    const probes = new Set<number>([0, Math.max(0, claim.sizeBytes - PROBE_BYTES)]);
    for (let i = 0; i < 2 && totalParts > 1; i += 1)
      probes.add(Math.floor(random() * (totalParts - 1) + 1) * claim.partBytes);
    for (const start of probes) {
      const end = Math.min(claim.sizeBytes, start + PROBE_BYTES) - 1;
      if (end < start) continue;
      const [ours, theirs] = await Promise.all([
        deps.r2.publicRange(key, start, end, signal),
        readRange(drive, claim, start, end, signal)
      ]);
      if (!sameBytes(ours, theirs)) throw new TeamFunctionError('VIDEO_R2_CHECKSUM_MISMATCH');
    }
    await deps.r2.removeStaging(key, signal).catch(() => undefined);
    await rpc('service_catalog_video_r2_ready', {
      ...params,
      p_full_hash_verified: fullHashVerified,
      p_duration_ms: now() - startedAt
    });
    return { outcome: 'ready', fullHashVerified, parts: totalParts };
  } catch (error) {
    const { code, terminal } = failureCode(error, abort.signal.aborted);
    if (terminal && uploadId)
      await deps.r2
        .abortMultipart(key, uploadId, AbortSignal.timeout(5_000))
        .catch(() => undefined);
    await rpc('service_catalog_video_r2_release', {
      ...params,
      p_code: code,
      p_terminal: terminal
    }).catch(() => undefined);
    return { outcome: terminal ? 'failed' : 'retry', code };
  } finally {
    clearInterval(heartbeat);
    if (renewal) await renewal;
  }
}

async function sweep(
  deps: CatalogVideoR2WorkerDeps,
  rpc: (name: string, parameters: Record<string, unknown>) => Promise<unknown>,
  worker: string,
  signal: AbortSignal
): Promise<unknown> {
  const summary = { retired: 0, deleted: 0, purged: 0, failed: 0 };
  summary.retired = Number(await rpc('service_catalog_video_r2_retire_orphans', {})) || 0;
  for (let i = 0; i < 5 && !signal.aborted; i += 1) {
    const raw = await rpc('service_catalog_video_r2_claim_retire', { p_worker: worker });
    if (raw === null) break;
    const retire = videoR2Object(raw);
    const copyId = videoR2Id(retire.copyId);
    const fence = videoR2Integer(retire.fence);
    const key = videoR2String(retire.objectKey, 64);
    try {
      await deps.r2.removePublic(key, signal);
      await deps.r2.removeStaging(key, signal).catch(() => undefined);
      await rpc('service_catalog_video_r2_mark_deleted', {
        p_copy: copyId,
        p_worker: worker,
        p_fence: fence,
        p_success: true,
        p_code: null
      });
      summary.deleted += 1;
    } catch (error) {
      const code = error instanceof TeamFunctionError ? error.code : 'VIDEO_R2_CLEANUP_PARTIAL';
      await rpc('service_catalog_video_r2_mark_deleted', {
        p_copy: copyId,
        p_worker: worker,
        p_fence: fence,
        p_success: false,
        p_code: code
      }).catch(() => undefined);
      summary.failed += 1;
    }
  }
  for (let i = 0; i < 5 && !signal.aborted; i += 1) {
    const raw = await rpc('service_catalog_video_r2_claim_purge', { p_worker: worker });
    if (raw === null) break;
    const purge = videoR2Object(raw);
    const id = videoR2Id(purge.id);
    const fence = videoR2Integer(purge.fence);
    const key = videoR2String(purge.objectKey, 64);
    try {
      if (typeof purge.uploadId === 'string' && purge.uploadId.length > 0)
        await deps.r2.abortMultipart(key, purge.uploadId, signal);
      await deps.r2.removeStaging(key, signal);
      await deps.r2.removePublic(key, signal);
      await rpc('service_catalog_video_r2_mark_purged', {
        p_id: id,
        p_fence: fence,
        p_success: true,
        p_code: null
      });
      summary.purged += 1;
    } catch (error) {
      const code = error instanceof TeamFunctionError ? error.code : 'VIDEO_R2_CLEANUP_PARTIAL';
      await rpc('service_catalog_video_r2_mark_purged', {
        p_id: id,
        p_fence: fence,
        p_success: false,
        p_code: code
      }).catch(() => undefined);
      summary.failed += 1;
    }
  }
  return summary;
}
