import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import {
  detectMediaMetadataFormat,
  readTiffOrientation,
  stripMediaMetadata
} from '../packages/shared/src/media-metadata.js';
import { describeRequiring } from './support/requires.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import { ffmpegBinaries } from './support/toolchain.js';

const run = promisify(execFile);

/*
 * 073: what leaves Soty carries pictures and sound and nothing else. These tests hold the
 * stripper to two promises at once — nothing identifying survives, and not one decoded pixel
 * or sample changes — because a cleaner that damages the creative is worse than none.
 */

const text = (value: string) => new TextEncoder().encode(value);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const contains = (bytes: Uint8Array, needle: string) =>
  Buffer.from(bytes).includes(Buffer.from(needle, 'latin1'));

/** A big-endian TIFF with Orientation, Make, Model, Software and a GPS IFD. */
function identifyingTiff(orientation: number): Uint8Array {
  const strings = text('Apple\0iPhone 15 Pro\0Secret Editor 1.0\0');
  const entries = 5;
  const ifd0 = 8;
  const gpsIfd = ifd0 + 2 + entries * 12 + 4;
  const gpsEntries = 2;
  const stringsAt = gpsIfd + 2 + gpsEntries * 12 + 4;
  const out = new Uint8Array(stringsAt + strings.length);
  const view = new DataView(out.buffer);
  out.set(text('MM'));
  view.setUint16(2, 42);
  view.setUint32(4, ifd0);
  view.setUint16(ifd0, entries);
  const entry = (
    at: number,
    tag: number,
    type: number,
    count: number,
    value: number,
    short = false
  ) => {
    view.setUint16(at, tag);
    view.setUint16(at + 2, type);
    view.setUint32(at + 4, count);
    if (short) view.setUint16(at + 8, value);
    else view.setUint32(at + 8, value);
  };
  entry(ifd0 + 2, 0x010f, 2, 6, stringsAt);
  entry(ifd0 + 14, 0x0110, 2, 14, stringsAt + 6);
  entry(ifd0 + 26, 0x0112, 3, 1, orientation, true);
  entry(ifd0 + 38, 0x0131, 2, 19, stringsAt + 20);
  entry(ifd0 + 50, 0x8825, 4, 1, gpsIfd);
  view.setUint16(gpsIfd, gpsEntries);
  entry(gpsIfd + 2, 0x0001, 2, 2, 0x4e000000); // 'N'
  entry(gpsIfd + 14, 0x0003, 2, 2, 0x45000000); // 'E'
  out.set(strings, stringsAt);
  return out;
}

const jpegSegment = (marker: number, payload: Uint8Array) =>
  concat(
    Uint8Array.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]),
    payload
  );

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(text(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A real 2×1 RGB PNG, so the result can be decoded by anything. */
function png(...extra: Uint8Array[]): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 2);
  view.setUint32(4, 1);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const pixels = Uint8Array.from([0, 255, 0, 0, 0, 0, 255]);
  return concat(
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    ...extra,
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', new Uint8Array())
  );
}

describe('detecting what a file is', () => {
  it.each([
    ['jpeg', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])],
    ['png', png()],
    ['webp', concat(text('RIFF'), new Uint8Array(4), text('WEBPVP8 '))],
    ['gif', text('GIF89a')],
    ['isobmff', concat(Uint8Array.from([0, 0, 0, 16]), text('ftypisom'), new Uint8Array(4))],
    ['heif', concat(Uint8Array.from([0, 0, 0, 16]), text('ftypheic'), new Uint8Array(4))],
    ['unknown', text('\u001aEß£ matroska')]
  ])('%s', (format, bytes) => {
    expect(detectMediaMetadataFormat(bytes)).toBe(format);
  });

  it('leaves a format it does not understand exactly as it was', () => {
    const bytes = text('plain text with GPS 50.45');
    const result = stripMediaMetadata(bytes);
    expect(result).toMatchObject({ supported: false, changed: false });
    expect(result.bytes).toBe(bytes);
  });
});

describe('a JPEG', () => {
  const scan = concat(
    Uint8Array.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0]),
    Uint8Array.from([0x12, 0xff, 0x00, 0x34])
  );
  const tables = jpegSegment(0xdb, new Uint8Array(65));
  const frame = jpegSegment(0xc0, Uint8Array.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0]));
  const build = (orientation: number) =>
    concat(
      Uint8Array.from([0xff, 0xd8]),
      jpegSegment(0xe0, text('JFIF\0\u0001\u0001\0\0\u0001\0\u0001\0\0')),
      jpegSegment(0xe1, concat(text('Exif\0\0'), identifyingTiff(orientation))),
      jpegSegment(0xe1, text('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>Kyiv</x:xmpmeta>')),
      jpegSegment(0xe2, text('ICC_PROFILE\0\u0001\u0001display-p3')),
      jpegSegment(0xe2, text('MPF\0secondary')),
      jpegSegment(0xed, text('Photoshop 3.0\0IPTC author')),
      jpegSegment(0xeb, text('JP\0\0c2pa manifest')),
      jpegSegment(0xfe, text('a comment with a name')),
      tables,
      frame,
      scan,
      Uint8Array.from([0xff, 0xd9]),
      text('SEFHtrailer from a phone')
    );

  it('keeps JFIF, the colour profile, tables, the frame and the scan, and nothing else', () => {
    const result = stripMediaMetadata(build(1));
    expect(result).toMatchObject({ format: 'jpeg', supported: true, changed: true });
    const out = result.bytes;
    for (const gone of [
      'Apple',
      'iPhone',
      'Secret Editor',
      'Kyiv',
      'MPF',
      'IPTC',
      'c2pa',
      'comment',
      'SEFH',
      'Exif'
    ]) {
      expect(contains(out, gone), gone).toBe(false);
    }
    expect(contains(out, 'JFIF')).toBe(true);
    expect(contains(out, 'display-p3')).toBe(true);
    expect(Buffer.from(out).includes(Buffer.from(tables))).toBe(true);
    expect(Buffer.from(out).includes(Buffer.from(frame))).toBe(true);
    expect(Buffer.from(out.subarray(out.length - scan.length - 2))).toEqual(
      Buffer.from(concat(scan, Uint8Array.from([0xff, 0xd9])))
    );
  });

  it('keeps a turned photo turned, with Orientation as the only tag left', () => {
    const out = stripMediaMetadata(build(6)).bytes;
    expect(contains(out, 'Exif')).toBe(true);
    const exifAt = Buffer.from(out).indexOf(Buffer.from('Exif\0\0', 'latin1'));
    const tiff = out.subarray(exifAt + 6);
    expect(readTiffOrientation(tiff)).toBe(6);
    expect(new DataView(tiff.buffer, tiff.byteOffset).getUint16(8)).toBe(1); // one entry
    expect(contains(out, 'Apple')).toBe(false);
    // JFIF stays the first segment so readers that insist on it still find it.
    expect([out[2], out[3]]).toEqual([0xff, 0xe0]);
  });

  it('is idempotent', () => {
    const once = stripMediaMetadata(build(3)).bytes;
    const twice = stripMediaMetadata(once);
    expect(twice.changed).toBe(false);
    expect(Buffer.from(twice.bytes)).toEqual(Buffer.from(once));
  });

  it('reports a truncated file as unsupported instead of half-cleaning it', () => {
    const bytes = build(1).subarray(0, 60);
    expect(stripMediaMetadata(bytes)).toMatchObject({ supported: false, changed: false });
  });
});

describe('a PNG', () => {
  it('drops text, time and EXIF chunks and keeps colour and transparency', () => {
    const input = png(
      pngChunk('iCCP', concat(text('sRGB-ish\0\0'), deflateSync(text('profile')))),
      pngChunk('tEXt', text('Author\0Roman')),
      pngChunk('iTXt', text('XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta>Kyiv</x:xmpmeta>')),
      pngChunk('zTXt', concat(text('Comment\0\0'), deflateSync(text('secret')))),
      pngChunk('tIME', Uint8Array.from([7, 232, 5, 1, 10, 0, 0])),
      pngChunk('eXIf', identifyingTiff(1)),
      pngChunk('caBX', text('c2pa'))
    );
    const result = stripMediaMetadata(input);
    expect(result).toMatchObject({ format: 'png', supported: true, changed: true });
    for (const gone of ['tEXt', 'iTXt', 'zTXt', 'tIME', 'eXIf', 'caBX', 'Roman', 'Apple']) {
      expect(contains(result.bytes, gone), gone).toBe(false);
    }
    expect(contains(result.bytes, 'iCCP')).toBe(true);
    expect(Buffer.from(result.bytes)).toEqual(
      Buffer.from(png(pngChunk('iCCP', concat(text('sRGB-ish\0\0'), deflateSync(text('profile'))))))
    );
  });

  it('keeps a non-default orientation as a one-tag eXIf after IHDR', () => {
    const out = stripMediaMetadata(png(pngChunk('eXIf', identifyingTiff(8)))).bytes;
    const at = Buffer.from(out).indexOf(Buffer.from('eXIf', 'latin1'));
    expect(at).toBe(8 + 25 + 4); // signature, IHDR, then this chunk's length field
    expect(readTiffOrientation(out.subarray(at + 4))).toBe(8);
    expect(contains(out, 'Apple')).toBe(false);
  });
});

describe('a WebP', () => {
  function webp(...chunks: Uint8Array[]): Uint8Array {
    const body = concat(text('WEBP'), ...chunks);
    const head = concat(text('RIFF'), new Uint8Array(4));
    new DataView(head.buffer).setUint32(4, body.length, true);
    return concat(head, body);
  }
  function chunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(8 + data.length + (data.length & 1));
    out.set(text(type));
    new DataView(out.buffer).setUint32(4, data.length, true);
    out.set(data, 8);
    return out;
  }
  const vp8x = (flags: number) =>
    chunk('VP8X', Uint8Array.from([flags, 0, 0, 0, 1, 0, 0, 1, 0, 0]));

  it('drops EXIF and XMP and clears their flags', () => {
    const input = webp(
      vp8x(0x2c),
      chunk('ICCP', text('icc')),
      chunk('VP8L', text('pixels')),
      chunk('EXIF', identifyingTiff(1)),
      chunk('XMP ', text('<x>Kyiv</x>'))
    );
    const out = stripMediaMetadata(input).bytes;
    expect(Buffer.from(out)).toEqual(
      Buffer.from(webp(vp8x(0x20), chunk('ICCP', text('icc')), chunk('VP8L', text('pixels'))))
    );
  });

  it('keeps a non-default orientation', () => {
    const out = stripMediaMetadata(
      webp(vp8x(0x08), chunk('VP8L', text('pixels')), chunk('EXIF', identifyingTiff(6)))
    ).bytes;
    expect(contains(out, 'Apple')).toBe(false);
    const at = Buffer.from(out).indexOf(Buffer.from('EXIF', 'latin1'));
    expect(readTiffOrientation(out.subarray(at + 8))).toBe(6);
    expect(out[20]! & 0x08).toBe(0x08);
  });
});

describe('a GIF', () => {
  it('drops comments and XMP and keeps the looping block', () => {
    const header = concat(
      text('GIF89a'),
      Uint8Array.from([1, 0, 1, 0, 0x80, 0, 0]),
      new Uint8Array(6)
    );
    const loop = concat(
      Uint8Array.from([0x21, 0xff, 11]),
      text('NETSCAPE2.0'),
      Uint8Array.from([3, 1, 0, 0, 0])
    );
    const comment = concat(Uint8Array.from([0x21, 0xfe, 6]), text('secret'), Uint8Array.from([0]));
    const xmp = concat(
      Uint8Array.from([0x21, 0xff, 11]),
      text('XMP DataXMP'),
      Uint8Array.from([4]),
      text('Kyiv'),
      Uint8Array.from([0])
    );
    const image = Uint8Array.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x4c, 0x01, 0]);
    const out = stripMediaMetadata(
      concat(header, loop, comment, xmp, image, Uint8Array.from([0x3b]))
    ).bytes;
    expect(Buffer.from(out)).toEqual(
      Buffer.from(concat(header, loop, image, Uint8Array.from([0x3b])))
    );
  });
});

describeRequiring(ffmpegBinaries, 'real files through the real decoder', () => {
  let dir = '';
  afterAll(async () => {
    if (dir) await removeTemporaryDirectory(dir);
  });
  const work = async () => (dir ||= await mkdtemp(path.join(os.tmpdir(), 'soty-073-')));
  const ffmpeg = (...args: string[]) =>
    run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  const decodedMd5 = async (
    file: string,
    map = ['-map', '0:v?', '-map', '0:a?'],
    before: string[] = []
  ) =>
    (
      await run('ffmpeg', ['-v', 'error', ...before, '-i', file, ...map, '-f', 'md5', '-'])
    ).stdout.trim();
  const tags = async (file: string) =>
    (
      await run('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'format_tags:stream_tags:stream=codec_type:stream_side_data=rotation',
        '-of',
        'json',
        file
      ])
    ).stdout;
  const strip = async (input: string, output: string) => {
    const result = stripMediaMetadata(new Uint8Array(await readFile(input)));
    await writeFile(output, result.bytes);
    return result;
  };

  it('an MP4 with dates, a place, a title, a handler name and a rotation', async () => {
    const root = await work();
    const base = path.join(root, 'base.mp4');
    const input = path.join(root, 'in.mp4');
    const output = path.join(root, 'out.mp4');
    await ffmpeg(
      ...['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=25:duration=1'],
      ...['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1'],
      ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'],
      ...[
        '-metadata',
        'creation_time=2024-05-01T10:00:00Z',
        '-metadata',
        'location=+50.4501+030.5234/'
      ],
      ...['-metadata', 'title=Secret', '-metadata:s:v', 'handler_name=Phone Handler'],
      base
    );
    await ffmpeg('-display_rotation', '90', '-i', base, '-c', 'copy', '-map_metadata', '0', input);
    const before = await tags(input);
    expect(before).toContain('50.4501');
    const result = await strip(input, output);
    expect(result).toMatchObject({ format: 'isobmff', supported: true, changed: true });
    expect(result.bytes.length).toBe((await readFile(input)).length);
    const after = JSON.parse(await tags(output)) as {
      streams: { tags?: Record<string, string>; side_data_list?: { rotation?: number }[] }[];
      format: { tags?: Record<string, string> };
    };
    const formatTags = Object.keys(after.format.tags ?? {}).filter(
      k => !['major_brand', 'minor_version', 'compatible_brands'].includes(k)
    );
    expect(formatTags).toEqual([]);
    for (const stream of after.streams) {
      expect(Object.keys(stream.tags ?? {}).filter(k => k !== 'language')).toEqual([]);
    }
    expect(after.streams[0]?.side_data_list?.[0]?.rotation).toBe(90);
    for (const gone of ['x264', 'Lavf', 'Phone Handler', 'Secret', '50.4501']) {
      expect(contains(result.bytes, gone), gone).toBe(false);
    }
    expect(await decodedMd5(output)).toBe(await decodedMd5(input));
  });

  it('a MOV with timecode and a text track keeps only pictures and sound', async () => {
    const root = await work();
    const srt = path.join(root, 's.srt');
    const input = path.join(root, 'in.mov');
    const output = path.join(root, 'out.mov');
    await writeFile(srt, '1\n00:00:00,000 --> 00:00:00,800\nGPS 50.45 30.52 TELEMETRY\n');
    await ffmpeg(
      ...['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=25:duration=1'],
      ...['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1'],
      ...['-i', srt, '-map', '0', '-map', '1', '-map', '2'],
      ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'mov_text'],
      ...[
        '-timecode',
        '10:11:12:13',
        '-metadata',
        'com.apple.quicktime.make=Apple',
        '-movflags',
        'use_metadata_tags'
      ],
      input
    );
    const result = await strip(input, output);
    expect(result.changed).toBe(true);
    const after = await tags(output);
    expect(after).not.toContain('timecode');
    expect(after).not.toContain('subtitle');
    expect(after).not.toContain('Apple');
    expect(contains(result.bytes, 'TELEMETRY')).toBe(false);
    expect(await decodedMd5(output)).toBe(await decodedMd5(input));
  });

  it('an HEVC MP4 loses the x265 signature everywhere it was copied', async () => {
    const root = await work();
    const input = path.join(root, 'hevc.mp4');
    const output = path.join(root, 'hevc-out.mp4');
    await ffmpeg(
      ...['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=25:duration=1'],
      ...['-c:v', 'libx265', '-tag:v', 'hvc1', '-x265-params', 'log-level=error'],
      input
    );
    const result = await strip(input, output);
    expect(contains(new Uint8Array(await readFile(input)), 'x265')).toBe(true);
    expect(contains(result.bytes, 'x265')).toBe(false);
    expect(await decodedMd5(output)).toBe(await decodedMd5(input));
  });

  it('a JPEG from a phone: identical pixels, no EXIF but the orientation', async () => {
    const root = await work();
    const plain = path.join(root, 'plain.jpg');
    const input = path.join(root, 'phone.jpg');
    const output = path.join(root, 'phone-out.jpg');
    await ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=64x48', '-frames:v', '1', plain);
    const jpeg = new Uint8Array(await readFile(plain));
    const exif = jpegSegment(0xe1, concat(text('Exif\0\0'), identifyingTiff(6)));
    await writeFile(input, concat(jpeg.subarray(0, 2), exif, jpeg.subarray(2), text('trailer')));
    const result = await strip(input, output);
    expect(contains(result.bytes, 'iPhone')).toBe(false);
    expect(contains(result.bytes, 'Lavc')).toBe(false); // FFmpeg's own COM segment
    const exifAt = Buffer.from(result.bytes).indexOf(Buffer.from('Exif\0\0', 'latin1'));
    expect(readTiffOrientation(result.bytes.subarray(exifAt + 6))).toBe(6);
    // Pixels compared as stored: the orientation is asserted above, and FFmpeg applies it.
    const stored = ['-noautorotate'];
    expect(await decodedMd5(output, [], stored)).toBe(await decodedMd5(input, [], stored));
  });

  it('a PNG decodes to the same pixels', async () => {
    const root = await work();
    // FFmpeg here has no WebP encoder; WebP is covered byte for byte above.
    for (const ext of ['png']) {
      const input = path.join(root, `in.${ext}`);
      const output = path.join(root, `out.${ext}`);
      await ffmpeg(
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=64x48',
        '-frames:v',
        '1',
        '-metadata',
        'comment=secret',
        input
      );
      const result = await strip(input, output);
      expect(result.supported).toBe(true);
      expect(await decodedMd5(output, [])).toBe(await decodedMd5(input, []));
    }
  });
});
