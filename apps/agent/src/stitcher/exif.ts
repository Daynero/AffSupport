/**
 * Which way up a photograph is (030).
 *
 * A phone writes its pictures sideways and records the turn in EXIF; a viewer applies it,
 * and so does FFmpeg — in some builds, at some versions, for some decoders. A screen that
 * depends on which build is running is a screen that is sometimes upside down. So the turn
 * is read here, from the bytes, and applied as an explicit filter with autorotation off:
 * one answer, whatever FFmpeg does.
 *
 * Only JPEG carries the tag in practice. PNG has no EXIF orientation of its own, and WebP's
 * EXIF chunk is rare enough that a wrong guess would be the greater harm; both read as 1.
 */

import { open } from 'node:fs/promises';

/** The eight EXIF orientations; 1 is "as stored". */
export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** Far more than any APP1 segment needs, little enough to read on every screen. */
const HEADER_BYTES = 256 * 1024;

export async function imageOrientation(filePath: string): Promise<ExifOrientation> {
  let bytes: Buffer;
  try {
    const handle = await open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(HEADER_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
      bytes = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return 1;
  }
  return orientationFromJpeg(bytes);
}

/** The EXIF orientation of a JPEG's leading bytes, or 1 when there is none to be found. */
export function orientationFromJpeg(bytes: Buffer): ExifOrientation {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) return 1;
  let offset = 2;
  // Walk the segments until the scan starts; APP1/Exif is normally the first or second.
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return 1;
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) return 1; // SOS / EOI: no EXIF before the image
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return 1;
    if (marker === 0xe1 && offset + 4 + 6 <= bytes.length) {
      const payload = bytes.subarray(offset + 4, Math.min(offset + 2 + length, bytes.length));
      if (payload.subarray(0, 6).toString('ascii') === 'Exif\0\0') {
        return orientationFromTiff(payload.subarray(6));
      }
    }
    offset += 2 + length;
  }
  return 1;
}

function orientationFromTiff(tiff: Buffer): ExifOrientation {
  if (tiff.length < 8) return 1;
  const order = tiff.subarray(0, 2).toString('ascii');
  const little = order === 'II';
  if (!little && order !== 'MM') return 1;
  const u16 = (at: number) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at: number) => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  if (u16(2) !== 42) return 1;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return 1;
  const entries = u16(ifd);
  for (let index = 0; index < entries; index += 1) {
    const at = ifd + 2 + index * 12;
    if (at + 12 > tiff.length) return 1;
    if (u16(at) !== 0x0112) continue;
    if (u16(at + 2) !== 3 || u32(at + 4) !== 1) return 1;
    const value = u16(at + 8);
    return value >= 1 && value <= 8 ? (value as ExifOrientation) : 1;
  }
  return 1;
}

/**
 * The FFmpeg filter that puts a picture the right way up, given its EXIF orientation.
 * Empty for 1. Composed in front of the fit filter, so the fit sees the upright picture.
 */
export function orientationFilter(orientation: ExifOrientation): string {
  switch (orientation) {
    case 2:
      return 'hflip';
    case 3:
      return 'hflip,vflip';
    case 4:
      return 'vflip';
    case 5:
      return 'transpose=0';
    case 6:
      return 'transpose=1';
    case 7:
      return 'transpose=3';
    case 8:
      return 'transpose=2';
    default:
      return '';
  }
}
