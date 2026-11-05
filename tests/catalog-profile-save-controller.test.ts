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
