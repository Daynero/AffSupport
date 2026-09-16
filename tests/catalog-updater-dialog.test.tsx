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
 * Feature 023, US1/US2/US4: the catalog updater's dialog — the registry, search and selection,
 * starting with the chosen interval, saving a running updater and stopping it.
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
    saveCatalogUpdater: vi.fn().mockResolvedValue({ ...running, interval: '1w' }),
    stopCatalogUpdater: vi.fn().mockResolvedValue(stopped),
    ...overrides
  };
}

function renderDialog(api: DialogClient, team: TeamContextSnapshot = owned) {
  const onClose = vi.fn();
  const onChanged = vi.fn();
  render(
    <TeamProvider initialTeams={[team]} realtime={false}>
      <ToastProvider>
        <CatalogUpdaterDialog
          teamId={TEAM_ID}
          client={api}
          onClose={onClose}
          onChanged={onChanged}
        />
      </ToastProvider>
    </TeamProvider>
  );
  return { onClose, onChanged };
}

const startButton = () => screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement;
const box = (name: string) => screen.getByLabelText(`Select ${name} catalog`) as HTMLInputElement;

describe('the registry', () => {
  it('lists every catalog with its video, folder and state', async () => {
    renderDialog(
      client(
        [
          row('1', 'polo.mp4', { lastUpdateError: 'NEEDS_REAUTH' }),
          row('2', 'shirt.mp4', { folderName: null })
        ],
        stopped
      )
    );
    expect(await screen.findByText('polo.mp4 catalog')).toBeTruthy();
    expect(screen.getByText('shirt.mp4 catalog')).toBeTruthy();
    expect(screen.getByText(/Space root/)).toBeTruthy();
    expect(screen.getByText(/Last update failed/)).toBeTruthy();
    expect(screen.getByText('Not running')).toBeTruthy();
    // Opening a catalog is the material vocabulary's `open` now (024), not an
    // anchor of the updater's own — so the row is checked by what pressing it
    // does rather than by the href it used to carry.
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await userEvent.click(screen.getAllByRole('button', { name: 'Open' })[0]!);
    expect(open).toHaveBeenCalledWith(
      'https://docs.google.com/spreadsheets/d/1/edit',
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('says so when the space has no catalogs', async () => {
    renderDialog(client([], stopped));
    expect(await screen.findByText('No catalogs yet. Create one from a video.')).toBeTruthy();
    expect(startButton().disabled).toBe(true);
  });

  it('narrows the list by search and selects only what is shown', async () => {
    renderDialog(client([row('1', 'polo.mp4'), row('2', 'shirt.mp4')], stopped));
    await screen.findByText('polo.mp4 catalog');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '  SHIRT ' } });
    expect(screen.queryByText('polo.mp4')).toBeNull();
    fireEvent.click(screen.getByLabelText('Select all shown'));
    expect(box('shirt.mp4').checked).toBe(true);
    expect(screen.getByText('1 catalog selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(box('polo.mp4').checked).toBe(false);
  });

  it('filters by the video or the sheet name', () => {
    const rows = [row('1', 'polo.mp4'), row('2', 'shirt.mp4', { name: 'Summer' })];
    expect(filterCatalogRows(rows, 'summ').map(item => item.videoName)).toEqual(['shirt.mp4']);
    expect(filterCatalogRows(rows, ' ')).toHaveLength(2);
  });
});

describe('starting, saving and stopping', () => {
  it('starts with the ticked catalogs and the chosen interval', async () => {
    const api = client([row('1', 'polo.mp4'), row('2', 'shirt.mp4')], stopped);
    renderDialog(api);
    await screen.findByText('polo.mp4 catalog');
    expect(startButton().disabled).toBe(true);
    expect(screen.getByText('Select at least one catalog.')).toBeTruthy();
    fireEvent.click(box('shirt.mp4'));
    fireEvent.click(screen.getByRole('button', { name: '1 week' }));
    fireEvent.click(startButton());
    await waitFor(() =>
      expect(api.saveCatalogUpdater).toHaveBeenCalledWith(TEAM_ID, {
        catalogIds: [row('2', 'x').catalogId],
        interval: '1w',
        restitch: false
      })
    );
    expect(await screen.findByText('Updater started')).toBeTruthy();
  });

  it('starts on an own interval in whole hours, and refuses one out of range', async () => {
    const api = client([row('1', 'polo.mp4')], stopped);
    renderDialog(api);
    await screen.findByText('polo.mp4 catalog');
    fireEvent.click(box('polo.mp4'));
    fireEvent.click(screen.getByRole('button', { name: 'Own interval' }));
    const hours = screen.getByLabelText('Hours between updates');
    fireEvent.change(hours, { target: { value: '721' } });
    expect(screen.getByText('Enter whole hours from 1 to 720.')).toBeTruthy();
    expect(startButton().disabled).toBe(true);
    fireEvent.change(hours, { target: { value: '6' } });
    expect(startButton().disabled).toBe(false);
    fireEvent.click(startButton());
    await waitFor(() =>
      expect(api.saveCatalogUpdater).toHaveBeenCalledWith(
        TEAM_ID,
        expect.objectContaining({ interval: '6h' })
      )
    );
  });

  it('opens a running updater on its own interval with the hours filled in', async () => {
    renderDialog(
      client([row('1', 'polo.mp4', { inUpdater: true })], { ...running, interval: '36h' })
    );
    await screen.findByText('polo.mp4 catalog');
    await waitFor(() =>
      expect((screen.getByLabelText('Hours between updates') as HTMLInputElement).value).toBe('36')
    );
    expect(screen.getByRole('button', { name: 'Own interval' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
  });

  it('starts with re-stitching when it is ticked, and says how copies are prepared', async () => {
    const api = client([row('1', 'polo.mp4')], stopped);
    renderDialog(api);
    await screen.findByText('polo.mp4 catalog');
    expect(screen.getByText(/Copies are prepared while Soty is open/)).toBeTruthy();
    const restitch = screen.getByLabelText(/Re-stitch videos/) as HTMLInputElement;
    await waitFor(() => expect(restitch.disabled).toBe(false));
    fireEvent.click(restitch);
    fireEvent.click(box('polo.mp4'));
    fireEvent.click(startButton());
    await waitFor(() =>
      expect(api.saveCatalogUpdater).toHaveBeenCalledWith(
        TEAM_ID,
        expect.objectContaining({ restitch: true })
      )
    );
  });

  it('shows the copies ready while re-stitching runs, and when this computer is preparing one', async () => {
    const restitching: CatalogUpdaterState = {
      ...running,
      restitch: true,
      catalogCount: 2,
      spareReadyCount: 1
    };
    render(
      <TeamProvider initialTeams={[owned]} realtime={false}>
        <ToastProvider>
          <CatalogUpdaterDialog
            teamId={TEAM_ID}
            client={client([row('1', 'polo.mp4', { inUpdater: true })], restitching)}
            preparing
            onClose={vi.fn()}
          />
        </ToastProvider>
      </TeamProvider>
    );
    await screen.findByText('polo.mp4 catalog');
    await waitFor(() =>
      expect((screen.getByLabelText(/Re-stitch videos/) as HTMLInputElement).checked).toBe(true)
    );
    expect(screen.getByText('Copies ready: 1 of 2')).toBeTruthy();
    expect(screen.getByText('This computer is preparing a copy now.')).toBeTruthy();
  });

  it('opens a running updater with its catalogs ticked and its interval', async () => {
    const api = client([row('1', 'polo.mp4', { inUpdater: true }), row('2', 'shirt.mp4')], running);
    renderDialog(api);
    await screen.findByText('polo.mp4 catalog');
    await waitFor(() => expect(box('polo.mp4').checked).toBe(true));
    expect(box('shirt.mp4').checked).toBe(false);
    expect(screen.getByRole('button', { name: '1 day' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(/Running · next update in/)).toBeTruthy();
    fireEvent.click(box('shirt.mp4'));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(api.saveCatalogUpdater).toHaveBeenCalledWith(TEAM_ID, {
        catalogIds: [row('1', 'x').catalogId, row('2', 'x').catalogId],
        interval: '1d',
        restitch: false
      })
    );
  });

  it('stops only after confirming', async () => {
    const api = client([row('1', 'polo.mp4', { inUpdater: true })], running);
    const { onChanged } = renderDialog(api);
    await screen.findByText('polo.mp4 catalog');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    const confirm = await screen.findByRole('dialog', { name: 'Stop the updater?' });
    expect(api.stopCatalogUpdater).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(api.stopCatalogUpdater).toHaveBeenCalledWith(TEAM_ID));
    expect(await screen.findByText('Updater stopped')).toBeTruthy();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('shows the server refusal', async () => {
    const api = client([row('1', 'polo.mp4')], stopped, {
      saveCatalogUpdater: vi.fn().mockRejectedValue(new TeamApiError('PERMISSION_DENIED', false))
    });
    renderDialog(api);
    await screen.findByText('polo.mp4 catalog');
    fireEvent.click(box('polo.mp4'));
    fireEvent.click(startButton());
    expect(await screen.findByText('You do not have permission for this.')).toBeTruthy();
    expect(startButton().disabled).toBe(false);
  });

  it('lets a viewer look but not run it', async () => {
    renderDialog(client([row('1', 'polo.mp4')], stopped), viewing);
    await screen.findByText('polo.mp4 catalog');
    expect(box('polo.mp4').disabled).toBe(true);
    expect(startButton().disabled).toBe(true);
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
