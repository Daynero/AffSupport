import { deflateSync } from 'node:zlib';

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
export function testPngChunk(type: string, data: Uint8Array): Buffer {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(type, 4, 'ascii');
  result.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < result.length - 4; i++)
    crc = crcTable[(crc ^ result[i]!) & 255]! ^ (crc >>> 8);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}
export function catalogPixels(width = 512, height = 512): Uint8ClampedArray {
  const result = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      result[at] = x % 251;
      result[at + 1] = y % 251;
      result[at + 2] = (x + y) % 251;
      result[at + 3] = (x + y) % 7 === 0 ? 0 : 255;
    }
  return result;
}
export function makeCatalogPng(
  options: {
    width?: number;
    height?: number;
    level?: number;
    text?: string;
    color?: 0 | 2 | 3 | 4 | 6;
    depth?: 8 | 16;
    interlace?: boolean;
  } = {}
): Buffer {
  const { width = 512, height = 512, level = 9, color = 6, depth = 8, interlace = false } = options;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = color;
  header[12] = interlace ? 1 : 0;
  const pixels = catalogPixels(width, height);
  const rows: Buffer[] = [];
  const passes = interlace
    ? [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2]
      ]
    : [[0, 0, 1, 1]];
  for (const [startX, startY, dx, dy] of passes)
    for (let y = startY!; y < height; y += dy!) {
      const columns = Math.max(0, Math.ceil((width - startX!) / dx!));
      if (!columns) continue;
      const row = Buffer.alloc(1 + columns * channels * (depth / 8));
      let at = 1;
      for (let x = startX!; x < width; x += dx!)
        for (let channel = 0; channel < channels; channel++) {
          const value = color === 3 ? (x + y) % 2 : pixels[(y * width + x) * 4 + channel]!;
          if (depth === 16) {
            row.writeUInt16BE(value * 257, at);
            at += 2;
          } else row[at++] = value;
        }
      rows.push(row);
    }
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), testPngChunk('IHDR', header)];
  if (color === 3) {
    parts.push(testPngChunk('PLTE', Buffer.from([200, 0, 0, 0, 200, 0])));
    parts.push(testPngChunk('tRNS', Buffer.from([0, 255])));
  }
  if (options.text !== undefined)
    parts.push(testPngChunk('tEXt', Buffer.from('Comment\0' + options.text)));
  parts.push(
    testPngChunk('IDAT', deflateSync(Buffer.concat(rows), { level })),
    testPngChunk('IEND', Buffer.alloc(0))
  );
  return Buffer.concat(parts);
}

/** Independent packed indexed/Adam7 fixture encoder, including all PNG row filters. */
export function makeIndexedCatalogPng(
  depth: number,
  filter: number,
  interlace: boolean,
  invalid = false
): Buffer {
  const width = 501,
    height = 503;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = 3;
  header[12] = interlace ? 1 : 0;
  const passes = interlace
    ? [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2]
      ]
    : [[0, 0, 1, 1]];
  const rows: Buffer[] = [];
  let injected = false;
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const x = Math.abs(p - a),
      y = Math.abs(p - b),
      z = Math.abs(p - c);
    return x <= y && x <= z ? a : y <= z ? b : c;
  };
  for (const [sx, sy, dx, dy] of passes) {
    const columns = Math.max(0, Math.ceil((width - sx!) / dx!));
    let previous = Buffer.alloc(Math.ceil((columns * depth) / 8));
    for (let y = sy!; y < height; y += dy!) {
      const raw = Buffer.alloc(previous.length);
      let sample = 0;
      for (let x = sx!; x < width; x += dx!) {
        let value = invalid ? 0 : (x + y) % 2;
        if (invalid && !injected) {
          value = (1 << depth) - 1;
          injected = true;
        }
        const bit = sample++ * depth;
        raw[bit >>> 3]! |= value << (8 - depth - (bit & 7));
      }
      const encoded = Buffer.alloc(raw.length + 1);
      encoded[0] = filter;
      for (let i = 0; i < raw.length; i++) {
        const a = i ? raw[i - 1]! : 0,
          b = previous[i]!,
          c = i ? previous[i - 1]! : 0;
        const prediction =
          filter === 1
            ? a
            : filter === 2
              ? b
              : filter === 3
                ? (a + b) >>> 1
                : filter === 4
                  ? paeth(a, b, c)
                  : 0;
        encoded[i + 1] = (raw[i]! - prediction) & 255;
      }
      rows.push(encoded);
      previous = raw;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    testPngChunk('IHDR', header),
    testPngChunk('PLTE', Buffer.from(invalid ? [255, 0, 0] : [255, 0, 0, 0, 255, 0])),
    testPngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    testPngChunk('IEND', Buffer.alloc(0))
  ]);
}
