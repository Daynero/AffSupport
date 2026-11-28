import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  importSpaceReadGrantKey,
  signSpaceReadGrant,
  type SpaceReadGrantClaims
} from '../packages/shared/src/team/space-read-grant.js';
import { signGlobalImageAlias } from '../packages/shared/src/team/catalog-global-alias.js';
import {
  createCachedEpochReader,
  handleSpaceRead,
  safeDownloadDisposition,
  type SpaceReadBucket,
  type SpaceReadCache,
  type SpaceReadDeps
} from '../apps/catalog-image-delivery/src/space-read.js';
import delivery, { type GlobalImageDeliveryEnv } from '../apps/catalog-image-delivery/src/index.js';
import { globalFixtureId } from './fixtures/catalog-global.js';

const NOW = 1_800_000_000;
const HOST = 'files.example.test';
const TEAM_A = '11111111-2222-4333-8444-555555555555';
const TEAM_B = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const USER = '0f0f0f0f-1e1e-4d2d-a3c3-4b4b4b4b4b4b';
const CONTENT = 'ab'.repeat(32);
const OBJECT_KEY = `t/${TEAM_A}/o/${CONTENT}`;
const DERIVATIVE_KEY = `t/${TEAM_A}/d/${CONTENT}/1/tile`;
const BYTES = Uint8Array.from({ length: 100 }, (_, n) => n);
const ORIGIN = 'https://app.example.test';
const keyBytes = new Uint8Array(32).fill(5);

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
function fakeBucket(objects: Record<string, Stored>) {
  const calls: { op: 'get' | 'head'; key: string; range?: { offset: number; length: number } }[] =
    [];
  const meta = (o: Stored) => ({
    size: o.bytes.length,
    httpEtag: `"${o.etag}"`,
    httpMetadata: o.contentType === undefined ? {} : { contentType: o.contentType }
  });
  const bucket: SpaceReadBucket = {
    async head(key) {
      calls.push({ op: 'head', key });
      const o = objects[key];
      return o ? meta(o) : null;
    },
    async get(key, options) {
      calls.push({ op: 'get', key, ...(options?.range ? { range: options.range } : {}) });
      const o = objects[key];
      if (!o) return null;
      const slice = options?.range
        ? o.bytes.slice(options.range.offset, options.range.offset + options.range.length)
        : o.bytes;
      return { ...meta(o), body: new Response(slice).body! };
    }
  };
  return { bucket, calls };
}
function fakeCache() {
  const entries = new Map<string, Response>();
  const matched: string[] = [];
  const put: string[] = [];
  const cache: SpaceReadCache = {
    async match(request) {
      matched.push(request.url);
      return entries.get(request.url)?.clone();
    },
    async put(request, response) {
      put.push(request.url);
      const bytes = await response.arrayBuffer();
      entries.set(request.url, new Response(bytes, { headers: response.headers }));
    }
  };
  return { cache, entries, matched, put };
}

async function setup(
  over: Partial<SpaceReadDeps> & {
    epochValue?: bigint | null;
    objects?: Record<string, Stored>;
  } = {}
) {
  const key = await importSpaceReadGrantKey(keyBytes);
  const { bucket, calls } = fakeBucket(
    over.objects ?? {
      [OBJECT_KEY]: { bytes: BYTES, contentType: 'video/mp4', etag: 'obj' },
      [DERIVATIVE_KEY]: { bytes: BYTES.slice(0, 10), contentType: 'image/webp', etag: 'tile' }
    }
  );
  const epoch = vi.fn(async () => (over.epochValue === undefined ? 7n : over.epochValue));
  const deps: SpaceReadDeps = {
    environment: 'beta',
    filesHost: HOST,
    keys: new Map([[1, key]]),
    bucket,
    epoch,
    allowedOrigins: [ORIGIN],
    nowSeconds: () => NOW,
    ...over
  };
  const grant = (o: Partial<SpaceReadGrantClaims> = {}) => signSpaceReadGrant(claims(o), key);
  return { deps, calls, epoch, grant, key };
}
const url = (path: string, grant: string, extra = '') =>
  `https://${HOST}/${path}?g=${encodeURIComponent(grant)}${extra}`;
const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
const settle = async () => {
  await Promise.all(pending.splice(0));
};

function expectErrorHeaders(response: Response) {
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('space-read Worker', () => {
  it('serves a valid grant with immutable private headers and the bytes', async () => {
    const { deps, grant } = await setup();
    const g = await grant();
    const response = await handleSpaceRead(
      new Request(url(OBJECT_KEY, g), { headers: { origin: ORIGIN } }),
      deps
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('content-length')).toBe('100');
    expect(response.headers.get('etag')).toBe('"obj"');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox"
    );
    expect(response.headers.get('content-disposition')).toBe('inline');
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(response.headers.get('access-control-expose-headers')).toBe(
      'Content-Length, Content-Range, Accept-Ranges, ETag'
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
  });

  it('falls back to octet-stream and does not grant CORS to a foreign origin', async () => {
    const { deps, grant } = await setup({
      objects: { [OBJECT_KEY]: { bytes: BYTES, etag: 'x' } }
    });
    const response = await handleSpaceRead(
      new Request(url(OBJECT_KEY, await grant()), { headers: { origin: 'https://evil.test' } }),
      deps
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('serves a derivative path', async () => {
    const { deps, grant } = await setup();
    const response = await handleSpaceRead(new Request(url(DERIVATIVE_KEY, await grant())), deps);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES.slice(0, 10));
  });

  it('refuses a tampered signature, a missing grant and an unknown key', async () => {
    const { deps, grant, calls, epoch } = await setup();
    const g = await grant();
    const tampered = g.slice(0, -2) + (g.at(-2) === 'A' ? 'B' : 'A') + g.at(-1);
    for (const target of [
      url(OBJECT_KEY, tampered),
      `https://${HOST}/${OBJECT_KEY}`,
      url(OBJECT_KEY, await grant({ keyVersion: 2 }))
    ]) {
      const response = await handleSpaceRead(new Request(target), deps);
      expect([401, 403]).toContain(response.status);
      expectErrorHeaders(response);
      const text = await response.text();
      expect(text).not.toContain(g.slice(0, 20));
      expect(text).not.toContain(TEAM_A);
    }
    expect(calls).toEqual([]);
    expect(epoch).not.toHaveBeenCalled();
  });

  it('answers an expired grant with 401 no-store and never touches R2', async () => {
    const { deps, grant, calls } = await setup();
    const response = await handleSpaceRead(
      new Request(url(OBJECT_KEY, await grant({ issuedAt: NOW - 700, expiresAt: NOW - 100 }))),
      deps
    );
    expect(response.status).toBe(401);
    expectErrorHeaders(response);
    expect(await response.json()).toEqual({ error: 'GRANT_EXPIRED' });
    expect(calls).toEqual([]);
  });

  it('answers a revoked epoch and a non-R2 space with 403', async () => {
    const revoked = await setup({ epochValue: 8n });
    const response = await handleSpaceRead(
      new Request(url(OBJECT_KEY, await revoked.grant())),
      revoked.deps
    );
    expect(response.status).toBe(403);
    expectErrorHeaders(response);
    expect(await response.json()).toEqual({ error: 'ACCESS_REVOKED' });
    expect(revoked.calls).toEqual([]);
    expect(revoked.epoch).toHaveBeenCalledWith(TEAM_A);

    const gone = await setup({ epochValue: null });
    const none = await handleSpaceRead(new Request(url(OBJECT_KEY, await gone.grant())), gone.deps);
    expect(none.status).toBe(403);
    expectErrorHeaders(none);
  });

  it('answers 503 no-store when the epoch is unknown', async () => {
    const { deps, grant, calls } = await setup({
      epoch: async () => {
        throw new Error('rpc down');
      }
    });
    const response = await handleSpaceRead(new Request(url(OBJECT_KEY, await grant())), deps);
    expect(response.status).toBe(503);
    expectErrorHeaders(response);
    expect(calls).toEqual([]);
  });

  it('refuses a grant of team A on a path of team B before reading the epoch', async () => {
    const { deps, grant, epoch, calls } = await setup();
    const response = await handleSpaceRead(
      new Request(url(`t/${TEAM_B}/o/${CONTENT}`, await grant())),
      deps
    );
    expect(response.status).toBe(403);
    expectErrorHeaders(response);
    expect(epoch).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('caches under a grant-free key and answers another valid grant from the cache', async () => {
    const { cache, matched, put } = fakeCache();
    const { deps, grant, calls } = await setup({ cache });
    const first = await handleSpaceRead(
      new Request(url(OBJECT_KEY, await grant(), '&dl=a.mp4')),
      deps,
      ctx
    );
    expect(first.status).toBe(200);
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(BYTES);
    await settle();
    expect(put).toEqual([`https://${HOST}/${OBJECT_KEY}`]);
    expect(matched).toEqual([`https://${HOST}/${OBJECT_KEY}`]);
    for (const key of [...put, ...matched]) {
      expect(new URL(key).search).toBe('');
    }
    expect(calls.filter(c => c.op === 'get')).toHaveLength(1);

    const other = await grant({ issuedAt: NOW - 5, expiresAt: NOW + 300 });
    const second = await handleSpaceRead(
      new Request(url(OBJECT_KEY, other), { headers: { origin: ORIGIN } }),
      deps,
      ctx
    );
    expect(second.status).toBe(200);
    expect(second.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(second.headers.get('content-disposition')).toBe('inline');
    expect(second.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(second.headers.get('etag')).toBe('"obj"');
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(BYTES);
    expect(calls.filter(c => c.op === 'get')).toHaveLength(1);
  });

  it('never consults the cache for a request that fails authorization', async () => {
    const { cache, matched } = fakeCache();
    const { deps, grant } = await setup({ cache, epochValue: 9n });
    const response = await handleSpaceRead(new Request(url(OBJECT_KEY, await grant())), deps);
    expect(response.status).toBe(403);
    expect(matched).toEqual([]);
  });

  it('serves Range as 206 straight from R2 without caching it', async () => {
    const { cache, put } = fakeCache();
    const { deps, grant, calls } = await setup({ cache });
    const g = await grant();
    const cases: [string, string, Uint8Array][] = [
      ['bytes=10-19', 'bytes 10-19/100', BYTES.slice(10, 20)],
      ['bytes=90-', 'bytes 90-99/100', BYTES.slice(90)],
      ['bytes=-5', 'bytes 95-99/100', BYTES.slice(95)],
      ['bytes=95-500', 'bytes 95-99/100', BYTES.slice(95)]
    ];
    for (const [range, contentRange, bytes] of cases) {
      const response = await handleSpaceRead(
        new Request(url(OBJECT_KEY, g), { headers: { range } }),
        deps,
        ctx
      );
      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe(contentRange);
      expect(response.headers.get('content-length')).toBe(String(bytes.length));
      expect(response.headers.get('accept-ranges')).toBe('bytes');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    }
    await settle();
    expect(put).toEqual([]);
    expect(calls.find(c => c.op === 'get' && c.range?.offset === 10)?.range).toEqual({
      offset: 10,
      length: 10
    });
  });

  it('answers an unsatisfiable or malformed range with 416', async () => {
    const { deps, grant } = await setup();
    const g = await grant();
    for (const range of ['bytes=100-', 'bytes=20-10', 'bytes=-0', 'items=0-1', 'bytes=0-1,4-5']) {
      const response = await handleSpaceRead(
        new Request(url(OBJECT_KEY, g), { headers: { range } }),
        deps
      );
      expect(response.status, range).toBe(416);
      expectErrorHeaders(response);
      expect(response.headers.get('content-range')).toBe('bytes */100');
    }
  });

  it('answers a missing object with 404', async () => {
    const { deps, grant } = await setup({ objects: {} });
    const response = await handleSpaceRead(new Request(url(OBJECT_KEY, await grant())), deps);
    expect(response.status).toBe(404);
    expectErrorHeaders(response);
  });

  it('builds a safe attachment disposition from dl', async () => {
    const { deps, grant } = await setup();
    const g = await grant();
    const evil = '../evil"\r\nX: y.mp4';
    const response = await handleSpaceRead(
      new Request(url(OBJECT_KEY, g, `&dl=${encodeURIComponent(evil)}`)),
      deps
    );
    expect(response.status).toBe(200);
    const header = response.headers.get('content-disposition')!;
    expect(header).toMatch(/^attachment; filename="[^"\\/\r\n]*"; filename\*=UTF-8''[^"\s]*$/u);
    expect(header).not.toMatch(/[\r\n]/u);
    expect(header).not.toContain('/');
    expect(response.headers.get('x')).toBeNull();

    expect(safeDownloadDisposition('Звіт за листопад.mp4')).toBe(
      `attachment; filename="____ __ ________.mp4"; filename*=UTF-8''${encodeURIComponent(
        'Звіт за листопад.mp4'
      )}`
    );
    expect(safeDownloadDisposition('\u0000"\\/')).toBe(
      `attachment; filename="download"; filename*=UTF-8''download`
    );
    expect(safeDownloadDisposition("it's (1)*.png")).toBe(
      `attachment; filename="it's (1)*.png"; filename*=UTF-8''it%27s%20%281%29%2A.png`
    );
    const long = safeDownloadDisposition('я'.repeat(500));
    expect(decodeURIComponent(long.split("UTF-8''")[1]!)).toHaveLength(180);
  });

  it('never serves a foreign host, a staging key or a malformed path', async () => {
    const { deps, grant, calls, epoch } = await setup();
    const g = await grant();
    const targets = [
      `https://other.example.test/${OBJECT_KEY}?g=${g}`,
      url(`t/${TEAM_A}/u/${USER}`, g),
      url(`t/${TEAM_A}/o/${CONTENT}/extra`, g),
      url(`t/${TEAM_A}/d/${CONTENT}/1/evil`, g),
      url(`t/${TEAM_A}/o/${CONTENT.toUpperCase()}`, g),
      `https://${HOST}/t/${TEAM_A}/o/..%2f${CONTENT}?g=${g}`
    ];
    for (const target of targets) {
      const response = await handleSpaceRead(new Request(target), deps);
      expect(response.status, target).toBe(404);
      expectErrorHeaders(response);
    }
    expect(calls).toEqual([]);
    expect(epoch).not.toHaveBeenCalled();
  });

  it('allows only GET and HEAD; HEAD has headers and no body', async () => {
    const { deps, grant } = await setup();
    const g = await grant();
    const post = await handleSpaceRead(new Request(url(OBJECT_KEY, g), { method: 'POST' }), deps);
    expect(post.status).toBe(405);
    expectErrorHeaders(post);
    const head = await handleSpaceRead(new Request(url(OBJECT_KEY, g), { method: 'HEAD' }), deps);
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('100');
    expect(head.headers.get('etag')).toBe('"obj"');
    expect(head.body).toBeNull();
    const missing = await setup({ objects: {} });
    const headMissing = await handleSpaceRead(
      new Request(url(OBJECT_KEY, await missing.grant()), { method: 'HEAD' }),
      missing.deps
    );
    expect(headMissing.status).toBe(404);
    expect(headMissing.body).toBeNull();
  });

  it('clears the files host cache on /clear-site-data', async () => {
    const { deps } = await setup();
    const response = await handleSpaceRead(new Request(`https://${HOST}/clear-site-data`), deps);
    expect(response.status).toBe(204);
    expect(response.headers.get('clear-site-data')).toBe('"cache"');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });
});

describe('epoch cache', () => {
  it('trusts a cached epoch for at most the window, then sees the revocation', async () => {
    let clock = 0;
    let current: bigint | null = 7n;
    const load = vi.fn(async () => current);
    const read = createCachedEpochReader({ load, nowMs: () => clock, ttlSeconds: 30 });
    expect(await read(TEAM_A)).toBe(7n);
    current = 8n;
    clock = 29_999;
    expect(await read(TEAM_A)).toBe(7n);
    expect(load).toHaveBeenCalledTimes(1);
    clock = 30_000;
    expect(await read(TEAM_A)).toBe(8n);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not cache failures and stays bounded', async () => {
    let fail = true;
    const load = vi.fn(async (team: string) => {
      if (fail) throw new Error('down');
      return BigInt(team.length);
    });
    const read = createCachedEpochReader({ load, nowMs: () => 0, ttlSeconds: 30, maxEntries: 2 });
    await expect(read(TEAM_A)).rejects.toThrow();
    fail = false;
    expect(await read(TEAM_A)).toBe(36n);
    await read(TEAM_B);
    await read(USER);
    expect(load).toHaveBeenCalledTimes(4);
    await read(TEAM_A);
    expect(load).toHaveBeenCalledTimes(5);
  });
});

describe('space-read through the Worker entry', () => {
  const env = (over: Partial<GlobalImageDeliveryEnv> = {}): GlobalImageDeliveryEnv => ({
    CATALOG_IMAGES_ENVIRONMENT: 'beta',
    R2_CATALOG_PUBLIC_ORIGIN: 'https://images.example.test',
    CATALOG_GLOBAL_ALIAS_KEYS: JSON.stringify({
      '1': Buffer.from(new Uint8Array(32).fill(7)).toString('base64')
    }),
    CATALOG_GLOBAL_ROUTING_REVISION: 'r1',
    CATALOG_GLOBAL_DELIVERY_CONFIRMATION: 'beta:https://images.example.test:r1:1',
    SPACE_BUCKET: fakeBucket({
      [OBJECT_KEY]: { bytes: BYTES, contentType: 'video/mp4', etag: 'obj' }
    }).bucket,
    SPACE_FILES_HOST: HOST,
    SPACE_READ_GRANT_KEYS: JSON.stringify({ '1': Buffer.from(keyBytes).toString('base64') }),
    SPACE_ALLOWED_ORIGINS: `${ORIGIN}, https://next.example.test`,
    SUPABASE_URL: 'https://db.example.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    ...over
  });
  const realGrant = async () => {
    const key = await importSpaceReadGrantKey(keyBytes);
    const now = Math.floor(Date.now() / 1000);
    return signSpaceReadGrant(claims({ issuedAt: now - 5, expiresAt: now + 300 }), key);
  };

  it('reads the epoch from Supabase with the service key, fetch unbound, and serves', async () => {
    const platformFetch = vi.fn(async function (
      this: unknown,
      input: RequestInfo | URL,
      init?: RequestInit
    ) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      const request = new Request(input, init);
      expect(request.url).toBe('https://db.example.test/rest/v1/rpc/service_space_read_epoch');
      expect(request.method).toBe('POST');
      expect(request.headers.get('apikey')).toBe('service-key');
      expect(request.headers.get('authorization')).toBe('Bearer service-key');
      expect(await request.json()).toEqual({ p_team: TEAM_A });
      return new Response(JSON.stringify('7'), {
        headers: { 'content-type': 'application/json' }
      });
    });
    vi.stubGlobal('fetch', platformFetch);
    const e = env();
    const g = await realGrant();
    const response = await delivery.fetch(new Request(url(OBJECT_KEY, g)), e, ctx);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
    const again = await delivery.fetch(new Request(url(OBJECT_KEY, g)), e, ctx);
    expect(again.status).toBe(200);
    expect(platformFetch).toHaveBeenCalledOnce();
  });

  it('answers 503 when the epoch RPC fails or answers garbage', async () => {
    for (const answer of [
      () => new Response('boom', { status: 500 }),
      () => new Response(JSON.stringify(7)),
      () => new Response('not json')
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => answer())
      );
      const response = await delivery.fetch(
        new Request(url(OBJECT_KEY, await realGrant())),
        env(),
        ctx
      );
      expect(response.status).toBe(503);
      expectErrorHeaders(response);
    }
  });

  it('answers 403 when the RPC says the space is not an active R2 space', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('null'))
    );
    const response = await delivery.fetch(
      new Request(url(OBJECT_KEY, await realGrant())),
      env(),
      ctx
    );
    expect(response.status).toBe(403);
  });

  it('keeps the alias path working on its host, and 503s the files host without config', async () => {
    const aliasKey = await (
      await import('../packages/shared/src/team/catalog-global-alias.js')
    ).importGlobalAliasKey(new Uint8Array(32).fill(7));
    const alias = await signGlobalImageAlias(
      {
        environment: 'beta',
        keyVersion: 1,
        imageId: globalFixtureId(5),
        generation: 1,
        mime: 'image/jpeg'
      },
      aliasKey
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/jpeg' } })
      )
    );
    const unconfigured = env({ SPACE_READ_GRANT_KEYS: undefined, SUPABASE_URL: undefined });
    const aliased = await delivery.fetch(
      new Request(`https://images.example.test/g/${alias}.jpg`),
      unconfigured,
      ctx
    );
    expect(aliased.status).toBe(200);
    const files = await delivery.fetch(
      new Request(url(OBJECT_KEY, await realGrant())),
      unconfigured,
      ctx
    );
    expect(files.status).toBe(503);
    expectErrorHeaders(files);
    const foreign = await delivery.fetch(
      new Request(`https://elsewhere.example.test/${OBJECT_KEY}?g=x`),
      env(),
      ctx
    );
    expect(foreign.status).toBe(404);
  });
});
