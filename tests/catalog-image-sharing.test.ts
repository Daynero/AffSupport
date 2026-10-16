import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCatalogImageSharer } from '../supabase/functions/_shared/catalog-image-sharing';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';

afterEach(() => vi.useRealTimers());
const images = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ driveFileId: `image-${index}` }));
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe('catalog image sharing', () => {
  it.each([false, true])(
    'bounds 100 distinct images and verifies new grants (public=%s)',
    async publicAlready => {
      vi.useFakeTimers();
      const granted = new Set(publicAlready ? images(100).map(image => image.driveFileId) : []);
      let active = 0;
      let peak = 0;
      const request = async () => {
        active += 1;
        peak = Math.max(peak, active);
        await delay(10);
        active -= 1;
      };
      const drive = {
        listAnyonePermissions: vi.fn(async (id: string) => {
          await request();
          return granted.has(id) ? [{ id: 'permission', role: 'reader' }] : [];
        }),
        createAnyoneReaderPermission: vi.fn(async (id: string) => {
          await request();
          granted.add(id);
          return { id: 'permission', role: 'reader' as const };
        })
      };
      const started = Date.now();
      const share = createCatalogImageSharer(drive);
      const pending = share([...images(100), ...images(100)]);
      await vi.runAllTimersAsync();
      await pending;
      expect(peak).toBe(8);
      expect(active).toBe(0);
      expect(granted.size).toBe(100);
      expect(drive.listAnyonePermissions).toHaveBeenCalledTimes(publicAlready ? 100 : 200);
      expect(drive.createAnyoneReaderPermission).toHaveBeenCalledTimes(publicAlready ? 0 : 100);
      // Equal-latency model: 13 waves rather than 100. This is not a Drive wall-clock claim.
      expect(Date.now() - started).toBe(publicAlready ? 130 : 390);
      await share(images(100));
      expect(drive.listAnyonePermissions).toHaveBeenCalledTimes(publicAlready ? 100 : 200);
      const nextAttempt = createCatalogImageSharer(drive)(images(100));
      await vi.runAllTimersAsync();
      await nextAttempt;
      expect(drive.listAnyonePermissions).toHaveBeenCalledTimes(publicAlready ? 200 : 300);
    }
  );

  it('stops scheduling on failure and waits for every started permission receipt', async () => {
    vi.useFakeTimers();
    const failure = new TeamFunctionError('RATE_LIMITED');
    const receipts: string[] = [];
    const drive = {
      listAnyonePermissions: vi.fn(async (id: string) => {
        await delay(id === 'image-0' ? 10 : 50);
        if (id === 'image-0') throw failure;
        receipts.push(id);
        return [{ id: 'permission', role: 'reader' }];
      }),
      createAnyoneReaderPermission: vi.fn()
    };
    let settled = false;
    const result = createCatalogImageSharer(drive)(images(100)).catch(error => {
      settled = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false);
    expect(drive.listAnyonePermissions).toHaveBeenCalledTimes(8);
    await vi.runAllTimersAsync();
    expect(await result).toBe(failure);
    expect(receipts).toHaveLength(7);
    expect(drive.listAnyonePermissions).toHaveBeenCalledTimes(8);
    expect(drive.createAnyoneReaderPermission).not.toHaveBeenCalled();
  });

  it('does not cache a permission that the provider accepted but did not grant', async () => {
    const drive = {
      listAnyonePermissions: vi.fn(async () => []),
      createAnyoneReaderPermission: vi.fn(async () => ({ id: 'p', role: 'reader' as const }))
    };
    const share = createCatalogImageSharer(drive);
    await expect(share(images(1))).rejects.toMatchObject({ code: 'SHARE_NOT_ALLOWED' });
    await expect(share(images(1))).rejects.toMatchObject({ code: 'SHARE_NOT_ALLOWED' });
    expect(drive.createAnyoneReaderPermission).toHaveBeenCalledTimes(2);
    expect(drive.listAnyonePermissions).toHaveBeenCalledTimes(4);
  });

  it('does no work for an empty pool and keeps sharing clients isolated', async () => {
    const drive = {
      listAnyonePermissions: vi.fn(async () => [{ id: 'p', role: 'writer' }]),
      createAnyoneReaderPermission: vi.fn()
    };
    await createCatalogImageSharer(drive)([]);
    expect(drive.listAnyonePermissions).not.toHaveBeenCalled();
    await createCatalogImageSharer(drive)(images(1));
    const other = {
      ...drive,
      listAnyonePermissions: vi.fn(async () => {
        throw new TeamFunctionError('PERMISSION_DENIED');
      })
    };
    await expect(createCatalogImageSharer(other)(images(1))).rejects.toMatchObject({
      code: 'PERMISSION_DENIED'
    });
    expect(drive.createAnyoneReaderPermission).not.toHaveBeenCalled();
  });
});
