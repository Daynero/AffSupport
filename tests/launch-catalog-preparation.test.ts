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

describe('Launch catalog readiness uses the admitted image source without setup', () => {
  const expectNoLegacyReads = (client: ReturnType<typeof fixture>) => {
    expect(client.getProductCatalogSettings).not.toHaveBeenCalled();
    expect(client.listProductCatalogTexts).not.toHaveBeenCalled();
    expect(client.listProductCatalogImageSources).not.toHaveBeenCalled();
  };
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
      expectNoLegacyReads(client);
      expect(client.catalogImages.capabilities).not.toHaveBeenCalled();
      expect(client.catalogImages.inventory).not.toHaveBeenCalled();
    }
  );
  it('checks the admitted R2 source before shared-pool cutover', async () => {
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
    expectNoLegacyReads(client);
  });
  it.each([0, 1, 3])('accepts %s unclassified images without a private text pool', async count => {
    const client = fixture();
    client.catalogImages.inventory.mockResolvedValue({ total: 3, unclassified: count });
    client.getProductCatalogSettings.mockRejectedValue(new Error('retired settings unavailable'));
    client.listProductCatalogTexts.mockRejectedValue(new Error('retired texts unavailable'));
    expect(await isLaunchCatalogReady(client, 'team')).toBe(true);
    expectNoLegacyReads(client);
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
    expectNoLegacyReads(client);
  });
  it('defers legacy source and fallback admission to the server without reading settings', async () => {
    const client = fixture('legacy');
    client.getProductCatalogSettings.mockRejectedValue(new Error('not configured'));
    expect(await isLaunchCatalogReady(client, 'team')).toBe(true);
    expectNoLegacyReads(client);
    expect(client.catalogImages.inventory).not.toHaveBeenCalled();
  });
  it('works with no legacy settings client at all', async () => {
    const { catalogImages } = fixture();
    expect(await isLaunchCatalogReady({ catalogImages }, 'team')).toBe(true);
  });
  it('propagates unavailable image inventory instead of reporting ready', async () => {
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
