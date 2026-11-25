/**
 * Removing what a media file says about where it came from (073).
 *
 * A creative that leaves Soty — downloaded, copied into a catalog, sent to R2 or to Facebook —
 * must carry its pictures and its sound and nothing else: no camera, no phone model, no GPS, no
 * date it was shot, no editing software, no author. This module does that without re-encoding:
 * every pixel and every audio sample stays byte-for-byte what it was, so the file looks and
 * plays exactly as before and the work costs a pass over the headers, not a transcode.
 *
 * Two shapes of work, chosen by how the format is laid out:
 *
 * - Images (JPEG, PNG, WebP, GIF) are small and their metadata sits in self-describing
 *   segments, so the file is rebuilt in memory with only the segments a decoder needs.
 * - ISO-BMFF (MP4, MOV, M4V, 3GP, HEIC/AVIF) can be gigabytes and its sample tables point at
 *   absolute byte offsets, so nothing moves: metadata boxes are turned into `free` boxes of the
 *   same size with zeroed contents, dates are zeroed, names are blanked. The result is a list of
 *   patches, which is how the agent scrubs a file on disk without reading the media.
 *
 * What is deliberately kept, because it changes how the picture looks and identifies no one:
 * the colour profile (ICC, `colr`, `sRGB`, `gAMA`, `cHRM`, HDR boxes), the track matrix and the
 * image orientation. An EXIF Orientation other than "normal" survives as a minimal EXIF block
 * holding that one tag: rotating the pixels instead would mean re-encoding a JPEG, which loses
 * quality, and dropping the tag would turn every portrait phone photo on its side.
 */

export type MediaMetadataFormat = 'jpeg' | 'png' | 'webp' | 'gif' | 'isobmff' | 'heif' | 'unknown';

/** One write into the original bytes. `data` absent means "fill `length` bytes with zeros". */
export interface MediaMetadataPatch {
  offset: number;
  length: number;
  data?: Uint8Array;
}

export interface MediaMetadataStripResult {
  format: MediaMetadataFormat;
  /** False for a format this module does not understand; `bytes` is then the input, untouched. */
  supported: boolean;
  /** True when at least one byte differs from the input. */
  changed: boolean;
  bytes: Uint8Array;
}

/** Random access to a file too large to hold: the agent backs this with a file handle. */
export interface MediaByteSource {
  size: number;
  read(offset: number, length: number): Uint8Array;
}

export interface MediaMetadataPatchPlan {
  format: MediaMetadataFormat;
  supported: boolean;
  patches: MediaMetadataPatch[];
}

/**
 * File names whose contents can carry identifying metadata and are cleaned on the way out:
 * pictures and video. Everything else (documents, archives, text) leaves as it is.
 */
const METADATA_BEARING_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'jfif',
  'png',
  'apng',
  'webp',
  'gif',
  'heic',
  'heif',
  'avif',
  'mp4',
  'm4v',
  'mov',
  'qt',
  '3gp',
  '3g2',
  'mkv',
  'webm',
  'avi',
  'flv',
  'wmv',
  'asf',
  'mpg',
  'mpeg',
  'ts',
  'm2ts',
  'mts',
  'ogv'
]);

export function isMetadataBearingFileName(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 && METADATA_BEARING_EXTENSIONS.has(fileName.slice(dot + 1).toLowerCase());
}

/** The largest `moov` (or HEIF `meta`) read into memory; real ones are a few MB at most. */
export const MEDIA_METADATA_MAX_HEADER_BYTES = 256 * 1024 * 1024;

const ascii = (bytes: Uint8Array, start: number, length: number): string => {
  let out = '';
  for (let i = start; i < start + length && i < bytes.length; i += 1) {
    out += String.fromCharCode(bytes[i]!);
  }
  return out;
};

const u16be = (b: Uint8Array, o: number): number => (b[o]! << 8) | b[o + 1]!;
const u32be = (b: Uint8Array, o: number): number =>
  ((b[o]! << 24) >>> 0) + ((b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!);
const u64be = (b: Uint8Array, o: number): number => u32be(b, o) * 0x1_0000_0000 + u32be(b, o + 4);

const ISOBMFF_LEADING_TYPES = new Set([
  'ftyp',
  'moov',
  'mdat',
  'free',
  'skip',
  'wide',
  'pnot',
  'styp'
]);
const HEIF_BRANDS = new Set([
  'heic',
  'heix',
  'heim',
  'heis',
  'mif1',
  'mif2',
  'avif',
  'avci',
  'jpgh'
]);
const HEIF_SEQUENCE_BRANDS = new Set(['msf1', 'hevc', 'hevx', 'hevm', 'hevs', 'avis']);

export function detectMediaMetadataFormat(bytes: Uint8Array): MediaMetadataFormat {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'jpeg';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    ascii(bytes, 1, 3) === 'PNG' &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP')
    return 'webp';
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a'))
    return 'gif';
  if (bytes.length >= 8 && ISOBMFF_LEADING_TYPES.has(ascii(bytes, 4, 4))) {
    if (ascii(bytes, 4, 4) === 'ftyp' && isHeifImageBrand(bytes)) return 'heif';
    return 'isobmff';
  }
  return 'unknown';
}

function isHeifImageBrand(bytes: Uint8Array): boolean {
  const size = u32be(bytes, 0);
  if (size < 16 || size > bytes.length) return false;
  const major = ascii(bytes, 8, 4);
  if (HEIF_SEQUENCE_BRANDS.has(major)) return false;
  if (HEIF_BRANDS.has(major)) return true;
  // A `qt  ` or `mp42` file that also lists `mif1` is still a movie.
  return false;
}

/**
 * Strips a whole file held in memory. Images are rebuilt; ISO-BMFF is patched in a copy. The input
 * is never modified.
 */
export function stripMediaMetadata(input: Uint8Array): MediaMetadataStripResult {
  const format = detectMediaMetadataFormat(input);
  try {
    switch (format) {
      case 'jpeg':
        return rebuilt(format, input, stripJpeg(input));
      case 'png':
        return rebuilt(format, input, stripPng(input));
      case 'webp':
        return rebuilt(format, input, stripWebp(input));
      case 'gif':
        return rebuilt(format, input, stripGif(input));
      case 'isobmff':
      case 'heif': {
        const plan = planIsoBmffMetadataPatches(memorySource(input));
        if (!plan.supported) return { format, supported: false, changed: false, bytes: input };
        const bytes = applyMediaMetadataPatches(input, plan.patches);
        return { format, supported: true, changed: !sameBytes(bytes, input), bytes };
      }
      default:
        return { format, supported: false, changed: false, bytes: input };
    }
  } catch {
    // A file we cannot walk is reported as unsupported rather than half-cleaned.
    return { format, supported: false, changed: false, bytes: input };
  }
}

function rebuilt(
  format: MediaMetadataFormat,
  input: Uint8Array,
  output: Uint8Array | null
): MediaMetadataStripResult {
  if (!output) return { format, supported: false, changed: false, bytes: input };
  return { format, supported: true, changed: !sameBytes(output, input), bytes: output };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

export function memorySource(bytes: Uint8Array): MediaByteSource {
  return {
    size: bytes.length,
    read: (offset, length) => bytes.subarray(offset, Math.min(bytes.length, offset + length))
  };
}

export function applyMediaMetadataPatches(
  input: Uint8Array,
  patches: readonly MediaMetadataPatch[]
): Uint8Array {
  if (patches.length === 0) return input;
  const out = new Uint8Array(input);
  for (const patch of patches) {
    if (patch.offset < 0 || patch.offset + patch.length > out.length)
      throw new Error('patch out of range');
    if (patch.data) out.set(patch.data.subarray(0, patch.length), patch.offset);
    else out.fill(0, patch.offset, patch.offset + patch.length);
  }
  return out;
}

class ByteWriter {
  private chunks: Uint8Array[] = [];
  private total = 0;
  push(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.total += chunk.length;
  }
  finish(): Uint8Array {
    const out = new Uint8Array(this.total);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
}

/* ------------------------------------------------------------------------------------------ */
/* EXIF orientation                                                                             */
/* ------------------------------------------------------------------------------------------ */

/** Reads tag 0x0112 from IFD0 of a TIFF structure; 1 when absent or unreadable. */
export function readTiffOrientation(tiff: Uint8Array): number {
  if (tiff.length < 8) return 1;
  const order = ascii(tiff, 0, 2);
  const little = order === 'II';
  if (!little && order !== 'MM') return 1;
  const r16 = (o: number) => (little ? tiff[o]! | (tiff[o + 1]! << 8) : u16be(tiff, o));
  const r32 = (o: number) =>
    little
      ? (tiff[o]! | (tiff[o + 1]! << 8) | (tiff[o + 2]! << 16) | (tiff[o + 3]! << 24)) >>> 0
      : u32be(tiff, o);
  if (r16(2) !== 42) return 1;
  const ifd = r32(4);
  if (ifd + 2 > tiff.length) return 1;
  const count = r16(ifd);
  for (let i = 0; i < count; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) return 1;
    if (r16(entry) === 0x0112) {
      const value = r16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

/** A big-endian TIFF whose IFD0 holds only Orientation. */
function minimalOrientationTiff(orientation: number): Uint8Array {
  return Uint8Array.from([
    0x4d,
    0x4d,
    0x00,
    0x2a,
    0x00,
    0x00,
    0x00,
    0x08, // header, IFD0 at 8
    0x00,
    0x01, // one entry
    0x01,
    0x12,
    0x00,
    0x03,
    0x00,
    0x00,
    0x00,
    0x01,
    orientation >> 8,
    orientation & 0xff,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00 // no next IFD
  ]);
}

/* ------------------------------------------------------------------------------------------ */
/* JPEG                                                                                         */
/* ------------------------------------------------------------------------------------------ */

const EXIF_HEADER = Uint8Array.from([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);

function stripJpeg(input: Uint8Array): Uint8Array | null {
  let at = 2;
  let orientation = 1;
  const kept: { marker: number; bytes: Uint8Array }[] = [];
  while (at + 4 <= input.length) {
    if (input[at] !== 0xff) return null;
    const marker = input[at + 1]!;
    if (marker === 0xff) {
      at += 1; // fill byte
      continue;
    }
    if (marker === 0xda) {
      // Start of scan: everything up to the first EOI is the picture. Anything after it — an MPF
      // secondary image, a gain map, a vendor trailer — is another file with its own metadata.
      const end = findJpegEnd(input, at);
      if (end < 0) return null;
      const out = new ByteWriter();
      out.push(input.subarray(0, 2));
      // JFIF must follow SOI directly, wherever the source had it.
      const jfif = kept.findIndex(segment => segment.marker === 0xe0);
      if (jfif >= 0) out.push(kept.splice(jfif, 1)[0]!.bytes);
      if (orientation !== 1) {
        const tiff = minimalOrientationTiff(orientation);
        const length = 2 + EXIF_HEADER.length + tiff.length;
        out.push(Uint8Array.from([0xff, 0xe1, length >> 8, length & 0xff]));
        out.push(EXIF_HEADER);
        out.push(tiff);
      }
      for (const segment of kept) out.push(segment.bytes);
      out.push(input.subarray(at, end));
      return out.finish();
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2;
      continue;
    }
    if (marker === 0xd8 || marker === 0xd9) return null;
    const length = u16be(input, at + 2);
    if (length < 2 || at + 2 + length > input.length) return null;
    const payload = input.subarray(at + 4, at + 2 + length);
    if (marker === 0xe1 && startsWith(payload, EXIF_HEADER)) {
      if (orientation === 1) orientation = readTiffOrientation(payload.subarray(6));
    } else if (keepJpegSegment(marker, payload)) {
      kept.push({ marker, bytes: input.subarray(at, at + 2 + length) });
    }
    at += 2 + length;
  }
  return null;
}

function keepJpegSegment(marker: number, payload: Uint8Array): boolean {
  if (marker === 0xe0) return startsWithAscii(payload, 'JFIF\0'); // JFXX thumbnails go
  if (marker === 0xe2) return startsWithAscii(payload, 'ICC_PROFILE\0'); // MPF, FPXR go
  if (marker === 0xee) return startsWithAscii(payload, 'Adobe'); // colour transform, needed to decode
  if (marker >= 0xe0 && marker <= 0xef) return false; // EXIF, XMP, IPTC, JUMBF/C2PA, vendor blocks
  if (marker === 0xfe) return false; // comments
  return true; // tables, frame headers, restart interval
}

/** Offset just past the first EOI after a scan begins, or -1. */
function findJpegEnd(input: Uint8Array, scanStart: number): number {
  for (let i = scanStart + 2; i + 1 < input.length; i += 1) {
    if (input[i] !== 0xff) continue;
    const next = input[i + 1]!;
    if (next === 0xd9) return i + 2;
    if (next === 0x00 || next === 0xff || (next >= 0xd0 && next <= 0xd7)) continue;
    // A segment between progressive scans (DHT, SOS, DRI): step over its length so bytes inside
    // it are not mistaken for a marker.
    if (i + 3 < input.length) {
      const length = u16be(input, i + 2);
      if (length >= 2) i += 1 + length;
    }
  }
  return -1;
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) if (bytes[i] !== prefix[i]) return false;
  return true;
}

function startsWithAscii(bytes: Uint8Array, prefix: string): boolean {
  return bytes.length >= prefix.length && ascii(bytes, 0, prefix.length) === prefix;
}

/* ------------------------------------------------------------------------------------------ */
/* PNG                                                                                          */
/* ------------------------------------------------------------------------------------------ */

const PNG_KEPT_ANCILLARY = new Set([
  'tRNS',
  'cHRM',
  'gAMA',
  'iCCP',
  'sBIT',
  'sRGB',
  'cICP',
  'mDCv',
  'cLLi',
  'mDCV',
  'cLLI',
  'bKGD',
  'hIST',
  'pHYs',
  'sPLT',
  'acTL',
  'fcTL',
  'fdAT'
]);

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = crcTable[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function stripPng(input: Uint8Array): Uint8Array | null {
  const out = new ByteWriter();
  out.push(input.subarray(0, 8));
  let at = 8;
  let orientation = 1;
  const chunks: { type: string; bytes: Uint8Array }[] = [];
  while (at + 12 <= input.length) {
    const length = u32be(input, at);
    const type = ascii(input, at + 4, 4);
    const end = at + 12 + length;
    if (end > input.length) return null;
    if (type === 'eXIf') {
      if (orientation === 1)
        orientation = readTiffOrientation(input.subarray(at + 8, at + 8 + length));
    } else {
      const critical = (input[at + 4]! & 0x20) === 0;
      if (critical || PNG_KEPT_ANCILLARY.has(type))
        chunks.push({ type, bytes: input.subarray(at, end) });
    }
    at = end;
    if (type === 'IEND') break;
  }
  if (
    chunks.length === 0 ||
    chunks[0]!.type !== 'IHDR' ||
    chunks[chunks.length - 1]!.type !== 'IEND'
  )
    return null;
  for (const chunk of chunks) {
    out.push(chunk.bytes);
    if (chunk.type === 'IHDR' && orientation !== 1)
      out.push(pngChunk('eXIf', minimalOrientationTiff(orientation)));
  }
  return out.finish();
}

/* ------------------------------------------------------------------------------------------ */
/* WebP                                                                                         */
/* ------------------------------------------------------------------------------------------ */

const WEBP_KEPT = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);

function stripWebp(input: Uint8Array): Uint8Array | null {
  let at = 12;
  const riffEnd = Math.min(input.length, 8 + u32le(input, 4));
  let orientation = 1;
  const chunks: Uint8Array[] = [];
  let vp8xIndex = -1;
  while (at + 8 <= riffEnd) {
    const type = ascii(input, at, 4);
    const length = u32le(input, at + 4);
    const end = at + 8 + length + (length & 1);
    if (at + 8 + length > riffEnd) return null;
    if (type === 'EXIF') {
      const payload = input.subarray(at + 8, at + 8 + length);
      const tiff = startsWith(payload, EXIF_HEADER) ? payload.subarray(6) : payload;
      if (orientation === 1) orientation = readTiffOrientation(tiff);
    } else if (WEBP_KEPT.has(type)) {
      if (type === 'VP8X') vp8xIndex = chunks.length;
      chunks.push(new Uint8Array(input.subarray(at, Math.min(end, riffEnd))));
    }
    at = end;
  }
  if (vp8xIndex >= 0) {
    const vp8x = chunks[vp8xIndex]!;
    vp8x[8] = vp8x[8]! & ~0x0c; // EXIF and XMP flags
    if (orientation !== 1) vp8x[8] = vp8x[8]! | 0x08;
  }
  if (orientation !== 1 && vp8xIndex >= 0) {
    const tiff = minimalOrientationTiff(orientation);
    const chunk = new Uint8Array(8 + tiff.length + (tiff.length & 1));
    chunk.set([0x45, 0x58, 0x49, 0x46]);
    new DataView(chunk.buffer).setUint32(4, tiff.length, true);
    chunk.set(tiff, 8);
    chunks.push(chunk); // EXIF goes after the image data
  }
  const body = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(12 + body);
  out.set(input.subarray(0, 12));
  new DataView(out.buffer).setUint32(4, 4 + body, true);
  let w = 12;
  for (const chunk of chunks) {
    out.set(chunk, w);
    w += chunk.length;
  }
  return out;
}

const u32le = (b: Uint8Array, o: number): number =>
  (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

/* ------------------------------------------------------------------------------------------ */
/* GIF                                                                                          */
/* ------------------------------------------------------------------------------------------ */

const GIF_KEPT_APPLICATIONS = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0', 'ICCRGBG1012']);

function stripGif(input: Uint8Array): Uint8Array | null {
  if (input.length < 13) return null;
  const out = new ByteWriter();
  const flags = input[10]!;
  let at = 13 + (flags & 0x80 ? 3 * (1 << ((flags & 0x07) + 1)) : 0);
  if (at > input.length) return null;
  out.push(input.subarray(0, at));
  const skipSubBlocks = (from: number): number => {
    let i = from;
    while (i < input.length) {
      const size = input[i]!;
      i += 1 + size;
      if (size === 0) return i;
    }
    return -1;
  };
  while (at < input.length) {
    const introducer = input[at]!;
    if (introducer === 0x3b) {
      out.push(input.subarray(at, at + 1));
      return out.finish();
    }
    if (introducer === 0x21) {
      const label = input[at + 1]!;
      const end = skipSubBlocks(at + 2);
      if (end < 0) return null;
      let keep = label !== 0xfe; // comments go
      if (label === 0xff) {
        const id = input[at + 2] === 11 ? ascii(input, at + 3, 11) : '';
        keep = GIF_KEPT_APPLICATIONS.has(id); // XMP and other application blocks go
      }
      if (keep) out.push(input.subarray(at, end));
      at = end;
      continue;
    }
    if (introducer === 0x2c) {
      const packed = input[at + 9]!;
      const tableEnd = at + 10 + (packed & 0x80 ? 3 * (1 << ((packed & 0x07) + 1)) : 0);
      const end = skipSubBlocks(tableEnd + 1);
      if (end < 0) return null;
      out.push(input.subarray(at, end));
      at = end;
      continue;
    }
    return null;
  }
  return null;
}

/* ------------------------------------------------------------------------------------------ */
/* ISO-BMFF: MP4, MOV, HEIF                                                                     */
/* ------------------------------------------------------------------------------------------ */

interface BoxHeader {
  type: string;
  start: number;
  headerSize: number;
  end: number;
}

function readBoxHeader(bytes: Uint8Array, at: number, limit: number, base = 0): BoxHeader | null {
  if (at + 8 > limit) return null;
  let size = u32be(bytes, at);
  const type = ascii(bytes, at + 4, 4);
  let headerSize = 8;
  if (size === 1) {
    if (at + 16 > limit) return null;
    size = u64be(bytes, at + 8);
    headerSize = 16;
  } else if (size === 0) {
    size = limit - at;
  }
  if (size < headerSize || at + size > limit) return null;
  return { type, start: base + at, headerSize, end: base + at + size };
}

const FREE = Uint8Array.from([0x66, 0x72, 0x65, 0x65]);
/** Tracks a creative needs: pictures and sound. Everything else — timed metadata (Apple
 *  `mebx`, GoPro GPS), timecode (time of day on most cameras), text tracks (DJI telemetry),
 *  chapters, hint tracks — is erased. */
const KEPT_HANDLERS = new Set(['vide', 'soun']);
const CONTAINERS_IN_TRACK = new Set(['mdia', 'minf', 'stbl', 'edts', 'dinf']);

class PatchSet {
  readonly patches: MediaMetadataPatch[] = [];
  zero(offset: number, length: number): void {
    if (length > 0) this.patches.push({ offset, length });
  }
  write(offset: number, data: Uint8Array): void {
    this.patches.push({ offset, length: data.length, data });
  }
  /** Turns a box into a `free` box of the same size with nothing inside. */
  free(box: BoxHeader): void {
    this.write(box.start + 4, FREE);
    this.zero(box.start + box.headerSize, box.end - box.start - box.headerSize);
  }
}

/**
 * Plans the in-place scrub of an ISO-BMFF file: which bytes to overwrite so that no metadata is
 * left and every offset the sample tables hold still points at the same data.
 */
export function planIsoBmffMetadataPatches(source: MediaByteSource): MediaMetadataPatchPlan {
  const head = source.read(0, Math.min(source.size, 64));
  const format = detectMediaMetadataFormat(head);
  if (format !== 'isobmff' && format !== 'heif') return { format, supported: false, patches: [] };
  const patches = new PatchSet();
  let at = 0;
  let sawMoov = false;
  while (at + 8 <= source.size) {
    const box = readTopLevelHeader(source.read(at, 16), at, source.size);
    if (!box) break;
    switch (box.type) {
      case 'moov': {
        sawMoov = true;
        if (box.end - box.start > MEDIA_METADATA_MAX_HEADER_BYTES)
          return { format, supported: false, patches: [] };
        const moov = source.read(box.start, box.end - box.start);
        scrubMovie(moov, box.start, patches, source);
        break;
      }
      case 'meta':
        if (format === 'heif') {
          if (box.end - box.start > MEDIA_METADATA_MAX_HEADER_BYTES)
            return { format, supported: false, patches: [] };
          scrubHeifMeta(source.read(box.start, box.end - box.start), box.start, patches, source);
        } else {
          patches.free(box);
        }
        break;
      case 'udta':
      case 'uuid':
        patches.free(box);
        break;
      case 'free':
      case 'skip':
      case 'wide':
        // Free space is where editors leave what they replaced; it may hold yesterday's tags.
        patches.zero(box.start + box.headerSize, box.end - box.start - box.headerSize);
        break;
      default:
        break;
    }
    at = box.end;
  }
  if (format === 'isobmff' && !sawMoov) return { format, supported: false, patches: [] };
  return { format, supported: true, patches: patches.patches };
}

/** A top-level box header, read from a 16-byte window; the limit is the file, not the window. */
function readTopLevelHeader(bytes: Uint8Array, at: number, size: number): BoxHeader | null {
  if (bytes.length < 8) return null;
  let boxSize = u32be(bytes, 0);
  const type = ascii(bytes, 4, 4);
  let headerSize = 8;
  if (boxSize === 1) {
    if (bytes.length < 16) return null;
    boxSize = u64be(bytes, 8);
    headerSize = 16;
  } else if (boxSize === 0) {
    boxSize = size - at;
  }
  if (boxSize < headerSize || at + boxSize > size) return null;
  return { type, start: at, headerSize, end: at + boxSize };
}

function children(bytes: Uint8Array, from: number, to: number, base: number): BoxHeader[] {
  const out: BoxHeader[] = [];
  let at = from;
  while (at + 8 <= to) {
    const box = readBoxHeader(bytes, at, to, base);
    if (!box) break;
    out.push(box);
    at = box.end - base;
  }
  return out;
}

/** Zeroes a creation and a modification time of a FullBox laid out like `mvhd`/`tkhd`/`mdhd`. */
function zeroTimes(bytes: Uint8Array, box: BoxHeader, base: number, patches: PatchSet): void {
  const local = box.start - base + box.headerSize;
  if (local + 4 > bytes.length) return;
  const version = bytes[local]!;
  const width = version === 1 ? 8 : 4;
  if (box.end - box.start < box.headerSize + 4 + 2 * width) return;
  patches.zero(box.start + box.headerSize + 4, 2 * width);
}

function scrubMovie(
  moov: Uint8Array,
  base: number,
  patches: PatchSet,
  source: MediaByteSource
): void {
  for (const box of children(moov, 8, moov.length, base)) {
    switch (box.type) {
      case 'mvhd':
        zeroTimes(moov, box, base, patches);
        break;
      case 'trak':
        scrubTrack(moov, box, base, patches, source);
        break;
      case 'udta':
      case 'meta':
      case 'uuid':
        patches.free(box);
        break;
      case 'free':
      case 'skip':
        patches.zero(box.start + box.headerSize, box.end - box.start - box.headerSize);
        break;
      default:
        break;
    }
  }
}

function trackHandler(moov: Uint8Array, trak: BoxHeader, base: number): string {
  const mdia = children(moov, trak.start - base + trak.headerSize, trak.end - base, base).find(
    b => b.type === 'mdia'
  );
  if (!mdia) return '';
  const hdlr = children(moov, mdia.start - base + mdia.headerSize, mdia.end - base, base).find(
    b => b.type === 'hdlr'
  );
  if (!hdlr) return '';
  return ascii(moov, hdlr.start - base + hdlr.headerSize + 8, 4);
}

function scrubTrack(
  moov: Uint8Array,
  trak: BoxHeader,
  base: number,
  patches: PatchSet,
  source: MediaByteSource
): void {
  const handler = trackHandler(moov, trak, base);
  if (!KEPT_HANDLERS.has(handler)) {
    for (const range of trackSampleRanges(moov, trak, base, source.size))
      patches.zero(range.offset, range.length);
    patches.free(trak);
    return;
  }
  const visit = (parent: BoxHeader): void => {
    for (const box of children(
      moov,
      parent.start - base + parent.headerSize,
      parent.end - base,
      base
    )) {
      switch (box.type) {
        case 'tkhd':
        case 'mdhd':
          zeroTimes(moov, box, base, patches);
          break;
        case 'hdlr': {
          // version/flags, pre_defined, handler_type, reserved[3]; the rest is the name
          // ("Core Media Video", "Mainconcept Video Media Handler", "L-SMASH Audio Handler").
          const nameStart = box.start + box.headerSize + 24;
          patches.zero(nameStart, box.end - nameStart);
          break;
        }
        case 'udta':
        case 'meta':
        case 'uuid':
          patches.free(box);
          break;
        case 'free':
        case 'skip':
          patches.zero(box.start + box.headerSize, box.end - box.start - box.headerSize);
          break;
        case 'stsd':
          blankSampleEntryNames(moov, box, base, patches, handler === 'vide');
          break;
        default:
          if (CONTAINERS_IN_TRACK.has(box.type)) visit(box);
          break;
      }
    }
  };
  visit(trak);
  if (handler === 'vide') blankEncoderSei(moov, trak, base, patches, source);
}

/**
 * A sample entry names who wrote it: QuickTime's 4-byte `vendor` ("FFMP", "appl") in every entry,
 * and a visual entry's 32-byte `compressorname` ("Lavc60 libx264"). Both are informational; in
 * ISO files the same bytes are reserved zeros.
 */
function blankSampleEntryNames(
  moov: Uint8Array,
  stsd: BoxHeader,
  base: number,
  patches: PatchSet,
  visual: boolean
): void {
  const entriesStart = stsd.start - base + stsd.headerSize + 8; // version/flags + entry_count
  for (const entry of children(moov, entriesStart, stsd.end - base, base)) {
    const body = entry.start + entry.headerSize;
    if (body + 16 <= entry.end) patches.zero(body + 12, 4);
    if (visual && body + 74 <= entry.end) patches.zero(body + 42, 32);
  }
}

interface ByteRange {
  offset: number;
  length: number;
}

function findChild(
  moov: Uint8Array,
  parent: BoxHeader | undefined,
  base: number,
  type: string,
  skip = 0
): BoxHeader | undefined {
  if (!parent) return undefined;
  return children(
    moov,
    parent.start - base + parent.headerSize + skip,
    parent.end - base,
    base
  ).find(b => b.type === type);
}

/** Each sample of a track as a file range, in decode order; stops after `limit` samples. */
function trackSamples(
  moov: Uint8Array,
  trak: BoxHeader,
  base: number,
  limit = Infinity
): ByteRange[] {
  const stbl = findChild(
    moov,
    findChild(moov, findChild(moov, trak, base, 'mdia'), base, 'minf'),
    base,
    'stbl'
  );
  if (!stbl) return [];
  const boxes = children(moov, stbl.start - base + stbl.headerSize, stbl.end - base, base);
  const body = (b: BoxHeader) => b.start - base + b.headerSize;
  const stco = boxes.find(b => b.type === 'stco' || b.type === 'co64');
  const stsc = boxes.find(b => b.type === 'stsc');
  const stsz = boxes.find(b => b.type === 'stsz');
  if (!stco || !stsc || !stsz) return [];
  const chunkCount = u32be(moov, body(stco) + 4);
  const runs: { first: number; perChunk: number }[] = [];
  const stscCount = u32be(moov, body(stsc) + 4);
  for (let i = 0; i < stscCount; i += 1) {
    runs.push({
      first: u32be(moov, body(stsc) + 8 + i * 12),
      perChunk: u32be(moov, body(stsc) + 12 + i * 12)
    });
  }
  const uniformSize = u32be(moov, body(stsz) + 4);
  const sampleCount = Math.min(u32be(moov, body(stsz) + 8), limit);
  const sampleSize = (n: number) =>
    uniformSize !== 0 ? uniformSize : u32be(moov, body(stsz) + 12 + n * 4);
  const samples: ByteRange[] = [];
  let run = 0;
  for (let chunk = 0; chunk < chunkCount && samples.length < sampleCount; chunk += 1) {
    while (run + 1 < runs.length && runs[run + 1]!.first <= chunk + 1) run += 1;
    const perChunk = runs[run]?.perChunk ?? 0;
    let offset =
      stco.type === 'co64'
        ? u64be(moov, body(stco) + 8 + chunk * 8)
        : u32be(moov, body(stco) + 8 + chunk * 4);
    for (let s = 0; s < perChunk && samples.length < sampleCount; s += 1) {
      const length = sampleSize(samples.length);
      samples.push({ offset, length });
      offset += length;
    }
  }
  return samples;
}

/** File ranges holding the samples of one track, merged; empty when the tables are absent. */
function trackSampleRanges(
  moov: Uint8Array,
  trak: BoxHeader,
  base: number,
  fileSize: number
): ByteRange[] {
  const ranges: ByteRange[] = [];
  for (const sample of trackSamples(moov, trak, base)) {
    if (sample.length === 0 || sample.offset + sample.length > fileSize) continue;
    const last = ranges[ranges.length - 1];
    if (last && last.offset + last.length === sample.offset) last.length += sample.length;
    else ranges.push({ ...sample });
  }
  return ranges;
}

/** How many leading samples to search for an encoder's SEI; x264 and x265 write it once, first. */
const SEI_SEARCH_SAMPLES = 3;

/**
 * x264 and x265 sign the first picture with a `user_data_unregistered` SEI holding their version
 * and every encoding option — what MediaInfo shows as "Writing library" and "Encoding settings".
 * The text is overwritten with spaces in place: same length, no zero bytes introduced, so the
 * NAL stays valid and decoders, which ignore unregistered user data, see no difference.
 */
function blankEncoderSei(
  moov: Uint8Array,
  trak: BoxHeader,
  base: number,
  patches: PatchSet,
  source: MediaByteSource
): void {
  const stbl = findChild(
    moov,
    findChild(moov, findChild(moov, trak, base, 'mdia'), base, 'minf'),
    base,
    'stbl'
  );
  const stsd = findChild(moov, stbl, base, 'stsd');
  if (!stsd) return;
  const entry = children(moov, stsd.start - base + stsd.headerSize + 8, stsd.end - base, base)[0];
  if (!entry) return;
  const hevc = entry.type === 'hvc1' || entry.type === 'hev1';
  if (!hevc && entry.type !== 'avc1' && entry.type !== 'avc3') return;
  const config = findChild(moov, entry, base, hevc ? 'hvcC' : 'avcC', 78);
  if (!config) return;
  const configBody = config.start - base + config.headerSize;
  const lengthSize = ((hevc ? moov[configBody + 21]! : moov[configBody + 4]!) & 0x03) + 1;
  if (hevc) {
    // FFmpeg also copies x265's SEI into the decoder configuration's NAL arrays.
    let at = configBody + 23;
    const arrays = moov[configBody + 22] ?? 0;
    const configEnd = config.end - base;
    for (let a = 0; a < arrays && at + 3 <= configEnd; a += 1) {
      const type = moov[at]! & 0x3f;
      const count = u16be(moov, at + 1);
      at += 3;
      for (let n = 0; n < count && at + 2 <= configEnd; n += 1) {
        const size = u16be(moov, at);
        const start = at + 2;
        const end = Math.min(configEnd, start + size);
        if (type === 39 || type === 40) blankUserDataText(moov, start + 2, end, base, patches);
        at = end;
      }
    }
  }
  for (const sample of trackSamples(moov, trak, base, SEI_SEARCH_SAMPLES)) {
    if (
      sample.length === 0 ||
      sample.offset + sample.length > source.size ||
      sample.length > 64 * 1024 * 1024
    )
      continue;
    const data = source.read(sample.offset, sample.length);
    let at = 0;
    while (at + lengthSize <= data.length) {
      let size = 0;
      for (let i = 0; i < lengthSize; i += 1) size = size * 256 + data[at + i]!;
      const start = at + lengthSize;
      const end = start + size;
      if (size === 0 || end > data.length) break;
      const type = hevc ? (data[start]! >> 1) & 0x3f : data[start]! & 0x1f;
      const sei = hevc ? type === 39 || type === 40 : type === 6;
      if (sei) blankUserDataText(data, start + (hevc ? 2 : 1), end, sample.offset, patches);
      at = end;
    }
  }
}

function blankUserDataText(
  nal: Uint8Array,
  from: number,
  end: number,
  fileOffset: number,
  patches: PatchSet
): void {
  let at = from;
  while (at + 2 < end && nal[at] !== 0x80) {
    let payloadType = 0;
    while (at < end && nal[at] === 0xff) {
      payloadType += 255;
      at += 1;
    }
    payloadType += nal[at]!;
    at += 1;
    let payloadSize = 0;
    while (at < end && nal[at] === 0xff) {
      payloadSize += 255;
      at += 1;
    }
    payloadSize += nal[at]!;
    at += 1;
    const payloadEnd = Math.min(end, at + payloadSize);
    if (payloadType === 5 && payloadSize > 16) {
      let runStart = -1;
      for (let i = at + 16; i <= payloadEnd; i += 1) {
        const printable = i < payloadEnd && nal[i]! >= 0x21 && nal[i]! <= 0x7e;
        if (printable && runStart < 0) runStart = i;
        if (!printable && runStart >= 0) {
          patches.write(fileOffset + runStart, new Uint8Array(i - runStart).fill(0x20));
          runStart = -1;
        }
      }
    }
    at = payloadEnd;
  }
}

/* HEIF: the picture is defined inside `meta`, so the box stays and only the EXIF and XMP items
   are overwritten where `iloc` says they live. Orientation in HEIF is the `irot`/`imir`
   property, not EXIF, so nothing about how the image is shown changes. */
function scrubHeifMeta(
  meta: Uint8Array,
  base: number,
  patches: PatchSet,
  source: MediaByteSource
): void {
  const top: BoxHeader = { type: 'meta', start: base, headerSize: 8, end: base + meta.length };
  const boxes = children(meta, top.headerSize + 4, meta.length, base);
  const iinf = boxes.find(b => b.type === 'iinf');
  const iloc = boxes.find(b => b.type === 'iloc');
  const idat = boxes.find(b => b.type === 'idat');
  for (const box of boxes) if (box.type === 'udta' || box.type === 'uuid') patches.free(box);
  if (!iinf || !iloc) return;
  const kinds = new Map<number, 'exif' | 'xmp'>();
  const iinfBody = iinf.start - base + iinf.headerSize;
  const iinfVersion = meta[iinfBody]!;
  const entriesAt = iinfBody + 4 + (iinfVersion === 0 ? 2 : 4);
  for (const infe of children(meta, entriesAt, iinf.end - base, base)) {
    if (infe.type !== 'infe') continue;
    const at = infe.start - base + infe.headerSize;
    const version = meta[at]!;
    if (version < 2) continue;
    const idWidth = version === 3 ? 4 : 2;
    const id = idWidth === 4 ? u32be(meta, at + 4) : u16be(meta, at + 4);
    const typeAt = at + 4 + idWidth + 2;
    const itemType = ascii(meta, typeAt, 4);
    if (itemType === 'Exif') kinds.set(id, 'exif');
    else if (itemType === 'mime') {
      let p = typeAt + 4;
      while (p < infe.end - base && meta[p] !== 0) p += 1; // item_name
      const contentType = readCString(meta, p + 1, infe.end - base);
      if (contentType.includes('rdf+xml')) kinds.set(id, 'xmp');
    }
  }
  if (kinds.size === 0) return;
  const body = iloc.start - base + iloc.headerSize;
  const version = meta[body]!;
  const offsetSize = meta[body + 4]! >> 4;
  const lengthSize = meta[body + 4]! & 0x0f;
  const baseOffsetSize = meta[body + 5]! >> 4;
  const indexSize = version >= 1 ? meta[body + 5]! & 0x0f : 0;
  let p = body + 6;
  const read = (width: number): number => {
    let value = 0;
    for (let i = 0; i < width; i += 1) value = value * 256 + meta[p + i]!;
    p += width;
    return value;
  };
  const itemCount = read(version < 2 ? 2 : 4);
  for (let i = 0; i < itemCount; i += 1) {
    const id = read(version < 2 ? 2 : 4);
    const construction = version >= 1 ? read(2) & 0x0f : 0;
    read(2); // data_reference_index
    const baseOffset = read(baseOffsetSize);
    const extents = read(2);
    for (let e = 0; e < extents; e += 1) {
      if (indexSize > 0) read(indexSize);
      const offset = read(offsetSize);
      const length = read(lengthSize);
      const kind = kinds.get(id);
      if (!kind || length === 0) continue;
      let absolute: number;
      if (construction === 0) absolute = baseOffset + offset;
      else if (construction === 1 && idat)
        absolute = idat.start + idat.headerSize + baseOffset + offset;
      else continue;
      if (absolute + length > source.size) continue;
      if (kind === 'exif' && e === 0 && length >= 18) {
        // exif_tiff_header_offset = 0, then a TIFF with an empty IFD0: a valid "no EXIF". Written
        // as one patch beside one zero fill — patches never overlap, so a reader can check each.
        patches.write(
          absolute,
          Uint8Array.from([0, 0, 0, 0, 0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0])
        );
        patches.zero(absolute + 18, length - 18);
      } else {
        patches.zero(absolute, length);
      }
    }
  }
}

function readCString(bytes: Uint8Array, from: number, to: number): string {
  let out = '';
  for (let i = from; i < to && bytes[i] !== 0; i += 1) out += String.fromCharCode(bytes[i]!);
  return out;
}

/* ------------------------------------------------------------------------------------------ */
/* Planning over a remote file                                                                  */
/* ------------------------------------------------------------------------------------------ */

class MissingRange extends Error {
  constructor(
    readonly offset: number,
    readonly length: number
  ) {
    super('MISSING_RANGE');
  }
}

/** Smallest read made while planning; box headers are 8–16 bytes and live close together. */
const PLANNING_READ_BYTES = 64 * 1024;
const PLANNING_MAX_READS = 64;

/**
 * The same plan as `planIsoBmffMetadataPatches`, for a file that can only be read in ranges over
 * the network (the R2 copy worker reading Drive). The synchronous planner runs against what has
 * been fetched so far; when it asks for bytes that are not there, they are fetched and it runs
 * again. The plan depends only on the file's bytes, so every rerun reaches the same answer, and
 * the number of reads is bounded by the number of boxes it has to look at.
 */
export async function planIsoBmffMetadataPatchesRemote(
  size: number,
  read: (offset: number, length: number) => Promise<Uint8Array>
): Promise<MediaMetadataPatchPlan> {
  const cache: { offset: number; bytes: Uint8Array }[] = [];
  const source: MediaByteSource = {
    size,
    read(offset, length) {
      const end = Math.min(size, offset + length);
      for (const range of cache) {
        if (range.offset <= offset && range.offset + range.bytes.length >= end) {
          return range.bytes.subarray(offset - range.offset, end - range.offset);
        }
      }
      throw new MissingRange(offset, end - offset);
    }
  };
  for (let reads = 0; reads <= PLANNING_MAX_READS; reads += 1) {
    try {
      return planIsoBmffMetadataPatches(source);
    } catch (error) {
      if (!(error instanceof MissingRange)) {
        return { format: 'unknown', supported: false, patches: [] };
      }
      const length = Math.min(size - error.offset, Math.max(error.length, PLANNING_READ_BYTES));
      if (length <= 0) return { format: 'unknown', supported: false, patches: [] };
      cache.push({ offset: error.offset, bytes: await read(error.offset, length) });
    }
  }
  return { format: 'unknown', supported: false, patches: [] };
}

/**
 * Applies the patches that fall inside one window of the file (`bytes` starting at `start`),
 * returning a patched copy, or the same array when none touches it.
 */
export function applyMediaMetadataPatchesToWindow(
  bytes: Uint8Array,
  start: number,
  patches: readonly MediaMetadataPatch[]
): Uint8Array {
  let out: Uint8Array | null = null;
  const end = start + bytes.length;
  for (const patch of patches) {
    const from = Math.max(start, patch.offset);
    const to = Math.min(end, patch.offset + patch.length);
    if (from >= to) continue;
    out ??= new Uint8Array(bytes);
    if (patch.data)
      out.set(patch.data.subarray(from - patch.offset, to - patch.offset), from - start);
    else out.fill(0, from - start, to - start);
  }
  return out ?? bytes;
}

/** The parts of each patch that fall inside [start, end), as absolute ranges with their content. */
export function mediaMetadataPatchesInWindow(
  start: number,
  end: number,
  patches: readonly MediaMetadataPatch[]
): MediaMetadataPatch[] {
  const out: MediaMetadataPatch[] = [];
  for (const patch of patches) {
    const from = Math.max(start, patch.offset);
    const to = Math.min(end, patch.offset + patch.length);
    if (from >= to) continue;
    out.push({
      offset: from,
      length: to - from,
      ...(patch.data ? { data: patch.data.subarray(from - patch.offset, to - patch.offset) } : {})
    });
  }
  return out;
}
