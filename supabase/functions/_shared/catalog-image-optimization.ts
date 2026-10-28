import { TeamFunctionError } from './errors.ts';
import { validateCatalogImage, type ValidatedCatalogImage } from './catalog-image-validation.ts';

export const CATALOG_IMAGE_OPTIMIZATION_VERSION = 'lossless-v1';
export const CATALOG_IMAGE_PUBLIC_MAX_BYTES = 8_000_000;
export const CATALOG_IMAGE_PUBLIC_MIN_SIDE = 500;
export const CATALOG_IMAGE_WEBP_MAX_PIXELS = 4_000_000;
// A tiny compressed DEFLATE chunk can expand ~1000x. Bound the native inflate
// result as well as its input; a 64 KB feed can otherwise allocate ~64 MB at once.
const CHUNK = 1024;
const MAX_PARTS = 4096;
const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const text = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

export interface OptimizedCatalogImage {
  bytes: Uint8Array;
  image: ValidatedCatalogImage & {
    sourceSize: number;
    sourceSha256: string;
    optimizationVersion: typeof CATALOG_IMAGE_OPTIMIZATION_VERSION;
  };
}
function fail(
  code: 'IMAGE_CONTENT_INVALID' | 'IMAGE_TOO_LARGE' | 'IMAGE_UNSUPPORTED_FORMAT'
): never {
  throw new TeamFunctionError(code, { retryable: false });
}
function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}
function u32(bytes: Uint8Array, offset: number, little = false): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, little);
}
/** Reject pathological containers before the structural validator or view allocation. */
function boundStructure(bytes: Uint8Array): void {
  if (bytes.length > 50_000_000) fail('IMAGE_TOO_LARGE');
  if (bytes.length < 12) return;
  const isPng = ascii(bytes, 1, 3) === 'PNG';
  const isWebp = ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP';
  if (isPng || isWebp) {
    let count = 0;
    for (let at = isPng ? 8 : 12; at < bytes.length;) {
      if (++count > MAX_PARTS || at + (isPng ? 12 : 8) > bytes.length)
        fail('IMAGE_CONTENT_INVALID');
      const length = u32(bytes, at + (isPng ? 0 : 4), isWebp);
      at += length + (isPng ? 12 : 8 + (length & 1));
      if (at > bytes.length) fail('IMAGE_CONTENT_INVALID');
    }
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    let count = 0;
    let at = 2;
    while (at < bytes.length) {
      if (++count > MAX_PARTS || bytes[at++] !== 255) fail('IMAGE_CONTENT_INVALID');
      while (bytes[at] === 255) at++;
      const marker = bytes[at++];
      if (marker === undefined) fail('IMAGE_CONTENT_INVALID');
      if (marker === 217) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (at + 2 > bytes.length) fail('IMAGE_CONTENT_INVALID');
      const length = (bytes[at]! << 8) | bytes[at + 1]!;
      if (length < 2 || at + length > bytes.length) fail('IMAGE_CONTENT_INVALID');
      at += length;
      if (marker === 218)
        while (at < bytes.length) {
          if (bytes[at] !== 255) {
            at++;
            continue;
          }
          const next = bytes[at + 1];
          if (next === 0 || (next !== undefined && next >= 208 && next <= 215)) {
            at += 2;
            continue;
          }
          break;
        }
    }
  }
}
function join(parts: readonly Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  if (size > CATALOG_IMAGE_PUBLIC_MAX_BYTES) fail('IMAGE_TOO_LARGE');
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const result = new Uint8Array(data.length + 12);
  const view = new DataView(result.buffer);
  view.setUint32(0, data.length);
  result.set(text.encode(type), 4);
  result.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < result.length - 4; i++)
    crc = crcTable[(crc ^ result[i]!) & 255]! ^ (crc >>> 8);
  view.setUint32(result.length - 4, (crc ^ 0xffffffff) >>> 0);
  return result;
}

/** Only fresh native outputs / explicitly owned pixels, never source views. */
function releaseNativeChunk(value: ArrayBuffer | ArrayBufferView): void {
  // Node zlib can reuse even a complete output slab on its next write. Only
  // Deno native compression guarantees fresh backing stores for these chunks.
  if (!Reflect.has(globalThis, 'Deno')) return;
  const buffer = value instanceof ArrayBuffer ? value : value.buffer;
  if (!(buffer instanceof ArrayBuffer)) return;
  // Node zlib may expose partial views into a reused slab; those stay with its
  // producer. Deno's native output is a complete fresh backing store.
  if (
    !(value instanceof ArrayBuffer) &&
    (value.byteOffset !== 0 || value.byteLength !== buffer.byteLength)
  )
    return;
  const transfer = (buffer as ArrayBuffer & { transfer?: (size: number) => ArrayBuffer }).transfer;
  if (transfer) {
    try {
      transfer.call(buffer, 0);
    } catch {
      /* Host-owned slabs may be non-transferable. */
    }
  }
}

/** Native zlib is streamed. An oversized candidate is discarded, never accumulated. */
async function collect(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length <= CATALOG_IMAGE_PUBLIC_MAX_BYTES) parts.push(part.value);
      else {
        for (const stored of parts) releaseNativeChunk(stored);
        parts.length = 0;
        releaseNativeChunk(part.value);
      }
    }
    const result = length <= CATALOG_IMAGE_PUBLIC_MAX_BYTES ? join(parts) : null;
    for (const stored of parts) releaseNativeChunk(stored);
    return result;
  } catch (error) {
    for (const stored of parts) releaseNativeChunk(stored);
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
function streamParts(
  parts: readonly Uint8Array[],
  signal?: AbortSignal
): ReadableStream<BufferSource> {
  let part = 0;
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      signal?.throwIfAborted();
      while (part < parts.length && offset === parts[part]!.length) {
        part++;
        offset = 0;
      }
      if (part === parts.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + CHUNK, parts[part]!.length);
      const value = parts[part]!.subarray(offset, end);
      controller.enqueue(
        value.buffer instanceof ArrayBuffer
          ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
          : Uint8Array.from(value)
      );
      offset = end;
    }
  });
}

/** Native inflate outputs are fresh owned buffers. Consume and release each one
 * before reading the next instead of retaining an entire raster until a GC. */
async function recompressPng(
  source: ReadableStream<BufferSource>,
  header: Uint8Array,
  paletteEntries: number,
  signal?: AbortSignal
): Promise<Uint8Array | null> {
  const input = source
    .pipeThrough(new DecompressionStream('deflate'))
    .pipeThrough(pngScanlines(header, paletteEntries));
  const reader = input.getReader();
  const compressor = new CompressionStream('deflate');
  const writer = compressor.writable.getWriter();
  const collected = collect(compressor.readable, signal);
  void collected.catch(() => undefined);
  try {
    while (true) {
      signal?.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      try {
        await writer.write(next.value);
      } finally {
        releaseNativeChunk(next.value);
      }
    }
    await writer.close();
    return await collected;
  } catch (error) {
    await Promise.allSettled([reader.cancel(error), writer.abort(error)]);
    await collected.catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
    writer.releaseLock();
  }
}

interface PngPart {
  type: string;
  data: Uint8Array;
  full: Uint8Array;
}
function pngParts(bytes: Uint8Array): PngPart[] {
  const parts: PngPart[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = u32(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    if (type[0] === type[0]!.toUpperCase() && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type))
      fail('IMAGE_UNSUPPORTED_FORMAT');
    parts.push({
      type,
      data: bytes.subarray(offset + 8, offset + 8 + length),
      full: bytes.subarray(offset, offset + length + 12)
    });
    offset += length + 12;
  }
  return parts;
}

/** Checks every inflated row/filter, including Adam7, without allocating a raster. */
function pngScanlines(
  header: Uint8Array,
  paletteEntries: number
): TransformStream<Uint8Array<ArrayBuffer>, BufferSource> {
  const width = u32(header, 0);
  const height = u32(header, 4);
  const channels = [1, 0, 3, 1, 2, 0, 4][header[9]!]!;
  const passes =
    header[12] === 0
      ? [[0, 0, 1, 1]]
      : [
          [0, 0, 8, 8],
          [4, 0, 8, 8],
          [0, 4, 4, 8],
          [2, 0, 4, 4],
          [0, 2, 2, 4],
          [1, 0, 2, 2],
          [0, 1, 1, 2]
        ];
  const rows = passes
    .map(([x, y, dx, dy]) => {
      const columns = Math.max(0, Math.ceil((width - x!) / dx!));
      return {
        columns,
        length: Math.ceil((columns * channels * header[8]!) / 8) + 1,
        count: columns ? Math.max(0, Math.ceil((height - y!) / dy!)) : 0
      };
    })
    .filter(pass => pass.count > 0);
  let pass = 0;
  let row = 0;
  let position = 0;
  let filter = 0;
  const indexed = header[9] === 3;
  const depth = header[8]!;
  const rowCapacity = indexed ? Math.max(...rows.map(value => value.length - 1)) : 0;
  let previous = new Uint8Array(rowCapacity);
  let current = new Uint8Array(rowCapacity);
  const paeth = (left: number, up: number, corner: number): number => {
    const prediction = left + up - corner;
    const a = Math.abs(prediction - left),
      b = Math.abs(prediction - up),
      c = Math.abs(prediction - corner);
    return a <= b && a <= c ? left : b <= c ? up : corner;
  };
  return new TransformStream({
    transform(bytes, controller) {
      let at = 0;
      while (at < bytes.length) {
        if (pass >= rows.length) fail('IMAGE_CONTENT_INVALID');
        if (position === 0) {
          filter = bytes[at]!;
          if (filter > 4) fail('IMAGE_CONTENT_INVALID');
          if (indexed) {
            position++;
            at++;
            continue;
          }
        }
        const size = Math.min(rows[pass]!.length - position, bytes.length - at);
        if (indexed)
          for (let index = 0; index < size; index++) {
            const columnByte = position - 1 + index;
            const left = columnByte ? current[columnByte - 1]! : 0;
            const up = previous[columnByte]!;
            const corner = columnByte ? previous[columnByte - 1]! : 0;
            const predictor =
              filter === 1
                ? left
                : filter === 2
                  ? up
                  : filter === 3
                    ? (left + up) >>> 1
                    : filter === 4
                      ? paeth(left, up, corner)
                      : 0;
            const value = (bytes[at + index]! + predictor) & 255;
            current[columnByte] = value;
            const samples = Math.min(8 / depth, rows[pass]!.columns - columnByte * (8 / depth));
            for (let sample = 0; sample < samples; sample++) {
              if (((value >>> (8 - depth * (sample + 1))) & ((1 << depth) - 1)) >= paletteEntries)
                fail('IMAGE_CONTENT_INVALID');
            }
          }
        position += size;
        at += size;
        if (position === rows[pass]!.length) {
          position = 0;
          if (indexed) {
            const swap = previous;
            previous = current;
            current = swap;
          }
          row++;
          if (row === rows[pass]!.count) {
            row = 0;
            pass++;
            if (indexed) previous.fill(0);
          }
        }
      }
      controller.enqueue(bytes);
    },
    flush() {
      if (pass !== rows.length || position !== 0) fail('IMAGE_CONTENT_INVALID');
    }
  });
}

async function optimizePng(bytes: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
  const parts = pngParts(bytes);
  const ids = parts.map((part, i) => (part.type === 'IDAT' ? i : -1)).filter(i => i >= 0);
  if (!ids.length || ids.at(-1)! - ids[0]! + 1 !== ids.length) fail('IMAGE_CONTENT_INVALID');
  const colour = parts[0]!.data[9]!;
  const depth = parts[0]!.data[8]!;
  const palette = parts.findIndex(part => part.type === 'PLTE');
  const transparency = parts.findIndex(part => part.type === 'tRNS');
  for (const type of ['PLTE', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'eXIf']) {
    if (parts.filter(part => part.type === type).length > 1) fail('IMAGE_CONTENT_INVALID');
  }
  if (palette >= 0) {
    const length = parts[palette]!.data.length;
    if (
      [0, 4].includes(colour) ||
      palette >= ids[0]! ||
      !length ||
      length % 3 !== 0 ||
      length > 768 ||
      (colour === 3 && length / 3 > 2 ** depth)
    )
      fail('IMAGE_CONTENT_INVALID');
  } else if (colour === 3) fail('IMAGE_CONTENT_INVALID');
  if (transparency >= 0) {
    const length = parts[transparency]!.data.length;
    if (
      transparency >= ids[0]! ||
      [4, 6].includes(colour) ||
      (colour === 0 && length !== 2) ||
      (colour === 2 && length !== 6) ||
      (colour === 3 &&
        (transparency <= palette || !length || length > parts[palette]!.data.length / 3))
    )
      fail('IMAGE_CONTENT_INVALID');
  }
  for (const part of parts) {
    if (
      (part.type === 'gAMA' && (part.data.length !== 4 || !u32(part.data, 0))) ||
      (part.type === 'sRGB' && (part.data.length !== 1 || part.data[0]! > 3)) ||
      (part.type === 'cHRM' && part.data.length !== 32)
    )
      fail('IMAGE_CONTENT_INVALID');
  }
  // Only textual/time metadata is removed. ICC, gamma, chromaticities, bit depth,
  // alpha, EXIF and unknown ancillary rendering information remain byte-identical.
  const retained = parts.filter(part => !['tEXt', 'zTXt', 'iTXt', 'tIME'].includes(part.type));
  let compressed: Uint8Array | null;
  try {
    compressed = await recompressPng(
      streamParts(
        ids.map(i => parts[i]!.data),
        signal
      ),
      parts[0]!.data,
      palette >= 0 ? parts[palette]!.data.length / 3 : 0,
      signal
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    fail('IMAGE_CONTENT_INVALID');
  }
  const originalSize = 8 + retained.reduce((sum, part) => sum + part.full.length, 0);
  const replacementSize = compressed
    ? originalSize - ids.reduce((sum, i) => sum + parts[i]!.full.length, 0) + compressed.length + 12
    : Infinity;
  if (
    compressed &&
    replacementSize < originalSize &&
    replacementSize <= CATALOG_IMAGE_PUBLIC_MAX_BYTES
  ) {
    const output: Uint8Array[] = [PNG_SIGNATURE];
    let inserted = false;
    for (const part of retained) {
      if (part.type !== 'IDAT') output.push(part.full);
      else if (!inserted) {
        output.push(pngChunk('IDAT', compressed));
        inserted = true;
      }
    }
    return join(output);
  }
  return join([PNG_SIGNATURE, ...retained.map(part => part.full)]);
}

/** Keep JPEG scan coefficients, quantizers and all rendering metadata intact. */
function optimizeJpeg(bytes: Uint8Array): Uint8Array {
  const parts = [bytes.subarray(0, 2)];
  let offset = 2;
  while (offset < bytes.length) {
    const start = offset;
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++]!;
    if (marker === 0xd9 || marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(bytes.subarray(start, offset));
      continue;
    }
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
        marker
      )
    ) {
      if (
        ![0xc0, 0xc2].includes(marker) ||
        bytes[offset + 2] !== 8 ||
        ![1, 3].includes(bytes[offset + 7]!)
      )
        fail('IMAGE_UNSUPPORTED_FORMAT');
    }
    offset += length;
    if (marker === 0xda) {
      while (offset < bytes.length) {
        if (bytes[offset] !== 255) {
          offset++;
          continue;
        }
        const next = bytes[offset + 1]!;
        if (next === 0 || (next >= 0xd0 && next <= 0xd7)) {
          offset += 2;
          continue;
        }
        break;
      }
    }
    if (marker !== 0xfe) parts.push(bytes.subarray(start, offset));
  }
  return join(parts);
}

async function webpPng(
  bytes: Uint8Array,
  source: ValidatedCatalogImage,
  signal?: AbortSignal
): Promise<Uint8Array> {
  if (source.width * source.height > CATALOG_IMAGE_WEBP_MAX_PIXELS)
    throw new TeamFunctionError('IMAGE_DIMENSIONS_INVALID');
  const decodeParts: Uint8Array[] = [];
  let icc: Uint8Array | null = null;
  let exif: Uint8Array | null = null;
  for (let offset = 12; offset < bytes.length;) {
    const type = ascii(bytes, offset, 4);
    const length = u32(bytes, offset + 4, true);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'ICCP') {
      if (icc || length > 1_000_000) fail('IMAGE_CONTENT_INVALID');
      icc = data;
    } else if (type === 'EXIF') {
      if (exif || length > 1_000_000) fail('IMAGE_CONTENT_INVALID');
      exif = data;
    } else if (type === 'VP8X') {
      const copy = bytes.slice(offset, offset + length + 8);
      copy[8] = copy[8]! & ~(32 | 8 | 4);
      decodeParts.push(copy);
    } else if (type === 'VP8 ' || type === 'VP8L' || type === 'ALPH')
      decodeParts.push(bytes.subarray(offset, offset + 8 + length + (length & 1)));
    offset += 8 + length + (length & 1);
  }
  const riff = new Uint8Array(12);
  riff.set(text.encode('RIFF'), 0);
  riff.set(text.encode('WEBP'), 8);
  const bitstreamSize = decodeParts.reduce((sum, part) => sum + part.length, 0);
  new DataView(riff.buffer).setUint32(4, bitstreamSize + 4, true);
  // Bound copied decoder input separately from a source's removable metadata.
  // A 50 MB metadata-heavy source may decode, but its image bitstream is <=8 MB.
  const bitstream = join([riff, ...decodeParts]);
  signal?.throwIfAborted();
  const { decodeCatalogWebp } = await import('./catalog-webp/index.ts');
  const decoded = await decodeCatalogWebp(bitstream);
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, decoded.width);
  view.setUint32(4, decoded.height);
  header[8] = 8;
  header[9] = 6;
  let row = 0;
  let compressed: Uint8Array | null;
  try {
    if (decoded.width !== source.width || decoded.height !== source.height)
      fail('IMAGE_CONTENT_INVALID');
    compressed = await collect(
      new ReadableStream<BufferSource>({
        pull(controller) {
          signal?.throwIfAborted();
          if (row === decoded.height) {
            controller.close();
            return;
          }
          // Lossless Sub filtering needs one row; no second complete RGBA buffer.
          const width = decoded.width * 4;
          const filtered = new Uint8Array(width + 1);
          filtered[0] = 1;
          const start = row * width;
          for (let i = 0; i < width; i++)
            filtered[i + 1] =
              (decoded.data[start + i]! - (i >= 4 ? decoded.data[start + i - 4]! : 0)) & 255;
          controller.enqueue(filtered);
          row++;
        }
      }).pipeThrough(new CompressionStream('deflate')),
      signal
    );
  } finally {
    // This buffer is an owned copy, never the caller's encoded input or WASM
    // linear memory. Release it before metadata/readback rather than waiting for GC.
    releaseNativeChunk(decoded.data);
  }
  if (!compressed) fail('IMAGE_TOO_LARGE');
  const output = [PNG_SIGNATURE, pngChunk('IHDR', header)];
  if (icc) {
    const packed = await collect(
      streamParts([icc], signal).pipeThrough(new CompressionStream('deflate')),
      signal
    );
    if (!packed) fail('IMAGE_TOO_LARGE');
    output.push(pngChunk('iCCP', join([text.encode('ICC'), Uint8Array.of(0, 0), packed])));
  } else output.push(pngChunk('sRGB', Uint8Array.of(0)));
  if (exif)
    output.push(pngChunk('eXIf', ascii(exif, 0, 6) === 'Exif\0\0' ? exif.subarray(6) : exif));
  output.push(pngChunk('IDAT', compressed), pngChunk('IEND', new Uint8Array()));
  return join(output);
}

/** One deterministic canonical representation, shared by local and Drive imports. */
export async function optimizeCatalogImage(
  bytes: Uint8Array,
  declaredMime?: string,
  signal?: AbortSignal
): Promise<OptimizedCatalogImage> {
  signal?.throwIfAborted();
  boundStructure(bytes);
  const source = await validateCatalogImage(bytes, declaredMime);
  if (source.width < CATALOG_IMAGE_PUBLIC_MIN_SIDE || source.height < CATALOG_IMAGE_PUBLIC_MIN_SIDE)
    throw new TeamFunctionError('IMAGE_DIMENSIONS_INVALID', { retryable: false });
  signal?.throwIfAborted();
  let output: Uint8Array;
  try {
    if (source.mime === 'image/jpeg' && source.width * source.height > 4_000_000)
      throw new TeamFunctionError('IMAGE_DIMENSIONS_INVALID', { retryable: false });
    if (source.mime === 'image/webp' && source.size > CATALOG_IMAGE_PUBLIC_MAX_BYTES)
      fail('IMAGE_TOO_LARGE');
    output =
      source.mime === 'image/jpeg'
        ? optimizeJpeg(bytes)
        : source.mime === 'image/png'
          ? await optimizePng(bytes, signal)
          : await webpPng(bytes, source, signal);
    if (source.mime === 'image/jpeg') {
      try {
        const { assertCatalogJpegDecodes } = await import('./catalog-jpeg/index.ts');
        assertCatalogJpegDecodes(output, source.width, source.height);
      } catch (error) {
        if (error instanceof Error && error.message === 'JPEG_RESOURCE_LIMIT')
          throw new TeamFunctionError('IMAGE_DIMENSIONS_INVALID', { retryable: false });
        fail('IMAGE_CONTENT_INVALID');
      }
    }
  } catch (error) {
    if (error instanceof TeamFunctionError || signal?.aborted) throw error;
    fail('IMAGE_CONTENT_INVALID');
  }
  const image = await validateCatalogImage(output);
  if (image.width !== source.width || image.height !== source.height || image.mime === 'image/webp')
    fail('IMAGE_CONTENT_INVALID');
  return {
    bytes: output,
    image: {
      ...image,
      sourceSize: source.size,
      sourceSha256: source.sha256,
      optimizationVersion: CATALOG_IMAGE_OPTIMIZATION_VERSION
    }
  };
}
