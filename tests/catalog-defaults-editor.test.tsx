// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CatalogDefaultsEditor,
  type CatalogDefaultsClient
} from '../apps/web/src/team/catalog-updater/CatalogDefaultsEditor';

vi.mock('../apps/web/src/analytics/service', () => ({ analytics: { track: vi.fn() } }));

const permissions = vi.hoisted(() => ({ editable: true }));
vi.mock('../apps/web/src/team/TeamContext', () => ({
  useTeam: () => ({ can: () => permissions.editable })
}));
beforeEach(() => {
  localStorage.setItem('language', 'en');
  permissions.editable = true;
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function client() {
  const values = {
    Restitch: false,
    RandomLinkVariation: true,
    RefreshImages: true,
    RefreshTexts: true,
    Grow: false
  };
  const api = {} as CatalogDefaultsClient;
  for (const suffix of Object.keys(values) as Array<keyof typeof values>) {
    Object.assign(api, {
      [`getCatalogUpdater${suffix === 'Restitch' ? 'RestitchDefault' : suffix}`]: vi.fn(
        async () => values[suffix]
      ),
      [`setCatalogUpdater${suffix}`]: vi.fn(async (_team: string, value: boolean) => {
        values[suffix] = value;
        return value;
      })
    });
  }
  return api;
}

describe('catalog defaults explicit save', () => {
  it('keeps edits local until Save and Cancel restores persisted defaults', async () => {
    const api = client();
    const user = userEvent.setup();
    render(<CatalogDefaultsEditor teamId="space" client={api} />);
    const checkbox = await screen.findByRole('checkbox', { name: 'Images' });
    await user.click(checkbox);
    expect(api.setCatalogUpdaterRefreshImages).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    await user.click(checkbox);
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() =>
      expect(api.setCatalogUpdaterRefreshImages).toHaveBeenCalledWith('space', false)
    );
    expect(api.setCatalogUpdaterRestitch).not.toHaveBeenCalled();
    expect(api.setCatalogUpdaterRefreshTexts).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save settings' }).hasAttribute('disabled')).toBe(
        true
      )
    );
  });

  it('preserves failed fields and retries only those after a partial save', async () => {
    const api = client();
    const original = api.setCatalogUpdaterRefreshTexts!;
    api.setCatalogUpdaterRefreshTexts = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(original);
    const user = userEvent.setup();
    render(<CatalogDefaultsEditor teamId="space" client={api} />);
    await user.click(await screen.findByRole('checkbox', { name: 'Images' }));
    await user.click(screen.getByRole('checkbox', { name: 'Names, texts and prices' }));
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await screen.findByRole('alert');
    expect(
      (
        screen.getByRole('checkbox', {
          name: 'Names, texts and prices'
        }) as HTMLInputElement
      ).checked
    ).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.setCatalogUpdaterRefreshTexts).toHaveBeenCalledTimes(2));
    expect(api.setCatalogUpdaterRefreshImages).toHaveBeenCalledTimes(1);
  });

  it('offers a retry for failed loading and keeps permission-restricted controls read only', async () => {
    permissions.editable = false;
    const api = client();
    api.getCatalogUpdaterRestitchDefault = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(false);
    const user = userEvent.setup();
    render(<CatalogDefaultsEditor teamId="space" client={api} />);
    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    const checkbox = await screen.findByRole('checkbox', { name: 'Images' });
    expect(checkbox.hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save settings' })).toBeNull();
  });
});
