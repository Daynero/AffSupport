import { describe, expect, it, vi } from 'vitest';
import {
  importGlobalAliasKey,
  signGlobalImageAlias,
  verifyGlobalImageAlias
} from '../packages/shared/src/team/catalog-global-alias.js';
import { handleGlobalImageDelivery } from '../apps/catalog-image-delivery/src/handler.js';
import delivery from '../apps/catalog-image-delivery/src/index.js';
import { globalFixtureId } from './fixtures/catalog-global.js';

const claims = {
  environment: 'beta',
  keyVersion: 1,
  imageId: globalFixtureId(123),
  generation: 1,
  mime: 'image/jpeg'
} as const;
const key = () => importGlobalAliasKey(new Uint8Array(32).fill(7));
describe('global media aliases', () => {
  it('calls the platform fetch unbound, as the Workers runtime requires', async () => {
    const k = await key(),
      token = await signGlobalImageAlias({ ...claims, environment: 'production' }, k);
    const platformFetch = vi.fn(function (this: unknown) {
      // Workers: "Illegal invocation" when fetch is called with a foreign `this`.
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(
        new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/jpeg' } })
      );
    });
    vi.stubGlobal('fetch', platformFetch);
    try {
      const response = await delivery.fetch(
        new Request(`https://images.example.test/g/${token}.jpg`),
        {
          CATALOG_IMAGES_ENVIRONMENT: 'production',
          R2_CATALOG_PUBLIC_ORIGIN: 'https://images.example.test',
          CATALOG_GLOBAL_ALIAS_KEYS: JSON.stringify({
            '1': Buffer.from(new Uint8Array(32).fill(7)).toString('base64')
          }),
          CATALOG_GLOBAL_ROUTING_REVISION: 'r1',
          CATALOG_GLOBAL_DELIVERY_CONFIRMATION: 'production:https://images.example.test:r1:1'
        }
      );
      expect(response.status).toBe(200);
      expect(platformFetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('fetches the canonical object the way the Workers runtime allows (no redirect: error)', async () => {
    // Workers fetch throws on redirect 'error'; that made every alias answer 503 on next.
    const k = await key(),
      token = await signGlobalImageAlias(claims, k);
    const deps = (fetcher: typeof fetch) => ({
      environment: 'beta' as const,
      canonicalOrigin: 'https://images.example.test',
      keys: new Map([[1, k]]),
      fetcher
    });
    const workersFetch = vi.fn<typeof fetch>(async input => {
      if ((input as Request).redirect === 'error') throw new TypeError('Invalid redirect value');
      return new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/jpeg' } });
    });
    const served = await handleGlobalImageDelivery(
      new Request(`https://images.example.test/g/${token}.jpg`),
      deps(workersFetch)
    );
    expect(served.status).toBe(200);
    const redirected = await handleGlobalImageDelivery(
      new Request(`https://images.example.test/g/${token}.jpg`),
      deps(async () => new Response(null, { status: 302, headers: { location: 'https://x.test' } }))
    );
    expect(redirected.status).toBe(503);
    expect(redirected.headers.get('location')).toBeNull();
  });
  it('authenticates immutable image, generation, environment and MIME without expiry', async () => {
    const k = await key(),
      token = await signGlobalImageAlias(claims, k);
    expect(await verifyGlobalImageAlias(token, 'beta', new Map([[1, k]]))).toEqual(claims);
    expect(await verifyGlobalImageAlias(token, 'production', new Map([[1, k]]))).toBeNull();
    expect(await verifyGlobalImageAlias(token, 'beta', new Map())).toBeNull();
    const tampered = (token[0] === 'A' ? 'B' : 'A') + token.slice(1);
    expect(await verifyGlobalImageAlias(tampered, 'beta', new Map([[1, k]]))).toBeNull();
  });
  it('uses one canonical object for multiple direct URLs and streams identical bytes', async () => {
    const k = await key(),
      fetcher = vi.fn<typeof fetch>(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            headers: {
              'content-type': 'image/jpeg',
              'content-length': '3',
              etag: '"fixture"',
              'set-cookie': 'private=bad'
            }
          })
      );
    const tokens = await Promise.all(
      [1, 2].map(generation => signGlobalImageAlias({ ...claims, generation }, k))
    );
    expect(tokens[0]).not.toBe(tokens[1]);
    for (const token of tokens) {
      const response = await handleGlobalImageDelivery(
        new Request(`https://images.example.test/g/${token}.jpg`),
        {
          environment: 'beta',
          canonicalOrigin: 'https://images.example.test',
          keys: new Map([[1, k]]),
          fetcher
        }
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    }
    expect(
      fetcher.mock.calls.map(([input]) => String(input instanceof Request ? input.url : input))
    ).toEqual([
      `https://images.example.test/g1/${claims.imageId}`,
      `https://images.example.test/g1/${claims.imageId}`
    ]);
  });
  it('never fetches foreign or invalid destinations and does not cache failed bytes', async () => {
    const k = await key(),
      fetcher = vi.fn<typeof fetch>(async () => new Response('failure', { status: 503 }));
    const deps = {
      environment: 'beta' as const,
      canonicalOrigin: 'https://images.example.test',
      keys: new Map([[1, k]]),
      fetcher
    };
    expect(
      (
        await handleGlobalImageDelivery(
          new Request('https://images.example.test/g/https://foreign.test.jpg'),
          deps
        )
      ).status
    ).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
    const token = await signGlobalImageAlias(claims, k);
    const result = await handleGlobalImageDelivery(
      new Request(`https://images.example.test/g/${token}.jpg`),
      deps
    );
    expect(result.status).toBe(503);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(
      (
        await handleGlobalImageDelivery(
          new Request(`https://images.example.test/g/${token}.jpg`, { method: 'POST' }),
          deps
        )
      ).status
    ).toBe(405);
  });
});
