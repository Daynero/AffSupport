import { describe, expect, it, vi } from 'vitest';
import {
  readCatalogImageBytes,
  validateCatalogImage
} from '../supabase/functions/_shared/catalog-image-validation.js';
import { CatalogImageR2 } from '../supabase/functions/_shared/r2-catalog-images.js';
import { createCatalogImagePermit } from '../supabase/functions/_shared/catalog-images.js';

const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
    'base64'
  )
);
const config = {
  accountId: 'a'.repeat(32),
  stagingBucket: 'private-staging',
  publicBucket: 'public-final',
  publicOrigin: 'https://media.test',
  zoneId: 'b'.repeat(32),
  purgeToken: 'secret'
};
const KEY = 'v1/45000000-0000-4000-8000-000000000001';

describe('bounded image validation and immutable publication', () => {
  it.each(['get', 'put', 'delete'] as const)(
    'preserves cancellation across a signer that drops Request.signal for %s',
    async method => {
      const controller = new AbortController();
      const signer = {
        sign: async (input: Request) =>
          new Request(input.url, {
            method: input.method,
            headers: input.headers
          })
      };
      const requests: Request[] = [];
      const fetcher: typeof fetch = async input => {
        const request = input instanceof Request ? input : new Request(input);
        requests.push(request);
        controller.abort();
        throw controller.signal.reason;
      };
      const r2 = new CatalogImageR2(config, signer, fetcher);
      const operation =
        method === 'get'
          ? r2.get('public', KEY, controller.signal)
          : method === 'put'
            ? r2.putFinal(KEY, PNG, 'image/png', controller.signal, 'a'.repeat(64))
            : r2.remove('public', KEY, controller.signal);
      await expect(operation).rejects.toBeDefined();
      expect(requests).toHaveLength(1);
      expect(requests[0]!.signal.aborted).toBe(true);
    }
  );
  it('checks actual static PNG bytes and returns a server digest', async () => {
    const value = await validateCatalogImage(PNG, 'image/png');
    expect(value).toMatchObject({
      mime: 'image/png',
      width: 1,
      height: 1,
      size: PNG.length,
      orientation: 1
    });
    expect(value.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });
  it('rejects CRC corruption, disguised HTML and metadata/container mismatch', async () => {
    const corrupt = PNG.slice();
    corrupt[corrupt.length - 1] ^= 1;
    await expect(validateCatalogImage(corrupt)).rejects.toMatchObject({
      code: 'IMAGE_CONTENT_INVALID'
    });
    await expect(
      validateCatalogImage(new TextEncoder().encode('<html>image</html>'))
    ).rejects.toMatchObject({ code: 'IMAGE_UNSUPPORTED_FORMAT' });
    await expect(validateCatalogImage(PNG, 'image/jpeg')).rejects.toMatchObject({
      code: 'IMAGE_CONTENT_INVALID'
    });
  });
  it('cancels overflowing streams without buffering the rest', async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(11));
      },
      cancel() {
        cancelled = true;
      }
    });
    await expect(readCatalogImageBytes(new Response(stream), 10)).rejects.toMatchObject({
      code: 'IMAGE_TOO_LARGE'
    });
    expect(cancelled).toBe(true);
  });
  it('publishes using conditional create-only and cannot expose a browser final grant', async () => {
    const requests: Request[] = [];
    const fetcher: typeof fetch = async input => {
      requests.push(input instanceof Request ? input : new Request(input));
      return new Response(null, { status: 412 });
    };
    const signer = {
      sign: vi.fn(async (request: Request) => {
        expect(request.body).toBeNull();
        return request;
      })
    };
    const r2 = new CatalogImageR2(config, signer, fetcher);
    const image = await validateCatalogImage(PNG);
    expect(
      await r2.putFinal(KEY, PNG, 'image/png', new AbortController().signal, image.sha256)
    ).toBe('exists');
    expect(requests[0]!.headers.get('if-none-match')).toBe('*');
    expect(requests[0]!.headers.get('content-length')).toBe(String(PNG.length));
    expect(requests[0]!.headers.get('x-amz-content-sha256')).toBe(image.sha256);
    expect(signer.sign).toHaveBeenCalledWith(expect.any(Request), { aws: { allHeaders: true } });
    expect(new Uint8Array(await requests[0]!.arrayBuffer())).toEqual(PNG);
    expect(requests[0]!.url).toContain('/public-final/');
    await expect(
      r2.stagingGrant(KEY, 'image/png', new Date(Date.now() + 60_000).toISOString(), 1)
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('attaches a known-length large payload after signing without exposing backing-buffer bytes', async () => {
    const storage = new Uint8Array(512_630).fill(17);
    const bytes = storage.subarray(1, storage.length - 1);
    bytes[0] = 23;
    bytes[bytes.length - 1] = 42;
    const digest = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
    const signer = {
      sign: vi.fn(async (request: Request) => {
        expect(request.body).toBeNull();
        expect(request.headers.get('content-length')).toBe(String(bytes.byteLength));
        expect(request.headers.get('x-amz-content-sha256')).toBe(digest);
        request.headers.set('authorization', 'signed-metadata');
        return request;
      })
    };
    const fetcher: typeof fetch = async input => {
      const request = input as Request;
      expect(request.headers.get('authorization')).toBe('signed-metadata');
      expect(request.headers.get('content-length')).toBe(String(bytes.byteLength));
      expect(request.headers.get('if-none-match')).toBe('*');
      const reader = request.body!.getReader();
      // A native BufferSource body retains its known size. The old manually
      // chunked stream failed real R2 signature checks above the small-body path.
      const first = await reader.read();
      expect(first.value?.byteLength).toBe(bytes.byteLength);
      expect(first.value?.every((value, index) => value === bytes[index])).toBe(true);
      expect(await reader.read()).toEqual({ done: true, value: undefined });
      return new Response(null, { status: 200 });
    };
    const r2 = new CatalogImageR2(config, signer, fetcher);
    await expect(
      r2.putFinal(KEY, bytes, 'image/png', new AbortController().signal, digest)
    ).resolves.toBe('created');
    expect(signer.sign).toHaveBeenCalledWith(expect.any(Request), { aws: { allHeaders: true } });
  });
  it('verifies real public bytes and the response transform, not metadata or ETag alone', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(PNG, {
          headers: { 'content-type': 'image/png', 'x-content-type-options': 'nosniff' }
        })
      )
      .mockResolvedValueOnce(new Response(PNG, { headers: { 'content-type': 'image/png' } }));
    const r2 = new CatalogImageR2(config, { sign: async request => request }, fetcher);
    await expect(
      r2.verify(KEY, PNG, 'image/png', new AbortController().signal, true)
    ).resolves.toBeUndefined();
    await expect(
      r2.verify(KEY, PNG, 'image/png', new AbortController().signal, true)
    ).rejects.toMatchObject({ code: 'IMAGE_PUBLIC_VERIFICATION_FAILED' });
  });
  it('allows one heavy operation per isolate admission and releases exactly once', () => {
    const permit = createCatalogImagePermit();
    const release = permit.acquire();
    expect(release).not.toBeNull();
    expect(permit.acquire()).toBeNull();
    release!();
    release!();
    const next = permit.acquire();
    expect(next).not.toBeNull();
    next!();
  });
});
