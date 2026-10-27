import { TeamFunctionError } from './errors.ts';

export const CATALOG_IMAGE_MAX_BYTES = 50_000_000;
export const CATALOG_IMAGE_MAX_PIXELS = 16_000_000;

export interface ValidatedCatalogImage {
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
  orientation: 1;
  size: number;
  sha256: string;
}

function invalid(): never {
  throw new TeamFunctionError('IMAGE_CONTENT_INVALID', { retryable: false });
}

function dimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > CATALOG_IMAGE_MAX_PIXELS
  ) {
    throw new TeamFunctionError('IMAGE_DIMENSIONS_INVALID', { retryable: false });
  }
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  if (start < 0 || start + length > bytes.length) invalid();
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function u32(bytes: Uint8Array, start: number, little = false): number {
  if (start < 0 || start + 4 > bytes.length) invalid();
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(start, little);
}

/** Checks only TIFF metadata, never decodes raster pixels. */
function orientation(bytes: Uint8Array): void {
  let base = 0;
  if (bytes.length >= 6 && ascii(bytes, 0, 6) === 'Exif\0\0') base = 6;
  if (bytes.length - base < 8) invalid();
  const order = ascii(bytes, base, 2);
  if (order !== 'II' && order !== 'MM') invalid();
  const little = order === 'II';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const short = (at: number): number => {
    if (at < base || at + 2 > bytes.length) invalid();
    return view.getUint16(at, little);
  };
  if (short(base + 2) !== 42) invalid();
  const at = base + u32(bytes, base + 4, little);
  const count = short(at);
  if (count > 4096 || at + 2 + count * 12 + 4 > bytes.length) invalid();
  let found = false;
  for (let index = 0; index < count; index += 1) {
    const entry = at + 2 + index * 12;
    if (short(entry) !== 0x112) continue;
    if (found || short(entry + 2) !== 3 || u32(bytes, entry + 4, little) !== 1) invalid();
    found = true;
    if (short(entry + 8) !== 1) {
      throw new TeamFunctionError('IMAGE_ORIENTATION_UNSUPPORTED', { retryable: false });
    }
  }
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function png(bytes: Uint8Array): { width: number; height: number } {
  let offset = 8;
  let width = 0;
  let height = 0;
  let data = false;
  let ended = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) invalid();
    const length = u32(bytes, offset);
    const end = offset + 12 + length;
    if (end > bytes.length || ended) invalid();
    const type = ascii(bytes, offset + 4, 4);
    if (!/^[A-Za-z]{4}$/u.test(type)) invalid();
    let crc = 0xffffffff;
    for (let at = offset + 4; at < end - 4; at += 1)
      crc = CRC_TABLE[(crc ^ bytes[at]!) & 255]! ^ (crc >>> 8);
    if ((crc ^ 0xffffffff) >>> 0 !== u32(bytes, end - 4)) invalid();
    if (offset === 8 && type !== 'IHDR') invalid();
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13) invalid();
      width = u32(bytes, offset + 8);
      height = u32(bytes, offset + 12);
      dimensions(width, height);
      const bitDepth = bytes[offset + 16]!;
      const colour = bytes[offset + 17]!;
      const depths: Record<number, readonly number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16]
      };
      if (
        !depths[colour]?.includes(bitDepth) ||
        bytes[offset + 18] !== 0 ||
        bytes[offset + 19] !== 0 ||
        bytes[offset + 20]! > 1
      )
        invalid();
    } else if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') {
      throw new TeamFunctionError('IMAGE_ANIMATED_UNSUPPORTED', { retryable: false });
    } else if (type === 'IDAT') data = data || length > 0;
    else if (type === 'eXIf') orientation(bytes.subarray(offset + 8, end - 4));
    else if (type === 'IEND') {
      if (length !== 0 || !data || end !== bytes.length) invalid();
      ended = true;
    }
    offset = end;
  }
  if (!ended || !width || !height) invalid();
  return { width, height };
}

function jpeg(bytes: Uint8Array): { width: number; height: number } {
  let offset = 2;
  let width = 0;
  let height = 0;
  let scan = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) invalid();
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!scan || !width || offset !== bytes.length) invalid();
      return { width, height };
    }
    if (marker === undefined || marker === 0 || marker === 0xd8) invalid();
    if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) invalid();
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.length) invalid();
    if (marker === 0xe1 && length >= 8 && ascii(bytes, offset + 2, 6) === 'Exif\0\0')
      orientation(bytes.subarray(offset + 2, offset + length));
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (width || length < 8) invalid();
      height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!;
      width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      dimensions(width, height);
    }
    offset += length;
    if (marker === 0xda) {
      scan = true;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const next = bytes[offset + 1];
        if (next === 0 || (next !== undefined && next >= 0xd0 && next <= 0xd7)) {
          offset += 2;
          continue;
        }
        break;
      }
    }
  }
  return invalid();
}

function webp(bytes: Uint8Array): { width: number; height: number } {
  if (u32(bytes, 4, true) + 8 !== bytes.length) invalid();
  let offset = 12;
  let width = 0;
  let height = 0;
  let frame = false;
  while (offset < bytes.length) {
    const type = ascii(bytes, offset, 4);
    const length = u32(bytes, offset + 4, true);
    const at = offset + 8;
    if (at + length > bytes.length) invalid();
    if (type === 'ANIM' || type === 'ANMF' || (type === 'VP8X' && (bytes[at]! & 2) !== 0))
      throw new TeamFunctionError('IMAGE_ANIMATED_UNSUPPORTED', { retryable: false });
    if (type === 'VP8X') {
      if (length !== 10 || width) invalid();
      width = 1 + bytes[at + 4]! + (bytes[at + 5]! << 8) + (bytes[at + 6]! << 16);
      height = 1 + bytes[at + 7]! + (bytes[at + 8]! << 8) + (bytes[at + 9]! << 16);
    } else if (type === 'VP8 ') {
      if (
        length < 10 ||
        frame ||
        bytes[at + 3] !== 0x9d ||
        bytes[at + 4] !== 1 ||
        bytes[at + 5] !== 0x2a
      )
        invalid();
      const w = ((bytes[at + 7]! << 8) | bytes[at + 6]!) & 0x3fff;
      const h = ((bytes[at + 9]! << 8) | bytes[at + 8]!) & 0x3fff;
      if (width && (width !== w || height !== h)) invalid();
      width = w;
      height = h;
      frame = true;
    } else if (type === 'VP8L') {
      if (length < 5 || frame || bytes[at] !== 0x2f) invalid();
      const bits = u32(bytes, at + 1, true);
      const w = 1 + (bits & 0x3fff);
      const h = 1 + ((bits >>> 14) & 0x3fff);
      if (bits >>> 29 !== 0 || (width && (width !== w || height !== h))) invalid();
      width = w;
      height = h;
      frame = true;
    } else if (type === 'EXIF') orientation(bytes.subarray(at, at + length));
    offset = at + length + (length & 1);
  }
  if (!frame || offset !== bytes.length) invalid();
  dimensions(width, height);
  return { width, height };
}

export async function validateCatalogImage(
  bytes: Uint8Array,
  declaredMime?: string
): Promise<ValidatedCatalogImage> {
  if (bytes.length < 1 || bytes.length > CATALOG_IMAGE_MAX_BYTES)
    throw new TeamFunctionError('IMAGE_TOO_LARGE', { retryable: false });
  let mime: ValidatedCatalogImage['mime'];
  let geometry: { width: number; height: number };
  if (bytes.length >= 8 && ascii(bytes, 0, 8) === '\x89PNG\r\n\x1a\n') {
    mime = 'image/png';
    geometry = png(bytes);
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    mime = 'image/jpeg';
    geometry = jpeg(bytes);
  } else if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    mime = 'image/webp';
    geometry = webp(bytes);
  } else throw new TeamFunctionError('IMAGE_UNSUPPORTED_FORMAT', { retryable: false });
  if (declaredMime && declaredMime !== 'application/octet-stream' && declaredMime !== mime)
    invalid();
  const digestInput =
    bytes.buffer instanceof ArrayBuffer
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : Uint8Array.from(bytes);
  const sha = new Uint8Array(await crypto.subtle.digest('SHA-256', digestInput));
  return {
    ...geometry,
    mime,
    orientation: 1,
    size: bytes.length,
    sha256: Array.from(sha, b => b.toString(16).padStart(2, '0')).join('')
  };
}

export async function readCatalogImageBytes(response: Response, size: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(size) || size < 1 || size > CATALOG_IMAGE_MAX_BYTES)
    throw new TeamFunctionError('IMAGE_TOO_LARGE', { retryable: false });
  if (!response.ok || !response.body)
    throw new TeamFunctionError('IMAGE_SOURCE_UNAVAILABLE', { retryable: true });
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) !== size) {
    await response.body.cancel();
    if (Number(length) > size) throw new TeamFunctionError('IMAGE_TOO_LARGE', { retryable: false });
    invalid();
  }
  const bytes = new Uint8Array(size);
  const reader = response.body.getReader();
  let offset = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (offset + part.value.length > size)
        throw new TeamFunctionError('IMAGE_TOO_LARGE', { retryable: false });
      bytes.set(part.value, offset);
      offset += part.value.length;
    }
    if (offset !== size) invalid();
    return bytes;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
