import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { simd } from 'wasm-feature-detect';
import { init as initWebpEncode, default as encodeWebpModule } from '@jsquash/webp/encode.js';
import { init as initPngDecode, default as decodePngModule } from '@jsquash/png/decode.js';
import type { LandingImageQuality } from '@video-compressor/shared';

const require = createRequire(import.meta.url);

export interface RawImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * WebP encoding options tuned for the two Landing Optimizer modes.
 *
 * Optimal favours a strong size reduction while staying visually clean.
 * High Quality compresses far more carefully so the result is virtually
 * indistinguishable from the original.
 */
function webpOptions(quality: LandingImageQuality) {
  return quality === 'high'
    ? { quality: 90, method: 6, alpha_quality: 100 }
    : { quality: 80, method: 5, alpha_quality: 100 };
}

let codecs: Promise<void> | null = null;

/**
 * Loads the bundled libwebp/libpng WebAssembly once. The codecs default to
 * `fetch`-ing their `.wasm` next to the module, which does not exist in a
 * headless Node agent, so the compiled modules are handed in explicitly.
 */
export function initImageCodecs(): Promise<void> {
  if (!codecs) codecs = load();
  return codecs;
}

async function load(): Promise<void> {
  const useSimd = await simd().catch(() => false);
  const webpWasm = require.resolve(
    useSimd ? '@jsquash/webp/codec/enc/webp_enc_simd.wasm' : '@jsquash/webp/codec/enc/webp_enc.wasm'
  );
  const pngWasm = require.resolve('@jsquash/png/codec/pkg/squoosh_png_bg.wasm');
  await initWebpEncode(await WebAssembly.compile(await readFile(webpWasm)));
  await initPngDecode(await WebAssembly.compile(await readFile(pngWasm)));
}

/** Decodes a PNG buffer (produced by FFmpeg) into raw RGBA pixels. */
export async function decodePng(buffer: Buffer): Promise<RawImage> {
  await initImageCodecs();
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  const image = await decodePngModule(bytes.buffer as ArrayBuffer);
  return { data: image.data, width: image.width, height: image.height };
}

/** Encodes raw RGBA pixels into a WebP buffer at the requested quality. */
export async function encodeWebp(image: RawImage, quality: LandingImageQuality): Promise<Buffer> {
  await initImageCodecs();
  const encoded = await encodeWebpModule(image as unknown as ImageData, webpOptions(quality));
  return Buffer.from(encoded);
}
