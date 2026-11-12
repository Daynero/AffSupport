import { describe, expect, it, vi } from 'vitest';
import {
  importGlobalAliasKey,
  signGlobalImageAlias,
  verifyGlobalImageAlias
} from '../packages/shared/src/team/catalog-global-alias.js';
import { handleGlobalImageDelivery } from '../apps/catalog-image-delivery/src/handler.js';
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
