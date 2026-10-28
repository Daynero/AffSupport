import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertCatalogJpegDecodes } from '../supabase/functions/_shared/catalog-jpeg/index';

const baseline = new Uint8Array(readFileSync('tests/fixtures/catalog-images/garment.jpg'));
afterEach(() => vi.restoreAllMocks());
function headers(bytes: Uint8Array): Array<{ marker: number; start: number; end: number }> {
  const result = [];
  for (let offset = 2; offset < bytes.length;) {
    const start = offset;
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++]!;
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    const end = offset + length;
    result.push({ marker, start, end });
    if (marker === 0xda) break;
    offset = end;
  }
  return result;
}
function withoutTable(marker: number): Uint8Array {
  const parts = [baseline.subarray(0, 2)];
  for (const part of headers(baseline)) {
    if (part.marker !== marker)
      parts.push(baseline.subarray(part.start, part.marker === 0xda ? undefined : part.end));
  }
  return new Uint8Array(Buffer.concat(parts));
}
function progressiveScans(bytes: Uint8Array) {
  const scans = [];
  for (let offset = 2; offset < bytes.length;) {
    const start = offset;
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++]!;
    if (marker === 0xd9) break;
    const headerEnd = offset + ((bytes[offset]! << 8) | bytes[offset + 1]!);
    offset = headerEnd;
    if (marker !== 0xda) continue;
    while (offset < bytes.length - 1) {
      if (bytes[offset] !== 255) {
        offset++;
        continue;
      }
      const next = bytes[offset + 1]!;
      if (next === 0 || (next >= 0xd0 && next <= 0xd7)) {
        offset += 2;
        continue;
      }
      if (next === 255) {
        offset++;
        continue;
      }
      break;
    }
    scans.push({
      start,
      headerEnd,
      end: offset,
      ss: bytes[headerEnd - 3]!,
      se: bytes[headerEnd - 2]!,
      approximation: bytes[headerEnd - 1]!
    });
  }
  return scans;
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function rejectsUnchanged(
  bytes: Uint8Array,
  width: number,
  height: number,
  message: string,
  cause: string
) {
  const before = hash(bytes);
  let failure: unknown;
  try {
    assertCatalogJpegDecodes(bytes, width, height);
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ message, cause: { message: cause } });
  expect(hash(bytes)).toBe(before);
}
/** Independent legal all-zero progressive stream: one-bit DC/EOB tables and disjoint AC bands. */
function zeroProgressive(width: number, height: number, scanCount: number): Uint8Array {
  const segment = (marker: number, data: Uint8Array) => {
    const header = Buffer.from([255, marker, (data.length + 2) >>> 8, (data.length + 2) & 255]);
    return Buffer.concat([header, data]);
  };
  const table = (kind: number) => Buffer.from([kind, 1, ...Array<number>(15).fill(0), 0]);
  const blocks = Math.ceil(width / 8) * Math.ceil(height / 8);
  const entropy = Buffer.alloc(Math.ceil(blocks / 8));
  if (blocks % 8) entropy[entropy.length - 1] = (1 << (8 - (blocks % 8))) - 1;
  const parts = [
    Buffer.from([255, 216]),
    segment(0xdb, Buffer.from([0, ...Array<number>(64).fill(1)])),
    segment(
      0xc2,
      Buffer.from([8, height >>> 8, height & 255, width >>> 8, width & 255, 1, 1, 0x11, 0])
    ),
    segment(0xc4, Buffer.concat([table(0), table(0x10)]))
  ];
  for (let scan = 0; scan < scanCount; scan++) {
    const end = scan === 0 ? 0 : scan === scanCount - 1 ? 63 : scan;
    parts.push(segment(0xda, Buffer.from([1, 1, 0, scan, end, 0])), entropy);
  }
  parts.push(Buffer.from([255, 217]));
  return new Uint8Array(Buffer.concat(parts));
}

describe('bounded JPEG decodability validation', () => {
  it.each([
    ['tests/fixtures/catalog-images/garment.jpg', 512, 512],
    ['tests/fixtures/catalog-jpeg/progressive.jpg', 512, 512],
    ['tests/fixtures/catalog-jpeg/grayscale.jpg', 8, 8]
  ] as const)(
    'accepts real supported JPEG %s without changing one encoded byte',
    (name, width, height) => {
      const bytes = new Uint8Array(readFileSync(name));
      const original = Uint8Array.from(bytes);
      expect(assertCatalogJpegDecodes(bytes, width, height)).toBeUndefined();
      expect(bytes).toEqual(original);
    }
  );

  it('rejects the reviewer 27-byte fake and images missing quantization or Huffman tables', () => {
    const fake = new Uint8Array(
      Buffer.from('FFD8FFC00011080200020003011100021100031100FFDA0002FFD9', 'hex')
    );
    for (const bytes of [fake, withoutTable(0xdb), withoutTable(0xc4)]) {
      const original = Uint8Array.from(bytes);
      expect(() => assertCatalogJpegDecodes(bytes, 512, 512)).toThrow('JPEG_DECODE_FAILED');
      expect(bytes).toEqual(original);
    }
  });

  it('rejects malformed SOS parameters and truncated encoded entropy without borrowing pixels', () => {
    const scan = headers(baseline).find(part => part.marker === 0xda)!;
    const badHeader = Uint8Array.from(baseline);
    badHeader[scan.start + 4] = 0;
    const badParameters = Uint8Array.from(baseline);
    badParameters[scan.end - 3] = 1;
    const truncated = new Uint8Array(
      Buffer.concat([baseline.subarray(0, scan.end + 2), Uint8Array.of(255, 217)])
    );
    for (const bytes of [badHeader, badParameters, truncated])
      expect(() => assertCatalogJpegDecodes(bytes, 512, 512)).toThrow('JPEG_DECODE_FAILED');
  });

  it('rejects unsupported CMYK and dimension mismatch, with explicit resource-limit outcomes', () => {
    const cmyk = new Uint8Array(readFileSync('tests/fixtures/catalog-jpeg/cmyk.jpg'));
    expect(() => assertCatalogJpegDecodes(cmyk, 8, 8)).toThrow('JPEG_DECODE_FAILED');
    expect(() => assertCatalogJpegDecodes(baseline, 511, 512)).toThrow('JPEG_DECODE_FAILED');
    expect(() => assertCatalogJpegDecodes(baseline, 4001, 1000)).toThrow('JPEG_RESOURCE_LIMIT');
    expect(() => assertCatalogJpegDecodes(new Uint8Array(8_000_001), 512, 512)).toThrow(
      'JPEG_RESOURCE_LIMIT'
    );
  });

  it('rejects replayed first AC scans before their entropy is processed', () => {
    const source = new Uint8Array(readFileSync('tests/fixtures/catalog-jpeg/progressive.jpg'));
    const first = progressiveScans(source).find(scan => scan.ss > 0)!;
    expect([first.ss, first.se, first.approximation]).toEqual([1, 5, 2]);
    const replay = source.subarray(first.start, first.end);
    const repeated = new Uint8Array(
      Buffer.concat([
        source.subarray(0, first.end),
        ...Array<Uint8Array>(10).fill(replay),
        source.subarray(first.end)
      ])
    );
    rejectsUnchanged(
      repeated,
      512,
      512,
      'JPEG_DECODE_FAILED',
      'Invalid JPEG coefficient progression'
    );
  });

  it.each([0x10, 0x32])('rejects skipped or reversed progressive refinement %#', approximation => {
    const source = new Uint8Array(readFileSync('tests/fixtures/catalog-jpeg/progressive.jpg'));
    const first = progressiveScans(source).find(scan => scan.ss > 0)!;
    const next = Uint8Array.from(source.subarray(first.start, first.end));
    next[first.headerEnd - first.start - 1] = approximation;
    const malformed = new Uint8Array(
      Buffer.concat([source.subarray(0, first.end), next, source.subarray(first.end)])
    );
    rejectsUnchanged(
      malformed,
      512,
      512,
      'JPEG_DECODE_FAILED',
      'Invalid JPEG coefficient progression'
    );
  });

  it('bounds otherwise legal scan schedules by scan count and cumulative frame work', () => {
    const allowed = zeroProgressive(8, 8, 32);
    const before = hash(allowed);
    expect(assertCatalogJpegDecodes(allowed, 8, 8)).toBeUndefined();
    expect(hash(allowed)).toBe(before);
    rejectsUnchanged(
      zeroProgressive(8, 8, 33),
      8,
      8,
      'JPEG_RESOURCE_LIMIT',
      'JPEG scan count limit exceeded'
    );
    rejectsUnchanged(
      zeroProgressive(2000, 2000, 17),
      2000,
      2000,
      'JPEG_RESOURCE_LIMIT',
      'JPEG scan work limit exceeded'
    );
  });

  it('detaches only decoder-owned backing stores after both success and rejected input', () => {
    const transferablePrototype = ArrayBuffer.prototype as ArrayBuffer & {
      transfer?: (newByteLength?: number) => ArrayBuffer;
    };
    const transfer = transferablePrototype.transfer;
    if (typeof transfer !== 'function')
      throw new Error('This decoder test requires ArrayBuffer.transfer');
    const released: ArrayBuffer[] = [];
    vi.spyOn(
      transferablePrototype as ArrayBuffer & { transfer: (newByteLength?: number) => ArrayBuffer },
      'transfer'
    ).mockImplementation(function (this: ArrayBuffer, length?: number) {
      released.push(this);
      return transfer.call(this, length);
    });
    for (const [bytes, valid] of [
      [baseline, true],
      [withoutTable(0xc4), false]
    ] as const) {
      released.length = 0;
      const before = hash(bytes);
      const inputLength = bytes.byteLength;
      if (valid) assertCatalogJpegDecodes(bytes, 512, 512);
      else expect(() => assertCatalogJpegDecodes(bytes, 512, 512)).toThrow('JPEG_DECODE_FAILED');
      expect(released.length).toBeGreaterThan(0);
      expect(released.every(buffer => buffer.byteLength === 0)).toBe(true);
      expect(released).not.toContain(bytes.buffer);
      expect(bytes.byteLength).toBe(inputLength);
      expect(hash(bytes)).toBe(before);
    }
    // Module constants and the allocation scope must remain reusable after rejection.
    expect(assertCatalogJpegDecodes(baseline, 512, 512)).toBeUndefined();
  });

  it('refuses an unsupported release primitive before decoding without touching input', () => {
    const descriptor = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'transfer')!;
    const before = hash(baseline);
    try {
      Object.defineProperty(ArrayBuffer.prototype, 'transfer', { ...descriptor, value: undefined });
      expect(() => assertCatalogJpegDecodes(baseline, 512, 512)).toThrow('JPEG_RESOURCE_LIMIT');
      expect(hash(baseline)).toBe(before);
    } finally {
      Object.defineProperty(ArrayBuffer.prototype, 'transfer', descriptor);
    }
  });
});
