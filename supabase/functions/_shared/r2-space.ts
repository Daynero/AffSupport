import { TeamFunctionError } from './errors.ts';
import {
  SPACE_STORAGE_LIMITS,
  isSpaceKey,
  normalizePartEtag
} from '../../../packages/shared/dist/team/space-storage.js';
import { spaceMd5HexToBase64 } from '../../../packages/shared/dist/team/space-storage-md5.js';

/**
 * The bucket client of Soty spaces on R2 (057 T009), after `r2-catalog-video.ts`.
 *
 * S3-compatible calls against `soty-spaces-{env}` only, signed by an injected
 * signer — the edge entry passes `new AwsClient(...)` from `npm:aws4fetch@1.0.20`,
 * as `catalog-global-images/index.ts` does. No provider payload, key, account or
 * credential crosses this module: every failure is a closed `TeamFunctionError`.
 *
 * Content identity rests on part ETags (research.md R3, 2026-11-28): R2 answers
 * 501 for `x-amz-checksum-sha256`, so a part URL signs `Content-MD5` instead and
 * the server reads the ETags R2 computed through `listParts`.
 */
export interface SpaceR2Signer {
  sign(
    request: Request,
    options?: { aws?: { signQuery?: boolean; allHeaders?: boolean } }
  ): Promise<Request>;
}

export type SpaceR2Environment = 'production' | 'beta' | 'dev';

export interface SpaceR2Config {
  environment: SpaceR2Environment;
  accountId: string;
  bucket: string;
  /** For the edge entry's signer only; never logged, never returned. */
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * `R2_SPACE_*` from the function secrets. The bucket must be exactly
 * `soty-spaces-${CATALOG_IMAGES_ENVIRONMENT}`, so a beta function can never be
 * pointed at the production bucket or at another feature's bucket.
 */
export function readSpaceR2Config(env: (key: string) => string | undefined): SpaceR2Config | null {
  const environment = env('CATALOG_IMAGES_ENVIRONMENT');
  const accountId = env('R2_SPACE_ACCOUNT_ID');
  const accessKeyId = env('R2_SPACE_ACCESS_KEY_ID');
  const secretAccessKey = env('R2_SPACE_SECRET_ACCESS_KEY');
  const bucket = env('R2_SPACE_BUCKET');
  if (
    (environment !== 'production' && environment !== 'beta' && environment !== 'dev') ||
    !accountId ||
    !/^[a-f0-9]{32}$/u.test(accountId) ||
    !accessKeyId ||
    !secretAccessKey ||
    bucket !== `soty-spaces-${environment}`
  )
    return null;
  return { environment, accountId, bucket, accessKeyId, secretAccessKey };
}

export interface SpaceSignedPart {
  partNumber: number;
  url: string;
  /** The exact `Content-MD5` header the client must send; it is inside the signature. */
  contentMd5: string;
  expiresAt: string;
}

export interface SpaceListedPart {
  partNumber: number;
  /** The part's MD5 as R2 computed it, 32 lowercase hex. */
  etag: string;
  bytes: number;
}

export interface SpaceListedObject {
  key: string;
  bytes: number;
  etag: string;
}

const MAX_RANGE_BYTES = 16 * 1024 * 1024;
const LIST_PAGE = 1000;
const PREFIX =
  /^t\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(?:[uod]\/)?$/u;

function invalidInput(): never {
  throw new TeamFunctionError('INVALID_INPUT');
}

function invalidResponse(): never {
  throw new TeamFunctionError('INVALID_RESPONSE');
}

/** A refusal of our own credentials is configuration, not an outage: not retryable. */
function providerFailure(status: number): never {
  if (status === 429) throw new TeamFunctionError('RATE_LIMITED', { retryable: true });
  throw new TeamFunctionError('STORAGE_UNAVAILABLE', {
    retryable: !(status === 401 || status === 403)
  });
}

function unavailable(): never {
  throw new TeamFunctionError('STORAGE_UNAVAILABLE', { retryable: true });
}

const ENTITIES: Record<string, string> = {
  '&quot;': '"',
  '&apos;': "'",
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&'
};
const decodeXml = (value: string): string =>
  value.replace(/&(?:quot|apos|lt|gt|amp);/gu, entity => ENTITIES[entity]!);

function xmlValue(body: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'u').exec(body);
  return match ? decodeXml(match[1]!.trim()) : null;
}

function xmlBlocks(body: string, tag: string): string[] {
  return [...body.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'gu'))].map(m => m[1]!);
}

function safeInteger(value: string | null, min: number, max: number): number {
  if (value === null || !/^\d{1,16}$/u.test(value)) return invalidResponse();
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : invalidResponse();
}

function validUploadId(uploadId: string): void {
  if (typeof uploadId !== 'string' || uploadId.length < 1 || uploadId.length > 1024) invalidInput();
}

function validPartNumber(partNumber: number): void {
  if (
    !Number.isSafeInteger(partNumber) ||
    partNumber < 1 ||
    partNumber > SPACE_STORAGE_LIMITS.maxParts
  )
    invalidInput();
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
}

async function collect(response: Response, expected: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return expected === 0 ? new Uint8Array(0) : invalidResponse();
  const out = new Uint8Array(expected);
  let offset = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (offset + part.value.byteLength > expected) invalidResponse();
      out.set(part.value, offset);
      offset += part.value.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof TeamFunctionError) throw error;
    unavailable();
  } finally {
    reader.releaseLock();
  }
  if (offset !== expected) invalidResponse();
  return out;
}

export class SpaceR2 {
  constructor(
    readonly config: SpaceR2Config,
    readonly signer: SpaceR2Signer,
    readonly fetcher: typeof fetch = fetch
  ) {}

  private bucketUrl(): URL {
    return new URL(
      `https://${this.config.accountId}.r2.cloudflarestorage.com/${this.config.bucket}`
    );
  }

  private endpoint(key: string): URL {
    if (!isSpaceKey(key)) invalidInput();
    return new URL(
      `https://${this.config.accountId}.r2.cloudflarestorage.com/${this.config.bucket}/${key}`
    );
  }

  private async send(request: Request, signal: AbortSignal, body?: BodyInit): Promise<Response> {
    try {
      return await this.fetcher(
        new Request(request, body === undefined ? { signal } : { body, signal })
      );
    } catch {
      return unavailable();
    }
  }

  private async text(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return unavailable();
    }
  }

  async createMultipart(key: string, contentType: string, signal: AbortSignal): Promise<string> {
    const url = this.endpoint(key);
    if (typeof contentType !== 'string' || !/^[\w.+-]{1,64}\/[\w.+-]{1,128}$/u.test(contentType))
      invalidInput();
    url.searchParams.set('uploads', '');
    const signed = await this.signer.sign(
      new Request(url, { method: 'POST', headers: { 'Content-Type': contentType } })
    );
    const response = await this.send(signed, signal);
    const body = await this.text(response);
    if (!response.ok) providerFailure(response.status);
    const uploadId = xmlValue(body, 'UploadId');
    if (!uploadId || uploadId.length > 1024) invalidResponse();
    return uploadId;
  }

  /**
   * A presigned PUT for one part. `Content-MD5` is a signed header, so the URL
   * accepts only the bytes whose MD5 the client declared, and R2 rejects a part
   * that arrives damaged. Nothing is sent to R2 here.
   */
  async signPart(
    key: string,
    uploadId: string,
    partNumber: number,
    md5Hex: string,
    nowMs: number = Date.now(),
    ttlSeconds: number = SPACE_STORAGE_LIMITS.partUrlTtlSeconds
  ): Promise<SpaceSignedPart> {
    const url = this.endpoint(key);
    validUploadId(uploadId);
    validPartNumber(partNumber);
    const contentMd5 = typeof md5Hex === 'string' ? spaceMd5HexToBase64(md5Hex) : null;
    if (
      !contentMd5 ||
      !Number.isSafeInteger(ttlSeconds) ||
      ttlSeconds < 1 ||
      ttlSeconds > SPACE_STORAGE_LIMITS.partUrlTtlSeconds ||
      !Number.isFinite(nowMs)
    )
      invalidInput();
    url.searchParams.set('partNumber', String(partNumber));
    url.searchParams.set('uploadId', uploadId);
    url.searchParams.set('X-Amz-Expires', String(ttlSeconds));
    const signed = await this.signer.sign(
      new Request(url, { method: 'PUT', headers: { 'Content-MD5': contentMd5 } }),
      { aws: { signQuery: true } }
    );
    return {
      partNumber,
      url: signed.url,
      contentMd5,
      expiresAt: new Date(nowMs + ttlSeconds * 1000).toISOString()
    };
  }

  /** Every uploaded part with the ETag R2 computed from the bytes it received, in order. */
  async listParts(key: string, uploadId: string, signal: AbortSignal): Promise<SpaceListedPart[]> {
    validUploadId(uploadId);
    const parts: SpaceListedPart[] = [];
    let marker = 0;
    for (let page = 0; page <= SPACE_STORAGE_LIMITS.maxParts / LIST_PAGE; page += 1) {
      const url = this.endpoint(key);
      url.searchParams.set('uploadId', uploadId);
      url.searchParams.set('max-parts', String(LIST_PAGE));
      if (marker > 0) url.searchParams.set('part-number-marker', String(marker));
      const response = await this.send(await this.signer.sign(new Request(url)), signal);
      const body = await this.text(response);
      if (!response.ok) providerFailure(response.status);
      if (!body.includes('<ListPartsResult')) invalidResponse();
      for (const block of xmlBlocks(body, 'Part')) {
        const partNumber = safeInteger(
          xmlValue(block, 'PartNumber'),
          1,
          SPACE_STORAGE_LIMITS.maxParts
        );
        const etag = normalizePartEtag(xmlValue(block, 'ETag'));
        const bytes = safeInteger(xmlValue(block, 'Size'), 0, 5 * 1024 * 1024 * 1024);
        if (!etag || partNumber <= (parts.at(-1)?.partNumber ?? 0)) invalidResponse();
        parts.push({ partNumber, etag, bytes });
      }
      const truncated = xmlValue(body, 'IsTruncated');
      if (truncated === 'false') return parts;
      if (truncated !== 'true') invalidResponse();
      const next = safeInteger(
        xmlValue(body, 'NextPartNumberMarker'),
        1,
        SPACE_STORAGE_LIMITS.maxParts
      );
      if (next <= marker) invalidResponse();
      marker = next;
    }
    return invalidResponse();
  }

  /** Close the upload with the given parts (the caller passes what `listParts` returned). */
  async completeMultipart(
    key: string,
    uploadId: string,
    parts: ReadonlyArray<{ partNumber: number; etag: string }>,
    signal: AbortSignal
  ): Promise<{ etag: string }> {
    const url = this.endpoint(key);
    validUploadId(uploadId);
    if (parts.length < 1 || parts.length > SPACE_STORAGE_LIMITS.maxParts) invalidInput();
    let previous = 0;
    const xml =
      '<CompleteMultipartUpload>' +
      parts
        .map(part => {
          validPartNumber(part.partNumber);
          const etag = normalizePartEtag(part.etag);
          if (!etag || part.partNumber <= previous) invalidInput();
          previous = part.partNumber;
          return `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>"${etag}"</ETag></Part>`;
        })
        .join('') +
      '</CompleteMultipartUpload>';
    const bytes = new TextEncoder().encode(xml);
    url.searchParams.set('uploadId', uploadId);
    const signed = await this.signer.sign(
      new Request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/xml',
          'Content-Length': String(bytes.byteLength),
          'X-Amz-Content-Sha256': await sha256Hex(bytes)
        }
      }),
      { aws: { allHeaders: true } }
    );
    const response = await this.send(signed, signal, bytes);
    const text = await this.text(response);
    if (!response.ok) providerFailure(response.status);
    // S3 may answer 200 with an error document; only a result with an ETag is a completion.
    const etag = text.includes('<CompleteMultipartUploadResult') ? xmlValue(text, 'ETag') : null;
    if (!etag || etag.length > 255) unavailable();
    return { etag };
  }

  async abortMultipart(key: string, uploadId: string, signal: AbortSignal): Promise<void> {
    const url = this.endpoint(key);
    validUploadId(uploadId);
    url.searchParams.set('uploadId', uploadId);
    const response = await this.send(
      await this.signer.sign(new Request(url, { method: 'DELETE' })),
      signal
    );
    await response.body?.cancel();
    if (!response.ok && response.status !== 404) providerFailure(response.status);
  }

  async head(
    key: string,
    signal: AbortSignal
  ): Promise<{ bytes: number; etag: string; contentType: string | null } | null> {
    const response = await this.send(
      await this.signer.sign(new Request(this.endpoint(key), { method: 'HEAD' })),
      signal
    );
    await response.body?.cancel();
    if (response.status === 404) return null;
    if (!response.ok) providerFailure(response.status);
    const bytes = safeInteger(
      response.headers.get('content-length'),
      0,
      SPACE_STORAGE_LIMITS.maxObjectBytes
    );
    const etag = response.headers.get('etag');
    if (!etag || etag.length > 255) invalidResponse();
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() || null;
    return { bytes, etag, contentType };
  }

  /** At most 16 MiB of one object, for the server's own checks (derivative headers). */
  async rangeGet(
    key: string,
    start: number,
    end: number,
    signal: AbortSignal
  ): Promise<Uint8Array> {
    const url = this.endpoint(key);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end - start + 1 > MAX_RANGE_BYTES
    )
      invalidInput();
    const response = await this.send(
      await this.signer.sign(new Request(url, { headers: { Range: `bytes=${start}-${end}` } })),
      signal
    );
    if (response.status !== 206) {
      await response.body?.cancel();
      if (response.status === 404) throw new TeamFunctionError('NOT_FOUND');
      if (response.ok) invalidResponse();
      providerFailure(response.status);
    }
    const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/u.exec(
      response.headers.get('content-range') ?? ''
    );
    if (!range || Number(range[1]) !== start || Number(range[2]) !== end) {
      await response.body?.cancel();
      invalidResponse();
    }
    return collect(response, end - start + 1);
  }

  async remove(key: string, signal: AbortSignal): Promise<void> {
    const response = await this.send(
      await this.signer.sign(new Request(this.endpoint(key), { method: 'DELETE' })),
      signal
    );
    await response.body?.cancel();
    if (!response.ok && response.status !== 404) providerFailure(response.status);
  }

  /**
   * One page of a space prefix (`t/{team}/`, optionally `u/`, `o/` or `d/`), for
   * reconciliation. Only keys of the documented shapes are returned; anything
   * else under the prefix is counted, never echoed.
   */
  async listPrefix(
    prefix: string,
    continuationToken: string | null,
    signal: AbortSignal
  ): Promise<{ objects: SpaceListedObject[]; foreignKeys: number; nextToken: string | null }> {
    if (typeof prefix !== 'string' || !PREFIX.test(prefix)) invalidInput();
    if (
      continuationToken !== null &&
      (typeof continuationToken !== 'string' ||
        continuationToken.length < 1 ||
        continuationToken.length > 1024)
    )
      invalidInput();
    const url = this.bucketUrl();
    url.searchParams.set('list-type', '2');
    url.searchParams.set('prefix', prefix);
    url.searchParams.set('max-keys', String(LIST_PAGE));
    if (continuationToken) url.searchParams.set('continuation-token', continuationToken);
    const response = await this.send(await this.signer.sign(new Request(url)), signal);
    const body = await this.text(response);
    if (!response.ok) providerFailure(response.status);
    if (!body.includes('<ListBucketResult')) invalidResponse();
    const objects: SpaceListedObject[] = [];
    let foreignKeys = 0;
    const blocks = xmlBlocks(body, 'Contents');
    if (blocks.length > LIST_PAGE) invalidResponse();
    for (const block of blocks) {
      const key = xmlValue(block, 'Key');
      const bytes = safeInteger(xmlValue(block, 'Size'), 0, SPACE_STORAGE_LIMITS.maxObjectBytes);
      const etag = xmlValue(block, 'ETag');
      if (key && isSpaceKey(key) && key.startsWith(prefix) && etag && etag.length <= 255)
        objects.push({ key, bytes, etag });
      else foreignKeys += 1;
    }
    const truncated = xmlValue(body, 'IsTruncated');
    if (truncated === 'false') return { objects, foreignKeys, nextToken: null };
    if (truncated !== 'true') invalidResponse();
    const nextToken = xmlValue(body, 'NextContinuationToken');
    if (!nextToken || nextToken.length > 1024) invalidResponse();
    return { objects, foreignKeys, nextToken };
  }
}
