import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CATALOG_WEBP_WASM_BASE64 } from '../supabase/functions/_shared/catalog-webp/wasm';

// Native cwebp 1.6.0, -lossless -exact -m 0; independently encoded 3x2 RGBA.
const rgba = new Uint8ClampedArray([
  255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 1, 0, 0, 0, 0, 19, 31, 47, 64, 255, 255, 255, 255
]);
const fixture = new Uint8Array(readFileSync('tests/fixtures/catalog-webp/rgba-lossless.webp'));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('offline catalog WebP decoder', () => {
  it('preserves every RGBA channel with no ImageData global or runtime fetch, initializing once', async () => {
    vi.resetModules();
    vi.stubGlobal('ImageData', undefined);
    const imageDataBefore = Object.getOwnPropertyDescriptor(globalThis, 'ImageData');
    const fetch = vi.fn(() => Promise.reject(new Error('Runtime fetch is forbidden')));
    vi.stubGlobal('fetch', fetch);
    const compile = vi.fn();
    class MeasuredModule extends WebAssembly.Module {
      constructor(bytes: BufferSource) {
        super(bytes);
        compile();
      }
    }
    const wasm = Object.create(WebAssembly) as typeof WebAssembly;
    wasm.Module = MeasuredModule;
    vi.stubGlobal('WebAssembly', wasm);
    const { decodeCatalogWebp } = await import('../supabase/functions/_shared/catalog-webp/index');
    // Exercise a BufferSource view without accidentally consuming prefix/suffix bytes.
    const padded = new Uint8Array(fixture.length + 8);
    padded.set(fixture, 4);
    const [first, second] = await Promise.all([
      decodeCatalogWebp(padded.subarray(4, fixture.length + 4)),
      decodeCatalogWebp(fixture)
    ]);
    expect(first).toEqual({ data: rgba, width: 3, height: 2 });
    expect(second).toEqual({ data: rgba, width: 3, height: 2 });
    expect(compile).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(Object.getOwnPropertyDescriptor(globalThis, 'ImageData')).toEqual(imageDataBefore);
    expect(first.data.buffer).not.toBe(second.data.buffer);
    first.data.fill(0);
    expect(second.data).toEqual(rgba);
    expect((await decodeCatalogWebp(fixture)).data).toEqual(rgba);
    expect(compile).toHaveBeenCalledOnce();
  });

  it('rejects corrupt input and keeps the cached decoder usable for a later valid image', async () => {
    const { decodeCatalogWebp } = await import('../supabase/functions/_shared/catalog-webp/index');
    await expect(decodeCatalogWebp(new Uint8Array([1, 2, 3]))).rejects.toThrow(
      'CATALOG_WEBP_DECODE_FAILED'
    );
    expect(await decodeCatalogWebp(fixture)).toEqual({ data: rgba, width: 3, height: 2 });
  });

  it('embeds the exact pinned WASM artifact rather than a runtime-resolved codec', () => {
    const bytes = Buffer.from(CATALOG_WEBP_WASM_BASE64, 'base64');
    expect(bytes.length).toBe(565_369);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '164cd9583a3e4d081f767d3b41ff0a730443dc7535fcc5caff83561463384b79'
    );
  });
});
