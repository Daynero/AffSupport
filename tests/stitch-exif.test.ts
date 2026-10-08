import { describe, expect, it } from 'vitest';
import {
  imageOrientation,
  orientationFilter,
  orientationFromJpeg
} from '../apps/agent/src/stitcher/exif.js';
import { RESTITCH_FIXTURES, restitchFixturePath } from './fixtures/restitch-images/index.js';

/**
 * Feature 030: which way up a photograph is, read from its bytes and turned into the one
 * FFmpeg filter that puts it upright. Pinned here so a build of FFmpeg that rotates on its
 * own, or stops doing so, changes nothing: autorotation is off and this is the whole answer.
 */

describe('reading the orientation', () => {
  it('finds the tag in each fixture and reads 1 where there is none', async () => {
    for (const [name, fixture] of Object.entries(RESTITCH_FIXTURES)) {
      if (fixture.animated) continue;
      expect([name, await imageOrientation(restitchFixturePath(name as never))]).toEqual([
        name,
        fixture.orientation
      ]);
    }
  });

  it('reads 1 for a file it cannot open or that is not a JPEG', async () => {
    expect(await imageOrientation('/nowhere/at/all.jpg')).toBe(1);
    expect(orientationFromJpeg(Buffer.from('not a jpeg'))).toBe(1);
    expect(orientationFromJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBe(1);
  });

  it('survives a big-endian TIFF header and refuses an out-of-range value', () => {
    const tiff = Buffer.alloc(26);
    tiff.write('MM', 0, 'ascii');
    tiff.writeUInt16BE(42, 2);
    tiff.writeUInt32BE(8, 4);
    tiff.writeUInt16BE(1, 8);
    tiff.writeUInt16BE(0x0112, 10);
    tiff.writeUInt16BE(3, 12);
    tiff.writeUInt32BE(1, 14);
    tiff.writeUInt16BE(8, 18);
    const payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
    const header = Buffer.alloc(4);
    header.writeUInt16BE(0xffe1, 0);
    header.writeUInt16BE(payload.length + 2, 2);
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      header,
      payload,
      Buffer.from([0xff, 0xda, 0, 2])
    ]);
    expect(orientationFromJpeg(jpeg)).toBe(8);
    tiff.writeUInt16BE(9, 18);
    const bad = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      header,
      Buffer.from('Exif\0\0', 'ascii'),
      tiff
    ]);
    expect(orientationFromJpeg(bad)).toBe(1);
  });
});

describe('the filter', () => {
  it('is empty for upright and names a turn or a flip for the rest', () => {
    expect(orientationFilter(1)).toBe('');
    expect(orientationFilter(2)).toBe('hflip');
    expect(orientationFilter(3)).toBe('hflip,vflip');
    expect(orientationFilter(4)).toBe('vflip');
    expect(orientationFilter(5)).toBe('transpose=0');
    expect(orientationFilter(6)).toBe('transpose=1');
    expect(orientationFilter(7)).toBe('transpose=3');
    expect(orientationFilter(8)).toBe('transpose=2');
  });
});
