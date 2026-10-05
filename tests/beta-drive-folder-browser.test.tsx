// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { useBetaFolderPicker } from '../apps/web/src/team/drive/BetaFolderPicker';
import { driveScopeReconsentRequired } from '../supabase/functions/drive-connect/readiness';
import { DRIVE_FILE_SCOPE, DRIVE_RESTRICTED_SCOPE } from '../supabase/functions/_shared/scopes';

vi.mock('../apps/web/src/lib/config', () => ({ configuredEnvironment: () => 'beta' }));
afterEach(cleanup);

it('browses every Drive page before indexing exists and returns the selected resource key', async () => {
  const listFolders = vi
    .fn()
    .mockResolvedValueOnce({ folders: [{ id: 'first', name: 'First' }], nextPageToken: 'next' })
    .mockResolvedValueOnce({
      folders: [{ id: 'second', name: 'Campaigns', resourceKey: 'resource' }],
      nextPageToken: null
    })
    .mockResolvedValue({ folders: [], nextPageToken: null });
  const selected = vi.fn();
  const client = { listFolders };
  function Harness() {
    const picker = useBetaFolderPicker('team', client);
    return (
      <>
        <button
          onClick={() =>
            void picker
              .pickFolders({ accessToken: 'unused', config: null, title: 'Pick' })
              .then(selected)
          }
        >
          Open
        </button>
        {picker.dialog}
      </>
    );
  }
  render(<Harness />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Open' }));
  await user.click(await screen.findByRole('button', { name: /Campaigns/ }));
  await user.click(screen.getByRole('button', { name: /Select.*Campaigns/ }));
  await waitFor(() =>
    expect(selected).toHaveBeenCalledWith([
      {
        id: 'second',
        name: 'Campaigns',
        mimeType: 'application/vnd.google-apps.folder',
        resourceKey: 'resource'
      }
    ])
  );
  expect(listFolders).toHaveBeenCalledWith('team', 'root', 'next');
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('requires renewed beta consent when the configured full-tree grant is missing', () => {
  const environment = { DRIVE_RESTRICTED_SCOPE_APPROVED: 'true' };
  expect(driveScopeReconsentRequired(environment, false, DRIVE_FILE_SCOPE)).toBe(true);
  expect(
    driveScopeReconsentRequired(environment, false, `${DRIVE_FILE_SCOPE} ${DRIVE_RESTRICTED_SCOPE}`)
  ).toBe(false);
  expect(driveScopeReconsentRequired(environment, true, DRIVE_FILE_SCOPE)).toBe(false);
  expect(driveScopeReconsentRequired({}, false, DRIVE_FILE_SCOPE)).toBe(false);
});
