import { createHash } from 'node:crypto';
import { it, expect, vi } from 'vitest';
import { probeCatalogGlobalRetirement } from '../scripts/lib/catalog-global-retirement-probe.mjs';
const id = '52000000-0000-4000-8000-000000000001';
const bytes = new Uint8Array([1, 2, 3]);
const image = { id, size: 3, sha256: createHash('sha256').update(bytes).digest('hex') };
const manifest = {
  origin: 'https://owned.test',
  retirement: {
    deleteAfter: '2026-12-12T00:00:00Z',
    managed: [{ ...image, url: `https://owned.test/v1/${id}` }],
    protected: [{ ...image, url: `https://owned.test/g1/${id}` }]
  }
};
it('observes grace and protected bytes, then refuses to equate public absence with a verified purge receipt', async () => {
  const before = await probeCatalogGlobalRetirement(manifest, {
    phase: 'retirement-before',
    now: Date.parse('2026-12-11'),
    fetcher: async () => new Response(bytes)
  });
  expect(before.http).toBe('verified');
  const after = await probeCatalogGlobalRetirement(manifest, {
    phase: 'retirement-after',
    now: Date.parse('2026-12-12'),
    fetcher: async input =>
      new URL(input instanceof Request ? input.url : input.toString()).pathname.startsWith('/v1/')
        ? new Response(null, { status: 404 })
        : new Response(bytes)
  });
  expect(after).toMatchObject({
    http: 'verified',
    origin_delete_receipt: 'unverified',
    cdn_purge_receipt: 'unverified',
    quota_settlement: 'unverified',
    acceptance: 'blocked'
  });
});
it('rejects early after checks, foreign targets, changed protected bytes and ambiguous HTTP failures', async () => {
  const fetcher = vi.fn(async () => new Response(bytes));
  await expect(
    probeCatalogGlobalRetirement(manifest, {
      phase: 'retirement-after',
      now: Date.parse('2026-12-11'),
      fetcher
    })
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  for (const status of [200, 403, 500])
    await expect(
      probeCatalogGlobalRetirement(manifest, {
        phase: 'retirement-after',
        now: Date.parse('2026-12-12'),
        fetcher: async () => new Response(null, { status })
      })
    ).rejects.toThrow();
  await expect(
    probeCatalogGlobalRetirement(
      {
        ...manifest,
        retirement: {
          ...manifest.retirement,
          managed: [{ ...image, url: `https://foreign.test/v1/${id}` }]
        }
      },
      { phase: 'retirement-before', now: Date.parse('2026-12-11'), fetcher }
    )
  ).rejects.toThrow();
  await expect(
    probeCatalogGlobalRetirement(manifest, {
      phase: 'retirement-before',
      now: Date.parse('2026-12-11'),
      fetcher: async () => new Response(new Uint8Array([9, 9, 9]))
    })
  ).rejects.toThrow();
});

it('checks a protected video on an explicitly owned separate media origin', async () => {
  const fixture = {
    ...manifest,
    retirement: {
      ...manifest.retirement,
      protectedOrigins: ['https://owned-video.test'],
      protected: [{ ...image, url: `https://owned-video.test/v/${'a'.repeat(32)}.mp4` }]
    }
  };
  const report = await probeCatalogGlobalRetirement(fixture, {
    phase: 'retirement-before',
    now: Date.parse('2026-12-11'),
    fetcher: async () => new Response(bytes)
  });
  expect(report.checks).toHaveLength(2);
});
