import { describe, expect, it } from 'vitest';
import {
  CatalogVideoR2,
  readCatalogVideoR2Config,
  sha256Hex,
  type CatalogVideoR2Config
} from '../supabase/functions/_shared/r2-catalog-video';
import { md5Hex, Md5 } from '../supabase/functions/_shared/md5';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';

const KEY = 'v/' + 'c'.repeat(32) + '.mp4';
/** A fresh ArrayBuffer-backed view: the Response body type rejects the generic `ArrayBufferLike` view. */
const body = (bytes: Uint8Array) => new Uint8Array(bytes);
const config = (
  partVerification: CatalogVideoR2Config['partVerification'] = 'readback'
): CatalogVideoR2Config => ({
  accountId: 'a'.repeat(32),
  stagingBucket: 'soty-catalog-videos-dev-staging',
  publicBucket: 'soty-catalog-videos-dev-public',
  publicOrigin: 'https://videos.test',
  zoneId: 'b'.repeat(32),
  purgeToken: 'not-a-real-token',
  partVerification
});
const signer = {
  async sign(request: Request) {
    const headers = new Headers(request.headers);
    headers.set('authorization', 'AWS4-HMAC-SHA256 signed');
    return new Request(request, { headers });
  }
};

/** An in-memory S3 + CDN: just enough protocol to prove the adapter's contract. */
function fakeStorage(
  options: {
    echoChecksum?: boolean;
    rejectBadChecksum?: boolean;
    completeBody?: string;
    purgeOk?: boolean;
    headAfterDelete?: number;
  } = {}
) {
  const staging = new Map<string, Uint8Array>();
  const publicBucket = new Map<string, Uint8Array>();
  const uploads = new Map<string, Map<number, Uint8Array>>();
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const method = request.method;
    calls.push(`${method} ${url.host}${url.pathname}${url.search}`);
    if (url.host === 'api.cloudflare.com') {
      return new Response(JSON.stringify({ success: options.purgeOk !== false }), {
        status: options.purgeOk === false ? 500 : 200
      });
    }
    if (url.host === 'videos.test') {
      const bytes = publicBucket.get(url.pathname.slice(1));
      if (!bytes) return new Response(null, { status: 404 });
      const range = request.headers.get('range');
      if (range) {
        const [, s, e] = /^bytes=(\d+)-(\d+)$/u.exec(range)!;
        return new Response(body(bytes.slice(Number(s), Number(e) + 1)), {
          status: 206,
          headers: { 'content-type': 'video/mp4' }
        });
      }
      return new Response(method === 'HEAD' ? null : body(bytes), {
        status: 200,
        headers: {
          'content-length': String(bytes.byteLength),
          'content-type': 'video/mp4',
          'x-content-type-options': 'nosniff',
          'accept-ranges': 'bytes'
        }
      });
    }
    expect(request.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256/u);
    const [, bucket, ...rest] = url.pathname.split('/');
    const key = rest.join('/');
    const store = bucket!.endsWith('-public') ? publicBucket : staging;
    if (method === 'POST' && url.searchParams.has('uploads')) {
      const id = `upload-${uploads.size + 1}`;
      uploads.set(id, new Map());
      return new Response(
        `<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
        { status: 200 }
      );
    }
    if (method === 'PUT' && url.searchParams.has('uploadId')) {
      const parts = uploads.get(url.searchParams.get('uploadId')!);
      if (!parts) return new Response('<Error><Code>NoSuchUpload</Code></Error>', { status: 404 });
      const body = new Uint8Array(await request.arrayBuffer());
      const sent = request.headers.get('x-amz-checksum-sha256');
      const headers: Record<string, string> = {
        etag: `"etag-${url.searchParams.get('partNumber')}"`
      };
      if (sent) {
        const digest = btoa(
          String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', body)))
        );
        if (options.rejectBadChecksum && digest !== sent)
          return new Response('<Error><Code>BadDigest</Code></Error>', { status: 400 });
        if (options.echoChecksum) headers['x-amz-checksum-sha256'] = digest;
      }
      parts.set(Number(url.searchParams.get('partNumber')), body);
      return new Response(null, { status: 200, headers });
    }
    if (method === 'POST' && url.searchParams.has('uploadId')) {
      const parts = uploads.get(url.searchParams.get('uploadId')!);
      if (!parts) return new Response('<Error><Code>NoSuchUpload</Code></Error>', { status: 404 });
      const ordered = [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
      const total = ordered.reduce((n, b) => n + b.byteLength, 0);
      const joined = new Uint8Array(total);
      let offset = 0;
      for (const part of ordered) {
        joined.set(part, offset);
        offset += part.byteLength;
      }
      staging.set(key, joined);
      uploads.delete(url.searchParams.get('uploadId')!);
      return new Response(
        options.completeBody ??
          `<CompleteMultipartUploadResult><ETag>"final"</ETag></CompleteMultipartUploadResult>`,
        { status: 200 }
      );
    }
    if (method === 'DELETE' && url.searchParams.has('uploadId')) {
      return new Response(null, {
        status: uploads.delete(url.searchParams.get('uploadId')!) ? 204 : 404
      });
    }
    if (method === 'PUT' && request.headers.has('x-amz-copy-source')) {
      const source = request.headers.get('x-amz-copy-source')!.replace(/^\/[^/]+\//u, '');
      const bytes = staging.get(source);
      if (!bytes) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
      publicBucket.set(key, bytes);
      return new Response('<CopyObjectResult><ETag>"copied"</ETag></CopyObjectResult>', {
        status: 200
      });
    }
    if (method === 'HEAD') {
      const bytes = store.get(key);
      if (!bytes) return new Response(null, { status: options.headAfterDelete ?? 404 });
      return new Response(null, {
        status: 200,
        headers: { 'content-length': String(bytes.byteLength) }
      });
    }
    if (method === 'GET') {
      const bytes = store.get(key);
      if (!bytes) return new Response(null, { status: 404 });
      const range = request.headers.get('range');
      if (range) {
        const [, s, e] = /^bytes=(\d+)-(\d+)$/u.exec(range)!;
        return new Response(body(bytes.slice(Number(s), Number(e) + 1)), { status: 206 });
      }
      return new Response(body(bytes), { status: 200 });
    }
    if (method === 'DELETE') {
      store.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response('unexpected', { status: 500 });
  };
  return { fetcher, staging, publicBucket, uploads, calls };
}

const bytes = (n: number, seed = 7) =>
  Uint8Array.from({ length: n }, (_, i) => (i * seed + 3) & 0xff);
const signal = () => new AbortController().signal;

describe('catalog video R2 adapter', () => {
  it('reads only a complete, confirmed environment and refuses public R2 hostnames', () => {
    const env: Record<string, string> = {
      CATALOG_IMAGES_ENVIRONMENT: 'dev',
      R2_CATALOG_ACCOUNT_ID: 'a'.repeat(32),
      R2_CATALOG_VIDEO_STAGING_BUCKET: 'soty-catalog-videos-dev-staging',
      R2_CATALOG_VIDEO_PUBLIC_BUCKET: 'soty-catalog-videos-dev-public',
      R2_CATALOG_VIDEO_PUBLIC_ORIGIN: 'https://videos.test',
      R2_CATALOG_ZONE_ID: 'b'.repeat(32),
      R2_CATALOG_PURGE_TOKEN: 'token',
      R2_CATALOG_VIDEO_TARGET_CONFIRMATION: `dev:${'a'.repeat(32)}:soty-catalog-videos-dev-staging:soty-catalog-videos-dev-public:https://videos.test`
    };
    const read = (patch: Record<string, string | undefined>) =>
      readCatalogVideoR2Config(key => ({ ...env, ...patch })[key]);
    expect(read({})).toMatchObject({
      partVerification: 'readback',
      publicOrigin: 'https://videos.test'
    });
    expect(read({ CATALOG_VIDEOS_PART_VERIFICATION: 'provider_checksum' })?.partVerification).toBe(
      'provider_checksum'
    );
    expect(read({ CATALOG_VIDEOS_PART_VERIFICATION: 'trust-me' })).toBeNull();
    expect(read({ R2_CATALOG_VIDEO_PUBLIC_ORIGIN: 'https://pub-123.r2.dev' })).toBeNull();
    expect(read({ R2_CATALOG_VIDEO_TARGET_CONFIRMATION: 'dev:other' })).toBeNull();
    expect(read({ R2_CATALOG_VIDEO_STAGING_BUCKET: 'soty-catalog-images-dev-staging' })).toBeNull();
    expect(read({ R2_CATALOG_VIDEO_PUBLIC_ORIGIN: 'https://videos.test/path' })).toBeNull();
  });

  it('runs a multipart upload end to end: create, parts, complete, verify, promote, probe, clean', async () => {
    const storage = fakeStorage();
    const r2 = new CatalogVideoR2(config(), signer, storage.fetcher);
    const uploadId = await r2.createMultipart(KEY, signal());
    expect(uploadId).toBe('upload-1');
    const part1 = bytes(5_000);
    const part2 = bytes(3_000, 11);
    const first = await r2.uploadPart(KEY, uploadId, 1, part1, await sha256Hex(part1), signal());
    const second = await r2.uploadPart(KEY, uploadId, 2, part2, await sha256Hex(part2), signal());
    expect(first).toEqual({ etag: '"etag-1"', verifiedBy: null });
    expect(second.etag).toBe('"etag-2"');
    expect(
      storage.calls
        .filter(c => c.includes('partNumber'))
        .every(c => c.includes('uploadId=upload-1'))
    ).toBe(true);
    await r2.completeMultipart(
      KEY,
      uploadId,
      [
        { partNumber: 1, etag: first.etag },
        { partNumber: 2, etag: second.etag }
      ],
      signal()
    );
    expect(await r2.headStaging(KEY, signal())).toEqual({ sizeBytes: 8_000 });
    const back = await r2.readStagingRange(KEY, 5_000, 7_999, signal());
    expect(Buffer.from(back).equals(Buffer.from(part2))).toBe(true);
    await r2.promote(KEY, signal());
    expect(await r2.publicHead(KEY, signal())).toEqual({
      sizeBytes: 8_000,
      contentType: 'video/mp4',
      nosniff: true,
      acceptRanges: true
    });
    const probe = await r2.publicRange(KEY, 0, 9, signal());
    expect(Buffer.from(probe).equals(Buffer.from(part1.subarray(0, 10)))).toBe(true);
    await r2.removeStaging(KEY, signal());
    expect(await r2.headStaging(KEY, signal())).toBeNull();
    await r2.removePublic(KEY, signal());
    expect(storage.publicBucket.has(KEY)).toBe(false);
    expect(storage.calls.at(-1)).toMatch(
      /^POST api\.cloudflare\.com\/client\/v4\/zones\/b{32}\/purge_cache$/u
    );
  });

  it('asks the provider to verify a part only under provider_checksum and reports what it proved', async () => {
    const echo = fakeStorage({ echoChecksum: true, rejectBadChecksum: true });
    const r2 = new CatalogVideoR2(config('provider_checksum'), signer, echo.fetcher);
    const uploadId = await r2.createMultipart(KEY, signal());
    const part = bytes(100);
    expect(await r2.uploadPart(KEY, uploadId, 1, part, await sha256Hex(part), signal())).toEqual({
      etag: '"etag-1"',
      verifiedBy: 'provider_checksum'
    });
    await expect(
      r2.uploadPart(KEY, uploadId, 2, part, 'f'.repeat(64), signal())
    ).rejects.toMatchObject({ code: 'VIDEO_R2_CHECKSUM_MISMATCH' });
    const silent = fakeStorage({ echoChecksum: false });
    const quiet = new CatalogVideoR2(config('provider_checksum'), signer, silent.fetcher);
    const id = await quiet.createMultipart(KEY, signal());
    expect(
      (await quiet.uploadPart(KEY, id, 1, part, await sha256Hex(part), signal())).verifiedBy
    ).toBeNull();
    const readback = fakeStorage({ echoChecksum: true });
    const plain = new CatalogVideoR2(config('readback'), signer, readback.fetcher);
    const id2 = await plain.createMultipart(KEY, signal());
    await plain.uploadPart(KEY, id2, 1, part, await sha256Hex(part), signal());
    expect(readback.calls.some(c => c.includes('partNumber=1'))).toBe(true);
  });

  it('reports an unimplemented checksum header as a configuration mistake, not an outage', async () => {
    // Measured on R2 (2026-11-10): UploadPart answers 501 NotImplemented to
    // x-amz-checksum-sha256. Retrying that for ever would stall every copy.
    const storage = fakeStorage();
    const refusing: typeof fetch = async (input, init) => {
      const request = new Request(input as Request, init);
      if (request.method === 'PUT' && request.headers.has('x-amz-checksum-sha256'))
        return new Response('<Error><Code>NotImplemented</Code></Error>', { status: 501 });
      return storage.fetcher(request);
    };
    const r2 = new CatalogVideoR2(config('provider_checksum'), signer, refusing);
    const uploadId = await r2.createMultipart(KEY, signal());
    const part = bytes(100);
    await expect(
      r2.uploadPart(KEY, uploadId, 1, part, await sha256Hex(part), signal())
    ).rejects.toMatchObject({ code: 'VIDEO_R2_NOT_CONFIGURED', retryable: false });
    const plain = new CatalogVideoR2(config('readback'), signer, refusing);
    expect(
      (await plain.uploadPart(KEY, uploadId, 1, part, await sha256Hex(part), signal())).verifiedBy
    ).toBeNull();
  });

  it('treats a lost or ambiguous completion as unknown, never as success', async () => {
    const noEtag = fakeStorage({ completeBody: '<Error><Code>InternalError</Code></Error>' });
    const r2 = new CatalogVideoR2(config(), signer, noEtag.fetcher);
    const id = await r2.createMultipart(KEY, signal());
    const part = bytes(10);
    await r2.uploadPart(KEY, id, 1, part, await sha256Hex(part), signal());
    await expect(
      r2.completeMultipart(KEY, id, [{ partNumber: 1, etag: '"etag-1"' }], signal())
    ).rejects.toMatchObject({ code: 'VIDEO_R2_UPLOAD_UNKNOWN', retryable: true });
    const dead = new CatalogVideoR2(config(), signer, async () => {
      throw new Error('socket hang up https://secret.internal');
    });
    await expect(
      dead.uploadPart(KEY, 'u', 1, part, await sha256Hex(part), signal())
    ).rejects.toMatchObject({ code: 'VIDEO_R2_UPLOAD_UNKNOWN' });
    await expect(dead.createMultipart(KEY, signal())).rejects.toMatchObject({
      code: 'VIDEO_R2_PROVIDER_UNAVAILABLE',
      retryable: true
    });
    const limited = new CatalogVideoR2(
      config(),
      signer,
      async () => new Response(null, { status: 429 })
    );
    await expect(limited.createMultipart(KEY, signal())).rejects.toMatchObject({
      code: 'VIDEO_R2_PROVIDER_RATE_LIMITED'
    });
  });

  it('aborts tolerate a missing upload and cleanup doubts stay partial', async () => {
    const storage = fakeStorage({ purgeOk: false });
    const r2 = new CatalogVideoR2(config(), signer, storage.fetcher);
    await r2.abortMultipart(KEY, 'never-existed', signal());
    const id = await r2.createMultipart(KEY, signal());
    await r2.abortMultipart(KEY, id, signal());
    expect(storage.uploads.size).toBe(0);
    storage.publicBucket.set(KEY, bytes(3));
    await expect(r2.removePublic(KEY, signal())).rejects.toMatchObject({
      code: 'VIDEO_R2_CLEANUP_PARTIAL',
      retryable: true
    });
    const sticky = fakeStorage({ headAfterDelete: 200 });
    sticky.publicBucket.set(KEY, bytes(3));
    const stickyR2 = new CatalogVideoR2(config(), signer, async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === 'HEAD' && new URL(request.url).host !== 'videos.test')
        return new Response(null, { status: 200, headers: { 'content-length': '3' } });
      return sticky.fetcher(input, init);
    });
    await expect(stickyR2.removePublic(KEY, signal())).rejects.toMatchObject({
      code: 'VIDEO_R2_CLEANUP_PARTIAL'
    });
  });

  it('refuses keys that are not ours and reports public failures without URLs', async () => {
    const storage = fakeStorage();
    const r2 = new CatalogVideoR2(config(), signer, storage.fetcher);
    for (const bad of ['v/short.mp4', 'team/alice/IN 40.mp4', '../' + KEY, KEY.toUpperCase()]) {
      expect(() => r2.publicUrl(bad)).toThrow(/INVALID_INPUT/u);
    }
    let caught: unknown;
    try {
      await r2.publicHead(KEY, signal());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TeamFunctionError);
    expect((caught as TeamFunctionError).message).toBe('VIDEO_R2_PUBLIC_UNREACHABLE');
    await expect(r2.readStagingRange(KEY, 0, 64 * 1024 * 1024, signal())).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    });
  });

  it('computes MD5 incrementally exactly like the one-shot digest', () => {
    expect(md5Hex(new Uint8Array())).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex(new TextEncoder().encode('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5Hex(new TextEncoder().encode('The quick brown fox jumps over the lazy dog'))).toBe(
      '9e107d9d372bb6826bd81d3542a419d6'
    );
    const big = bytes(200_000, 13);
    const incremental = new Md5();
    for (let offset = 0; offset < big.byteLength; offset += 7_777)
      incremental.update(big.subarray(offset, offset + 7_777));
    expect(incremental.digest()).toBe(md5Hex(big));
  });
});
