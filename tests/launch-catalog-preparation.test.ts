import { describe, expect, it, vi } from 'vitest';
import { isLaunchCatalogReady } from '../apps/web/src/team/launches/preparation';

function fixture(mode: 'legacy' | 'v2' = 'v2') {
  return {
    getProductCatalogSettings: vi.fn(async () => ({
      title: null as string | null,
      description: null as string | null,
      imageLink: null as string | null
    })),
    listProductCatalogTexts: vi.fn(async (): Promise<unknown[]> => []),
    listProductCatalogImageSources: vi.fn(async () => ({ poolSize: 0 })),
    catalogImages: {
      capabilities: vi.fn(async () => ({ mode })),
      inventory: vi.fn(async () => ({ total: 3, unclassified: 0 }))
    }
  };
}

describe('Launch catalog readiness uses the admitted image source', () => {
  it('accepts an R2-only matched pool without legacy pictures or fallback text', async () => {
    const client = fixture();
    expect(await isLaunchCatalogReady(client, 'team')).toBe(true);
    expect(client.listProductCatalogImageSources).not.toHaveBeenCalled();
  });
  it('keeps ordinary random pictures usable with generic texts', async () => {
    const client = fixture();
    client.catalogImages.inventory.mockResolvedValue({ total: 3, unclassified: 3 });
    client.listProductCatalogTexts.mockResolvedValue([{ title: 'Item', description: 'Details' }]);
    expect(await isLaunchCatalogReady(client, 'team')).toBe(true);
  });
  it('does not invent factual text for random pictures', async () => {
    const client = fixture();
    client.catalogImages.inventory.mockResolvedValue({ total: 3, unclassified: 1 });
    expect(await isLaunchCatalogReady(client, 'team')).toBe(false);
  });
  it('never repairs an empty admitted R2 pool with a stale legacy URL', async () => {
    const client = fixture();
    client.catalogImages.inventory.mockResolvedValue({ total: 0, unclassified: 0 });
    client.getProductCatalogSettings.mockResolvedValue({
      title: 'Item',
      description: 'Details',
      imageLink: 'https://example.invalid/old.jpg'
    });
    expect(await isLaunchCatalogReady(client, 'team')).toBe(false);
    expect(client.listProductCatalogImageSources).not.toHaveBeenCalled();
  });
  it('preserves legacy fallback settings without requiring R2 inventory', async () => {
    const client = fixture('legacy');
    client.getProductCatalogSettings.mockResolvedValue({
      title: 'Item',
      description: 'Details',
      imageLink: 'https://example.invalid/old.jpg'
    });
    expect(await isLaunchCatalogReady(client, 'team')).toBe(true);
    expect(client.catalogImages.inventory).not.toHaveBeenCalled();
  });
  it('propagates an unavailable dictionary instead of presenting a false ready state', async () => {
    const client = fixture();
    client.catalogImages.inventory.mockRejectedValue(new Error('IMAGE_STORAGE_UNAVAILABLE'));
    await expect(isLaunchCatalogReady(client, 'team')).rejects.toThrow('IMAGE_STORAGE_UNAVAILABLE');
  });
});
