// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CatalogDefaultsEditor,
  type CatalogDefaultsClient
} from '../apps/web/src/team/catalog-updater/CatalogDefaultsEditor';

const track = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/analytics/service', () => ({ analytics: { track } }));

const permissions = vi.hoisted(() => ({ editable: true }));
vi.mock('../apps/web/src/team/TeamContext', () => ({
  useTeam: () => ({ can: () => permissions.editable })
}));
beforeEach(() => {
  localStorage.setItem('language', 'en');
  permissions.editable = true;
  track.mockClear();
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
  it('shows active rule names while folded and completes the committed read result', async () => {
    const { unmount } = render(<CatalogDefaultsEditor teamId="space" client={client()} />);
    await waitFor(() =>
      expect(track.mock.calls.some(([event]) => event === 'operation_completed')).toBe(true)
    );
    const trigger = screen.getByRole('button', { name: /Updates for new catalogs/ });
    expect(trigger.textContent).toContain('Images');
    expect(trigger.textContent).toContain('Names, texts and prices');
    expect(trigger.textContent).not.toContain('Restitch video');
    expect(track.mock.calls.at(-1)?.[1]).toMatchObject({ action_identifier: 'result_visible' });
    expect(screen.queryByText('Defaults saved')).toBeNull();
    unmount();
    expect(track.mock.calls.some(([event]) => event === 'operation_cancelled')).toBe(false);
  });

  it('keeps edits local until Save and Cancel restores persisted defaults', async () => {
    const api = client();
    const user = userEvent.setup();
    render(<CatalogDefaultsEditor teamId="space" client={api} open />);
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
    render(<CatalogDefaultsEditor teamId="space" client={api} open />);
    await user.click(await screen.findByRole('checkbox', { name: 'Images' }));
    await user.click(screen.getByRole('checkbox', { name: 'Names, texts and prices' }));
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await screen.findByRole('alert');
    expect(screen.getAllByText('Not saved').length).toBeGreaterThan(0);
    expect(screen.getByText('Saved')).toBeTruthy();
    expect(screen.queryByText('Defaults saved')).toBeNull();
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

  it('keeps the draft and its indicator when folded and reopened', async () => {
    const user = userEvent.setup();
    render(<CatalogDefaultsEditor teamId="space" client={client()} />);
    const trigger = screen.getByRole('button', { name: /Updates for new catalogs/ });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await user.click(trigger);
    await user.click(await screen.findByRole('checkbox', { name: 'Images' }));
    await user.click(trigger);
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Images' })).toBeNull();
    await user.click(trigger);
    expect((screen.getByRole('checkbox', { name: 'Images' }) as HTMLInputElement).checked).toBe(
      false
    );
  });

  it('offers a retry for failed loading and keeps permission-restricted controls read only', async () => {
    permissions.editable = false;
    const api = client();
    api.getCatalogUpdaterRestitchDefault = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(false);
    const user = userEvent.setup();
    render(<CatalogDefaultsEditor teamId="space" client={api} open />);
    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    const checkbox = await screen.findByRole('checkbox', { name: 'Images' });
    expect(checkbox.hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save settings' })).toBeNull();
  });
});
