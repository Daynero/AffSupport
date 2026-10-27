import { describe, expect, it, vi } from 'vitest';
import {
  CatalogImageR2,
  readCatalogR2Config
} from '../supabase/functions/_shared/r2-catalog-images.js';

const KEY = 'v1/45000000-0000-4000-8000-000000000001';
const cfg = {
  accountId: 'a'.repeat(32),
  stagingBucket: 'staging',
  publicBucket: 'public',
  publicOrigin: 'https://media.test',
  zoneId: 'b'.repeat(32),
  purgeToken: 'secret'
};

describe('R2 cleanup evidence and environment isolation', () => {
  it('does not claim revocation until origin absence and CDN purge acknowledgement', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ success: true }));
    const r2 = new CatalogImageR2(cfg, { sign: async request => request }, fetcher);
    await r2.remove('public', KEY, new AbortController().signal);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[2]![0]).toContain('/purge_cache');
  });
  it('keeps deletion uncertain if public bytes still exist or purge was not accepted', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response('still here'));
    const r2 = new CatalogImageR2(cfg, { sign: async request => request }, fetcher);
    await expect(r2.remove('public', KEY, new AbortController().signal)).rejects.toMatchObject({
      code: 'IMAGE_WRITE_UNCERTAIN'
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('fails closed on absent or cross-environment bucket configuration', () => {
    expect(readCatalogR2Config(() => undefined)).toBeNull();
    const values: Record<string, string> = {
      CATALOG_IMAGES_ENVIRONMENT: 'beta',
      R2_CATALOG_ACCOUNT_ID: cfg.accountId,
      R2_CATALOG_STAGING_BUCKET: 'soty-catalog-images-production-staging',
      R2_CATALOG_PUBLIC_BUCKET: 'soty-catalog-images-production-public',
      R2_CATALOG_PUBLIC_ORIGIN: cfg.publicOrigin,
      R2_CATALOG_ZONE_ID: cfg.zoneId,
      R2_CATALOG_PURGE_TOKEN: 'secret',
      R2_CATALOG_TARGET_CONFIRMATION: 'no'
    };
    expect(readCatalogR2Config(key => values[key])).toBeNull();
  });
});
