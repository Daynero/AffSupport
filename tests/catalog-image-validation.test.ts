import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  validateCatalogImage,
  readCatalogImageBytes
} from '../supabase/functions/_shared/catalog-image-validation';

const fixture = async (name: string) =>
  new Uint8Array(await readFile(`tests/fixtures/restitch-images/${name}`));
const chunk = (type: string, data: Uint8Array) => {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length, 0);
  bytes.write(type, 4, 'ascii');
  bytes.set(data, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, bytes.length - 4)), bytes.length - 4);
  return bytes;
};

describe('public catalog image content boundaries with independently generated fixtures', () => {
  it.each([
    ['plain.png', 'image/png'],
    ['plain.jpg', 'image/jpeg'],
    ['plain.webp', 'image/webp'],
    ['exif-1.jpg', 'image/jpeg']
  ])('accepts actual %s and hashes the complete original bytes', async (name, mime) => {
    const bytes = await fixture(name);
    const result = await validateCatalogImage(bytes, mime);
    expect(result).toMatchObject({ mime, size: bytes.length, orientation: 1 });
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
  it.each(['exif-3.jpg', 'exif-6.jpg', 'exif-8.jpg'])(
    'rejects rotated metadata in %s without rewriting bytes',
    async name => {
      await expect(validateCatalogImage(await fixture(name))).rejects.toMatchObject({
        code: 'IMAGE_ORIENTATION_UNSUPPORTED'
      });
    }
  );
  it('rejects an actual animated WebP and an APNG control chunk', async () => {
    await expect(validateCatalogImage(await fixture('animated.webp'))).rejects.toMatchObject({
      code: 'IMAGE_ANIMATED_UNSUPPORTED'
    });
    const png = await fixture('plain.png');
    const apng = Buffer.concat([
      png.subarray(0, 33),
      chunk('acTL', new Uint8Array([0, 0, 0, 2, 0, 0, 0, 0])),
      png.subarray(33)
    ]);
    await expect(validateCatalogImage(apng)).rejects.toMatchObject({
      code: 'IMAGE_ANIMATED_UNSUPPORTED'
    });
  });
  it('rejects pixel and byte overflows before decoding or hashing the content', async () => {
    const png = Buffer.from(await fixture('plain.png'));
    png.writeUInt32BE(4001, 16);
    png.writeUInt32BE(4000, 20);
    png.writeUInt32BE(crc32(png.subarray(12, 29)), 29);
    await expect(validateCatalogImage(png)).rejects.toMatchObject({
      code: 'IMAGE_DIMENSIONS_INVALID'
    });
    await expect(validateCatalogImage(new Uint8Array(50_000_001))).rejects.toMatchObject({
      code: 'IMAGE_TOO_LARGE'
    });
  });
  it.each(['plain.png', 'plain.jpg', 'plain.webp'])(
    'rejects truncated or trailing content for %s',
    async name => {
      const bytes = await fixture(name);
      await expect(validateCatalogImage(bytes.subarray(0, bytes.length - 1))).rejects.toMatchObject(
        { code: 'IMAGE_CONTENT_INVALID' }
      );
      const extra = new Uint8Array(bytes.length + 1);
      extra.set(bytes);
      await expect(validateCatalogImage(extra)).rejects.toMatchObject({
        code: 'IMAGE_CONTENT_INVALID'
      });
    }
  );
  it('does not trust a missing length header, truncated stream or MIME declaration', async () => {
    const bytes = await fixture('plain.jpg');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      }
    });
    expect(await readCatalogImageBytes(new Response(stream), bytes.length)).toEqual(bytes);
    await expect(
      readCatalogImageBytes(new Response(bytes.subarray(1)), bytes.length)
    ).rejects.toMatchObject({ code: 'IMAGE_CONTENT_INVALID' });
    await expect(validateCatalogImage(bytes, 'image/png')).rejects.toMatchObject({
      code: 'IMAGE_CONTENT_INVALID'
    });
    expect((await validateCatalogImage(bytes, 'application/octet-stream')).mime).toBe('image/jpeg');
  });
});
