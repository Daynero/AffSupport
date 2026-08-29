// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TeamMaterialRow } from '@video-compressor/shared';
import { ToastProvider } from '../apps/web/src/components/toast';
import { ShareButton } from '../apps/web/src/team/explorer/ShareButton';
import { teamApi } from '../apps/web/src/api/team';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const row = {
  id: 'm-1',
  teamId: 't-1',
  name: 'clip.mp4',
  category: 'video',
  kind: 'video',
  driveFileId: 'd-1',
  parentFolderId: 'root'
} as unknown as TeamMaterialRow;

function renderButton() {
  render(
    <ToastProvider>
      <ShareButton teamId="t-1" row={row} />
    </ToastProvider>
  );
}

describe('ShareButton (011)', () => {
  it('shares by link, copies it, and confirms in green', async () => {
    const share = vi.spyOn(teamApi, 'shareLibraryMaterial').mockResolvedValue({
      state: 'ready',
      url: 'https://drive.google.com/file/d/shared/view',
      public: true,
      permissionChanged: true
    });
    // userEvent.setup() installs a clipboard stub; spy on its writeText.
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    renderButton();
    await user.click(screen.getByRole('button', { name: /Share clip\.mp4/ }));
    await waitFor(() =>
      expect(share).toHaveBeenCalledWith(
        expect.objectContaining({
          teamId: 't-1',
          materialId: 'm-1',
          allowIfRestricted: true,
          rememberChoice: true
        })
      )
    );
    expect(writeText).toHaveBeenCalledWith('https://drive.google.com/file/d/shared/view');
    expect(await screen.findByText('Link copied')).toBeTruthy();
  });

  it('surfaces a failure without claiming success', async () => {
    vi.spyOn(teamApi, 'shareLibraryMaterial').mockRejectedValue(new Error('PERMISSION_DENIED'));
    const user = userEvent.setup();
    renderButton();
    await user.click(screen.getByRole('button', { name: /Share clip\.mp4/ }));
    await waitFor(() => expect(screen.queryByText('Link copied')).toBeNull());
  });
});
