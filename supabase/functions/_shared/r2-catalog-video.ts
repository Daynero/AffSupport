import { TeamFunctionError } from './errors.ts';

/**
 * The S3-compatible adapter for catalog videos (050), after `r2-catalog-images.ts`.
 *
 * No SDK/provider error payload, key or credential crosses this adapter. Parts go
 * to the private staging bucket as a multipart upload; the completed object is
 * verified there, promoted to the public bucket with a server-side copy, probed
 * on its public origin, and only then handed back as a ready copy.
 */
export interface CatalogVideoSigner {
  sign(
    request: Request,
    options?: { aws?: { signQuery?: boolean; allHeaders?: boolean } }
  ): Promise<Request>;
}

export type CatalogVideoPartVerification = 'provider_checksum' | 'readback';

export interface CatalogVideoR2Config {
  accountId: string;
  stagingBucket: string;
  publicBucket: string;
  publicOrigin: string;
  zoneId: string;
  purgeToken: string;
  partVerification: CatalogVideoPartVerification;
}

export const CATALOG_VIDEO_OBJECT_KEY = /^v\/[0-9a-f]{32}\.mp4$/u;
export const CATALOG_VIDEO_MIME = 'video/mp4';

export function readCatalogVideoR2Config(
  env: (key: string) => string | undefined
): CatalogVideoR2Config | null {
  const environment = env('CATALOG_IMAGES_ENVIRONMENT');
  const accountId = env('R2_CATALOG_ACCOUNT_ID');
  const stagingBucket = env('R2_CATALOG_VIDEO_STAGING_BUCKET');
  const publicBucket = env('R2_CATALOG_VIDEO_PUBLIC_BUCKET');
  const publicOrigin = env('R2_CATALOG_VIDEO_PUBLIC_ORIGIN');
  const zoneId = env('R2_CATALOG_ZONE_ID');
  const purgeToken = env('R2_CATALOG_PURGE_TOKEN');
  const verification = env('CATALOG_VIDEOS_PART_VERIFICATION') ?? 'readback';
  if (
    !environment ||
    !['production', 'beta', 'dev'].includes(environment) ||
    !accountId ||
    !/^[a-f0-9]{32}$/u.test(accountId) ||
    stagingBucket !== `soty-catalog-videos-${environment}-staging` ||
    publicBucket !== `soty-catalog-videos-${environment}-public` ||
    !publicOrigin ||
    !zoneId ||
    !/^[a-f0-9]{32}$/u.test(zoneId) ||
    !purgeToken ||
    (verification !== 'readback' && verification !== 'provider_checksum')
  )
    return null;
  try {
    const origin = new URL(publicOrigin);
    if (
      origin.protocol !== 'https:' ||
      origin.origin !== publicOrigin ||
      origin.username ||
      origin.password ||
      origin.hostname.endsWith('.r2.dev') ||
      origin.hostname.endsWith('.r2.cloudflarestorage.com')
    )
      return null;
  } catch {
    return null;
  }
  const confirmation = `${environment}:${accountId}:${stagingBucket}:${publicBucket}:${publicOrigin}`;
  return env('R2_CATALOG_VIDEO_TARGET_CONFIRMATION') === confirmation
    ? {
        accountId,
        stagingBucket,
        publicBucket,
        publicOrigin,
        zoneId,
        purgeToken,
        partVerification: verification
      }
    : null;
}

function providerFailure(status: number): never {
  throw new TeamFunctionError(
    status === 429 ? 'VIDEO_R2_PROVIDER_RATE_LIMITED' : 'VIDEO_R2_PROVIDER_UNAVAILABLE',
    { retryable: true }
  );
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view =
    bytes.buffer instanceof ArrayBuffer
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : Uint8Array.from(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', view));
  return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBase64(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function xmlValue(body: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'u').exec(body);
  return match ? match[1]!.trim() : null;
}

async function collect(response: Response, expected: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new TeamFunctionError('VIDEO_R2_PROVIDER_UNAVAILABLE', { retryable: true });
  const out = new Uint8Array(expected);
  let offset = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (offset + part.value.byteLength > expected)
        throw new TeamFunctionError('VIDEO_R2_CHECKSUM_MISMATCH');
      out.set(part.value, offset);
      offset += part.value.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (offset !== expected) throw new TeamFunctionError('VIDEO_R2_CHECKSUM_MISMATCH');
  return out;
}

export class CatalogVideoR2 {
  constructor(
    readonly config: CatalogVideoR2Config,
    readonly signer: CatalogVideoSigner,
    readonly fetcher: typeof fetch = fetch
  ) {}

  private endpoint(kind: 'staging' | 'public', key: string): URL {
    if (!CATALOG_VIDEO_OBJECT_KEY.test(key)) throw new TeamFunctionError('INVALID_INPUT');
    return new URL(
      `https://${this.config.accountId}.r2.cloudflarestorage.com/${kind === 'staging' ? this.config.stagingBucket : this.config.publicBucket}/${key}`
    );
  }

  publicUrl(key: string): string {
    this.endpoint('public', key);
    return `${this.config.publicOrigin}/${key}`;
  }

  private async send(request: Request, signal: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(new Request(request, { signal }));
    } catch {
      throw new TeamFunctionError('VIDEO_R2_PROVIDER_UNAVAILABLE', { retryable: true });
    }
    return response;
  }

  async createMultipart(key: string, signal: AbortSignal): Promise<string> {
    const url = this.endpoint('staging', key);
    url.searchParams.set('uploads', '');
    const signed = await this.signer.sign(
      new Request(url, { method: 'POST', headers: { 'Content-Type': CATALOG_VIDEO_MIME } })
    );
    const response = await this.send(signed, signal);
    const body = await response.text();
    if (!response.ok) providerFailure(response.status);
    const uploadId = xmlValue(body, 'UploadId');
    if (!uploadId || uploadId.length > 1024) throw new TeamFunctionError('INVALID_RESPONSE');
    return uploadId;
  }

  /**
   * One part, already hashed by the caller. Under `provider_checksum` the storage
   * is asked to verify the hash and must echo it back; under `readback` the hash
   * is checked after completion by reading the part from staging.
   */
  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    bytes: Uint8Array,
    sha256: string,
    signal: AbortSignal
  ): Promise<{ etag: string; verifiedBy: 'provider_checksum' | null }> {
    if (!/^[0-9a-f]{64}$/u.test(sha256) || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000)
      throw new TeamFunctionError('INVALID_INPUT');
    const url = this.endpoint('staging', key);
    url.searchParams.set('partNumber', String(partNumber));
    url.searchParams.set('uploadId', uploadId);
    const headers: Record<string, string> = {
      'Content-Length': String(bytes.byteLength),
      'X-Amz-Content-Sha256': sha256
    };
    const provider = this.config.partVerification === 'provider_checksum';
    if (provider) {
      headers['x-amz-sdk-checksum-algorithm'] = 'SHA256';
      headers['x-amz-checksum-sha256'] = hexToBase64(sha256);
    }
    const signed = await this.signer.sign(new Request(url, { method: 'PUT', headers }), {
      aws: { allHeaders: true }
    });
    const body =
      bytes.buffer instanceof ArrayBuffer
        ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : Uint8Array.from(bytes);
    let response: Response;
    try {
      response = await this.fetcher(new Request(signed, { body, signal }));
    } catch {
      throw new TeamFunctionError('VIDEO_R2_UPLOAD_UNKNOWN', { retryable: true });
    }
    await response.body?.cancel();
    if (!response.ok) {
      if (response.status >= 500) throw new TeamFunctionError('VIDEO_R2_UPLOAD_UNKNOWN', { retryable: true });
      if (provider && response.status === 400) throw new TeamFunctionError('VIDEO_R2_CHECKSUM_MISMATCH');
      providerFailure(response.status);
    }
    const etag = response.headers.get('etag');
    if (!etag || etag.length > 255) throw new TeamFunctionError('VIDEO_R2_UPLOAD_UNKNOWN', { retryable: true });
    const echoed = response.headers.get('x-amz-checksum-sha256');
    return {
      etag,
      verifiedBy: provider && echoed === hexToBase64(sha256) ? 'provider_checksum' : null
    };
  }

  async completeMultipart(
    key: string,
    uploadId: string,
    parts: ReadonlyArray<{ partNumber: number; etag: string }>,
    signal: AbortSignal
  ): Promise<void> {
    if (parts.length < 1 || parts.length > 10_000) throw new TeamFunctionError('INVALID_INPUT');
    const xml =
      '<CompleteMultipartUpload>' +
      parts
        .map(
          part =>
            `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${part.etag.replace(/[<>&]/gu, '')}</ETag></Part>`
        )
        .join('') +
      '</CompleteMultipartUpload>';
    const bytes = new TextEncoder().encode(xml);
    const url = this.endpoint('staging', key);
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
    let response: Response;
    try {
      response = await this.fetcher(new Request(signed, { body: bytes, signal }));
    } catch {
      throw new TeamFunctionError('VIDEO_R2_UPLOAD_UNKNOWN', { retryable: true });
    }
    const text = await response.text();
    if (!response.ok) {
      if (response.status >= 500) throw new TeamFunctionError('VIDEO_R2_UPLOAD_UNKNOWN', { retryable: true });
      providerFailure(response.status);
    }
    // S3 may answer 200 with an error document; only a result with an ETag is a completion.
    if (!xmlValue(text, 'ETag')) throw new TeamFunctionError('VIDEO_R2_UPLOAD_UNKNOWN', { retryable: true });
  }

  async abortMultipart(key: string, uploadId: string, signal: AbortSignal): Promise<void> {
    const url = this.endpoint('staging', key);
    url.searchParams.set('uploadId', uploadId);
    const signed = await this.signer.sign(new Request(url, { method: 'DELETE' }));
    const response = await this.send(signed, signal);
    await response.body?.cancel();
    if (!response.ok && response.status !== 404) providerFailure(response.status);
  }

  async headStaging(key: string, signal: AbortSignal): Promise<{ sizeBytes: number } | null> {
    const signed = await this.signer.sign(new Request(this.endpoint('staging', key), { method: 'HEAD' }));
    const response = await this.send(signed, signal);
    await response.body?.cancel();
    if (response.status === 404) return null;
    if (!response.ok) providerFailure(response.status);
    const size = Number(response.headers.get('content-length'));
    if (!Number.isSafeInteger(size) || size < 0) throw new TeamFunctionError('INVALID_RESPONSE');
    return { sizeBytes: size };
  }

  async readStagingRange(key: string, start: number, end: number, signal: AbortSignal): Promise<Uint8Array> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start + 1 > 64 * 1024 * 1024)
      throw new TeamFunctionError('INVALID_INPUT');
    const signed = await this.signer.sign(
      new Request(this.endpoint('staging', key), { headers: { Range: `bytes=${start}-${end}` } })
    );
    const response = await this.send(signed, signal);
    if (response.status !== 206) {
      await response.body?.cancel();
      if (response.status === 404) throw new TeamFunctionError('VIDEO_R2_UPLOAD_UNKNOWN', { retryable: true });
      providerFailure(response.status);
    }
    return collect(response, end - start + 1);
  }

  /** Server-side copy of the verified staging object into the public bucket under the same key. */
  async promote(key: string, signal: AbortSignal): Promise<void> {
    const signed = await this.signer.sign(
      new Request(this.endpoint('public', key), {
        method: 'PUT',
        headers: {
          'x-amz-copy-source': `/${this.config.stagingBucket}/${key}`,
          'x-amz-metadata-directive': 'REPLACE',
          'Content-Type': CATALOG_VIDEO_MIME,
          'Cache-Control': 'public,max-age=31536000,immutable',
          'Content-Disposition': 'inline'
        }
      }),
      { aws: { allHeaders: true } }
    );
    let response: Response;
    try {
      response = await this.fetcher(new Request(signed, { signal }));
    } catch {
      throw new TeamFunctionError('VIDEO_R2_UPLOAD_UNKNOWN', { retryable: true });
    }
    const text = await response.text();
    if (!response.ok) {
      if (response.status >= 500) throw new TeamFunctionError('VIDEO_R2_UPLOAD_UNKNOWN', { retryable: true });
      providerFailure(response.status);
    }
    if (!xmlValue(text, 'ETag')) throw new TeamFunctionError('VIDEO_R2_UPLOAD_UNKNOWN', { retryable: true });
  }

  async publicHead(
    key: string,
    signal: AbortSignal
  ): Promise<{ sizeBytes: number; contentType: string | null; nosniff: boolean; acceptRanges: boolean }> {
    let response: Response;
    try {
      response = await this.fetcher(this.publicUrl(key), {
        method: 'HEAD',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal
      });
    } catch {
      throw new TeamFunctionError('VIDEO_R2_PUBLIC_UNREACHABLE', { retryable: true });
    }
    await response.body?.cancel();
    if (!response.ok) throw new TeamFunctionError('VIDEO_R2_PUBLIC_UNREACHABLE', { retryable: true });
    const size = Number(response.headers.get('content-length'));
    if (!Number.isSafeInteger(size) || size < 0) throw new TeamFunctionError('VIDEO_R2_PUBLIC_UNREACHABLE', { retryable: true });
    return {
      sizeBytes: size,
      contentType: response.headers.get('content-type')?.split(';')[0]?.trim() ?? null,
      nosniff: response.headers.get('x-content-type-options')?.toLowerCase() === 'nosniff',
      acceptRanges: response.headers.get('accept-ranges')?.toLowerCase() === 'bytes'
    };
  }

  async publicRange(key: string, start: number, end: number, signal: AbortSignal): Promise<Uint8Array> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start + 1 > 16 * 1024 * 1024)
      throw new TeamFunctionError('INVALID_INPUT');
    let response: Response;
    try {
      response = await this.fetcher(this.publicUrl(key), {
        headers: { Range: `bytes=${start}-${end}` },
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal
      });
    } catch {
      throw new TeamFunctionError('VIDEO_R2_PUBLIC_UNREACHABLE', { retryable: true });
    }
    if (response.status !== 206) {
      await response.body?.cancel();
      throw new TeamFunctionError('VIDEO_R2_PUBLIC_UNREACHABLE', { retryable: true });
    }
    return collect(response, end - start + 1);
  }

  async removeStaging(key: string, signal: AbortSignal): Promise<void> {
    const signed = await this.signer.sign(new Request(this.endpoint('staging', key), { method: 'DELETE' }));
    const response = await this.send(signed, signal);
    await response.body?.cancel();
    if (!response.ok && response.status !== 404) providerFailure(response.status);
  }

  /** Delete the public object, prove it is gone, and purge the CDN; any doubt is `CLEANUP_PARTIAL`. */
  async removePublic(key: string, signal: AbortSignal): Promise<void> {
    const signed = await this.signer.sign(new Request(this.endpoint('public', key), { method: 'DELETE' }));
    const response = await this.send(signed, signal);
    await response.body?.cancel();
    if (!response.ok && response.status !== 404) providerFailure(response.status);
    const readback = await this.send(
      await this.signer.sign(new Request(this.endpoint('public', key), { method: 'HEAD' })),
      signal
    );
    await readback.body?.cancel();
    if (readback.status !== 404) throw new TeamFunctionError('VIDEO_R2_CLEANUP_PARTIAL', { retryable: true });
    const purge = await this.send(
      new Request(`https://api.cloudflare.com/client/v4/zones/${this.config.zoneId}/purge_cache`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.purgeToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ files: [this.publicUrl(key)] })
      }),
      signal
    );
    const payload: unknown = await purge.json().catch(() => null);
    if (
      !purge.ok ||
      !payload ||
      typeof payload !== 'object' ||
      !('success' in payload) ||
      payload.success !== true
    )
      throw new TeamFunctionError('VIDEO_R2_CLEANUP_PARTIAL', { retryable: true });
  }
}
