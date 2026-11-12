import { describe, expect, it, vi } from 'vitest';
import {
  isLaunchCatalogReady,
  readLaunchPreparation
} from '../apps/web/src/team/launches/preparation';

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
  it.each([true, false])(
    'uses global readiness %s without reading retired private settings',
    async usable => {
      const legacy = fixture();
      const client = {
        ...legacy,
        catalogImages: {
          ...legacy.catalogImages,
          globalReadiness: vi.fn(async () => ({ state: 'active', usable }))
        }
      };
      expect(await isLaunchCatalogReady(client, 'team')).toBe(usable);
      expect(client.catalogImages.globalReadiness).toHaveBeenCalledWith('team');
      for (const read of [
        client.getProductCatalogSettings,
        client.listProductCatalogTexts,
        client.listProductCatalogImageSources,
        client.catalogImages.capabilities,
        client.catalogImages.inventory
      ])
        expect(read).not.toHaveBeenCalled();
    }
  );
  it('continues using the admitted private source before cutover', async () => {
    const legacy = fixture();
    const client = {
      ...legacy,
      catalogImages: {
        ...legacy.catalogImages,
        globalReadiness: vi.fn(async () => ({ state: 'prepared', usable: false }))
      }
    };
    expect(await isLaunchCatalogReady(client, 'team')).toBe(true);
    expect(client.catalogImages.inventory).toHaveBeenCalledOnce();
  });
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

it('does not let a canceled preflight deliver a late ready result', async () => {
  const controller = new AbortController();
  let finish!: (value: boolean) => void;
  const pending = readLaunchPreparation(
    new Promise<boolean>(resolve => {
      finish = resolve;
    }),
    controller.signal
  );
  controller.abort();
  await expect(pending).rejects.toMatchObject({ reason: 'canceled' });
  finish(true);
  await expect(
    readLaunchPreparation(Promise.reject(new Error('late read')), controller.signal)
  ).rejects.toMatchObject({ reason: 'canceled' });
  await expect(
    readLaunchPreparation(Promise.resolve(true), controller.signal)
  ).rejects.toMatchObject({
    reason: 'canceled'
  });
});

it('bounds a stalled preflight and removes its cancellation listener', async () => {
  vi.useFakeTimers();
  try {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = readLaunchPreparation(new Promise<never>(() => {}), controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
