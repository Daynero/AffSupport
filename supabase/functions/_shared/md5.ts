/**
 * Incremental MD5, for comparing a copied video with Drive's `md5Checksum`.
 *
 * WebCrypto has no MD5 and the edge runtime bundles no Node `crypto`. The
 * digest is not used for security here, only to prove that the bytes written
 * to R2 are the bytes Drive holds (FR-004), when the whole file passed through
 * one invocation.
 */
const K = new Uint32Array(64);
const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];
for (let i = 0; i < 64; i += 1) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;

export class Md5 {
  #state = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
  #buffer = new Uint8Array(64);
  #buffered = 0;
  #length = 0;
  #words = new Uint32Array(16);

  update(bytes: Uint8Array): this {
    let offset = 0;
    this.#length += bytes.byteLength;
    if (this.#buffered > 0) {
      const take = Math.min(64 - this.#buffered, bytes.byteLength);
      this.#buffer.set(bytes.subarray(0, take), this.#buffered);
      this.#buffered += take;
      offset = take;
      if (this.#buffered === 64) {
        this.#block(this.#buffer, 0);
        this.#buffered = 0;
      }
    }
    while (offset + 64 <= bytes.byteLength) {
      this.#block(bytes, offset);
      offset += 64;
    }
    if (offset < bytes.byteLength) {
      this.#buffer.set(bytes.subarray(offset), 0);
      this.#buffered = bytes.byteLength - offset;
    }
    return this;
  }

  /** Hex digest; the instance must not be updated afterwards. */
  digest(): string {
    const bits = this.#length * 8;
    const tail = new Uint8Array(this.#buffered <= 55 ? 64 : 128);
    tail.set(this.#buffer.subarray(0, this.#buffered), 0);
    tail[this.#buffered] = 0x80;
    const view = new DataView(tail.buffer);
    view.setUint32(tail.byteLength - 8, bits >>> 0, true);
    view.setUint32(tail.byteLength - 4, Math.floor(bits / 2 ** 32) >>> 0, true);
    this.#block(tail, 0);
    if (tail.byteLength === 128) this.#block(tail, 64);
    let hex = '';
    for (const word of this.#state) {
      for (let i = 0; i < 4; i += 1)
        hex += ((word >>> (8 * i)) & 0xff).toString(16).padStart(2, '0');
    }
    return hex;
  }

  #block(bytes: Uint8Array, offset: number) {
    const w = this.#words;
    for (let i = 0; i < 16; i += 1) {
      const at = offset + i * 4;
      w[i] =
        (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>>
        0;
    }
    let [a, b, c, d] = this.#state as unknown as [number, number, number, number];
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
      const sum = (a + f + K[i]! + w[g]!) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + ((sum << S[i]!) | (sum >>> (32 - S[i]!)))) >>> 0;
    }
    this.#state[0] = (this.#state[0]! + a) >>> 0;
    this.#state[1] = (this.#state[1]! + b) >>> 0;
    this.#state[2] = (this.#state[2]! + c) >>> 0;
    this.#state[3] = (this.#state[3]! + d) >>> 0;
  }
}

export function md5Hex(bytes: Uint8Array): string {
  return new Md5().update(bytes).digest();
}
