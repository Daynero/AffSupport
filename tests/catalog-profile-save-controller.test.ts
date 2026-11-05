import { describe, expect, it, vi } from 'vitest';
import type { CatalogUpdateProfile } from '@video-compressor/shared';
import { TeamApiError } from '../apps/web/src/api/team';
import { saveCatalogProfile } from '../apps/web/src/team/catalog-updater/saveCatalogProfile';
const profile: CatalogUpdateProfile = {
  catalogId: 'one',
  version: 1,
  updatedAt: '',
  restitch: false,
  refreshImages: true,
  refreshTexts: true,
  growProducts: false,
  randomLinkVariation: true
};
const base = { profile, interval: null };
describe('shared catalog save authority', () => {
  it('bounds a stalled write acknowledgement, then checks its exact version without resending it', async () => {
    vi.useFakeTimers();
    let finish!: (value: CatalogUpdateProfile) => void;
    let stored = profile;
    const write = vi.fn(
      () =>
        new Promise<CatalogUpdateProfile>(resolve => {
          finish = resolve;
        })
    );
    const read = vi.fn(async () => ({ ...base, profile: stored }));
    const saving = saveCatalogProfile({ base, patch: { restitch: true }, write, read });
    try {
      await vi.advanceTimersByTimeAsync(15_000);
      expect(read).toHaveBeenCalledTimes(1);
      expect((await saving).kind).toBe('unknown');
      stored = { ...profile, version: 2, restitch: true };
      finish(stored);
      const checked = await saveCatalogProfile({
        base,
        patch: { restitch: true },
        write,
        read,
        readOnly: true
      });
      expect(checked.kind).toBe('confirmed');
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      finish({ ...profile, version: 2, restitch: true });
      await saving;
      vi.useRealTimers();
    }
  });
  it('never treats a rejected version write as success when another writer saved the same value', async () => {
    const result = await saveCatalogProfile({
      base,
      patch: { restitch: true },
      write: async () => {
        throw new TeamApiError('STALE_RESULT', false);
      },
      read: async () => ({ ...base, profile: { ...profile, version: 2, restitch: true } })
    });
    expect(result.kind).toBe('conflict');
  });
  it('does not accept an acknowledgement that skipped settings versions', async () => {
    const newer = { ...profile, version: 3, restitch: true };
    expect(
      (
        await saveCatalogProfile({
          base,
          patch: { restitch: true },
          write: async () => newer,
          read: async () => ({ ...base, profile: newer })
        })
      ).kind
    ).toBe('conflict');
  });
  it('rechecks an unknown result without invoking the writer', async () => {
    const write = vi.fn();
    const result = await saveCatalogProfile({
      base,
      patch: { restitch: true },
      write,
      readOnly: true,
      read: async () => ({ ...base, profile: { ...profile, version: 2, restitch: true } })
    });
    expect(result.kind).toBe('confirmed');
    expect(write).not.toHaveBeenCalled();
  });
  it('does not claim delivery after the scope is revoked during readback', async () => {
    let active = true;
    const result = await saveCatalogProfile({
      base,
      patch: { updateInterval: '1d' },
      canContinue: () => active,
      write: async () => ({ ...profile, version: 2 }),
      read: async () => {
        active = false;
        return { profile: { ...profile, version: 2 }, interval: '1d' };
      }
    });
    expect(result.kind).toBe('unknown');
  });
});
