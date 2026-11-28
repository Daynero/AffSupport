import { TeamFunctionError } from '../_shared/errors.ts';
import type { SpaceR2 } from '../_shared/r2-space.ts';
import type { CatalogVideoDriveReader } from './worker.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTENT_ID = /^[0-9a-f]{64}$/u;
/** A single-part object's ETag is the MD5 of its bytes; a multipart one ends in `-N`. */
const SINGLE_PART_ETAG = /^"?([0-9a-f]{32})"?$/u;

/**
 * 057 T041: the source of a catalog video copy in an R2 space — the space's own bucket, read on
 * the server, never through Drive. It answers the reader seam of the Drive source
 * (`CatalogVideoDriveReader`, worker.ts) so the copy pipeline stays the one proven for Drive:
 * ranged parts, metadata cleaning, full readback against the source MD5, promotion.
 *
 * A file id here is the object's content id in this space; the space is fixed at construction,
 * so a claim can never read another space's object. A multipart object has no whole-file MD5
 * (its ETag is MD5-of-MD5s), so it reports none and the copy refuses it as it refuses a Drive file
 * without a checksum — the content-id path for those is a follow-up (tasks.md T041 note).
 */
export class CatalogVideoSpaceReader implements CatalogVideoDriveReader {
  readonly #space: Pick<SpaceR2, 'config' | 'signer' | 'fetcher' | 'head'>;
  readonly #teamId: string;

  constructor(space: Pick<SpaceR2, 'config' | 'signer' | 'fetcher' | 'head'>, teamId: string) {
    if (!UUID.test(teamId)) throw new TeamFunctionError('INVALID_INPUT');
    this.#space = space;
    this.#teamId = teamId;
  }

  #key(contentId: string): string {
    if (!CONTENT_ID.test(contentId)) throw new TeamFunctionError('INVALID_INPUT');
    return `t/${this.#teamId}/o/${contentId}`;
  }

  async getFile(fileId: string) {
    const head = await this.#space.head(this.#key(fileId), new AbortController().signal);
    if (!head) throw new TeamFunctionError('VIDEO_R2_SOURCE_UNAVAILABLE');
    return {
      id: fileId,
      checksum: SINGLE_PART_ETAG.exec(head.etag)?.[1] ?? null,
      mimeType: head.contentType ?? 'application/octet-stream',
      size: head.bytes,
      version: fileId,
      trashed: false
    };
  }

  async fetchFileRange(input: {
    fileId: string;
    start: number;
    end: number;
    signal?: AbortSignal;
  }): Promise<Response> {
    const key = this.#key(input.fileId);
    if (
      !Number.isSafeInteger(input.start) ||
      !Number.isSafeInteger(input.end) ||
      input.start < 0 ||
      input.end < input.start
    )
      throw new TeamFunctionError('INVALID_INPUT');
    const { config, signer, fetcher } = this.#space;
    const signed = await signer.sign(
      new Request(`https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}/${key}`, {
        headers: { Range: `bytes=${input.start}-${input.end}` }
      })
    );
    try {
      return await fetcher(new Request(signed, { signal: input.signal }));
    } catch {
      throw new TeamFunctionError('VIDEO_R2_PROVIDER_UNAVAILABLE', { retryable: true });
    }
  }
}
