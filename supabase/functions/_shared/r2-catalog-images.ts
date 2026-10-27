import { TeamFunctionError } from './errors.ts';
import { readCatalogImageBytes } from './catalog-image-validation.ts';

export interface CatalogImageSigner {
  sign(
    request: Request,
    options?: { aws?: { signQuery?: boolean; allHeaders?: boolean } }
  ): Promise<Request>;
}

export interface CatalogR2Config {
  accountId: string;
  stagingBucket: string;
  publicBucket: string;
  publicOrigin: string;
  zoneId: string;
  purgeToken: string;
}

export function readCatalogR2Config(
  env: (key: string) => string | undefined
): CatalogR2Config | null {
  const environment = env('CATALOG_IMAGES_ENVIRONMENT');
  const accountId = env('R2_CATALOG_ACCOUNT_ID');
  const stagingBucket = env('R2_CATALOG_STAGING_BUCKET');
  const publicBucket = env('R2_CATALOG_PUBLIC_BUCKET');
  const publicOrigin = env('R2_CATALOG_PUBLIC_ORIGIN');
  const zoneId = env('R2_CATALOG_ZONE_ID');
  const purgeToken = env('R2_CATALOG_PURGE_TOKEN');
  if (
    !environment ||
    !['production', 'beta', 'dev'].includes(environment) ||
    !accountId ||
    !/^[a-f0-9]{32}$/u.test(accountId) ||
    stagingBucket !== `soty-catalog-images-${environment}-staging` ||
    publicBucket !== `soty-catalog-images-${environment}-public` ||
    !publicOrigin ||
    !zoneId ||
    !/^[a-f0-9]{32}$/u.test(zoneId) ||
    !purgeToken
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
  return env('R2_CATALOG_TARGET_CONFIRMATION') === confirmation
    ? { accountId, stagingBucket, publicBucket, publicOrigin, zoneId, purgeToken }
    : null;
}

function providerFailure(status: number): never {
  throw new TeamFunctionError(
    status === 429 ? 'IMAGE_PROVIDER_RATE_LIMITED' : 'IMAGE_PROVIDER_UNAVAILABLE',
    { retryable: true }
  );
}

/** No SDK/provider error payload, key or credential crosses this adapter. */
export class CatalogImageR2 {
  constructor(
    readonly config: CatalogR2Config,
    readonly signer: CatalogImageSigner,
    readonly fetcher: typeof fetch = fetch
  ) {}

  private endpoint(kind: 'staging' | 'public', key: string): URL {
    if (!(kind === 'public' ? /^v1\/[a-f0-9-]{36}$/u : /^[a-f0-9-]{36}$/u).test(key))
      throw new TeamFunctionError('INVALID_INPUT');
    return new URL(
      `https://${this.config.accountId}.r2.cloudflarestorage.com/${kind === 'staging' ? this.config.stagingBucket : this.config.publicBucket}/${key}`
    );
  }

  publicUrl(key: string): string {
    this.endpoint('public', key);
    return `${this.config.publicOrigin}/${key}`;
  }

  async stagingGrant(key: string, mime: string, expiresAt: string, generation: number) {
    const seconds = Math.min(300, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
    if (!Number.isSafeInteger(seconds) || seconds < 1) throw new TeamFunctionError('EXPIRED');
    const url = this.endpoint('staging', key);
    url.searchParams.set('X-Amz-Expires', String(seconds));
    const headers = { 'Content-Type': mime };
    const signed = await this.signer.sign(new Request(url, { method: 'PUT', headers }), {
      aws: { signQuery: true, allHeaders: true }
    });
    return { url: signed.url, headers, expiresAt, generation };
  }

  async get(
    kind: 'staging' | 'public',
    key: string,
    signal: AbortSignal
  ): Promise<Response | null> {
    const signed = await this.signer.sign(new Request(this.endpoint(kind, key), { signal }));
    const request = new Request(signed, { signal });
    const result = await this.fetcher(request);
    if (result.status === 404) {
      await result.body?.cancel();
      return null;
    }
    if (!result.ok) {
      await result.body?.cancel();
      providerFailure(result.status);
    }
    return result;
  }

  async readStaging(key: string, size: number, signal: AbortSignal): Promise<Uint8Array | null> {
    const result = await this.get('staging', key, signal);
    return result ? readCatalogImageBytes(result, size) : null;
  }

  async putFinal(
    key: string,
    bytes: Uint8Array,
    mime: string,
    signal: AbortSignal,
    sha256: string
  ): Promise<'created' | 'exists'> {
    if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new TeamFunctionError('INVALID_INPUT');
    // Sign metadata and the already verified digest before attaching the body.
    // Passing a full-buffer Request through aws4fetch eagerly copies it several times.
    const signed = await this.signer.sign(
      new Request(this.endpoint('public', key), {
        method: 'PUT',
        signal,
        headers: {
          'Content-Type': mime,
          'Content-Length': String(bytes.byteLength),
          'X-Amz-Content-Sha256': sha256,
          'Cache-Control': 'public,max-age=31536000,immutable',
          'Content-Disposition': 'inline',
          'If-None-Match': '*'
        }
      }),
      { aws: { allHeaders: true } }
    );
    let offset = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (offset === bytes.byteLength) {
            controller.close();
            return;
          }
          const end = Math.min(offset + 262_144, bytes.byteLength);
          controller.enqueue(bytes.subarray(offset, end));
          offset = end;
        }
      },
      { highWaterMark: 0 }
    );
    // Node's fetch requires duplex for streams; Deno accepts the same portable init.
    const streaming = { body, duplex: 'half', signal };
    const request = new Request(signed, streaming);
    let response: Response;
    try {
      response = await this.fetcher(request);
    } catch {
      throw new TeamFunctionError('IMAGE_WRITE_UNCERTAIN', { retryable: true });
    }
    await response.body?.cancel();
    if (response.status === 412) return 'exists';
    if (!response.ok) {
      if (response.status >= 500)
        throw new TeamFunctionError('IMAGE_WRITE_UNCERTAIN', { retryable: true });
      providerFailure(response.status);
    }
    return 'created';
  }

  async verify(
    key: string,
    bytes: Uint8Array,
    mime: string,
    signal: AbortSignal,
    publicRead: boolean
  ): Promise<void> {
    const response = publicRead
      ? await this.fetcher(this.publicUrl(key), {
          redirect: 'error',
          credentials: 'omit',
          signal,
          cache: 'no-store'
        })
      : await this.get('public', key, signal);
    if (
      !response ||
      !response.ok ||
      !response.body ||
      response.headers.get('content-type')?.split(';')[0]?.trim() !== mime ||
      (publicRead && response.headers.get('x-content-type-options')?.toLowerCase() !== 'nosniff')
    ) {
      await response?.body?.cancel();
      throw new TeamFunctionError('IMAGE_PUBLIC_VERIFICATION_FAILED', { retryable: true });
    }
    const reader = response.body.getReader();
    let offset = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        if (offset + part.value.length > bytes.length)
          throw new TeamFunctionError('IMAGE_PUBLIC_VERIFICATION_FAILED');
        for (let at = 0; at < part.value.length; at += 1)
          if (part.value[at] !== bytes[offset + at])
            throw new TeamFunctionError('IMAGE_PUBLIC_VERIFICATION_FAILED');
        offset += part.value.length;
      }
      if (offset !== bytes.length) throw new TeamFunctionError('IMAGE_PUBLIC_VERIFICATION_FAILED');
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  async remove(kind: 'staging' | 'public', key: string, signal: AbortSignal): Promise<void> {
    const signed = await this.signer.sign(
      new Request(this.endpoint(kind, key), { method: 'DELETE', signal })
    );
    const request = new Request(signed, { signal });
    const response = await this.fetcher(request);
    await response.body?.cancel();
    if (!response.ok && response.status !== 404) providerFailure(response.status);
    const readback = await this.get(kind, key, signal);
    if (readback) {
      await readback.body?.cancel();
      throw new TeamFunctionError('IMAGE_WRITE_UNCERTAIN', { retryable: true });
    }
    if (kind === 'public') {
      const purge = await this.fetcher(
        `https://api.cloudflare.com/client/v4/zones/${this.config.zoneId}/purge_cache`,
        {
          method: 'POST',
          signal,
          headers: {
            authorization: `Bearer ${this.config.purgeToken}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({ files: [this.publicUrl(key)] })
        }
      );
      const payload: unknown = await purge.json().catch(() => null);
      if (
        !purge.ok ||
        !payload ||
        typeof payload !== 'object' ||
        !('success' in payload) ||
        payload.success !== true
      )
        throw new TeamFunctionError('IMAGE_WRITE_UNCERTAIN', { retryable: true });
    }
  }
}
