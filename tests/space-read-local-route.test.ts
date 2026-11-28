import { describe, expect, it, vi } from 'vitest';
import {
  importSpaceReadGrantKey,
  signSpaceReadGrant,
  type SpaceReadGrantClaims
} from '../packages/shared/src/team/space-read-grant.js';
import {
  isSpaceFilesBase,
  parseSpaceReadGrantResult,
  SPACE_LOCAL_FILES_PATH,
  spaceFilesUrl
} from '../packages/shared/src/team/space-storage.js';
import {
  handleSpaceRead,
  type SpaceReadBucket,
  type SpaceReadDeps
} from '../apps/catalog-image-delivery/src/space-read.js';
import { SpaceR2 } from '../supabase/functions/_shared/r2-space';
import {
  localSpaceReadPrefix,
  parseEpoch,
  readLocalSpaceReadConfig,
  serveLocalSpaceRead,
  spaceReadBucket
} from '../supabase/functions/space-storage/files';
import { readSpaceReadGrantConfig } from '../supabase/functions/space-storage/read';
import { readGrantParser } from '../apps/web/src/api/space-storage';

/**
 * 057, lead decision 2026-11-28 (amends T027/T062): on beta the Supabase API is loopback-only,
 * so `space-storage` serves space reads itself under `/functions/v1/space-storage/files/…`.
 * Enabled only by a non-production config; its answers are the Worker's for the same input.
 */

const NOW = 1_800_000_000;
const TEAM_A = '11111111-2222-4333-8444-555555555555';
const TEAM_B = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const USER = '0f0f0f0f-1e1e-4d2d-a3c3-4b4b4b4b4b4b';
const CONTENT = 'ab'.repeat(32);
const OBJECT_KEY = `t/${TEAM_A}/o/${CONTENT}`;
const DERIVATIVE_KEY = `t/${TEAM_A}/d/${CONTENT}/1/tile`;
const STAGING_KEY = `t/${TEAM_A}/u/${USER}`;
const BYTES = Uint8Array.from({ length: 100 }, (_, n) => n);
const RAW = new Uint8Array(32).fill(5);
const WEB = 'http://127.0.0.1:5175';
const FILES_HOST = 'files-beta.soty.pp.ua';
const API = 'http://127.0.0.1:54321';
const LOCAL_BASE = `${API}${SPACE_LOCAL_FILES_PATH}`;
const ACCOUNT = 'c'.repeat(32);

const env =
  (overrides: Record<string, string | undefined> = {}) =>
  (name: string) =>
    ({
      CATALOG_IMAGES_ENVIRONMENT: 'beta',
      SPACE_FILES_ORIGIN: LOCAL_BASE,
      SPACE_READ_GRANT_KEY_VERSION: '1',
      SPACE_READ_GRANT_KEYS: JSON.stringify({ '1': Buffer.from(RAW).toString('base64') }),
      ...overrides
    })[name];

const claims = (over: Partial<SpaceReadGrantClaims> = {}): SpaceReadGrantClaims => ({
  environment: 'beta',
  keyVersion: 1,
  teamId: TEAM_A,
  userId: USER,
  accessEpoch: 7n,
  issuedAt: NOW - 10,
  expiresAt: NOW + 590,
  ...over
});

interface Stored {
  bytes: Uint8Array<ArrayBuffer>;
  contentType?: string;
  etag: string;
}
const OBJECTS: Record<string, Stored> = {
  [OBJECT_KEY]: {
    bytes: BYTES,
    contentType: 'video/mp4',
    etag: 'd41d8cd98f00b204e9800998ecf8427e-3'
  },
  [DERIVATIVE_KEY]: { bytes: BYTES.slice(0, 10), contentType: 'image/webp', etag: 'tile' },
  [STAGING_KEY]: { bytes: BYTES, etag: 'staging' }
};

/** The Worker's binding: R2's own `R2Bucket` semantics. */
function workerBucket(): SpaceReadBucket {
  const meta = (o: Stored) => ({
    size: o.bytes.length,
    httpEtag: `"${o.etag}"`,
    httpMetadata: o.contentType === undefined ? {} : { contentType: o.contentType }
  });
  return {
    async head(key) {
      const o = OBJECTS[key];
      return o ? meta(o) : null;
    },
    async get(key, options) {
      const o = OBJECTS[key];
      if (!o) return null;
      const slice = options?.range
        ? o.bytes.slice(options.range.offset, options.range.offset + options.range.length)
        : o.bytes;
      return { ...meta(o), body: new Response(slice).body! };
    }
  };
}

/** Beta: the same objects behind the S3 API, as `SpaceR2` reaches them. */
function s3Bucket() {
  const seen: { method: string; key: string; range: string | null }[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const request = input as Request;
    const url = new URL(request.url);
    const prefix = `/soty-spaces-beta/`;
    expect(url.host).toBe(`${ACCOUNT}.r2.cloudflarestorage.com`);
    const key = url.pathname.slice(prefix.length);
    const range = request.headers.get('range');
    seen.push({ method: request.method, key, range });
    const o = OBJECTS[key];
    if (!o) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
    const headers: Record<string, string> = { etag: `"${o.etag}"` };
    if (o.contentType !== undefined) headers['content-type'] = o.contentType;
    if (range) {
      const [, a, b] = /^bytes=(\d+)-(\d+)$/u.exec(range)!;
      const slice = o.bytes.slice(Number(a), Number(b) + 1);
      headers['content-length'] = String(slice.length);
      headers['content-range'] = `bytes ${a}-${b}/${o.bytes.length}`;
      return new Response(slice, { status: 206, headers });
    }
    headers['content-length'] = String(o.bytes.length);
    return new Response(request.method === 'HEAD' ? null : o.bytes, { status: 200, headers });
  });
  const r2 = new SpaceR2(
    {
      environment: 'beta',
      accountId: ACCOUNT,
      bucket: 'soty-spaces-beta',
      accessKeyId: 'id',
      secretAccessKey: 'secret'
    },
    { sign: async request => request },
    fetcher as unknown as typeof fetch
  );
  return { r2, seen, fetcher };
}

async function setup(epochValue: bigint | null = 7n) {
  const key = await importSpaceReadGrantKey(RAW);
  const config = await readLocalSpaceReadConfig(env());
  expect(config).not.toBeNull();
  const epoch = vi.fn(async () => epochValue);
  const worker: SpaceReadDeps = {
    environment: 'beta',
    filesHost: FILES_HOST,
    keys: new Map([[1, key]]),
    bucket: workerBucket(),
    epoch,
    allowedOrigins: [WEB],
    nowSeconds: () => NOW
  };
  const s3 = s3Bucket();
  const local = {
    config,
    bucket: spaceReadBucket(s3.r2, new AbortController().signal),
    epoch,
    allowedOrigins: [WEB],
    nowSeconds: () => NOW
  };
  const grant = (o: Partial<SpaceReadGrantClaims> = {}) => signSpaceReadGrant(claims(o), key);
  return { worker, local, s3, grant, epoch };
}

/** One request, as the Worker sees it on the files host and as beta sees it on the API. */
function pair(path: string, query: string, init: RequestInit = {}) {
  const workerRequest = new Request(`https://${FILES_HOST}/${path}${query}`, init);
  const localUrl = new URL(`${LOCAL_BASE}/${path}${query}`);
  const localRequest = new Request(localUrl, init);
  return { workerRequest, localRequest, prefix: localSpaceReadPrefix(localUrl)! };
}

async function snapshot(response: Response) {
  const headers = [...response.headers.entries()].sort(([a], [b]) => a.localeCompare(b));
  const body = new Uint8Array(await response.arrayBuffer());
  return { status: response.status, headers, body: Array.from(body) };
}

describe('beta read route — config', () => {
  it('is enabled on beta and dev with the route as the files base', async () => {
    expect(await readLocalSpaceReadConfig(env())).toMatchObject({ environment: 'beta' });
    expect(
      await readLocalSpaceReadConfig(env({ CATALOG_IMAGES_ENVIRONMENT: 'dev' }))
    ).toMatchObject({ environment: 'dev' });
    const grantConfig = await readSpaceReadGrantConfig(env());
    expect(grantConfig?.filesOrigin).toBe(LOCAL_BASE);
  });

  it('is absent under a production config, an unknown environment or the Worker host', async () => {
    for (const overrides of [
      { CATALOG_IMAGES_ENVIRONMENT: 'production' },
      { CATALOG_IMAGES_ENVIRONMENT: undefined },
      { CATALOG_IMAGES_ENVIRONMENT: 'staging' },
      { SPACE_FILES_ORIGIN: 'https://files-beta.soty.pp.ua' },
      { SPACE_FILES_ORIGIN: undefined },
      { SPACE_FILES_ORIGIN: `${API}/functions/v1/space-storage/other` },
      { SPACE_FILES_ORIGIN: `http://10.0.0.5:54321${SPACE_LOCAL_FILES_PATH}` },
      { SPACE_READ_GRANT_KEYS: undefined },
      { SPACE_READ_GRANT_KEYS: '{' },
      { SPACE_READ_GRANT_KEYS: JSON.stringify({ x: 'AAAA' }) }
    ]) {
      expect(await readLocalSpaceReadConfig(env(overrides))).toBeNull();
    }
  });

  it('never hands out the local route in production grants, and keeps the files host there', async () => {
    expect(
      await readSpaceReadGrantConfig(env({ CATALOG_IMAGES_ENVIRONMENT: 'production' }))
    ).toBeNull();
    expect(
      await readSpaceReadGrantConfig(
        env({
          CATALOG_IMAGES_ENVIRONMENT: 'production',
          SPACE_FILES_ORIGIN: 'https://files.soty.pp.ua'
        })
      )
    ).toMatchObject({ filesOrigin: 'https://files.soty.pp.ua' });
  });

  it('answers 404 and touches nothing when the route is absent', async () => {
    const { s3, grant, epoch } = await setup();
    const { localRequest, prefix } = pair(OBJECT_KEY, `?g=${await grant()}`);
    for (const deps of [
      { config: null, bucket: spaceReadBucket(s3.r2, new AbortController().signal) },
      { config: await readLocalSpaceReadConfig(env()), bucket: null }
    ]) {
      const response = await serveLocalSpaceRead(localRequest, prefix, {
        ...deps,
        epoch,
        allowedOrigins: [WEB],
        nowSeconds: () => NOW
      });
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(epoch).not.toHaveBeenCalled();
    expect(s3.fetcher).not.toHaveBeenCalled();
  });

  it('finds the route behind and without /functions/v1, and nothing else', () => {
    expect(localSpaceReadPrefix(new URL(`${LOCAL_BASE}/${OBJECT_KEY}`))).toBe(
      SPACE_LOCAL_FILES_PATH
    );
    expect(localSpaceReadPrefix(new URL(`http://edge/space-storage/files/${OBJECT_KEY}`))).toBe(
      '/space-storage/files'
    );
    expect(localSpaceReadPrefix(new URL(`${API}/functions/v1/space-storage/read-grant`))).toBe(
      null
    );
    expect(localSpaceReadPrefix(new URL(`${API}/functions/v1/space-storage/files`))).toBe(null);
  });

  it('reads the epoch RPC answer strictly', () => {
    expect(parseEpoch('7')).toBe(7n);
    expect(parseEpoch(null)).toBeNull();
    for (const bad of [7, '07', '-1', 'x', '99999999999999999999', {}]) {
      expect(() => parseEpoch(bad)).toThrow();
    }
  });
});

describe('beta read route — parity with the Worker', () => {
  const cases: [string, number, (g: string, bad: string) => [string, string, RequestInit?]][] = [
    ['full GET with CORS', 200, g => [OBJECT_KEY, `?g=${g}`, { headers: { origin: WEB } }]],
    [
      'foreign origin',
      200,
      g => [OBJECT_KEY, `?g=${g}`, { headers: { origin: 'https://evil.test' } }]
    ],
    ['derivative', 200, g => [DERIVATIVE_KEY, `?g=${g}`]],
    ['range', 206, g => [OBJECT_KEY, `?g=${g}`, { headers: { range: 'bytes=10-19' } }]],
    ['suffix range', 206, g => [OBJECT_KEY, `?g=${g}`, { headers: { range: 'bytes=-5' } }]],
    ['open range', 206, g => [OBJECT_KEY, `?g=${g}`, { headers: { range: 'bytes=95-' } }]],
    ['bad range', 416, g => [OBJECT_KEY, `?g=${g}`, { headers: { range: 'bytes=500-600' } }]],
    ['HEAD', 200, g => [OBJECT_KEY, `?g=${g}`, { method: 'HEAD' }]],
    [
      'HEAD range',
      206,
      g => [OBJECT_KEY, `?g=${g}`, { method: 'HEAD', headers: { range: 'bytes=0-0' } }]
    ],
    ['download', 200, g => [OBJECT_KEY, `?g=${g}&dl=${encodeURIComponent('ролик "1".mp4')}`]],
    ['missing object', 404, g => [`t/${TEAM_A}/o/${'cd'.repeat(32)}`, `?g=${g}`]],
    ['staging key', 404, g => [STAGING_KEY, `?g=${g}`]],
    ['no grant', 401, () => [OBJECT_KEY, '']],
    ['two grants', 401, g => [OBJECT_KEY, `?g=${g}&g=${g}`]],
    ['tampered grant', 401, (g, bad) => [OBJECT_KEY, `?g=${bad}`]],
    ['other team in path', 403, g => [`t/${TEAM_B}/o/${CONTENT}`, `?g=${g}`]],
    ['clear site data', 204, () => ['clear-site-data', '', { headers: { origin: WEB } }]],
    ['POST', 405, g => [OBJECT_KEY, `?g=${g}`, { method: 'POST' }]]
  ];

  it.each(cases)('%s → %i', async (_name, status, build) => {
    const { worker, local, grant } = await setup();
    const g = await grant();
    const bad = `${g.slice(0, -2)}${g.endsWith('AA') ? 'BB' : 'AA'}`;
    const [path, query, init] = build(g, bad);
    const { workerRequest, localRequest, prefix } = pair(path, query, init);
    const expected = await snapshot(await handleSpaceRead(workerRequest, worker));
    const actual = await snapshot(await serveLocalSpaceRead(localRequest, prefix, local));
    expect(actual).toEqual(expected);
    expect(actual.status).toBe(status);
  });

  it('answers an expired grant, a revoked epoch and a non-R2 space as the Worker does', async () => {
    for (const [epochValue, over] of [
      [7n, { expiresAt: NOW - 1, issuedAt: NOW - 100 }],
      [8n, {}],
      [null, {}]
    ] as const) {
      const { worker, local, grant, s3 } = await setup(epochValue);
      const { workerRequest, localRequest, prefix } = pair(OBJECT_KEY, `?g=${await grant(over)}`);
      const expected = await snapshot(await handleSpaceRead(workerRequest, worker));
      const actual = await snapshot(await serveLocalSpaceRead(localRequest, prefix, local));
      expect(actual).toEqual(expected);
      expect(expected.status).toBeGreaterThanOrEqual(401);
      expect(s3.fetcher).not.toHaveBeenCalled();
    }
  });

  it('streams a range from S3 with one ranged GET after a HEAD, and never sends the grant', async () => {
    const { local, grant, s3 } = await setup();
    const g = await grant();
    const { localRequest, prefix } = pair(OBJECT_KEY, `?g=${g}`, {
      headers: { range: 'bytes=10-19' }
    });
    const response = await serveLocalSpaceRead(localRequest, prefix, local);
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 10-19/100');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES.slice(10, 20));
    expect(s3.seen).toEqual([
      { method: 'HEAD', key: OBJECT_KEY, range: null },
      { method: 'GET', key: OBJECT_KEY, range: 'bytes=10-19' }
    ]);
    for (const call of s3.fetcher.mock.calls)
      expect(String((call[0] as Request).url)).not.toContain(g);
  });

  it('answers 503 no-store when the bucket fails', async () => {
    const { local, grant } = await setup();
    const failing = new SpaceR2(
      {
        environment: 'beta',
        accountId: ACCOUNT,
        bucket: 'soty-spaces-beta',
        accessKeyId: 'id',
        secretAccessKey: 'secret'
      },
      { sign: async request => request },
      (async () => new Response('busy', { status: 500 })) as unknown as typeof fetch
    );
    const { localRequest, prefix } = pair(OBJECT_KEY, `?g=${await grant()}`);
    const response = await serveLocalSpaceRead(localRequest, prefix, {
      ...local,
      bucket: spaceReadBucket(failing, new AbortController().signal)
    });
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('files base on the wire', () => {
  const grantBody = (filesOrigin: string) => ({
    grant: 'A'.repeat(43),
    expiresAt: new Date(NOW * 1000).toISOString(),
    filesOrigin
  });

  it('accepts the files host everywhere and the local route only when allowed', () => {
    expect(isSpaceFilesBase('https://files.soty.pp.ua')).toBe(true);
    expect(isSpaceFilesBase(LOCAL_BASE)).toBe(false);
    expect(isSpaceFilesBase(LOCAL_BASE, { allowLocalRoute: true })).toBe(true);
    expect(
      isSpaceFilesBase(`https://api.example.test${SPACE_LOCAL_FILES_PATH}`, {
        allowLocalRoute: true
      })
    ).toBe(true);
    for (const bad of [
      `http://files.soty.pp.ua`,
      `http://10.0.0.5:54321${SPACE_LOCAL_FILES_PATH}`,
      `${LOCAL_BASE}/`,
      `${LOCAL_BASE}?x=1`,
      `${API}/functions/v1/drive-ops`,
      'https://files.soty.pp.ua/t/',
      'https://user:pw@files.soty.pp.ua'
    ])
      expect(isSpaceFilesBase(bad, { allowLocalRoute: true })).toBe(false);
  });

  it('a production web build refuses a grant pointing at the local route; beta follows it', () => {
    expect(readGrantParser('production')(grantBody(LOCAL_BASE)).ok).toBe(false);
    expect(readGrantParser('production')(grantBody('https://files.soty.pp.ua')).ok).toBe(true);
    expect(readGrantParser('beta')(grantBody(LOCAL_BASE))).toEqual({
      ok: true,
      value: grantBody(LOCAL_BASE)
    });
    expect(parseSpaceReadGrantResult(grantBody(LOCAL_BASE)).ok).toBe(false);
  });

  it('builds read URLs on either base with the same key path', () => {
    const local = spaceFilesUrl({
      filesOrigin: LOCAL_BASE,
      teamId: TEAM_A,
      contentId: CONTENT,
      grant: 'G'.repeat(43),
      download: 'a b.mp4'
    });
    expect(local).toBe(`${LOCAL_BASE}/${OBJECT_KEY}?g=${'G'.repeat(43)}&dl=a+b.mp4`);
    const worker = spaceFilesUrl({
      filesOrigin: 'https://files-beta.soty.pp.ua',
      teamId: TEAM_A,
      contentId: CONTENT,
      grant: 'G'.repeat(43)
    });
    expect(worker).toBe(`https://files-beta.soty.pp.ua/${OBJECT_KEY}?g=${'G'.repeat(43)}`);
    expect(() =>
      spaceFilesUrl({
        filesOrigin: 'http://files.soty.pp.ua',
        teamId: TEAM_A,
        contentId: CONTENT,
        grant: 'G'.repeat(43)
      })
    ).toThrow();
  });
});
