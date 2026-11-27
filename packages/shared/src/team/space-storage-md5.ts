// @ts-self-types="./space-storage-md5.d.ts"
/**
 * MD5 of one upload part (057 research R3, 2026-11-28).
 *
 * R2 computes a part's ETag as the MD5 of the bytes it received and rejects a
 * part whose `Content-MD5` does not match. A browser has no MD5 in WebCrypto,
 * so the web client and the tests use this one implementation; the agent may
 * use `node:crypto` and must produce the same hex. Not a security primitive:
 * see the residual risk recorded in research.md R3.
 */
const SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];
const CONSTANTS = Array.from(
  { length: 64 },
  (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0
);

/** Streaming MD5: feed parts of a part in order, then `digest()` once. */
export class SpaceMd5 {
  private state = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
  private buffer = new Uint8Array(64);
  private buffered = 0;
  private length = 0;
  private done = false;

  update(bytes: Uint8Array): this {
    if (this.done) throw new Error('MD5 already finalized');
    let offset = 0;
    this.length += bytes.length;
    if (this.buffered > 0) {
      const take = Math.min(64 - this.buffered, bytes.length);
      this.buffer.set(bytes.subarray(0, take), this.buffered);
      this.buffered += take;
      offset = take;
      if (this.buffered < 64) return this;
      this.block(this.buffer, 0);
      this.buffered = 0;
    }
    for (; offset + 64 <= bytes.length; offset += 64) this.block(bytes, offset);
    if (offset < bytes.length) {
      this.buffer.set(bytes.subarray(offset), 0);
      this.buffered = bytes.length - offset;
    }
    return this;
  }

  digest(): Uint8Array {
    if (this.done) throw new Error('MD5 already finalized');
    const bitLength = this.length * 8;
    const padding = new Uint8Array(this.buffered < 56 ? 64 - this.buffered : 128 - this.buffered);
    padding[0] = 0x80;
    const view = new DataView(padding.buffer);
    view.setUint32(padding.length - 8, bitLength >>> 0, true);
    view.setUint32(padding.length - 4, Math.floor(bitLength / 0x100000000) >>> 0, true);
    const total = this.length;
    this.update(padding);
    this.length = total;
    this.done = true;
    const out = new Uint8Array(16);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 4; i += 1) outView.setUint32(i * 4, this.state[i]!, true);
    return out;
  }

  private block(bytes: Uint8Array, offset: number): void {
    const words = new Uint32Array(16);
    for (let i = 0; i < 16; i += 1) {
      const at = offset + i * 4;
      words[i] =
        (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>>
        0;
    }
    let a = this.state[0]!;
    let b = this.state[1]!;
    let c = this.state[2]!;
    let d = this.state[3]!;
    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const next = d;
      d = c;
      c = b;
      const sum = (a + f + CONSTANTS[i]! + words[g]!) >>> 0;
      const shift = SHIFTS[i]!;
      b = (b + ((sum << shift) | (sum >>> (32 - shift)))) >>> 0;
      a = next;
    }
    this.state[0] = (this.state[0]! + a) >>> 0;
    this.state[1] = (this.state[1]! + b) >>> 0;
    this.state[2] = (this.state[2]! + c) >>> 0;
    this.state[3] = (this.state[3]! + d) >>> 0;
  }
}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

export function spaceMd5Hex(bytes: Uint8Array): string {
  return toHex(new SpaceMd5().update(bytes).digest());
}

/** The `Content-MD5` header value for a part: base64 of the 16 raw digest bytes. */
export function spaceMd5Base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...new SpaceMd5().update(bytes).digest()));
}

/** Hex MD5 (an R2 part ETag without quotes) → the `Content-MD5` base64 form. */
export function spaceMd5HexToBase64(hex: string): string | null {
  if (!/^[0-9a-f]{32}$/u.test(hex)) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return btoa(String.fromCharCode(...bytes));
}
