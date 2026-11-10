import { describe, expect, it, vi } from 'vitest';
import { runCatalogVideoR2Worker, type CatalogVideoR2WorkerDeps } from '../supabase/functions/catalog-video-r2/worker';
import { CatalogVideoR2, sha256Hex, type CatalogVideoR2Config } from '../supabase/functions/_shared/r2-catalog-video';
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
const signer = { async sign(request: Request) { return request; } };
const video = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);

interface Store { staging: Uint8Array | null; publicBytes: Uint8Array | null; uploads: Map<string, Map<number, Uint8Array>>; nosniff: boolean; mutateDriveAfterParts?: number }

function fakeR2(store: Store, calls: string[]) {
  const fetcher: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    calls.push(`${request.method} ${url.host}${url.pathname}${url.search}`);
    if (url.host === 'api.cloudflare.com') return new Response(JSON.stringify({ success: true }), { status: 200 });
    if (url.host === 'videos.test') {
      if (!store.publicBytes) return new Response(null, { status: 404 });
      const range = request.headers.get('range');
      if (range) {
        const [, s, e] = /^bytes=(\d+)-(\d+)$/u.exec(range)!;
        return new Response(new Uint8Array(store.publicBytes.slice(Number(s), Number(e) + 1)), { status: 206 });
      }
      return new Response(null, { status: 200, headers: { 'content-length': String(store.publicBytes.byteLength), 'content-type': 'video/mp4', ...(store.nosniff ? { 'x-content-type-options': 'nosniff' } : {}), 'accept-ranges': 'bytes' } });
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
      parts.set(Number(url.searchParams.get('partNumber')), new Uint8Array(await request.arrayBuffer()));
      return new Response(null, { status: 200, headers: { etag: `"e${url.searchParams.get('partNumber')}"` } });
    }
    if (request.method === 'POST' && url.searchParams.has('uploadId')) {
      const parts = store.uploads.get(url.searchParams.get('uploadId')!);
      if (!parts) return new Response(null, { status: 404 });
      const ordered = [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
      const joined = new Uint8Array(ordered.reduce((n, b) => n + b.byteLength, 0));
      let offset = 0;
      for (const b of ordered) { joined.set(b, offset); offset += b.byteLength; }
      store.staging = joined;
      store.uploads.delete(url.searchParams.get('uploadId')!);
      return new Response('<x><ETag>"f"</ETag></x>', { status: 200 });
    }
    if (request.method === 'DELETE' && url.searchParams.has('uploadId')) return new Response(null, { status: store.uploads.delete(url.searchParams.get('uploadId')!) ? 204 : 404 });
    if (request.method === 'PUT' && request.headers.has('x-amz-copy-source')) {
      if (!store.staging) return new Response(null, { status: 404 });
      store.publicBytes = store.staging;
      return new Response('<x><ETag>"c"</ETag></x>', { status: 200 });
    }
    const bytes = isPublic ? store.publicBytes : store.staging;
    if (request.method === 'HEAD') return bytes ? new Response(null, { status: 200, headers: { 'content-length': String(bytes.byteLength) } }) : new Response(null, { status: 404 });
    if (request.method === 'GET') {
      if (!bytes) return new Response(null, { status: 404 });
      const [, s, e] = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.get('range')!)!;
      return new Response(new Uint8Array(bytes.slice(Number(s), Number(e) + 1)), { status: 206 });
    }
    if (request.method === 'DELETE') {
      if (isPublic) store.publicBytes = null; else store.staging = null;
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 500 });
  };
  return new CatalogVideoR2(config, signer, fetcher);
}

function harness(options: { size?: number; sourceMd5?: 'match' | 'mismatch' | null; parts?: Array<{ partNumber: number; sizeBytes: number; sha256: string; etag: string; verifiedBy: 'readback' | 'provider_checksum' }>; state?: string; uploadId?: string | null; budgetMs?: number; msPerRead?: number; nosniff?: boolean; driveChanges?: number; route?: 'claim' | 'sweep'; retire?: unknown[]; purges?: unknown[]; claimNull?: boolean } = {}) {
  const size = options.size ?? PART * 3 + 100;
  const source = video(size);
  const store: Store = { staging: null, publicBytes: null, uploads: new Map(), nosniff: options.nosniff ?? true };
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
          copyId: COPY, teamId: TEAM, fence: 3, state: options.state ?? 'planned', objectKey: KEY, sizeBytes: size, mime: 'video/mp4', partBytes: PART,
          sourceMd5: options.sourceMd5 === 'match' ? md5Hex(source) : options.sourceMd5 === 'mismatch' ? 'f'.repeat(32) : null,
          uploadId: options.uploadId ?? null, sourceVersion: 'strict-v1:x', attempts: 1, catalogMaterialId: null, sourceMaterialId: TEAM, connectionId: TEAM,
          credentialId: CREDENTIAL, rootFolderId: 'root', fileId: 'file-1', resourceKey: null, publicOrigin: 'https://videos.test', parts: options.parts ?? []
        });
      case 'service_catalog_video_r2_renew': return ok(true);
      case 'service_catalog_video_r2_retire_orphans': return ok(0);
      case 'service_catalog_video_r2_claim_retire': return ok(retire.shift() ?? null);
      case 'service_catalog_video_r2_claim_purge': return ok(purges.shift() ?? null);
      default: return ok(null);
    }
  });
  const driveFor = vi.fn(async () => ({
    async fetchFileRange(input: { start: number; end: number }) {
      driveReads += 1;
      advance(options.msPerRead ?? 0);
      if (options.driveChanges && driveReads > options.driveChanges) return new Response(null, { status: 416 });
      return new Response(new Uint8Array(source.slice(input.start, input.end + 1)), { status: 206, headers: { 'content-range': `bytes ${input.start}-${input.end}/${size}` } });
    }
  }));
  let clock = 0;
  const deps: CatalogVideoR2WorkerDeps = { service: { rpc }, r2, enabled: true, route: options.route ?? 'claim', driveFor, budgetMs: options.budgetMs ?? 60_000, random: () => 0.5, now: () => clock };
  const advance = (ms: number) => { clock += ms; };
  return { deps, rpc, trace, store, calls, source, driveFor, names: () => trace.map(([name]) => name.replace('service_catalog_video_r2_', '')) };
}

describe('catalog video R2 worker', () => {
  it('copies a video in parts, verifies it, promotes it and marks it ready with the full hash', async () => {
    const h = harness({ sourceMd5: 'match' });
    const result = await runCatalogVideoR2Worker(h.deps);
    expect(result).toEqual({ outcome: 'ready', fullHashVerified: true, parts: 4 });
    expect(h.names()).toEqual(['claim', 'begin_upload', 'part', 'part', 'part', 'part', 'verifying', 'ready']);
    const partCalls = h.trace.filter(([name]) => name === 'service_catalog_video_r2_part').map(([, p]) => p);
    expect(partCalls.map(p => p.p_part)).toEqual([1, 2, 3, 4]);
    expect(partCalls.every(p => p.p_verified_by === 'readback' && typeof p.p_sha256 === 'string')).toBe(true);
    expect(partCalls[3]!.p_size).toBe(100);
    expect(partCalls[0]!.p_sha256).toBe(await sha256Hex(h.source.subarray(0, PART)));
    expect(h.trace.at(-1)![1]).toMatchObject({ p_full_hash_verified: true, p_fence: 3, p_worker: expect.stringMatching(/^catalog-video-r2:/u) });
    expect(h.store.publicBytes && Buffer.from(h.store.publicBytes).equals(Buffer.from(h.source))).toBe(true);
    expect(h.store.staging).toBeNull();
    expect(h.calls.filter(c => c.startsWith('GET videos.test')).length).toBeGreaterThanOrEqual(2);
  });

  it('yields before the budget ends and resumes from the next part without re-hashing the whole file', async () => {
    const first = harness({ budgetMs: 12_050, sourceMd5: 'match', msPerRead: 5_000 });
    const yielded = await runCatalogVideoR2Worker(first.deps);
    expect(yielded).toMatchObject({ outcome: 'yielded' });
    expect(first.names().at(-1)).toBe('yield');
    const done = first.trace.filter(([name]) => name === 'service_catalog_video_r2_part').map(([, p]) => ({ partNumber: p.p_part as number, sizeBytes: p.p_size as number, sha256: p.p_sha256 as string, etag: p.p_etag as string, verifiedBy: 'readback' as const }));
    expect(done.length).toBeLessThan(4);
    const uploadId = first.trace.find(([name]) => name === 'service_catalog_video_r2_begin_upload')![1].p_upload_id as string;
    const second = harness({ sourceMd5: 'match', state: 'uploading', uploadId, parts: done });
    second.store.uploads = first.store.uploads;
    const result = await runCatalogVideoR2Worker(second.deps);
    expect(result).toEqual({ outcome: 'ready', fullHashVerified: false, parts: 4 });
    const parts = second.trace.filter(([name]) => name === 'service_catalog_video_r2_part').map(([, p]) => p.p_part);
    expect(parts).toEqual([1, 2, 3, 4].filter(n => !done.some(d => d.partNumber === n)));
    expect(second.names()).not.toContain('begin_upload');
  });

  it('fails terminally and aborts the upload when the source changes mid-copy', async () => {
    const h = harness({ driveChanges: 2 });
    const result = await runCatalogVideoR2Worker(h.deps);
    expect(result).toEqual({ outcome: 'failed', code: 'SOURCE_CHANGED' });
    expect(h.trace.at(-1)).toEqual(['service_catalog_video_r2_release', expect.objectContaining({ p_code: 'SOURCE_CHANGED', p_terminal: true })]);
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
    expect(await runCatalogVideoR2Worker(tampered.deps)).toEqual({ outcome: 'failed', code: 'VIDEO_R2_CHECKSUM_MISMATCH' });
    expect(origPromote).toBeDefined();
    const unsniffed = harness({ nosniff: false });
    expect(await runCatalogVideoR2Worker(unsniffed.deps)).toEqual({ outcome: 'retry', code: 'VIDEO_R2_PUBLIC_UNREACHABLE' });
    expect(unsniffed.trace.at(-1)).toEqual(['service_catalog_video_r2_release', expect.objectContaining({ p_terminal: false })]);
    const badHash = harness({ sourceMd5: 'mismatch' });
    expect(await runCatalogVideoR2Worker(badHash.deps)).toEqual({ outcome: 'failed', code: 'VIDEO_R2_CHECKSUM_MISMATCH' });
  });

  it('reconciles an unknown completion by reading the staging object instead of uploading again', async () => {
    const h = harness({ state: 'uploading', uploadId: 'gone', parts: [] });
    const source = h.source;
    const parts = [] as Array<{ partNumber: number; sizeBytes: number; sha256: string; etag: string; verifiedBy: 'readback' }>;
    for (let n = 1; n <= 4; n += 1) {
      const slice = source.subarray((n - 1) * PART, Math.min(source.byteLength, n * PART));
      parts.push({ partNumber: n, sizeBytes: slice.byteLength, sha256: await sha256Hex(slice), etag: `"e${n}"`, verifiedBy: 'readback' });
    }
    const resumed = harness({ state: 'uploading', uploadId: 'gone', parts });
    resumed.store.staging = source;
    expect(await runCatalogVideoR2Worker(resumed.deps)).toEqual({ outcome: 'ready', fullHashVerified: false, parts: 4 });
    expect(resumed.names()).toEqual(['claim', 'verifying', 'ready']);
    expect(resumed.calls.some(c => c.includes('partNumber='))).toBe(false);
  });

  it('is idle without work and disabled without the runtime gate', async () => {
    const idle = harness({ claimNull: true });
    expect(await runCatalogVideoR2Worker(idle.deps)).toEqual({ idle: true });
    const off = harness();
    expect(await runCatalogVideoR2Worker({ ...off.deps, enabled: false })).toEqual({ disabled: true });
    expect(off.rpc).not.toHaveBeenCalled();
  });

  it('sweeps: deletes retired objects with a purge and clears tombstones including orphaned uploads', async () => {
    const h = harness({
      route: 'sweep',
      retire: [{ copyId: COPY, teamId: TEAM, fence: 9, objectKey: KEY, publicOrigin: 'https://videos.test', reason: 'replaced' }],
      purges: [{ id: '50000000-0000-4000-8000-000000000301', fence: 2, objectKey: 'v/' + 'e'.repeat(32) + '.mp4', uploadId: 'orphan', reason: 'failed_upload', publicOrigin: 'https://videos.test', teamRef: TEAM, copyRef: null }]
    });
    h.store.publicBytes = video(10);
    h.store.uploads.set('orphan', new Map());
    expect(await runCatalogVideoR2Worker(h.deps)).toEqual({ retired: 0, deleted: 1, purged: 1, failed: 0 });
    expect(h.store.publicBytes).toBeNull();
    expect(h.store.uploads.size).toBe(0);
    expect(h.names()).toEqual(['retire_orphans', 'claim_retire', 'mark_deleted', 'claim_retire', 'claim_purge', 'mark_purged', 'claim_purge']);
    expect(h.trace.find(([name]) => name === 'service_catalog_video_r2_mark_deleted')![1]).toMatchObject({ p_success: true, p_fence: 9 });
    expect(h.calls.filter(c => c.includes('purge_cache'))).toHaveLength(2);
  });

  it('keeps provider errors as codes and never records a part the storage did not acknowledge', async () => {
    const h = harness();
    vi.spyOn(h.deps.r2, 'uploadPart').mockRejectedValueOnce(new TeamFunctionError('VIDEO_R2_UPLOAD_UNKNOWN', { retryable: true }));
    expect(await runCatalogVideoR2Worker(h.deps)).toEqual({ outcome: 'retry', code: 'VIDEO_R2_UPLOAD_UNKNOWN' });
    expect(h.names()).toEqual(['claim', 'begin_upload', 'release']);
  });
});
