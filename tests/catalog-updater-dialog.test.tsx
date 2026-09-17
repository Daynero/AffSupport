// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';
import type {
  CatalogRegistryRow,
  CatalogUpdaterState,
  TeamContextSnapshot
} from '../apps/web/src/api/team';

/**
 * Feature 023, and a schedule per catalog in 024: the catalog updater's dialog — the registry and
 * search, each catalog's own interval saved the moment it is chosen, "update now" on a row, and
 * both of them across a selection.
 */

const { TeamProvider } = await import('../apps/web/src/team/TeamContext');
const { ToastProvider } = await import('../apps/web/src/components/toast');
const { TeamApiError } = await import('../apps/web/src/api/team');
const { CatalogUpdaterDialog } =
  await import('../apps/web/src/team/catalog-updater/CatalogUpdaterDialog');
const { filterCatalogRows } =
  await import('../apps/web/src/team/catalog-updater/useCatalogUpdater');
type DialogClient = NonNullable<Parameters<typeof CatalogUpdaterDialog>[0]['client']>;

const TEAM_ID = '23000000-0000-4000-8000-0000000000aa';

const owned: TeamContextSnapshot = {
  id: TEAM_ID,
  name: 'Creatives',
  role: 'owner',
  permissions: DEFAULT_ROLE_PERMISSIONS.owner,
  connectionState: 'connected'
};
const viewing: TeamContextSnapshot = {
  ...owned,
  role: 'viewer',
  permissions: DEFAULT_ROLE_PERMISSIONS.viewer
};

function row(id: string, videoName: string, patch: Partial<CatalogRegistryRow> = {}) {
  return {
    catalogId: `23000000-0000-4000-8000-00000000000${id}`,
    name: `${videoName} catalog`,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${id}/edit`,
    videoId: `23000000-0000-4000-8000-00000000010${id}`,
    videoName,
    folderName: 'Polo',
    productCount: 100,
    createdAt: '2026-09-15T10:00:00.000Z',
    lastUpdatedAt: null,
    updateCount: 0,
    inUpdater: false,
    lastUpdateError: null,
    updateInterval: null,
    nextRunAt: null,
    updatePending: false,
    folderDriveId: 'folder-polo',
    ...patch
  } satisfies CatalogRegistryRow;
}

const stopped: CatalogUpdaterState = {
  state: 'stopped',
  interval: '1h',
  restitch: false,
  nextRunAt: null,
  startedAt: null,
  catalogCount: 0,
  failingCount: 0,
  spareReadyCount: null,
  serverNow: new Date().toISOString()
};

const running: CatalogUpdaterState = {
  ...stopped,
  state: 'running',
  interval: '1d',
  nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
  startedAt: new Date().toISOString(),
  catalogCount: 1
};

beforeEach(() => {
  localStorage.setItem('wishly.active-team.v1', TEAM_ID);
  localStorage.setItem('language', 'en');
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function client(
  rows: CatalogRegistryRow[],
  state: CatalogUpdaterState,
  overrides: Partial<DialogClient> = {}
): DialogClient {
  return {
    getCatalogUpdater: vi.fn().mockResolvedValue(state),
    listTeamProductCatalogs: vi.fn().mockResolvedValue(rows),
    setCatalogUpdateInterval: vi.fn().mockResolvedValue(running),
    runCatalogUpdateNow: vi.fn().mockResolvedValue(1),
    setCatalogUpdaterRestitch: vi.fn().mockResolvedValue({ ...stopped, restitch: true }),
    ...overrides
  };
}

function renderDialog(api: DialogClient, team: TeamContextSnapshot = owned) {
  const onClose = vi.fn();
  const onChanged = vi.fn();
  const onReveal = vi.fn();
  render(
    <TeamProvider initialTeams={[team]} realtime={false}>
      <ToastProvider>
        <CatalogUpdaterDialog
          teamId={TEAM_ID}
          client={api}
          onClose={onClose}
          onChanged={onChanged}
          onReveal={onReveal}
        />
      </ToastProvider>
    </TeamProvider>
  );
  return { onClose, onChanged, onReveal };
}

const box = (name: string) => screen.getByLabelText(`Select ${name} catalog`) as HTMLInputElement;

describe('what an update refreshes (024: US20, US21)', () => {
  it('offers both choices, on by default, and saves the one that is changed', async () => {
    const setCatalogUpdaterRefreshTexts = vi.fn().mockResolvedValue(false);
    const api = client([row('1', 'polo.mp4')], stopped, {
      getCatalogUpdaterRefreshImages: vi.fn().mockResolvedValue(true),
      setCatalogUpdaterRefreshImages: vi.fn().mockResolvedValue(false),
      getCatalogUpdaterRefreshTexts: vi.fn().mockResolvedValue(true),
      getCatalogUpdaterGrow: vi.fn().mockResolvedValue(false),
      setCatalogUpdaterGrow: vi.fn().mockResolvedValue(true),
      setCatalogUpdaterRefreshTexts
    });
    renderDialog(api);
    const texts = (await screen.findByLabelText('Names, texts and prices')) as HTMLInputElement;
    expect(texts.checked).toBe(true);
    expect((screen.getByLabelText('Pictures') as HTMLInputElement).checked).toBe(true);
    // 024 US22: growing the sheet is the one that starts off.
    expect((screen.getByLabelText('1–5 new products') as HTMLInputElement).checked).toBe(false);
    await userEvent.click(texts);
    await waitFor(() => expect(setCatalogUpdaterRefreshTexts).toHaveBeenCalledWith(TEAM_ID, false));
  });
});

describe('leaving the dialog', () => {
  it('closes on Escape from the search field, once the field is empty', async () => {
    const { onClose } = renderDialog(client([row('1', 'polo.mp4')], stopped));
    const search = await screen.findByLabelText('Search by video or catalog');
    await userEvent.type(search, 'polo');
    // A field with something in it is emptied first: Escape is the way out of a search, too.
    fireEvent.keyDown(search, { key: 'Escape' });
    expect((search as HTMLInputElement).value).toBe('');
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('the registry', () => {
  it('lists every catalog with its folder, its schedule and its state', async () => {
    renderDialog(
      client(
        [
          row('1', 'polo.mp4', {
            lastUpdateError: 'NEEDS_REAUTH',
            inUpdater: true,
            updateInterval: '6h',
            nextRunAt: new Date(Date.now() + 3_600_000).toISOString()
          }),
          row('2', 'shirt.mp4', { folderName: null, updatePending: true })
        ],
        running
      )
    );
    expect(await screen.findByText('polo.mp4 catalog')).toBeTruthy();
    expect(screen.getByText('shirt.mp4 catalog')).toBeTruthy();
    expect(screen.getByText(/Last update failed/)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'How often polo.mp4 catalog updates: Every 6 h' })
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'How often shirt.mp4 catalog updates: Off' })
    ).toBeTruthy();
    // An update already waiting says so, and its "now" waits with it.
    expect(screen.getByText('Updating…')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Update shirt.mp4 catalog now' }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(screen.getByText(/On a schedule: 1/)).toBeTruthy();
  });

  it('says there is nothing on a schedule, and where to set one', async () => {
    renderDialog(client([row('1', 'polo.mp4')], stopped));
    expect(await screen.findByText(/Nothing updates on a schedule/)).toBeTruthy();
    expect(screen.getByText(/Each catalog updates on its own schedule/)).toBeTruthy();
  });

  it('narrows the list by search', async () => {
    const rows = [row('1', 'polo.mp4'), row('2', 'shirt.mp4', { name: 'summer catalog' })];
    expect(filterCatalogRows(rows, 'summ').map(item => item.videoName)).toEqual(['shirt.mp4']);
    renderDialog(client(rows, stopped));
    await screen.findByText('polo.mp4 catalog');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'polo' } });
    expect(screen.queryByText('summer catalog')).toBeNull();
  });
});

describe('a catalog’s own schedule', () => {
  it('saves an interval the moment it is chosen, for that catalog only', async () => {
    const api = client([row('1', 'polo.mp4'), row('2', 'shirt.mp4')], stopped);
    const { onChanged } = renderDialog(api);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'How often polo.mp4 catalog updates: Off' })
    );
    await user.click(await screen.findByRole('button', { name: 'Every day' }));
    await waitFor(() =>
      expect(api.setCatalogUpdateInterval).toHaveBeenCalledWith(
        TEAM_ID,
        [row('1', 'x').catalogId],
        '1d'
      )
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('takes hours of its own, and refuses hours out of range', async () => {
    const api = client([row('1', 'polo.mp4')], stopped);
    renderDialog(api);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'How often polo.mp4 catalog updates: Off' })
    );
    const hours = await screen.findByLabelText('Hours between updates');
    await user.type(hours, '999');
    expect(screen.getByText('Enter whole hours from 1 to 720.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Set' }) as HTMLButtonElement).disabled).toBe(true);
    await user.clear(hours);
    await user.type(hours, '36');
    await user.click(screen.getByRole('button', { name: 'Set' }));
    await waitFor(() =>
      expect(api.setCatalogUpdateInterval).toHaveBeenCalledWith(
        TEAM_ID,
        [row('1', 'x').catalogId],
        '36h'
      )
    );
  });

  it('turns a catalog off', async () => {
    const api = client([row('1', 'polo.mp4', { inUpdater: true, updateInterval: '1h' })], running);
    renderDialog(api);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'How often polo.mp4 catalog updates: Every hour' })
    );
    await user.click(await screen.findByRole('button', { name: 'Don’t update automatically' }));
    await waitFor(() =>
      expect(api.setCatalogUpdateInterval).toHaveBeenCalledWith(
        TEAM_ID,
        [row('1', 'x').catalogId],
        null
      )
    );
  });

  it('updates one catalog now, scheduled or not', async () => {
    const api = client([row('1', 'polo.mp4')], stopped);
    renderDialog(api);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Update polo.mp4 catalog now' }));
    await waitFor(() =>
      expect(api.runCatalogUpdateNow).toHaveBeenCalledWith(TEAM_ID, [row('1', 'x').catalogId])
    );
    expect(await screen.findByText('Updating now: 1')).toBeTruthy();
  });

  it('shows the server refusal', async () => {
    const api = client([row('1', 'polo.mp4')], stopped, {
      runCatalogUpdateNow: vi.fn().mockRejectedValue(new TeamApiError('PERMISSION_DENIED', false))
    });
    renderDialog(api);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Update polo.mp4 catalog now' }));
    expect(await screen.findByText('You do not have permission for this.')).toBeTruthy();
  });
});

describe('a catalog’s menu', () => {
  it('shows the sheet in its folder', async () => {
    const polo = row('1', 'polo.mp4');
    const { onReveal } = renderDialog(client([polo], stopped));
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: /^Actions (for|on) polo\.mp4 catalog/ })
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Show in folder' }));
    expect(onReveal).toHaveBeenCalledWith(polo);
  });
});

describe('a selection', () => {
  it('sets one interval and updates now across every ticked catalog', async () => {
    const api = client([row('1', 'polo.mp4'), row('2', 'shirt.mp4')], stopped);
    renderDialog(api);
    const user = userEvent.setup();
    await screen.findByText('polo.mp4 catalog');
    fireEvent.click(screen.getByLabelText('Select all shown'));
    const bar = screen.getByRole('group', { name: 'Selected catalogs' });
    expect(within(bar).getByText('2 catalogs selected')).toBeTruthy();

    await user.click(
      within(bar).getByRole('button', { name: /^How often the selected catalogs update/ })
    );
    await user.click(await screen.findByRole('button', { name: 'Every week' }));
    const ids = [row('1', 'x').catalogId, row('2', 'x').catalogId];
    await waitFor(() =>
      expect(api.setCatalogUpdateInterval).toHaveBeenCalledWith(TEAM_ID, ids, '1w')
    );

    await user.click(within(bar).getByRole('button', { name: 'Update now' }));
    await waitFor(() => expect(api.runCatalogUpdateNow).toHaveBeenCalledWith(TEAM_ID, ids));
  });

  it('switches re-stitching for the space as soon as it is ticked', async () => {
    const api = client([row('1', 'polo.mp4')], stopped);
    renderDialog(api);
    await screen.findByText('polo.mp4 catalog');
    fireEvent.click(screen.getByLabelText('Re-stitched video'));
    await waitFor(() => expect(api.setCatalogUpdaterRestitch).toHaveBeenCalledWith(TEAM_ID, true));
  });
});

describe('a viewer', () => {
  it('sees the schedules but cannot change them or update now', async () => {
    renderDialog(
      client([row('1', 'polo.mp4', { updateInterval: '1d', inUpdater: true })], running),
      viewing
    );
    expect(await screen.findByText('polo.mp4 catalog')).toBeTruthy();
    expect(
      (
        screen.getByRole('button', {
          name: /^How often polo.mp4 catalog updates/
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    expect(screen.queryByRole('button', { name: 'Update polo.mp4 catalog now' })).toBeNull();
    expect(screen.queryByLabelText('Select all shown')).toBeNull();
    expect(
      screen.getByText('Only members who can process materials can run the updater.')
    ).toBeTruthy();
  });

  it('closes from the header', async () => {
    const { onClose } = renderDialog(client([], stopped));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});
