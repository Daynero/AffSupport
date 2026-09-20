// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LibraryShareActions,
  type LibraryShareClient
} from '../apps/web/src/team/library/LibraryShareActions';
import { SharePreferenceSettings } from '../apps/web/src/team/workspace/SpaceSettings';
import { ToastProvider } from '../apps/web/src/components/toast';

const TEAM_ID = '48000000-0000-4000-8000-000000000001';
const MATERIAL_ID = '48000000-0000-4000-8000-000000000002';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Creative Library sharing UI', () => {
  it('does not claim success or touch the clipboard before restricted-share approval', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });
    const shareLibraryMaterial = vi
      .fn()
      .mockResolvedValueOnce({
        state: 'confirmation_required',
        url: 'https://drive.google.com/file/d/exact/view',
        public: false,
        canShare: true
      })
      .mockResolvedValueOnce({
        state: 'ready',
        url: 'https://drive.google.com/file/d/exact/view',
        public: true,
        permissionChanged: true
      });
    const client: LibraryShareClient = {
      getLibrarySharePreference: vi.fn().mockResolvedValue({
        allowLinkOnCopy: false,
        remembered: false
      }),
      shareLibraryMaterial,
      requestDownload: vi.fn()
    };
    render(
      <ToastProvider>
        <LibraryShareActions teamId={TEAM_ID} materialId={MATERIAL_ID} client={client} />
      </ToastProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(await screen.findByRole('heading', { name: 'Share this Drive item' })).toBeTruthy();
    expect(writeText).not.toHaveBeenCalled();
    expect(shareLibraryMaterial).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        materialId: MATERIAL_ID,
        allowIfRestricted: false,
        rememberChoice: false
      })
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Remember my choice for this space' }));
    fireEvent.click(screen.getByRole('button', { name: 'Allow and copy' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('https://drive.google.com/file/d/exact/view')
    );
    expect(shareLibraryMaterial).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ allowIfRestricted: true, rememberChoice: true })
    );
    expect(await screen.findByRole('button', { name: 'Link copied' })).toBeTruthy();
  });

  it('disables approval truthfully when live Drive capabilities cannot share', async () => {
    const client: LibraryShareClient = {
      getLibrarySharePreference: vi.fn().mockResolvedValue({
        allowLinkOnCopy: false,
        remembered: false
      }),
      shareLibraryMaterial: vi.fn().mockResolvedValue({
        state: 'confirmation_required',
        url: 'https://drive.google.com/file/d/exact/view',
        public: false,
        canShare: false
      }),
      requestDownload: vi.fn()
    };
    render(
      <ToastProvider>
        <LibraryShareActions teamId={TEAM_ID} materialId={MATERIAL_ID} client={client} />
      </ToastProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(
      await screen.findByText('Your current Drive access cannot change sharing.')
    ).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Allow and copy' }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('says the remembered choice in one line and asks again on request', async () => {
    const resetLibrarySharePreference = vi.fn().mockResolvedValue(true);
    const getLibrarySharePreference = vi
      .fn()
      .mockResolvedValue({ allowLinkOnCopy: true, remembered: true });
    render(
      <SharePreferenceSettings
        teamId={TEAM_ID}
        client={{ resetLibrarySharePreference, getLibrarySharePreference }}
      />
    );
    expect(await screen.findByText(/opens it to anyone with the link/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ask again' }));
    await waitFor(() => expect(resetLibrarySharePreference).toHaveBeenCalledWith(TEAM_ID));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Ask again' })).toBeNull());
  });

  it('shows nothing while no sharing choice is remembered', async () => {
    const getLibrarySharePreference = vi
      .fn()
      .mockResolvedValue({ allowLinkOnCopy: false, remembered: false });
    const { container } = render(
      <SharePreferenceSettings
        teamId={TEAM_ID}
        client={{ resetLibrarySharePreference: vi.fn(), getLibrarySharePreference }}
      />
    );
    await waitFor(() => expect(getLibrarySharePreference).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
