// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../apps/web/src/lib/config', () => ({ builtForEnvironment: () => 'beta' }));
vi.mock('../apps/web/src/analytics/service', () => ({ analytics: { track: vi.fn() } }));
import { CatalogProfileVideoCount } from '../apps/web/src/team/catalog-updater/CatalogProfileVideoCount';
import { CatalogBulkEditor } from '../apps/web/src/team/catalog-updater/CatalogBulkEditor';
import { profilePatchMatches } from '../apps/web/src/team/catalog-updater/profilePatchMatches';
const profile = (id: string, n: number) => ({
  catalogId: id,
  refreshImages: true,
  refreshTexts: true,
  growProducts: false,
  randomLinkVariation: true,
  restitch: true,
  videoVariantCount: n,
  version: 1,
  updatedAt: '2026-11-08T12:00:00Z'
});
beforeEach(() => {
  localStorage.setItem('language', 'en');
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllEnvs();
});
it('keeps mixed N untouched until an explicit value, bounds it by smallest catalog and undoes each original count', async () => {
  const saved = new Map<string, number>();
  const save = vi.fn(
    async (id: string, _version: number, patch: { videoVariantCount?: number }) => {
      saved.set(id, patch.videoVariantCount!);
      return { ...profile(id, patch.videoVariantCount!), version: saved.has(id) ? 2 : 1 };
    }
  );
  const read = async (id: string) => ({
    profile: { ...profile(id, saved.get(id) ?? (id === 'A' ? 2 : 4)), version: 2 },
    interval: null
  });
  render(
    <CatalogBulkEditor
      items={[
        { catalogId: 'A', name: 'A', productCount: 3, profile: profile('A', 2), interval: null },
        { catalogId: 'B', name: 'B', productCount: 8, profile: profile('B', 4), interval: null }
      ]}
      save={save}
      read={read}
      onSaved={() => {}}
    />
  );
  const input = screen.getByRole('textbox', { name: 'Video variations' });
  expect((input as HTMLInputElement).placeholder).toMatch(/mixed/i);
  fireEvent.change(input, { target: { value: '4' } });
  expect(screen.getByRole('button', { name: 'Save settings' }).hasAttribute('disabled')).toBe(true);
  fireEvent.change(input, { target: { value: '3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls.map(([id, , p]) => [id, p.videoVariantCount])).toEqual([
    ['A', 3],
    ['B', 3]
  ]);
  fireEvent.click(await screen.findByRole('button', { name: 'Undo saved changes' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(4));
  expect(save.mock.calls.slice(2).map(([id, , p]) => [id, p.videoVariantCount])).toEqual([
    ['A', 2],
    ['B', 4]
  ]);
});
it('does not confirm an N mutation from old readback that omits N', () => {
  const old = { ...profile('A', 1) };
  delete (old as { videoVariantCount?: number }).videoVariantCount;
  expect(profilePatchMatches({ profile: old, interval: null }, { videoVariantCount: 1 })).toBe(
    false
  );
  expect(
    profilePatchMatches({ profile: profile('A', 3), interval: null }, { videoVariantCount: 3 })
  ).toBe(true);
});
it('detail refuses an out of range count and a dirty concurrent profile change', () => {
  const save = vi.fn(async () => {});
  const view = render(
    <React.StrictMode>
      <CatalogProfileVideoCount value={2} productCount={5} disabled={false} onSave={save} />
    </React.StrictMode>
  );
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '6' } });
  expect(screen.getByRole('button', { name: 'Save settings' }).hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '4' } });
  view.rerender(
    <React.StrictMode>
      <CatalogProfileVideoCount value={3} productCount={5} disabled={false} onSave={save} />
    </React.StrictMode>
  );
  expect(screen.getByRole('button', { name: 'Save settings' }).hasAttribute('disabled')).toBe(true);
  expect(save).not.toHaveBeenCalled();
});
