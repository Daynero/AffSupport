import { describe, expect, it, vi } from 'vitest';
import {
  runCatalogVideoR2Worker,
  type CatalogVideoR2WorkerDeps,
  type CatalogVideoDriveReader
} from '../supabase/functions/catalog-video-r2/worker';
import {
  CatalogVideoR2,
  sha256Hex,
  type CatalogVideoR2Config
} from '../supabase/functions/_shared/r2-catalog-video';
import { catalogPublicationSourceIdentity } from '../packages/shared/src/team/catalog-publication-source';
import { md5Hex } from '../supabase/functions/_shared/md5';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';

const COPY = '50000000-0000-4000-8000-000000000201';
const TEAM = '50000000-0000-4000-8000-000000000202';
const CREDENTIAL = '50000000-0000-4000-8000-000000000203';
const KEY = 'v/' + 'd'.repeat(32) + '.mp4';
const PART = 4096;
const config: CatalogVideoR2Config = {
  accountId: 'a'.repeat(32),
  stagingBucket: 'soty-catalog-videos-dev-staging',
  publicBucket: 'soty-catalog-videos-dev-public',
  publicOrigin: 'https://videos.test',
  zoneId: 'b'.repeat(32),
  purgeToken: 'token',
  partVerification: 'readback'
};
const signer = {
  async sign(request: Request) {
    return request;
  }
};
const video = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);

interface Store {
  staging: Uint8Array | null;
  publicBytes: Uint8Array | null;
  uploads: Map<string, Map<number, Uint8Array>>;
  nosniff: boolean;
  mutateDriveAfterParts?: number;
}

function fakeR2(store: Store, calls: string[]) {
  const fetcher: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    calls.push(`${request.method} ${url.host}${url.pathname}${url.search}`);
    if (url.host === 'api.cloudflare.com')
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    if (url.host === 'videos.test') {
      if (!store.publicBytes) return new Response(null, { status: 404 });
      const range = request.headers.get('range');
      if (range) {
        const [, s, e] = /^bytes=(\d+)-(\d+)$/u.exec(range)!;
        return new Response(new Uint8Array(store.publicBytes.slice(Number(s), Number(e) + 1)), {
          status: 206
        });
      }
      return new Response(null, {
        status: 200,
        headers: {
          'content-length': String(store.publicBytes.byteLength),
          'content-type': 'video/mp4',
          ...(store.nosniff ? { 'x-content-type-options': 'nosniff' } : {}),
          'accept-ranges': 'bytes'
        }
      });
    }
    const isPublic = url.pathname.includes('-public/');
    if (request.method === 'POST' && url.searchParams.has('uploads')) {
      const id = `upload-${store.uploads.size + 1}`;
      store.uploads.set(id, new Map());
      return new Response(`<x><UploadId>${id}</UploadId></x>`, { status: 200 });
    }
    if (request.method === 'PUT' && url.searchParams.has('uploadId')) {
      const parts = store.uploads.get(url.searchParams.get('uploadId')!);
      if (!parts) return new Response(null, { status: 404 });
      parts.set(
        Number(url.searchParams.get('partNumber')),
        new Uint8Array(await request.arrayBuffer())
      );
      return new Response(null, {
        status: 200,
        headers: { etag: `"e${url.searchParams.get('partNumber')}"` }
      });
    }
    if (request.method === 'POST' && url.searchParams.has('uploadId')) {
      const parts = store.uploads.get(url.searchParams.get('uploadId')!);
      if (!parts) return new Response(null, { status: 404 });
      const ordered = [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
      const joined = new Uint8Array(ordered.reduce((n, b) => n + b.byteLength, 0));
      let offset = 0;
      for (const b of ordered) {
        joined.set(b, offset);
        offset += b.byteLength;
      }
      store.staging = joined;
      store.uploads.delete(url.searchParams.get('uploadId')!);
      return new Response('<x><ETag>"f"</ETag></x>', { status: 200 });
    }
    if (request.method === 'DELETE' && url.searchParams.has('uploadId'))
      return new Response(null, {
        status: store.uploads.delete(url.searchParams.get('uploadId')!) ? 204 : 404
      });
    if (request.method === 'PUT' && request.headers.has('x-amz-copy-source')) {
      if (!store.staging) return new Response(null, { status: 404 });
      if (request.headers.get('x-amz-copy-source-if-match') !== '"' + md5Hex(store.staging) + '"')
        return new Response(null, { status: 412 });
      store.publicBytes = store.staging;
      return new Response('<x><ETag>"c"</ETag></x>', { status: 200 });
    }
    const bytes = isPublic ? store.publicBytes : store.staging;
    if (request.method === 'HEAD')
      return bytes
        ? new Response(null, {
            status: 200,
            headers: { 'content-length': String(bytes.byteLength), etag: '"' + md5Hex(bytes) + '"' }
          })
        : new Response(null, { status: 404 });
    if (request.method === 'GET') {
      if (!bytes) return new Response(null, { status: 404 });
      const [, s, e] = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.get('range')!)!;
      if (request.headers.get('if-match') !== '"' + md5Hex(bytes) + '"')
        return new Response(null, { status: 412 });
      return new Response(new Uint8Array(bytes.slice(Number(s), Number(e) + 1)), {
        status: 206,
        headers: {
          'content-range': `bytes ${s}-${e}/${bytes.length}`,
          etag: '"' + md5Hex(bytes) + '"'
        }
      });
    }
    if (request.method === 'DELETE') {
      if (isPublic) store.publicBytes = null;
      else store.staging = null;
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 500 });
  };
  return new CatalogVideoR2(config, signer, fetcher);
}

interface ProofMemory {
  value?: Record<string, unknown>;
  etag?: string;
  cleanup?: boolean;
}

function harness(
  options: {
    size?: number;
    proofMemory?: ProofMemory;
    sourceMd5?: 'match' | 'mismatch' | null;
    parts?: Array<{
      partNumber: number;
      sizeBytes: number;
      sha256: string;
      etag: string;
      verifiedBy: 'readback' | 'provider_checksum';
    }>;
    state?: string;
    uploadId?: string | null;
    budgetMs?: number;
    msPerRead?: number;
    nosniff?: boolean;
    driveChanges?: number;
    driveRange?: (start: number, end: number, size: number) => string | null;
    route?: 'claim' | 'sweep';
    retire?: unknown[];
    purges?: unknown[];
    claimNull?: boolean;
    /** 073: a real movie layout instead of the patterned bytes. */
    source?: Uint8Array;
  } = {}
) {
  const size = options.source?.length ?? options.size ?? PART * 3 + 100;
  const source = options.source ?? video(size);
  const memory = options.proofMemory ?? {};
  const store: Store = {
    staging: null,
    publicBytes: null,
    uploads: new Map(),
    nosniff: options.nosniff ?? true
  };
  const calls: string[] = [];
  const r2 = fakeR2(store, calls);
  const trace: Array<[string, Record<string, unknown>]> = [];
  let driveReads = 0;
  const retire = [...(options.retire ?? [])];
  const purges = [...(options.purges ?? [])];
  const rpc = vi.fn(async (name: string, params: Record<string, unknown>) => {
    trace.push([name, params]);
    const ok = (data: unknown) => ({ data, error: null });
    switch (name) {
      case 'service_catalog_video_r2_claim':
        if (options.claimNull) return ok(null);
        return ok({
          copyId: COPY,
          teamId: TEAM,
          fence: 3,
          state: options.state ?? 'planned',
          objectKey: KEY,
          sizeBytes: size,
          mime: 'video/mp4',
          partBytes: PART,
          sourceMd5:
            options.sourceMd5 === undefined || options.sourceMd5 === 'match'
              ? md5Hex(source)
              : options.sourceMd5 === 'mismatch'
                ? 'f'.repeat(32)
                : null,
          uploadId: options.uploadId ?? null,
          sourceVersion: await catalogPublicationSourceIdentity(
            {
              materialId: TEAM,
              connectionId: TEAM,
              fileId: 'file-1',
              checksum: null,
              mimeType: 'video/mp4',
              sizeBytes: size,
              driveVersion: '1'
            },
            true
          ),
          attempts: 1,
          catalogMaterialId: null,
          sourceMaterialId: TEAM,
          connectionId: TEAM,
          credentialId: CREDENTIAL,
          rootFolderId: 'root',
          fileId: 'file-1',
          resourceKey: null,
          publicOrigin: 'https://videos.test',
          parts: options.parts ?? []
        });
      case 'service_catalog_video_r2_verification_open':
        memory.etag ??= String(params.p_etag);
        memory.value ??= { partsChecked: 0, bytesChecked: 0, hashState: null, finalMd5: null };
        return ok(structuredClone(memory.value));
      case 'service_catalog_video_r2_verification_advance':
        if (memory.value?.partsChecked !== params.p_previous_parts)
          return { data: null, error: { message: 'LEASE_MISMATCH' } };
        memory.value = {
          partsChecked: Number(params.p_previous_parts) + 1,
          bytesChecked: (params.p_hash_state as { bytes: number }).bytes,
          hashState: structuredClone(params.p_hash_state),
          finalMd5: params.p_final_md5
        };
        return ok(null);
      case 'service_catalog_video_r2_ready':
        memory.cleanup = true;
        return ok(null);
      case 'service_catalog_video_r2_claim_staging_cleanup':
        return ok(
          memory.cleanup ? { copyId: COPY, objectKey: KEY, fence: 1, etag: memory.etag } : null
        );
      case 'service_catalog_video_r2_finish_staging_cleanup':
        if (params.p_success) memory.cleanup = false;
        return ok(null);
      case 'service_catalog_video_r2_renew':
        return ok(true);
      case 'service_catalog_video_r2_retire_orphans':
        return ok(0);
      case 'service_catalog_video_r2_claim_retire':
        return ok(retire.shift() ?? null);
      case 'service_catalog_video_r2_claim_purge':
        return ok(purges.shift() ?? null);
      default:
        return ok(null);
    }
  });
  const driveFor = vi.fn(async () => ({
    async getFile(): ReturnType<CatalogVideoDriveReader['getFile']> {
      return {
        id: 'file-1',
        checksum: md5Hex(source),
        mimeType: 'video/mp4',
        size,
        version: '1',
        trashed: false
      };
    },
    async fetchFileRange(input: { start: number; end: number }) {
      driveReads += 1;
      advance(options.msPerRead ?? 0);
      if (options.driveChanges && driveReads > options.driveChanges)
        return new Response(null, { status: 416 });
      const range = options.driveRange
        ? options.driveRange(input.start, input.end, size)
        : `bytes ${input.start}-${input.end}/${size}`;
      return new Response(new Uint8Array(source.slice(input.start, input.end + 1)), {
        status: 206,
        headers: range === null ? {} : { 'content-range': range }
      });
    }
  }));
  let clock = 0;
  const deps: CatalogVideoR2WorkerDeps = {
    service: { rpc },
    r2,
    enabled: true,
    route: options.route ?? 'claim',
    driveFor,
    budgetMs: options.budgetMs ?? 60_000,
    random: () => 0.5,
    now: () => clock
  };
  const advance = (ms: number) => {
    clock += ms;
  };
  return {
    deps,
    rpc,
    trace,
    store,
    calls,
    source,
    driveFor,
    advance,
    names: () => trace.map(([name]) => name.replace('service_catalog_video_r2_', ''))
  };
}

describe('catalog video R2 worker', () => {
  it.each(['missing', 'shifted', 'resized', 'unknown-total'] as const)(
    'refuses a %s Drive range before uploading or publishing its bytes',
    async kind => {
      const h = harness({
        sourceMd5: null,
        driveRange: (start, end, size) => {
          if (kind === 'missing') return null;
          if (kind === 'shifted') return `bytes ${start + 1}-${end + 1}/${size}`;
          if (kind === 'resized') return `bytes ${start}-${end}/${size + 1}`;
          return `bytes ${start}-${end}/*`;
        }
      });
      expect(await runCatalogVideoR2Worker(h.deps)).toEqual({
        outcome: 'failed',
        code: 'SOURCE_CHANGED'
      });
      expect(h.names()).not.toContain('part');
      expect(h.names()).not.toContain('ready');
      expect(h.store.publicBytes).toBeNull();
      expect(h.trace.at(-1)![1]).toMatchObject({ p_code: 'SOURCE_CHANGED', p_terminal: true });
    }
  );

  it('copies a video in parts, verifies it, promotes it and marks it ready with the full hash', async () => {
    const h = harness({ sourceMd5: 'match' });
    const result = await runCatalogVideoR2Worker(h.deps);
    expect(result).toEqual({ outcome: 'ready', fullHashVerified: true, parts: 4 });
    expect(h.names()).toEqual([
      'claim',
      'begin_upload',
      'part',
      'part',
      'part',
      'part',
      'verifying',
      'verification_open',
      ...Array(4).fill('verification_advance'),
      'ready',
      'claim_staging_cleanup',
      'finish_staging_cleanup'
    ]);
    const partCalls = h.trace
      .filter(([name]) => name === 'service_catalog_video_r2_part')
      .map(([, p]) => p);
    expect(partCalls.map(p => p.p_part)).toEqual([1, 2, 3, 4]);
    expect(
      partCalls.every(p => p.p_verified_by === 'readback' && typeof p.p_sha256 === 'string')
    ).toBe(true);
    expect(partCalls[3]!.p_size).toBe(100);
    expect(partCalls[0]!.p_sha256).toBe(await sha256Hex(h.source.subarray(0, PART)));
    expect(h.trace.find(([name]) => name === 'service_catalog_video_r2_ready')![1]).toMatchObject({
      p_full_hash_verified: true,
      p_fence: 3,
      p_worker: expect.stringMatching(/^catalog-video-r2:/u)
    });
    expect(
      h.store.publicBytes && Buffer.from(h.store.publicBytes).equals(Buffer.from(h.source))
    ).toBe(true);
    expect(h.store.staging).toBeNull();
    expect(h.calls.filter(c => c.startsWith('GET videos.test')).length).toBeGreaterThanOrEqual(2);
  });

  it('yields before the budget ends and resumes from the next part without re-hashing the whole file', async () => {
    const first = harness({ budgetMs: 12_050, sourceMd5: 'match', msPerRead: 5_000 });
    const yielded = await runCatalogVideoR2Worker(first.deps);
    expect(yielded).toMatchObject({ outcome: 'yielded' });
    expect(first.names().at(-1)).toBe('yield');
    const done = first.trace
      .filter(([name]) => name === 'service_catalog_video_r2_part')
      .map(([, p]) => ({
        partNumber: p.p_part as number,
        sizeBytes: p.p_size as number,
        sha256: p.p_sha256 as string,
        etag: p.p_etag as string,
        verifiedBy: 'readback' as const
      }));
    expect(done.length).toBeLessThan(4);
    const uploadId = first.trace.find(
      ([name]) => name === 'service_catalog_video_r2_begin_upload'
    )![1].p_upload_id as string;
    const second = harness({ sourceMd5: 'match', state: 'uploading', uploadId, parts: done });
    second.store.uploads = first.store.uploads;
    const result = await runCatalogVideoR2Worker(second.deps);
    expect(result).toEqual({ outcome: 'ready', fullHashVerified: true, parts: 4 });
    const parts = second.trace
      .filter(([name]) => name === 'service_catalog_video_r2_part')
      .map(([, p]) => p.p_part);
    expect(parts).toEqual([1, 2, 3, 4].filter(n => !done.some(d => d.partNumber === n)));
    expect(second.names()).not.toContain('begin_upload');
  });

  it('fails terminally and aborts the upload when the source changes mid-copy', async () => {
    const h = harness({ driveChanges: 2 });
    const result = await runCatalogVideoR2Worker(h.deps);
    expect(result).toEqual({ outcome: 'failed', code: 'SOURCE_CHANGED' });
    expect(h.trace.at(-1)).toEqual([
      'service_catalog_video_r2_release',
      expect.objectContaining({ p_code: 'SOURCE_CHANGED', p_terminal: true })
    ]);
    expect(h.store.uploads.size).toBe(0);
  });

  it('refuses a copy whose bytes do not read back and one the public origin serves wrongly', async () => {
    const tampered = harness();
    const origPromote = tampered.deps.r2.promote.bind(tampered.deps.r2);
    const stagingTamper = tampered.deps.r2.headStaging.bind(tampered.deps.r2);
    vi.spyOn(tampered.deps.r2, 'headStaging').mockImplementation(async (key, signal) => {
      if (tampered.store.staging) tampered.store.staging[10] ^= 0xff;
      return stagingTamper(key, signal);
    });
    expect(await runCatalogVideoR2Worker(tampered.deps)).toEqual({
      outcome: 'failed',
      code: 'VIDEO_R2_CHECKSUM_MISMATCH'
    });
    expect(origPromote).toBeDefined();
    const unsniffed = harness({ nosniff: false });
    expect(await runCatalogVideoR2Worker(unsniffed.deps)).toEqual({
      outcome: 'retry',
      code: 'VIDEO_R2_PUBLIC_UNREACHABLE'
    });
    expect(unsniffed.trace.at(-1)).toEqual([
      'service_catalog_video_r2_release',
      expect.objectContaining({ p_terminal: false })
    ]);
    const badHash = harness({ sourceMd5: 'mismatch' });
    expect(await runCatalogVideoR2Worker(badHash.deps)).toEqual({
      outcome: 'failed',
      code: 'VIDEO_R2_CHECKSUM_MISMATCH'
    });
  });

  it('reconciles an unknown completion by reading the staging object instead of uploading again', async () => {
    const h = harness({ state: 'uploading', uploadId: 'gone', parts: [] });
    const source = h.source;
    const parts = [] as Array<{
      partNumber: number;
      sizeBytes: number;
      sha256: string;
      etag: string;
      verifiedBy: 'readback';
    }>;
    for (let n = 1; n <= 4; n += 1) {
      const slice = source.subarray((n - 1) * PART, Math.min(source.byteLength, n * PART));
      parts.push({
        partNumber: n,
        sizeBytes: slice.byteLength,
        sha256: await sha256Hex(slice),
        etag: `"e${n}"`,
        verifiedBy: 'readback'
      });
    }
    const resumed = harness({ state: 'uploading', uploadId: 'gone', parts });
    resumed.store.staging = source;
    expect(await runCatalogVideoR2Worker(resumed.deps)).toEqual({
      outcome: 'ready',
      fullHashVerified: true,
      parts: 4
    });
    expect(resumed.names()).toEqual([
      'claim',
      'verifying',
      'verification_open',
      ...Array(4).fill('verification_advance'),
      'ready',
      'claim_staging_cleanup',
      'finish_staging_cleanup'
    ]);
    expect(resumed.calls.some(c => c.includes('partNumber='))).toBe(false);
  });

  it('is idle without work and disabled without the runtime gate', async () => {
    const idle = harness({ claimNull: true });
    expect(await runCatalogVideoR2Worker(idle.deps)).toEqual({ idle: true });
    const off = harness();
    expect(await runCatalogVideoR2Worker({ ...off.deps, enabled: false })).toEqual({
      disabled: true
    });
    expect(off.rpc).not.toHaveBeenCalled();
  });

  it('sweeps: deletes retired objects with a purge and clears tombstones including orphaned uploads', async () => {
    const h = harness({
      route: 'sweep',
      retire: [
        {
          copyId: COPY,
          teamId: TEAM,
          fence: 9,
          objectKey: KEY,
          publicOrigin: 'https://videos.test',
          reason: 'replaced'
        }
      ],
      purges: [
        {
          id: '50000000-0000-4000-8000-000000000301',
          fence: 2,
          objectKey: 'v/' + 'e'.repeat(32) + '.mp4',
          uploadId: 'orphan',
          reason: 'failed_upload',
          publicOrigin: 'https://videos.test',
          teamRef: TEAM,
          copyRef: null
        }
      ]
    });
    h.store.publicBytes = video(10);
    h.store.uploads.set('orphan', new Map());
    expect(await runCatalogVideoR2Worker(h.deps)).toEqual({
      retired: 0,
      deleted: 1,
      purged: 1,
      failed: 0
    });
    expect(h.store.publicBytes).toBeNull();
    expect(h.store.uploads.size).toBe(0);
    expect(h.names()).toEqual([
      'claim_staging_cleanup',
      'retire_orphans',
      'claim_retire',
      'mark_deleted',
      'claim_retire',
      'claim_purge',
      'mark_purged',
      'claim_purge'
    ]);
    expect(
      h.trace.find(([name]) => name === 'service_catalog_video_r2_mark_deleted')![1]
    ).toMatchObject({ p_success: true, p_fence: 9 });
    expect(h.calls.filter(c => c.includes('purge_cache'))).toHaveLength(2);
  });

  it('keeps provider errors as codes and never records a part the storage did not acknowledge', async () => {
    const h = harness();
    vi.spyOn(h.deps.r2, 'uploadPart').mockRejectedValueOnce(
      new TeamFunctionError('VIDEO_R2_UPLOAD_UNKNOWN', { retryable: true })
    );
    expect(await runCatalogVideoR2Worker(h.deps)).toEqual({
      outcome: 'retry',
      code: 'VIDEO_R2_UPLOAD_UNKNOWN'
    });
    expect(h.names()).toEqual(['claim', 'begin_upload', 'release']);
  });
});

/** ftyp, two parts of media, then a `moov` whose user data names a place (073). */
function placeTaggedMovie(): { movie: Uint8Array; tagAt: number } {
  const box = (type: string, payload: Uint8Array) => {
    const out = new Uint8Array(8 + payload.length);
    new DataView(out.buffer).setUint32(0, out.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(payload, 8);
    return out;
  };
  const ftyp = box('ftyp', new TextEncoder().encode('isom\0\0\u0002\0isom'));
  const mdat = box('mdat', video(PART * 2));
  const udta = box('udta', new TextEncoder().encode('\u00a9xyz+50.4501+030.5234/ GPS'));
  const moov = box('moov', udta);
  const movie = new Uint8Array(ftyp.length + mdat.length + moov.length);
  movie.set(ftyp, 0);
  movie.set(mdat, ftyp.length);
  movie.set(moov, ftyp.length + mdat.length);
  return { movie, tagAt: ftyp.length + mdat.length + 8 };
}

describe('catalog video R2 copies carry no metadata (073)', () => {
  it('blanks the movie’s user data in the public copy and still proves the Drive source', async () => {
    const { movie, tagAt } = placeTaggedMovie();
    const h = harness({ source: movie, sourceMd5: 'match' });
    expect(await runCatalogVideoR2Worker(h.deps)).toMatchObject({
      outcome: 'ready',
      fullHashVerified: true
    });
    const published = Buffer.from(h.store.publicBytes!);
    expect(published.length).toBe(movie.length);
    expect(published.includes(Buffer.from('50.4501'))).toBe(false);
    expect(published.subarray(tagAt + 4, tagAt + 8).toString('latin1')).toBe('free');
    // Everything before the user data is the source byte for byte.
    expect(published.subarray(0, tagAt).equals(Buffer.from(movie.subarray(0, tagAt)))).toBe(true);
  });

  it('still verifies a copy whose parts were uploaded raw before 073', async () => {
    const { movie } = placeTaggedMovie();
    const parts = [];
    for (let n = 1; n * PART - PART < movie.length; n++) {
      const bytes = movie.slice((n - 1) * PART, n * PART);
      parts.push({
        partNumber: n,
        sizeBytes: bytes.length,
        sha256: await sha256Hex(bytes),
        etag: `"e${n}"`,
        verifiedBy: 'readback' as const
      });
    }
    const h = harness({ source: movie, state: 'verifying', parts });
    h.store.staging = movie;
    expect(await runCatalogVideoR2Worker(h.deps)).toMatchObject({ outcome: 'ready' });
  });

  it('refuses a staged part that is neither the source nor its planned blank', async () => {
    const { movie, tagAt } = placeTaggedMovie();
    const tampered = movie.slice();
    tampered[tagAt + 12] = 0x21;
    const parts = [];
    for (let n = 1; n * PART - PART < tampered.length; n++) {
      const bytes = tampered.slice((n - 1) * PART, n * PART);
      parts.push({
        partNumber: n,
        sizeBytes: bytes.length,
        sha256: await sha256Hex(bytes),
        etag: `"e${n}"`,
        verifiedBy: 'readback' as const
      });
    }
    const h = harness({ source: movie, state: 'verifying', parts });
    h.store.staging = tampered;
    expect(await runCatalogVideoR2Worker(h.deps)).toMatchObject({
      outcome: 'failed',
      code: 'VIDEO_R2_CHECKSUM_MISMATCH'
    });
  });
});

describe('catalog video ready acknowledgement recovery', () => {
  it.each(['before-commit', 'after-commit'] as const)(
    'retains staging when the ready acknowledgement is lost %s',
    async failure => {
      const h = harness({ sourceMd5: 'match' });
      const original = h.rpc.getMockImplementation()!;
      let committed = false;
      h.rpc.mockImplementation(async (name, params) => {
        if (name !== 'service_catalog_video_r2_ready') return original(name, params);
        if (failure === 'after-commit') {
          await original(name, params);
          committed = true;
        }
        throw new TypeError('lost database response');
      });
      expect(await runCatalogVideoR2Worker(h.deps)).toEqual({
        outcome: 'retry',
        code: 'VIDEO_R2_PROVIDER_UNAVAILABLE'
      });
      expect(committed).toBe(failure === 'after-commit');
      expect(h.store.publicBytes).toEqual(h.source);
      expect(h.store.staging).toEqual(h.source);
      expect(h.trace.at(-1)![1]).toMatchObject({
        p_code: 'VIDEO_R2_PROVIDER_UNAVAILABLE',
        p_terminal: false
      });
      // An acknowledged commit in our fault model leaves no eligible new claim.
      if (!committed) {
        const parts = h.trace
          .filter(([name]) => name === 'service_catalog_video_r2_part')
          .map(([, p]) => ({
            partNumber: Number(p.p_part),
            sizeBytes: Number(p.p_size),
            sha256: String(p.p_sha256),
            etag: String(p.p_etag),
            verifiedBy: 'readback' as const
          }));
        const retry = harness({ state: 'verifying', sourceMd5: 'match', parts });
        retry.store.staging = h.store.staging;
        retry.store.publicBytes = h.store.publicBytes;
        expect(await runCatalogVideoR2Worker(retry.deps)).toMatchObject({ outcome: 'ready' });
        expect(retry.calls.some(call => call.includes('partNumber='))).toBe(false);
        expect(retry.store.staging).toBeNull();
      }
    }
  );

  it('cleans staging after acknowledged ready and keeps a cleanup outage from undoing success', async () => {
    const h = harness();
    let readyBeforeCleanup = false;
    vi.spyOn(h.deps.r2, 'removeStaging').mockImplementation(async () => {
      readyBeforeCleanup = h.names().includes('ready');
      throw new TypeError('cleanup connection lost');
    });
    expect(await runCatalogVideoR2Worker(h.deps)).toMatchObject({ outcome: 'ready' });
    expect(readyBeforeCleanup).toBe(true);
    expect(h.store.staging).toEqual(h.source);
    expect(h.names()).not.toContain('release');
  });
});

// Reproductions from the server audit, now exercising durable verification.
describe('catalog video resumable integrity acceptance', () => {
  it.each(['before', 'after'] as const)(
    'reconciles a lost checkpoint reply %s commit without skipping or double hashing',
    async when => {
      const memory: ProofMemory = {};
      const h = harness({ proofMemory: memory });
      const rpc = h.rpc.getMockImplementation()!;
      let lost = false;
      h.rpc.mockImplementation(async (name, params) => {
        if (name === 'service_catalog_video_r2_verification_advance' && !lost) {
          lost = true;
          if (when === 'after') await rpc(name, params);
          throw new TypeError('reply lost');
        }
        const result = await rpc(name, params);
        if (
          name === 'service_catalog_video_r2_verification_open' &&
          result.data &&
          typeof result.data === 'object'
        ) {
          const row = result.data as Record<string, unknown>;
          if (row.hashState)
            row.hashState = Object.fromEntries(Object.entries(row.hashState).reverse());
        }
        return result;
      });
      const result = await runCatalogVideoR2Worker(h.deps);
      expect(result).toMatchObject({ outcome: when === 'after' ? 'ready' : 'retry' });
      if (when === 'before') {
        expect(memory.value?.partsChecked).toBe(0);
        expect(h.store.publicBytes).toBeNull();
      } else expect(memory.value?.finalMd5).toBe(md5Hex(h.source));
    }
  );

  it('completes a staged copy even when Drive disappears before final verification', async () => {
    const first = harness({ budgetMs: 12050, msPerRead: 20 });
    await runCatalogVideoR2Worker(first.deps);
    // Finish the upload in another invocation, then interrupt before verification.
    const parts = first.trace
      .filter(([name]) => name.endsWith('_part'))
      .map(([, p]) => ({
        partNumber: Number(p.p_part),
        sizeBytes: Number(p.p_size),
        sha256: String(p.p_sha256),
        etag: String(p.p_etag),
        verifiedBy: 'readback' as const
      }));
    // Use a complete independently staged fixture, with the frozen original checksum.
    const source = first.source;
    for (let n = parts.length + 1; n <= 4; n++) {
      const b = source.slice((n - 1) * PART, n * PART);
      parts.push({
        partNumber: n,
        sizeBytes: b.length,
        sha256: await sha256Hex(b),
        etag: `"e${n}"`,
        verifiedBy: 'readback'
      });
    }
    const h = harness({ state: 'verifying', parts });
    h.store.staging = source;
    h.driveFor.mockRejectedValue(new Error('source removed'));
    expect(await runCatalogVideoR2Worker(h.deps)).toMatchObject({
      outcome: 'ready',
      fullHashVerified: true
    });
    expect(h.driveFor).not.toHaveBeenCalled();
  });

  it.each(['checksum', 'revision', 'trashed'] as const)(
    'refuses an unverifiable fallback source: %s',
    async missing => {
      const h = harness({ sourceMd5: null });
      const drive = await h.driveFor();
      const metadata = await drive.getFile();
      h.driveFor.mockResolvedValue({
        ...drive,
        getFile: async () => ({
          ...metadata,
          ...(missing === 'checksum'
            ? { checksum: null }
            : missing === 'revision'
              ? { version: '2' }
              : { trashed: true })
        })
      });
      expect(await runCatalogVideoR2Worker(h.deps)).toMatchObject({
        outcome: 'failed',
        code: missing === 'checksum' ? 'VIDEO_R2_SOURCE_UNAVAILABLE' : 'SOURCE_CHANGED'
      });
      expect(h.names()).not.toContain('begin_upload');
      expect(h.names()).not.toContain('ready');
    }
  );

  it('rejects a changed staging entity between proof and promotion', async () => {
    const h = harness();
    const promote = h.deps.r2.promote.bind(h.deps.r2);
    vi.spyOn(h.deps.r2, 'promote').mockImplementation(async (...args) => {
      h.store.staging![0] ^= 1;
      return promote(...args);
    });
    expect(await runCatalogVideoR2Worker(h.deps)).toMatchObject({
      outcome: 'failed',
      code: 'VIDEO_R2_CHECKSUM_MISMATCH'
    });
    expect(h.store.publicBytes).toBeNull();
    expect(h.names()).not.toContain('ready');
  });

  it('sweeps retained staging after an unknown ready acknowledgement without touching public bytes', async () => {
    const memory: ProofMemory = {};
    const h = harness({ proofMemory: memory });
    const rpc = h.rpc.getMockImplementation()!;
    h.rpc.mockImplementation(async (name, params) => {
      const result = await rpc(name, params);
      if (name === 'service_catalog_video_r2_ready') throw new Error('reply lost');
      return result;
    });
    expect(await runCatalogVideoR2Worker(h.deps)).toMatchObject({ outcome: 'retry' });
    const sweeper = harness({ route: 'sweep', proofMemory: memory });
    sweeper.store.staging = h.store.staging;
    sweeper.store.publicBytes = h.store.publicBytes;
    await runCatalogVideoR2Worker(sweeper.deps);
    expect(sweeper.store.staging).toBeNull();
    expect(sweeper.store.publicBytes).toEqual(h.source);
    expect(sweeper.calls.some(call => call.startsWith('DELETE') && call.includes('-public/'))).toBe(
      false
    );
    expect(memory.cleanup).toBe(false);
  });
  it('refuses a same-size source replacement across a resumed upload', async () => {
    const size = 256 * 1024;
    const original = video(size);
    const parts = [];
    const uploaded = new Map<number, Uint8Array>();
    for (let n = 1; n <= 24; n++) {
      const bytes = original.slice((n - 1) * PART, n * PART);
      uploaded.set(n, bytes);
      parts.push({
        partNumber: n,
        sizeBytes: PART,
        sha256: await sha256Hex(bytes),
        etag: `"e${n}"`,
        verifiedBy: 'readback' as const
      });
    }
    const h = harness({
      size,
      sourceMd5: 'match',
      state: 'uploading',
      uploadId: 'existing',
      parts
    });
    h.store.uploads.set('existing', uploaded);
    const rpc = h.rpc.getMockImplementation()!;
    h.rpc.mockImplementation(async (name, params) => {
      const result = await rpc(name, params);
      if (name === 'service_catalog_video_r2_claim') {
        // Metadata/MD5 in the claim still refers to the old source; Drive now
        // has a replacement of equal length. Both changes are outside probes.
        h.source[80 * 1024] ^= 1;
        h.source[100 * 1024] ^= 1;
      }
      return result;
    });
    const result = await runCatalogVideoR2Worker(h.deps);
    console.info(
      'AUDIT same-size replacement',
      JSON.stringify({
        result,
        publicMatchesCurrent:
          h.store.publicBytes !== null &&
          Buffer.from(h.store.publicBytes).equals(Buffer.from(h.source)),
        publicMatchesOriginal:
          h.store.publicBytes !== null &&
          Buffer.from(h.store.publicBytes).equals(Buffer.from(original))
      })
    );
    expect(result).toMatchObject({ outcome: 'failed' });
    expect(h.names()).not.toContain('ready');
  });

  it('advances readback verification across three bounded worker invocations', async () => {
    const source = video(PART * 3 + 100);
    const parts = [];
    for (let n = 1; n <= 4; n++) {
      const bytes = source.slice((n - 1) * PART, n * PART);
      parts.push({
        partNumber: n,
        sizeBytes: bytes.length,
        sha256: await sha256Hex(bytes),
        etag: `"e${n}"`,
        verifiedBy: 'readback' as const
      });
    }
    const reads: number[][] = [];
    const outcomes: unknown[] = [];
    const proofMemory: ProofMemory = {};
    // 073: a resumed verification first reads the staged object's head (is it a movie the
    // copy patched?), one more bounded read per invocation — so a fourth invocation may finish.
    for (let attempt = 0; attempt < 4; attempt++) {
      const h = harness({ state: 'verifying', parts, budgetMs: 12_050, proofMemory });
      h.store.staging = source;
      const ranges: number[] = [];
      const read = h.deps.r2.readStagingRange.bind(h.deps.r2);
      vi.spyOn(h.deps.r2, 'readStagingRange').mockImplementation(async (...args) => {
        ranges.push(args[1]);
        h.advance(40);
        return read(...args);
      });
      outcomes.push(await runCatalogVideoR2Worker(h.deps));
      reads.push(ranges);
    }
    console.info('AUDIT verification restarts', JSON.stringify({ reads, outcomes }));
    expect(outcomes.some(result => (result as { outcome: string }).outcome === 'ready')).toBe(true);
  });
});
