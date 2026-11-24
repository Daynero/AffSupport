// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';
import type { CatalogRegistryRow, TeamContextSnapshot } from '../apps/web/src/api/team';
import { ToastProvider } from '../apps/web/src/components/toast';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { UpdaterRowActions } from '../apps/web/src/team/catalog-updater/UpdaterRowActions';

/**
 * 070 T025 — a catalog in the updater opens the same details card the explorer's pane is,
 * over the updater, instead of only a link to the sheet and a way to its folder.
 */

const TEAM_ID = '23000000-0000-4000-8000-0000000000ab';
const owned: TeamContextSnapshot = {
  id: TEAM_ID,
  name: 'Creatives',
  role: 'owner',
  permissions: DEFAULT_ROLE_PERMISSIONS.owner,
  connectionState: 'connected'
};

const row = {
  catalogId: '23000000-0000-4000-8000-000000000001',
  name: 'TR 7 catalog',
  sheetUrl: 'https://docs.google.com/spreadsheets/d/1/edit',
  videoId: '23000000-0000-4000-8000-000000000101',
  videoName: 'TR 7.mp4',
  folderName: 'Polo',
  productCount: 100,
  createdAt: '2026-09-15T10:00:00.000Z',
  lastUpdatedAt: '2026-11-20T10:00:00.000Z',
  updateCount: 3,
  inUpdater: true,
  lastUpdateError: null,
  updateInterval: null,
  nextRunAt: null,
  updatePending: false,
  updateStage: null,
  restitchProgress: null,
  restitchStage: null,
  folderDriveId: 'folder-polo'
} satisfies CatalogRegistryRow;

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('a catalog in the updater', () => {
  it('opens its details card, with where it lives, and does not offer the card again', async () => {
    localStorage.setItem('language', 'en');
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <TeamProvider realtime={false} initialTeams={[owned]}>
          <UpdaterRowActions
            row={row}
            teamId={TEAM_ID}
            permissions={DEFAULT_ROLE_PERMISSIONS.owner}
            onChanged={vi.fn()}
          />
        </TeamProvider>
      </ToastProvider>
    );
    await user.click(screen.getByRole('button', { name: /^Actions for/ }));
    await user.click(await screen.findByRole('menuitem', { name: /^Details/ }));
    const card = await screen.findByRole('dialog', { name: 'Details' });
    expect(card.querySelector('.team-material-detail-name')?.textContent).toContain('TR 7 catalog');
    expect(card.textContent).toContain('Polo');
    const more = within(card).queryByRole('button', { name: /^Actions for/ });
    if (more) {
      await user.click(more);
      const names = screen.getAllByRole('menuitem').map(item => item.textContent ?? '');
      expect(names.some(name => name.startsWith('Details'))).toBe(false);
    }
  });
});
