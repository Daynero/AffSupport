import { describe, expect, it } from 'vitest';
import {
  SpaceR2,
  readSpaceR2Config,
  type SpaceR2Signer
} from '../supabase/functions/_shared/r2-space';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';

/**
 * 057 T010 — the space bucket client (T009) against a fake fetch: what it signs,
 * which bucket it refuses, what it never lets out of a provider error, and how it
 * pages a listing. Nothing here reaches R2 or Cloudflare.
 */

const ACCOUNT = 'a'.repeat(32);
const TEAM = '57000000-0000-4000-8000-000000000001';
const UPLOAD = '57000000-0000-4000-8000-000000000004';
const STAGING = `t/${TEAM}/u/${UPLOAD}`;
const OBJECT = `t/${TEAM}/o/${'b'.repeat(64)}`;
const MD5 = '900150983cd24fb0d6963f7d28e17f72';
const MD5_B64 = 'kAFQmDzST7DWlj99KOF/cg==';

const ENV: Record<string, string> = {
  CATALOG_IMAGES_ENVIRONMENT: 'beta',
  R2_SPACE_ACCOUNT_ID: ACCOUNT,
  R2_SPACE_ACCESS_KEY_ID: 'access-key',
  R2_SPACE_SECRET_ACCESS_KEY: 'secret-key',
  R2_SPACE_BUCKET: 'soty-spaces-beta'
};

interface Signed {
  method: string;
  url: string;
  headers: Record<string, string>;
  options: unknown;
}

/** Records every signing; marks the request so the fake fetch can prove it was signed. */
function fakeSigner(log: Signed[]): SpaceR2Signer {
  return {
    async sign(request, options) {
      log.push({
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers.entries()),
        options: options ?? null
      });
      const url = new URL(request.url);
      if (options?.aws?.signQuery) url.searchParams.set('X-Amz-Signature', 'fake');
      const headers = new Headers(request.headers);
      if (!options?.aws?.signQuery) headers.set('authorization', 'AWS4-HMAC-SHA256 fake');
      return new Request(url, { method: request.method, headers });
    }
  };
}

function client(responses: Array<(request: Request) => Response | Promise<Response>>) {
  const signed: Signed[] = [];
  const sent: Request[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
    sent.push(request);
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return next(request);
  }) as typeof fetch;
  const config = readSpaceR2Config(key => ENV[key]);
  if (!config) throw new Error('config');
  return { r2: new SpaceR2(config, fakeSigner(signed), fetcher), signed, sent };
}

const xml =
  (body: string, status = 200) =>
  () =>
    new Response(body, { status, headers: { 'content-type': 'application/xml' } });

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TeamFunctionError) return error.code;
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('configuration', () => {
  it('accepts only the bucket named for this environment', () => {
    expect(readSpaceR2Config(key => ENV[key])).toMatchObject({
      accountId: ACCOUNT,
      bucket: 'soty-spaces-beta',
      environment: 'beta'
    });
    for (const [name, value] of [
      ['R2_SPACE_BUCKET', 'soty-spaces-production'],
      ['R2_SPACE_BUCKET', 'soty-catalog-videos-beta-staging'],
      ['CATALOG_IMAGES_ENVIRONMENT', 'staging'],
      ['R2_SPACE_ACCOUNT_ID', 'not-an-account'],
      ['R2_SPACE_SECRET_ACCESS_KEY', '']
    ] as const)
      expect(
        readSpaceR2Config(key => (key === name ? value : ENV[key])),
        name
      ).toBeNull();
    expect(
      readSpaceR2Config(key => (key === 'R2_SPACE_ACCESS_KEY_ID' ? undefined : ENV[key]))
    ).toBeNull();
  });

  it('never addresses a key outside the space key shapes', async () => {
    const { r2, sent } = client([]);
    const signal = new AbortController().signal;
    for (const key of [
      '../other-bucket/x',
      `t/${TEAM}/o/short`,
      `t/${TEAM}/u/${UPLOAD}/../../x`,
      ''
    ])
      expect(await code(r2.head(key, signal)), key).toBe('INVALID_INPUT');
    expect(await code(r2.createMultipart(OBJECT.replace('/o/', '/x/'), 'video/mp4', signal))).toBe(
      'INVALID_INPUT'
    );
    expect(sent).toHaveLength(0);
  });
});

describe('multipart', () => {
  it('opens a multipart upload in the space bucket', async () => {
    const { r2, signed, sent } = client([
      xml(
        '<InitiateMultipartUploadResult><UploadId>up-1</UploadId></InitiateMultipartUploadResult>'
      )
    ]);
    expect(await r2.createMultipart(STAGING, 'video/mp4', new AbortController().signal)).toBe(
      'up-1'
    );
    expect(signed[0]!.method).toBe('POST');
    expect(signed[0]!.url).toBe(
      `https://${ACCOUNT}.r2.cloudflarestorage.com/soty-spaces-beta/${STAGING}?uploads=`
    );
    expect(signed[0]!.headers['content-type']).toBe('video/mp4');
    expect(sent[0]!.headers.get('authorization')).toContain('AWS4-HMAC-SHA256');
  });

  it('signs a part URL with its Content-MD5 inside the signature and a ten-minute life', async () => {
    const { r2, signed, sent } = client([]);
    const now = Date.parse('2026-11-28T10:00:00Z');
    const part = await r2.signPart(STAGING, 'up 1/x', 3, MD5, now);
    expect(sent).toHaveLength(0);
    expect(signed[0]!.method).toBe('PUT');
    expect(signed[0]!.options).toEqual({ aws: { signQuery: true } });
    expect(signed[0]!.headers['content-md5']).toBe(MD5_B64);
    const url = new URL(signed[0]!.url);
    expect(url.searchParams.get('partNumber')).toBe('3');
    expect(url.searchParams.get('uploadId')).toBe('up 1/x');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(new URL(part.url).searchParams.get('X-Amz-Signature')).toBe('fake');
    expect(part.contentMd5).toBe(MD5_B64);
    expect(part.expiresAt).toBe('2026-11-28T10:10:00.000Z');
    expect(await code(r2.signPart(STAGING, 'up', 3, 'not-md5', now))).toBe('INVALID_INPUT');
    expect(await code(r2.signPart(STAGING, 'up', 10_001, MD5, now))).toBe('INVALID_INPUT');
    expect(await code(r2.signPart(STAGING, 'up', 3, MD5, now, 601))).toBe('INVALID_INPUT');
  });

  it('reads the part ETags R2 computed, across ListParts pages', async () => {
    const page = (parts: Array<[number, string, number]>, truncated: boolean, next?: number) =>
      xml(
        `<ListPartsResult><IsTruncated>${truncated}</IsTruncated>${next ? `<NextPartNumberMarker>${next}</NextPartNumberMarker>` : ''}` +
          parts
            .map(
              ([n, etag, size]) =>
                `<Part><PartNumber>${n}</PartNumber><ETag>&quot;${etag}&quot;</ETag><Size>${size}</Size></Part>`
            )
            .join('') +
          '</ListPartsResult>'
      );
    const { r2, signed } = client([
      page([[1, MD5.toUpperCase(), 16_777_216]], true, 1),
      page([[2, 'd41d8cd98f00b204e9800998ecf8427e', 5]], false)
    ]);
    const parts = await r2.listParts(STAGING, 'up-1', new AbortController().signal);
    expect(parts).toEqual([
      { partNumber: 1, etag: MD5, bytes: 16_777_216 },
      { partNumber: 2, etag: 'd41d8cd98f00b204e9800998ecf8427e', bytes: 5 }
    ]);
    expect(new URL(signed[1]!.url).searchParams.get('part-number-marker')).toBe('1');
    expect(new URL(signed[0]!.url).searchParams.get('uploadId')).toBe('up-1');
  });

  it('refuses a part listing it cannot trust', async () => {
    const { r2 } = client([
      xml(
        '<ListPartsResult><IsTruncated>false</IsTruncated><Part><PartNumber>1</PartNumber><ETag>"abc-2"</ETag><Size>5</Size></Part></ListPartsResult>'
      )
    ]);
    expect(await code(r2.listParts(STAGING, 'up-1', new AbortController().signal))).toBe(
      'INVALID_RESPONSE'
    );
  });

  it('completes with the listed ETags and treats a 200 error document as not completed', async () => {
    const { r2, signed, sent } = client([
      xml('<CompleteMultipartUploadResult><ETag>"x-2"</ETag></CompleteMultipartUploadResult>'),
      xml('<Error><Code>InternalError</Code><Message>secret detail</Message></Error>')
    ]);
    const parts = [
      { partNumber: 1, etag: MD5 },
      { partNumber: 2, etag: 'd41d8cd98f00b204e9800998ecf8427e' }
    ];
    await r2.completeMultipart(STAGING, 'up-1', parts, new AbortController().signal);
    expect(signed[0]!.method).toBe('POST');
    const body = await sent[0]!.text();
    expect(body).toBe(
      `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"${MD5}"</ETag></Part><Part><PartNumber>2</PartNumber><ETag>"d41d8cd98f00b204e9800998ecf8427e"</ETag></Part></CompleteMultipartUpload>`
    );
    expect(
      await code(r2.completeMultipart(STAGING, 'up-1', parts, new AbortController().signal))
    ).toBe('STORAGE_UNAVAILABLE');
    expect(
      await code(
        r2.completeMultipart(STAGING, 'up-1', [parts[1]!, parts[0]!], new AbortController().signal)
      )
    ).toBe('INVALID_INPUT');
  });

  it('aborts, and an already gone upload is not an error', async () => {
    const { r2, signed } = client([
      () => new Response(null, { status: 204 }),
      () => new Response(null, { status: 404 })
    ]);
    await r2.abortMultipart(STAGING, 'up-1', new AbortController().signal);
    await r2.abortMultipart(STAGING, 'up-1', new AbortController().signal);
    expect(signed[0]!.method).toBe('DELETE');
  });
});

describe('objects', () => {
  it('heads, range-reads and removes', async () => {
    const { r2, signed } = client([
      () =>
        new Response(null, {
          status: 200,
          headers: { 'content-length': '20', etag: '"e"', 'content-type': 'image/webp' }
        }),
      () => new Response(null, { status: 404 }),
      () =>
        new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 206,
          headers: { 'content-range': 'bytes 0-3/20', 'content-length': '4' }
        }),
      () => new Response(null, { status: 204 })
    ]);
    const signal = new AbortController().signal;
    expect(await r2.head(OBJECT, signal)).toEqual({
      bytes: 20,
      etag: '"e"',
      contentType: 'image/webp'
    });
    expect(await r2.head(OBJECT, signal)).toBeNull();
    expect([...(await r2.rangeGet(OBJECT, 0, 3, signal))]).toEqual([1, 2, 3, 4]);
    expect(signed[2]!.headers.range).toBe('bytes=0-3');
    await r2.remove(OBJECT, signal);
    expect(signed[3]!.method).toBe('DELETE');
  });

  it('refuses a range answer that is not the asked range, and an oversized range', async () => {
    const { r2 } = client([
      () => new Response(new Uint8Array(4), { status: 200 }),
      () =>
        new Response(new Uint8Array(8), {
          status: 206,
          headers: { 'content-range': 'bytes 0-7/20' }
        })
    ]);
    const signal = new AbortController().signal;
    expect(await code(r2.rangeGet(OBJECT, 0, 3, signal))).toBe('INVALID_RESPONSE');
    expect(await code(r2.rangeGet(OBJECT, 0, 3, signal))).toBe('INVALID_RESPONSE');
    expect(await code(r2.rangeGet(OBJECT, 0, 64 * 1024 * 1024, signal))).toBe('INVALID_INPUT');
  });

  it('pages a prefix listing and keeps only keys of the documented shapes', async () => {
    const entry = (key: string, size: number) =>
      `<Contents><Key>${key}</Key><Size>${size}</Size><ETag>"e"</ETag></Contents>`;
    const { r2, signed } = client([
      xml(
        `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>tok/1+</NextContinuationToken>${entry(OBJECT, 10)}${entry(`t/${TEAM}/stray.txt`, 3)}</ListBucketResult>`
      ),
      xml(
        `<ListBucketResult><IsTruncated>false</IsTruncated>${entry(STAGING, 7)}</ListBucketResult>`
      )
    ]);
    const signal = new AbortController().signal;
    const first = await r2.listPrefix(`t/${TEAM}/`, null, signal);
    expect(first).toEqual({
      objects: [{ key: OBJECT, bytes: 10, etag: '"e"' }],
      foreignKeys: 1,
      nextToken: 'tok/1+'
    });
    const url = new URL(signed[0]!.url);
    expect(url.searchParams.get('list-type')).toBe('2');
    expect(url.searchParams.get('prefix')).toBe(`t/${TEAM}/`);
    expect(url.pathname).toBe('/soty-spaces-beta');
    const second = await r2.listPrefix(`t/${TEAM}/`, first.nextToken, signal);
    expect(new URL(signed[1]!.url).searchParams.get('continuation-token')).toBe('tok/1+');
    expect(second).toEqual({
      objects: [{ key: STAGING, bytes: 7, etag: '"e"' }],
      foreignKeys: 0,
      nextToken: null
    });
    expect(await code(r2.listPrefix('t/', null, signal))).toBe('INVALID_INPUT');
    expect(await code(r2.listPrefix('', null, signal))).toBe('INVALID_INPUT');
  });
});

describe('provider errors are sanitized', () => {
  it('maps statuses to closed codes and never carries the provider body, key or account', async () => {
    const body = `<Error><Code>AccessDenied</Code><Message>key ${STAGING} account ${ACCOUNT} secret-key</Message></Error>`;
    const { r2 } = client([
      xml(body, 403),
      xml(body, 429),
      xml(body, 500),
      () => {
        throw new TypeError(`connect failed to ${ACCOUNT}.r2.cloudflarestorage.com`);
      }
    ]);
    const signal = new AbortController().signal;
    const errors: unknown[] = [];
    for (let i = 0; i < 4; i += 1) {
      try {
        await r2.createMultipart(STAGING, 'video/mp4', signal);
      } catch (error) {
        errors.push(error);
      }
    }
    expect(errors.map(error => (error as TeamFunctionError).code)).toEqual([
      'STORAGE_UNAVAILABLE',
      'RATE_LIMITED',
      'STORAGE_UNAVAILABLE',
      'STORAGE_UNAVAILABLE'
    ]);
    for (const error of errors) {
      expect(error).toBeInstanceOf(TeamFunctionError);
      const text = JSON.stringify({
        ...(error as TeamFunctionError),
        message: (error as Error).message
      });
      expect(text).not.toContain(ACCOUNT);
      expect(text).not.toContain(STAGING);
      expect(text).not.toContain('secret');
      expect(text).not.toContain('AccessDenied');
    }
    // A refusal of our own credentials is a configuration fault, not an outage to retry.
    expect(errors.map(error => (error as TeamFunctionError).retryable)).toEqual([
      false,
      true,
      true,
      true
    ]);
  });
});
