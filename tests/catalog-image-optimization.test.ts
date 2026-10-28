import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { optimizeCatalogImage } from '../supabase/functions/_shared/catalog-image-optimization';
import {
  makeCatalogPng,
  testPngChunk,
  catalogPixels,
  makeIndexedCatalogPng
} from './support/catalog-image-fixtures';

const hash = (bytes: Uint8Array | Uint8ClampedArray) =>
  createHash('sha256').update(bytes).digest('hex');
const require = createRequire(import.meta.url);
const { PNG } = require('pngjs') as {
  PNG: { sync: { read(input: Uint8Array): { width: number; height: number; data: Buffer } } };
};
function parts(bytes: Uint8Array): Array<{ type: string; data: Uint8Array }> {
  const result = [];
  const b = Buffer.from(bytes);
  for (let at = 8; at < b.length;) {
    const length = b.readUInt32BE(at);
    result.push({
      type: b.toString('ascii', at + 4, at + 8),
      data: b.subarray(at + 8, at + 8 + length)
    });
    at += length + 12;
  }
  return result;
}
describe('lossless canonical catalog images', () => {
  it.each(
    [1, 2, 4, 8].flatMap(depth =>
      [0, 1, 2, 3, 4].map(filter => ({ depth, filter, interlace: filter % 2 === 1 }))
    )
  )(
    'unfilters and range-checks packed palette samples %j without changing them',
    async ({ depth, filter, interlace }) => {
      const source = makeIndexedCatalogPng(depth, filter, interlace);
      const result = await optimizeCatalogImage(source);
      expect(hash(PNG.sync.read(Buffer.from(result.bytes)).data)).toBe(
        hash(PNG.sync.read(source).data)
      );
      await expect(
        optimizeCatalogImage(makeIndexedCatalogPng(depth, filter, interlace, true))
      ).rejects.toMatchObject({ code: 'IMAGE_CONTENT_INVALID' });
    }
  );
  it.each([
    { color: 6 as const, depth: 8 as const },
    { color: 3 as const, depth: 8 as const },
    { color: 0 as const, depth: 16 as const },
    { color: 6 as const, depth: 16 as const },
    { interlace: true }
  ])('keeps independent PNG pixels/alpha/dimensions and inflated precision %j', async options => {
    const source = makeCatalogPng({
      ...options,
      level: 0,
      text: 'Discardable comment'.repeat(200)
    });
    const result = await optimizeCatalogImage(source, 'image/png');
    expect(result.bytes.length).toBeLessThan(source.length);
    const decoded = PNG.sync.read(Buffer.from(result.bytes));
    const original = PNG.sync.read(source);
    expect([decoded.width, decoded.height]).toEqual([original.width, original.height]);
    expect(hash(decoded.data)).toBe(hash(original.data));
    const raw = (b: Uint8Array) =>
      inflateSync(
        Buffer.concat(
          parts(b)
            .filter(p => p.type === 'IDAT')
            .map(p => Buffer.from(p.data))
        )
      );
    expect(hash(raw(result.bytes))).toBe(hash(raw(source)));
    expect(parts(result.bytes).some(p => p.type === 'tEXt')).toBe(false);
    expect(result.image).toMatchObject({
      mime: 'image/png',
      width: 512,
      height: 512,
      sourceSize: source.length,
      optimizationVersion: 'lossless-v1'
    });
    expect(result.image.sourceSha256).not.toBe(result.image.sha256);
  });
  it('retains color metadata exactly and is deterministic without growing an already optimized PNG', async () => {
    const base = makeCatalogPng();
    const gamma = Buffer.alloc(4);
    gamma.writeUInt32BE(45455);
    const source = Buffer.concat([
      base.subarray(0, 33),
      testPngChunk('gAMA', gamma),
      testPngChunk('sRGB', Buffer.from([0])),
      base.subarray(33)
    ]);
    const a = await optimizeCatalogImage(source);
    const b = await optimizeCatalogImage(source);
    expect(a.bytes).toEqual(b.bytes);
    expect(a.bytes.length).toBeLessThanOrEqual(source.length);
    expect(parts(a.bytes).find(p => p.type === 'gAMA')?.data).toEqual(gamma);
    expect(parts(a.bytes).find(p => p.type === 'sRGB')?.data).toEqual(Buffer.from([0]));
  });
  it('retains WebP ICC and orientation-one EXIF in the canonical PNG without changing RGBA', async () => {
    const original = readFileSync('tests/fixtures/catalog-images/garment.webp');
    const profile = Buffer.alloc(128);
    profile.writeUInt32BE(128);
    profile.write('mntr', 12);
    profile.write('RGB ', 16);
    profile.write('XYZ ', 20);
    profile.write('acsp', 36);
    const tiff = Buffer.from('49492a0008000000010012010300010000000100000000000000', 'hex');
    const chunk = (type: string, data: Buffer) => {
      const output = Buffer.alloc(8 + data.length + (data.length & 1));
      output.write(type);
      output.writeUInt32LE(data.length, 4);
      output.set(data, 8);
      return output;
    };
    const extended = Buffer.alloc(10);
    extended[0] = 32 | 8 | 16;
    extended.writeUIntLE(511, 4, 3);
    extended.writeUIntLE(511, 7, 3);
    const body = Buffer.concat([
      chunk('VP8X', extended),
      chunk('ICCP', profile),
      original.subarray(12),
      chunk('EXIF', tiff)
    ]);
    const riff = Buffer.alloc(12);
    riff.write('RIFF');
    riff.writeUInt32LE(body.length + 4, 4);
    riff.write('WEBP', 8);
    const result = await optimizeCatalogImage(Buffer.concat([riff, body]), 'image/webp');
    expect(hash(PNG.sync.read(Buffer.from(result.bytes)).data)).toBe(hash(catalogPixels()));
    const pngParts = parts(result.bytes);
    const icc = pngParts.find(p => p.type === 'iCCP')!.data;
    const separator = icc.indexOf(0);
    expect(icc[separator + 1]).toBe(0);
    expect(inflateSync(icc.subarray(separator + 2))).toEqual(profile);
    expect(pngParts.find(p => p.type === 'eXIf')!.data).toEqual(tiff);
  });
  it('strips JPEG comments without changing any quantized scan, ICC or EXIF bytes', async () => {
    const original = readFileSync('tests/fixtures/catalog-images/garment.jpg');
    const comment = Buffer.from('removable'.repeat(200));
    const segment = Buffer.alloc(comment.length + 4);
    segment[0] = 255;
    segment[1] = 254;
    segment.writeUInt16BE(comment.length + 2, 2);
    segment.set(comment, 4);
    const source = Buffer.concat([original.subarray(0, 2), segment, original.subarray(2)]);
    const result = await optimizeCatalogImage(source, 'image/jpeg');
    expect(result.bytes).toEqual(new Uint8Array(original));
    expect(result.image).toMatchObject({
      mime: 'image/jpeg',
      sourceSize: source.length,
      width: 512,
      height: 512
    });
    expect((await optimizeCatalogImage(original)).bytes).toEqual(new Uint8Array(original));
  });
  it('retains every byte of a JPEG ICC APP2 payload while validating its original encoded scan', async () => {
    const original = readFileSync('tests/fixtures/catalog-images/garment.jpg');
    const payload = Buffer.concat([
      Buffer.from('ICC_PROFILE\0', 'ascii'),
      Buffer.from([1, 1]),
      Buffer.alloc(128)
    ]);
    const segment = Buffer.alloc(payload.length + 4);
    segment[0] = 255;
    segment[1] = 226;
    segment.writeUInt16BE(payload.length + 2, 2);
    segment.set(payload, 4);
    const source = Buffer.concat([original.subarray(0, 2), segment, original.subarray(2)]);
    expect((await optimizeCatalogImage(source)).bytes).toEqual(new Uint8Array(source));
  });
  it('converts real lossless WebP to PNG preserving every RGBA component including transparent RGB', async () => {
    const source = readFileSync('tests/fixtures/catalog-images/garment.webp');
    const result = await optimizeCatalogImage(source, 'image/webp');
    const decoded = PNG.sync.read(Buffer.from(result.bytes));
    expect(decoded.width).toBe(512);
    expect(decoded.height).toBe(512);
    expect(hash(decoded.data)).toBe(hash(catalogPixels()));
    expect(result.image.mime).toBe('image/png');
    expect((await optimizeCatalogImage(source)).bytes).toEqual(result.bytes);
  });
  it('refuses too-small, corrupt deflate, an inflate bomb and aborted work before publication', async () => {
    await expect(
      optimizeCatalogImage(
        Buffer.from('ffd8ffc00011080200020003011100021100031100ffda0002ffd9', 'hex'),
        'image/jpeg'
      )
    ).rejects.toMatchObject({ code: 'IMAGE_CONTENT_INVALID' });
    await expect(optimizeCatalogImage(makeCatalogPng({ width: 499 }))).rejects.toMatchObject({
      code: 'IMAGE_DIMENSIONS_INVALID'
    });
    const source = makeCatalogPng();
    const p = parts(source);
    const id = p.find(x => x.type === 'IDAT')!;
    const broken = Uint8Array.from(id.data);
    broken[broken.length - 1] ^= 1;
    const corrupt = Buffer.concat([
      source.subarray(0, 33),
      testPngChunk('IDAT', broken),
      testPngChunk('IEND', Buffer.alloc(0))
    ]);
    await expect(optimizeCatalogImage(corrupt)).rejects.toMatchObject({
      code: 'IMAGE_CONTENT_INVALID'
    });
    const bomb = makeCatalogPng({ width: 1024, height: 1024 });
    const header = Uint8Array.from(parts(bomb)[0]!.data);
    new DataView(header.buffer).setUint32(0, 500);
    new DataView(header.buffer).setUint32(4, 500);
    await expect(
      optimizeCatalogImage(
        Buffer.concat([
          bomb.subarray(0, 8),
          testPngChunk('IHDR', header),
          ...parts(bomb)
            .slice(1)
            .map(v => testPngChunk(v.type, v.data))
        ])
      )
    ).rejects.toMatchObject({ code: 'IMAGE_CONTENT_INVALID' });
    await expect(
      optimizeCatalogImage(source, undefined, AbortSignal.abort())
    ).rejects.toBeDefined();
  });
  it('bounds marker/chunk allocations before parsing hostile PNG and JPEG metadata', async () => {
    const png = makeCatalogPng();
    const hostile = Buffer.concat([
      png.subarray(0, 33),
      ...Array.from({ length: 4097 }, () => testPngChunk('abCd', Buffer.alloc(0))),
      png.subarray(33)
    ]);
    await expect(optimizeCatalogImage(hostile)).rejects.toMatchObject({
      code: 'IMAGE_CONTENT_INVALID'
    });
    const jpeg = readFileSync('tests/fixtures/catalog-images/garment.jpg');
    await expect(
      optimizeCatalogImage(
        Buffer.concat([
          jpeg.subarray(0, 2),
          ...Array.from({ length: 4097 }, () => Buffer.from([255, 1])),
          jpeg.subarray(2)
        ])
      )
    ).rejects.toMatchObject({ code: 'IMAGE_CONTENT_INVALID' });
  });
  it('rejects indexed PNGs without a valid palette or transparency order', async () => {
    const base = makeCatalogPng({ color: 3 });
    const sourceParts = parts(base);
    const encode = (values: typeof sourceParts) =>
      Buffer.concat([base.subarray(0, 8), ...values.map(p => testPngChunk(p.type, p.data))]);
    await expect(
      optimizeCatalogImage(encode(sourceParts.filter(p => p.type !== 'PLTE')))
    ).rejects.toMatchObject({ code: 'IMAGE_CONTENT_INVALID' });
    await expect(
      optimizeCatalogImage(
        encode(sourceParts.map(p => (p.type === 'PLTE' ? { ...p, data: Buffer.from([1, 2]) } : p)))
      )
    ).rejects.toMatchObject({ code: 'IMAGE_CONTENT_INVALID' });
    const trns = sourceParts.find(p => p.type === 'tRNS')!;
    await expect(
      optimizeCatalogImage(
        encode([sourceParts[0]!, trns, ...sourceParts.slice(1).filter(p => p.type !== 'tRNS')])
      )
    ).rejects.toMatchObject({ code: 'IMAGE_CONTENT_INVALID' });
  });
});
