/**
 * The content identity of a Soty space file (057, research R3), computed on this computer.
 *
 * `content_id` is SHA-256 over the scheme, the part size, the total length and the ordered part
 * MD5s — the same parts the multipart upload sends, so R2's part ETags and this hash agree. The
 * part size follows from the length alone (`spacePartBytes`), so a download, an upload and the
 * source cache all cut a file the same way without asking anyone.
 */
import { createHash, type Hash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { spaceContentId, spacePartBytes, spacePartCount } from '@video-compressor/shared';

const READ_BYTES = 4 * 1024 * 1024;

/**
 * Part MD5s fed in order, whatever the size of the pieces that arrive: a download feeds 32 MiB
 * ranges into 16 or 64 MiB parts, an upload reads whole parts. `checkpoint` and `restore` let a
 * ranged download take back a range that failed half way, as the Drive transfer does with MD5.
 */
export class SpacePartHasher {
  readonly #partBytes: number;
  readonly #totalBytes: number;
  #done: string[] = [];
  #current: Hash = createHash('md5');
  #inPart = 0;
  #fed = 0;
  /** The whole file's MD5 as well: delegates that key a cache on it keep working. */
  #whole: Hash = createHash('md5');

  constructor(totalBytes: number) {
    this.#totalBytes = totalBytes;
    this.#partBytes = spacePartBytes(totalBytes);
  }

  update(chunk: Uint8Array): void {
    this.#whole.update(chunk);
    let offset = 0;
    while (offset < chunk.byteLength) {
      const take = Math.min(this.#partBytes - this.#inPart, chunk.byteLength - offset);
      this.#current.update(chunk.subarray(offset, offset + take));
      this.#inPart += take;
      this.#fed += take;
      offset += take;
      if (this.#inPart === this.#partBytes) {
        this.#done.push(this.#current.digest('hex'));
        this.#current = createHash('md5');
        this.#inPart = 0;
      }
    }
  }

  checkpoint(): { done: string[]; current: Hash; inPart: number; fed: number; whole: Hash } {
    return {
      done: [...this.#done],
      current: this.#current.copy(),
      inPart: this.#inPart,
      fed: this.#fed,
      whole: this.#whole.copy()
    };
  }

  restore(state: ReturnType<SpacePartHasher['checkpoint']>): void {
    this.#done = [...state.done];
    this.#current = state.current.copy();
    this.#inPart = state.inPart;
    this.#fed = state.fed;
    this.#whole = state.whole.copy();
  }

  /** The part MD5s, the whole-file MD5 and the content id; only after every byte was fed. */
  async finish(): Promise<{ partMd5s: string[]; md5: string; contentId: string }> {
    if (this.#fed !== this.#totalBytes) throw new Error('INVALID_RESPONSE');
    const parts = [...this.#done];
    if (this.#inPart > 0 || parts.length === 0) parts.push(this.#current.digest('hex'));
    if (parts.length !== spacePartCount(this.#totalBytes)) throw new Error('INVALID_RESPONSE');
    const result = await spaceContentId(this.#totalBytes, parts);
    if (!result.ok) throw new Error('INVALID_RESPONSE');
    return { partMd5s: parts, md5: this.#whole.digest('hex'), contentId: result.contentId };
  }
}

/** The content id of a file on disk, read once in bounded pieces. */
export async function spaceContentOfFile(
  file: string,
  totalBytes: number,
  signal: AbortSignal
): Promise<{ partMd5s: string[]; md5: string; contentId: string }> {
  const handle = await open(file, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size !== totalBytes) throw new Error('SOURCE_CHANGED');
    const hasher = new SpacePartHasher(totalBytes);
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(READ_BYTES, totalBytes)));
    let offset = 0;
    while (offset < totalBytes) {
      if (signal.aborted) throw signal.reason ?? new Error('PROCESS_CANCELED');
      const length = Math.min(buffer.length, totalBytes - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead !== length) throw new Error('SOURCE_CHANGED');
      hasher.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return await hasher.finish();
  } finally {
    await handle.close();
  }
}
