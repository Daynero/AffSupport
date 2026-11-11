// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS, type CatalogUpdateProfile } from '@video-compressor/shared';
import type {
  CatalogRegistryRow,
  CatalogUpdaterState,
  TeamContextSnapshot
} from '../apps/web/src/api/team';
import type { WorkspaceOperationsValue } from '../apps/web/src/team/explorer/WorkspaceOperationsProvider';

const hostedWorkspace = vi.hoisted(() => ({ value: null as WorkspaceOperationsValue | null }));
vi.mock('../apps/web/src/team/explorer/WorkspaceOperationsProvider', () => ({
  useOptionalWorkspaceOperations: () => hostedWorkspace.value
}));

/**
 * Feature 023, and a schedule per catalog in 024: the catalog updater's dialog — the registry and
 * search, each catalog's own interval saved the moment it is chosen, "update now" on a row, and
 * both of them across a selection.
 */

const retryBackgroundRecovery = vi.fn(async (_teamId: string) => ({
  enabled: true,
  installationId: null,
  state: 'claiming',
  reason: null
}));
vi.mock('../apps/web/src/api/recovery', async importOriginal => ({
  ...(await importOriginal<typeof import('../apps/web/src/api/recovery')>()),
  retryBackgroundRecovery: (teamId: string) => retryBackgroundRecovery(teamId)
}));
vi.mock('../apps/web/src/auth/AuthContext', () => ({
  useOptionalAuth: () => ({ user: { id: '47000000-0000-4000-8000-000000000001' } })
}));

const { setPrivateCacheScope } = await import('../apps/web/src/team/private-cache-scope');
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
    updateStage: null,
    restitchProgress: null,
    restitchStage: null,
    folderDriveId: 'folder-polo',
    ...patch
  } satisfies CatalogRegistryRow;
}

function profileFor(catalogId: string) {
  return {
    catalogId,
    refreshImages: true,
    refreshTexts: true,
    growProducts: false,
    randomLinkVariation: true,
    restitch: false,
    version: 1,
    updatedAt: '2026-09-15T10:00:00.000Z'
  };
}

const stopped: CatalogUpdaterState = {
  restitchBlockedCode: null,
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
  hostedWorkspace.value = null;
  setPrivateCacheScope('47000000-0000-4000-8000-000000000001', 'owner');
  localStorage.setItem('wishly.active-team.v1', TEAM_ID);
  localStorage.setItem('language', 'en');
  localStorage.setItem('catalog-icon-legend-seen', '1');
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function client(
  rows: CatalogRegistryRow[],
  state: CatalogUpdaterState,
  overrides: Partial<DialogClient> = {}
): DialogClient {
  const api: DialogClient = {
    getCatalogUpdater: vi.fn().mockResolvedValue(state),
    listTeamProductCatalogs: vi.fn().mockResolvedValue(rows),
    setCatalogUpdateInterval: vi.fn().mockResolvedValue(running),
    listCatalogUpdateProfiles: vi
      .fn()
      .mockResolvedValue(rows.map(item => item.profile ?? profileFor(item.catalogId))),
    patchCatalogUpdateProfile: vi.fn().mockImplementation(async (_team, id, _version, patch) => ({
      ...profileFor(id),
      ...patch,
      version: 2
    })),
    runCatalogUpdateNow: vi.fn().mockResolvedValue(1),
    cancelCatalogUpdate: vi.fn().mockResolvedValue(true),
    setCatalogUpdaterRestitch: vi.fn().mockResolvedValue({ ...stopped, restitch: true }),
    ...overrides
  };
  api.requestCatalogUpdateCommand ??= async (_team, _actor, intent) => {
    const count = intent.sourceAttemptId
      ? await api.retryCatalogUpdate!(_team, intent.catalogIds[0]!, intent.sourceAttemptId)
      : await api.runCatalogUpdateNow(_team, intent.catalogIds);
    return {
      commandId: intent.commandId,
      kind: intent.sourceAttemptId ? 'retry' : 'run',
      status: 'accepted',
      sourceAttemptId: intent.sourceAttemptId ?? null,
      requestedCount: intent.catalogIds.length,
      acceptedCount: Math.min(count, intent.catalogIds.length),
      items: intent.catalogIds.map((catalogId, index) => ({
        catalogId,
        accepted: index < count,
        attemptId: index < count ? crypto.randomUUID() : null,
        reason: index < count ? 'accepted' : 'already_pending'
      }))
    };
  };
  api.getCatalogUpdateCommand ??= async () => null;
  return api;
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

it('starts with compact controls, search and closed filters without loading defaults', async () => {
  const getDefaults = vi.fn();
  renderDialog(
    client([row('1', 'polo.mp4')], stopped, { getCatalogUpdaterRefreshImages: getDefaults })
  );
  await screen.findByLabelText('polo.mp4 catalog');
  expect(screen.getByRole('searchbox')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Filters' })).toBeTruthy();
  expect(screen.queryByRole('group', { name: 'Filters' })).toBeNull();
  expect(screen.getAllByRole('toolbar')).toHaveLength(1);
  expect(getDefaults).not.toHaveBeenCalled();
});

it('filters by confirmed last update and clears the filter and sort together', async () => {
  const recent = row('1', 'recent', { lastUpdatedAt: new Date(Date.now() - 60_000).toISOString() });
  const old = row('2', 'old', {
    lastUpdatedAt: new Date(Date.now() - 10 * 86_400_000).toISOString()
  });
  renderDialog(client([recent, old], stopped));
  await screen.findByLabelText('recent catalog');
  await userEvent.click(screen.getByRole('button', { name: 'Filters' }));
  await userEvent.click(screen.getByRole('button', { name: 'Last update' }));
  await userEvent.click(screen.getByRole('option', { name: 'Within 24 hours' }));
  expect(screen.queryByLabelText('old catalog')).toBeNull();
  expect(screen.getByLabelText('recent catalog')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Sort by' }));
  await userEvent.click(screen.getByRole('option', { name: 'Last updated' }));
  await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  expect(screen.getByLabelText('old catalog')).toBeTruthy();
  expect((screen.getByRole('combobox', { name: 'Sort by' }) as HTMLInputElement).value).toBe(
    'Recently created'
  );
});

it('keeps unsaved bulk changes until explicit discard and never sends cancelled changes', async () => {
  const api = client([row('1', 'first'), row('2', 'second')], stopped);
  renderDialog(api);
  await userEvent.click(await screen.findByLabelText('Select first catalog'));
  await userEvent.click(screen.getByLabelText('Select second catalog'));
  const bar = screen.getByRole('group', { name: 'Selected catalogs' });
  await userEvent.click(within(bar).getByRole('button', { name: 'Configure' }));
  const bulk = screen.getByRole('dialog', { name: 'Edit selected update settings' });
  await userEvent.click(within(bulk).getByRole('button', { name: 'Images · On' }));
  await userEvent.click(screen.getByRole('option', { name: 'Off' }));
  await userEvent.click(within(bulk).getByRole('button', { name: 'Close' }));
  const prompt = screen.getByRole('dialog', { name: 'Discard changes?' });
  await userEvent.click(within(prompt).getByRole('button', { name: 'Keep editing' }));
  expect(screen.getByRole('dialog', { name: 'Edit selected update settings' })).toBe(bulk);
  await userEvent.click(within(bulk).getByRole('button', { name: 'Close' }));
  await userEvent.click(
    within(screen.getByRole('dialog', { name: 'Discard changes?' })).getByRole('button', {
      name: 'Discard changes'
    })
  );
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Edit selected update settings' })).toBeNull()
  );
  expect(api.patchCatalogUpdateProfile).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Select first catalog')).toBeTruthy();
});
it('explains that closing an unknown bulk result does not discard an accepted write', async () => {
  const api = client([row('1', 'first')], stopped, {
    patchCatalogUpdateProfile: vi.fn().mockRejectedValue(new TypeError('reply lost'))
  });
  renderDialog(api);
  await userEvent.click(await screen.findByLabelText('Select first catalog'));
  await userEvent.click(
    within(screen.getByRole('group', { name: 'Selected catalogs' })).getByRole('button', {
      name: 'Configure'
    })
  );
  const bulk = screen.getByRole('dialog', { name: 'Edit selected update settings' });
  await userEvent.click(within(bulk).getByRole('button', { name: 'Images · On' }));
  await userEvent.click(screen.getByRole('option', { name: 'Off' }));
  await userEvent.click(within(bulk).getByRole('button', { name: 'Save settings' }));
  await within(bulk).findByRole('button', { name: 'Check current settings' });
  await userEvent.click(within(bulk).getByRole('button', { name: 'Close' }));
  const prompt = screen.getByRole('dialog', { name: 'Result not confirmed' });
  expect(within(prompt).getByText(/Closing does not cancel it/)).toBeTruthy();
  expect(within(prompt).queryByRole('button', { name: 'Discard changes' })).toBeNull();
  await userEvent.click(within(prompt).getByRole('button', { name: 'Close' }));
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Edit selected update settings' })).toBeNull()
  );
  expect(api.patchCatalogUpdateProfile).toHaveBeenCalledTimes(1);
});
it('shows all five independent controls, with video first and IDs explained by the legend', async () => {
  renderDialog(client([row('1', 'polo.mp4')], stopped));
  const group = await screen.findByRole('toolbar', { name: 'What to update: polo.mp4 catalog' });
  expect(within(group).getAllByRole('button')).toHaveLength(5);
  expect(within(group).getAllByRole('button')[0]?.getAttribute('data-catalog-field')).toBe(
    'restitch'
  );
  await userEvent.click(screen.getByRole('button', { name: 'What do the icons mean?' }));
  const help = screen.getByRole('dialog', { name: 'What do the icons mean?' });
  const settingsLinks = within(help).getAllByRole('link', { name: 'space settings' });
  expect(settingsLinks).toHaveLength(3);
  expect(settingsLinks[0].getAttribute('href')).toContain('tab=restitch');
  expect(settingsLinks[1].getAttribute('href')).toContain('tab=product-catalog');
  expect(settingsLinks[2].getAttribute('href')).toContain('tab=product-catalog');
  expect(document.querySelector('.catalog-legend-strip')).toBeNull();
  fireEvent.keyDown(help, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'What do the icons mean?' })).toBeNull();
  expect(screen.getByRole('searchbox')).toBeTruthy();
});
it('closes on Escape from an empty search field', async () => {
  const { onClose } = renderDialog(client([row('1', 'polo.mp4')], stopped));
  const search = screen.getByRole('searchbox');
  await userEvent.type(search, 'abc');
  fireEvent.keyDown(search, { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.keyDown(search, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);
});
it('keeps each selection checkbox inside its own table cell', async () => {
  renderDialog(client([row('1', 'polo.mp4'), row('2', 'shirt.mp4')], stopped));
  const polo = await screen.findByLabelText('Select polo.mp4 catalog');
  const shirt = screen.getByLabelText('Select shirt.mp4 catalog');
  expect(polo.closest('td')).not.toBe(shirt.closest('td'));
  await userEvent.click(shirt);
  expect((polo as HTMLInputElement).checked).toBe(false);
  expect((shirt as HTMLInputElement).checked).toBe(true);
});
it('selects from empty row space without intercepting buttons or toggling twice from a checkbox', async () => {
  renderDialog(client([row('1', 'polo.mp4')], stopped));
  const checkbox = (await screen.findByLabelText('Select polo.mp4 catalog')) as HTMLInputElement;
  const tableRow = checkbox.closest('tr')!;
  const cells = within(tableRow).getAllByRole('cell');
  for (const cell of cells) {
    await userEvent.click(cell);
    expect(checkbox.checked).toBe(true);
    await userEvent.click(cell);
    expect(checkbox.checked).toBe(false);
  }
  await userEvent.click(checkbox);
  expect(checkbox.checked).toBe(true);
  await userEvent.click(checkbox);
  expect(checkbox.checked).toBe(false);
  await userEvent.click(screen.getByLabelText('polo.mp4 catalog'));
  expect(checkbox.checked).toBe(false);
});
it('shows per-catalog frequency, next run and confirmed success without hovering', async () => {
  const item = row('1', 'polo.mp4', {
    updateInterval: '6h',
    nextRunAt: '2026-11-20T10:00:00Z',
    lastUpdatedAt: '2026-10-17T10:00:00Z'
  });
  renderDialog(client([item], running));
  await screen.findByLabelText('polo.mp4 catalog');
  expect(screen.getByText('Every 6 h')).toBeTruthy();
  expect(screen.getByText(/20\/11/)).toBeTruthy();
  expect(
    screen.getByRole('button', { name: /^Last success: polo.mp4 catalog/ }).textContent
  ).toContain('17/10');
});
it('says the restitch round is waiting for the agent instead of a bare 0 of N', async () => {
  const item = row('1', 'polo.mp4', {
    videoGeneration: {
      setId: '23000000-0000-4000-8000-000000000777',
      requestedCount: 1,
      registeredCount: 0,
      state: 'accepted',
      waitReason: 'AGENT_REQUIRED'
    }
  });
  renderDialog(client([item], running));
  await screen.findByLabelText('polo.mp4 catalog');
  const status = screen.getByText(/Videos ready: 0 of 1/);
  expect(status.textContent).toContain('Waiting for the computer agent');
});
it('says background work stopped and resumes it from the row (1.4.3)', async () => {
  retryBackgroundRecovery.mockClear();
  const item = row('1', 'polo.mp4', {
    videoGeneration: {
      setId: '23000000-0000-4000-8000-000000000779',
      requestedCount: 1,
      registeredCount: 0,
      state: 'accepted',
      backgroundStalled: true
    }
  });
  renderDialog(client([item], running));
  await screen.findByLabelText('polo.mp4 catalog');
  const status = screen.getByText(/Videos ready: 0 of 1/);
  expect(status.textContent).toContain('Background work on this computer has stopped');
  await userEvent.click(within(status).getByRole('button', { name: 'Resume' }));
  await waitFor(() => expect(retryBackgroundRecovery).toHaveBeenCalledOnce());
  expect(retryBackgroundRecovery.mock.calls[0]![0]).toBeTruthy();
  await waitFor(() => expect(status.textContent).toContain('Resuming background work'));
});
it('points an unconfirmed restitch round at Stop instead of an endless wait', async () => {
  const item = row('1', 'polo.mp4', {
    videoGeneration: {
      setId: '23000000-0000-4000-8000-000000000778',
      requestedCount: 2,
      registeredCount: 0,
      state: 'unknown'
    }
  });
  renderDialog(client([item], running));
  await screen.findByLabelText('polo.mp4 catalog');
  const status = screen.getByText(/Videos ready: 0 of 2/);
  expect(status.textContent).toContain('stop this update if you do not want to wait');
  expect(status.textContent).not.toContain('Check the original operation');
});
it('keeps an older verified success when the latest attempt was partial', async () => {
  const item = row('1', 'polo.mp4', {
    lastUpdatedAt: '2026-10-18T10:00:00Z',
    profile: {
      ...profileFor(row('1', '').catalogId),
      lastSuccessfulAt: '2026-10-10T10:00:00Z',
      lastResult: 'partial'
    }
  });
  renderDialog(client([item], stopped));
  await screen.findByLabelText('polo.mp4 catalog');
  expect(
    screen.getByRole('button', { name: /^Last success: polo.mp4 catalog/ }).textContent
  ).toContain('10/10');
  expect(screen.getByRole('button', { name: 'Partially updated · details' })).toBeTruthy();
});
it('shows an overdue schedule as waiting rather than inventing another date', async () => {
  renderDialog(
    client(
      [row('1', 'polo.mp4', { updateInterval: '1d', nextRunAt: '2020-01-01T00:00:00Z' })],
      running
    )
  );
  expect(await screen.findByText('Waiting to start')).toBeTruthy();
});
describe('a registry with 500 catalogs', () => {
  beforeEach(async () => {
    const items = Array.from({ length: 500 }, (_, index) => row(String(index), `video-${index}`));
    renderDialog(client(items, stopped));
    await screen.findByLabelText('video-0 catalog');
  });

  it('searches all 500 catalogs while keeping the initial DOM bounded', async () => {
    // Count hidden rows too: hiding 500 mounted rows would not bound the DOM.
    expect(screen.getAllByRole('row', { hidden: true })).toHaveLength(61);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'video-499' } });
    expect(await screen.findByLabelText('video-499 catalog')).toBeTruthy();
    expect(screen.getAllByRole('row', { hidden: true })).toHaveLength(2);
  });
});
it('saves one toggle immediately for exactly one catalog', async () => {
  const api = client([row('1', 'polo.mp4'), row('2', 'shirt.mp4')], stopped);
  renderDialog(api);
  await userEvent.click(
    await screen.findByRole('button', { name: 'Replace video · Off: polo.mp4 catalog' })
  );
  await waitFor(() =>
    expect(api.patchCatalogUpdateProfile).toHaveBeenCalledWith(
      TEAM_ID,
      row('1', '').catalogId,
      1,
      {
        restitch: true
      },
      expect.objectContaining({ expectedActorId: '47000000-0000-4000-8000-000000000001' })
    )
  );
  expect(api.patchCatalogUpdateProfile).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'Save settings' })).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Replace video · Off: shirt.mp4 catalog' })
  ).toBeTruthy();
});
it('saves a precise catalog schedule only after explicit confirmation', async () => {
  const api = client([row('1', 'polo.mp4'), row('2', 'shirt.mp4')], stopped);
  renderDialog(api);
  await userEvent.click(
    await screen.findByRole('button', { name: 'How often polo.mp4 catalog updates: Off' })
  );
  await userEvent.click(screen.getByRole('button', { name: 'Every day' }));
  expect(api.patchCatalogUpdateProfile).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(api.patchCatalogUpdateProfile).toHaveBeenCalledWith(
      TEAM_ID,
      row('1', '').catalogId,
      1,
      {
        updateInterval: '1d',
        schedule: expect.objectContaining({
          time: expect.any(String),
          timeZone: expect.any(String),
          weekday: expect.any(Number)
        })
      },
      expect.objectContaining({ expectedActorId: '47000000-0000-4000-8000-000000000001' })
    )
  );
  expect(api.setCatalogUpdateInterval).not.toHaveBeenCalled();
});
it.each(['row', 'details'])(
  'keeps the typed schedule rejection visible in the %s picker',
  async surface => {
    const api = client([row('1', 'polo.mp4')], stopped, {
      patchCatalogUpdateProfile: vi
        .fn()
        .mockRejectedValue(new TeamApiError('PERMISSION_DENIED', false))
    });
    renderDialog(api);
    await screen.findByRole('button', { name: 'How often polo.mp4 catalog updates: Off' });
    if (surface === 'details') {
      fireEvent.click(screen.getByRole('button', { name: /^Actions (for|on) polo/ }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Configure' }));
    }
    const container = screen.getAllByRole('dialog').at(-1)!;
    fireEvent.click(
      within(container).getByRole('button', { name: 'How often polo.mp4 catalog updates: Off' })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.queryByText('Something went wrong. Try again in a moment.')).toBeNull()
    );
    expect(await screen.findAllByText('You do not have permission for this.')).toHaveLength(
      surface === 'details' ? 3 : 2
    );
    expect(api.patchCatalogUpdateProfile).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
  }
);
it('shows the saved schedule forecast immediately while the registry refresh is delayed', async () => {
  const item = row('1', 'polo.mp4', {
    updateInterval: '1w',
    nextRunAt: '2026-10-26T07:00:00Z',
    profile: {
      ...profileFor(row('1', '').catalogId),
      schedule: { timeZone: 'Europe/Kyiv', weekday: 1, time: '09:00' }
    }
  });
  const api = client([item], stopped);
  (api.listTeamProductCatalogs as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce([item])
    .mockImplementation(() => new Promise(() => {}));
  renderDialog(api);
  await userEvent.click(
    await screen.findByRole('button', { name: /How often polo.mp4 catalog updates: Every week/ })
  );
  fireEvent.change(screen.getByLabelText('Time'), { target: { value: '18:00' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).toBeNull());
  const trigger = screen.getByRole('button', {
    name: /How often polo.mp4 catalog updates: Every week/
  });
  expect(trigger.textContent).not.toContain('Next: unknown');
  expect(trigger.querySelector('small')?.textContent).toBeTruthy();
  expect(trigger.querySelector('small')?.textContent).not.toBe('Next: unknown');
  expect(api.patchCatalogUpdateProfile).toHaveBeenCalledTimes(1);
});
it('validates custom hours before the explicit numeric application', async () => {
  const api = client([row('1', 'polo.mp4')], stopped);
  renderDialog(api);
  await userEvent.click(
    await screen.findByRole('button', { name: 'How often polo.mp4 catalog updates: Off' })
  );
  await userEvent.click(screen.getByRole('button', { name: 'Custom' }));
  const hours = screen.getByLabelText('Hours between updates');
  await userEvent.clear(hours);
  await userEvent.type(hours, '999');
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  expect(api.patchCatalogUpdateProfile).not.toHaveBeenCalled();
  await userEvent.clear(hours);
  await userEvent.type(hours, '36');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(api.patchCatalogUpdateProfile).toHaveBeenCalledWith(
      TEAM_ID,
      row('1', '').catalogId,
      1,
      {
        updateInterval: '36h',
        schedule: null
      },
      expect.objectContaining({ expectedActorId: '47000000-0000-4000-8000-000000000001' })
    )
  );
});
it('updates a catalog now without changing its schedule', async () => {
  const api = client([row('1', 'polo.mp4', { updateInterval: '1d' })], running);
  renderDialog(api);
  await userEvent.click(await screen.findByRole('button', { name: 'Update polo.mp4 catalog now' }));
  expect(api.runCatalogUpdateNow).toHaveBeenCalledWith(TEAM_ID, [row('1', '').catalogId]);
  expect(api.patchCatalogUpdateProfile).not.toHaveBeenCalled();
});
it('waits for settings confirmation before permitting manual run', async () => {
  let resolve!: (profile: ReturnType<typeof profileFor>) => void;
  const item = row('1', 'polo.mp4');
  const api = client([item], stopped, {
    patchCatalogUpdateProfile: vi.fn(
      () =>
        new Promise<ReturnType<typeof profileFor>>(done => {
          resolve = done;
        })
    )
  });
  renderDialog(api);
  await userEvent.click(
    await screen.findByRole('button', { name: 'Replace video · Off: polo.mp4 catalog' })
  );
  expect(
    (screen.getByRole('button', { name: 'Update polo.mp4 catalog now' }) as HTMLButtonElement)
      .disabled
  ).toBe(true);
  resolve({ ...profileFor(item.catalogId), restitch: true, version: 2 });
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Update polo.mp4 catalog now' }) as HTMLButtonElement)
        .disabled
    ).toBe(false)
  );
});
it('starts manual preparation immediately when the requested video is not ready', async () => {
  const item = row('1', 'polo.mp4', {
    profile: { ...profileFor(row('1', '').catalogId), restitch: true, restitchStatus: 'waiting' }
  });
  const api = client([item], stopped);
  renderDialog(api);
  await userEvent.click(await screen.findByRole('button', { name: 'Update polo.mp4 catalog now' }));
  await waitFor(() => expect(api.runCatalogUpdateNow).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('button', { name: 'Update with current settings' })).toBeNull();
});
it.each([
  ['waiting', null, 'Waiting for video preparation…'],
  ['preparing', 'PROCESS_FAILED', 'Preparing replacement video…'],
  ['blocked', 'PROCESS_FAILED', 'Video preparation failed · details']
] as const)(
  'distinguishes pending video %s from an active preparation',
  async (status, code, label) => {
    const item = row('1', 'polo.mp4', {
      updatePending: true,
      profile: {
        ...profileFor(row('1', '').catalogId),
        restitch: true,
        restitchStatus: status,
        restitchBlockedCode: code
      }
    });
    renderDialog(client([item], running));
    const identity = await screen.findByLabelText('polo.mp4 catalog');
    const tableRow = identity.closest('tr')!;
    expect(within(tableRow).getByText(label)).toBeTruthy();
    expect(within(tableRow).queryByText('Updating…')).toBeNull();
    if (status === 'blocked') {
      expect(within(tableRow).queryByText('Preparing replacement video…')).toBeNull();
      await userEvent.click(within(tableRow).getByRole('button', { name: label }));
      expect(
        await screen.findByText(/This file could not be processed on this computer/)
      ).toBeTruthy();
    }
  }
);
it('shows the round stitching instead of the profile still waiting for video', async () => {
  // QA round 5: during the stitch the row said «Очікуємо підготовку відео…»
  // because it read the profile, which lags the running round.
  const item = row('1', 'polo.mp4', {
    updatePending: true,
    updateStage: 'restitching',
    activeRoundAt: '2026-11-05T10:00:00Z',
    activeAttemptId: '47000000-0000-4000-8000-000000000099',
    profile: { ...profileFor(row('1', '').catalogId), restitch: true, restitchStatus: 'waiting' }
  });
  renderDialog(client([item], running));
  const identity = await screen.findByLabelText('polo.mp4 catalog');
  const tableRow = identity.closest('tr')!;
  expect(within(tableRow).getAllByText('Preparing replacement video…').length).toBeGreaterThan(0);
  expect(within(tableRow).queryByText('Waiting for video preparation…')).toBeNull();
  // QA round 6: the stage was only announced (sr-only); it is shown in the row now.
  const feedback = tableRow.querySelector('.catalog-row-feedback')!;
  expect(feedback.classList.contains('sr-only')).toBe(false);
  expect(feedback.textContent).toBe('Preparing replacement video…');
});
it('keeps a frozen video failure visible after restitch is disabled for future runs', async () => {
  const item = row('1', 'polo.mp4', {
    updatePending: true,
    updateStage: 'waiting_video',
    profile: {
      ...profileFor(row('1', '').catalogId),
      restitch: false,
      restitchStatus: 'blocked',
      restitchBlockedCode: 'PROCESS_RESULT_UNCERTAIN'
    }
  });
  renderDialog(client([item], running));
  const identity = await screen.findByLabelText('polo.mp4 catalog');
  const tableRow = identity.closest('tr')!;
  const details = within(tableRow).getByRole('button', {
    name: 'Video preparation failed · details'
  });
  expect(within(tableRow).queryByText('Updating…')).toBeNull();
  await userEvent.click(details);
  expect(
    await screen.findByText(
      /Before retrying|before retrying|could not confirm|could not be confirmed/i
    )
  ).toBeTruthy();
});
it('does not label an active sheet write as waiting for next-run video', async () => {
  const item = row('1', 'polo.mp4', {
    updatePending: true,
    updateStage: 'building',
    profile: {
      ...profileFor(row('1', '').catalogId),
      restitch: true,
      restitchStatus: 'blocked',
      restitchBlockedCode: 'PROCESS_FAILED'
    }
  });
  renderDialog(client([item], running));
  const identity = await screen.findByLabelText('polo.mp4 catalog');
  const tableRow = identity.closest('tr')!;
  // The row names the round's real stage, not a generic «Updating…» (QA round 5).
  expect(
    within(tableRow).getAllByText('Building the updated product sheet…').length
  ).toBeGreaterThan(0);
  expect(within(tableRow).queryByText('Waiting for video preparation…')).toBeNull();
  expect(
    within(tableRow).queryByRole('button', { name: 'Video preparation failed · details' })
  ).toBeNull();
});
it('separates failed next-video preparation from the confirmed successful update', async () => {
  const item = row('1', 'polo.mp4', {
    lastUpdatedAt: '2026-10-18T18:51:05.535Z',
    updateCount: 1,
    profile: {
      ...profileFor(row('1', '').catalogId),
      restitch: true,
      restitchStatus: 'blocked',
      restitchBlockedCode: 'PROCESS_FAILED',
      lastResult: 'success',
      lastSuccessfulAt: '2026-10-18T18:51:05.535Z'
    }
  });
  renderDialog(client([item], running));
  const identity = await screen.findByLabelText('polo.mp4 catalog');
  const tableRow = identity.closest('tr')!;
  expect(
    within(tableRow).getByRole('button', { name: 'Next video preparation failed · details' })
  ).toBeTruthy();
  expect(within(tableRow).queryByText('Video preparation failed · details')).toBeNull();
  expect(within(tableRow).queryByText('Update failed · open details')).toBeNull();
  expect(
    within(tableRow).getByRole('button', { name: /Last success: polo.mp4 catalog/ })
  ).toBeTruthy();
  expect(
    within(tableRow).getByRole('button', { name: 'Update polo.mp4 catalog now' })
  ).toHaveProperty('disabled', false);
});
it('shows one reconciliation status instead of running and stacked errors', async () => {
  const item = row('1', 'polo.mp4', {
    updatePending: true,
    lastUpdateError: 'DELIVERY_UNAVAILABLE',
    profile: {
      ...profileFor(row('1', '').catalogId),
      reconciliationRequired: true,
      lastResult: 'running'
    }
  });
  renderDialog(client([item], running));
  const identity = await screen.findByLabelText('polo.mp4 catalog');
  const tableRow = identity.closest('tr')!;
  expect(tableRow.getAttribute('aria-busy')).toBe('true');
  expect(tableRow.style.getPropertyValue('--catalog-row-progress')).toBe('0.94');
  expect(tableRow.getAttribute('data-tip')).toBe('Checking the sheet on Google Drive…');
  expect(within(tableRow).queryByText('Updating…')).toBeNull();
  expect(within(tableRow).queryByText('Unknown result')).toBeNull();
  expect(
    within(tableRow).queryByRole('button', { name: 'Checking Drive confirmation… · details' })
  ).toBeNull();
  expect(screen.queryByRole('button', { name: /Needs attention/ })).toBeNull();
  expect(within(tableRow).queryByRole('button', { name: 'Cancel this update' })).toBeNull();
});
it('refuses a legacy Stop without an observed round and leaves the schedule unchanged', async () => {
  const api = client(
    [row('1', 'polo.mp4', { updatePending: true, updateInterval: '1d' })],
    running
  );
  renderDialog(api);
  await userEvent.click(await screen.findByRole('button', { name: 'Stop this update' }));
  expect(api.cancelCatalogUpdate).not.toHaveBeenCalled();
  expect(
    await screen.findByText(
      'The current attempt has not been verified. Refresh the catalog list before stopping this update.'
    )
  ).toBeTruthy();
  expect(api.patchCatalogUpdateProfile).not.toHaveBeenCalled();
});
it('binds stop to the observed updater round on a modern snapshot', async () => {
  const activeRoundAt = '2026-11-05T10:00:00Z';
  const api = client(
    [
      row('1', 'polo.mp4', {
        updatePending: true,
        activeRoundAt,
        activeAttemptId: 'observed-attempt'
      })
    ],
    running
  );
  renderDialog(api);
  await userEvent.click(await screen.findByRole('button', { name: 'Stop this update' }));
  expect(api.cancelCatalogUpdate).toHaveBeenCalledWith(
    TEAM_ID,
    row('1', '').catalogId,
    {
      roundAt: activeRoundAt,
      attemptId: 'observed-attempt'
    },
    expect.objectContaining({
      expectedActorId: '47000000-0000-4000-8000-000000000001',
      signal: expect.any(AbortSignal)
    })
  );
});
it('explains a stop that arrived after the run had already ended without changing its schedule', async () => {
  const api = client(
    [
      row('1', 'polo.mp4', {
        updatePending: true,
        updateInterval: '1d',
        activeRoundAt: '2026-11-05T10:00:00Z',
        activeAttemptId: null
      })
    ],
    running,
    { cancelCatalogUpdate: vi.fn().mockResolvedValue(false) }
  );
  vi.mocked(api.cancelCatalogUpdate!).mockImplementation(async () => {
    vi.mocked(api.listTeamProductCatalogs).mockResolvedValue([
      row('1', 'polo.mp4', { updateInterval: '1d', activeRoundAt: null, activeAttemptId: null })
    ]);
    return false;
  });
  renderDialog(api);
  await userEvent.click(await screen.findByRole('button', { name: 'Stop this update' }));
  expect(await screen.findByText('The observed update is no longer active.')).toBeTruthy();
  expect(api.patchCatalogUpdateProfile).not.toHaveBeenCalled();
  expect(api.setCatalogUpdateInterval).not.toHaveBeenCalled();
});
it('drops the stop tooltip with the stop button once the run has ended (1.4.3)', async () => {
  const api = client(
    [
      row('1', 'polo.mp4', {
        updatePending: true,
        activeRoundAt: '2026-11-05T10:00:00Z',
        activeAttemptId: null
      })
    ],
    running,
    { cancelCatalogUpdate: vi.fn().mockResolvedValue(true) }
  );
  vi.mocked(api.cancelCatalogUpdate!).mockImplementation(async () => {
    vi.mocked(api.listTeamProductCatalogs).mockResolvedValue([
      row('1', 'polo.mp4', { activeRoundAt: null, activeAttemptId: null })
    ]);
    return true;
  });
  renderDialog(api);
  const stop = await screen.findByRole('button', { name: 'Stop this update' });
  await userEvent.click(stop);
  const run = await screen.findByRole('button', { name: 'Update polo.mp4 catalog now' });
  // A native tooltip already on screen keeps its text while the pointer stays: the run button is
  // a new element, so the browser cannot go on showing "Stop this update" over it.
  expect(run).not.toBe(stop);
  expect(stop.isConnected).toBe(false);
  expect(run.getAttribute('title')).toBe('Update polo.mp4 catalog now');
});
it('shows the server refusal from a manual run', async () => {
  const api = client([row('1', 'polo.mp4')], stopped, {
    runCatalogUpdateNow: vi.fn().mockRejectedValue(new TeamApiError('PERMISSION_DENIED', false))
  });
  renderDialog(api);
  await userEvent.click(await screen.findByRole('button', { name: 'Update polo.mp4 catalog now' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
});
it('offers history and live settings inside the catalog overflow', async () => {
  const api = client([row('1', 'polo.mp4')], stopped, {
    listCatalogUpdateAttempts: vi.fn().mockResolvedValue([])
  });
  renderDialog(api);
  await userEvent.click(await screen.findByRole('button', { name: /^Actions (for|on) polo/ }));
  expect(screen.getByRole('menuitem', { name: 'Configure' })).toBeTruthy();
  await userEvent.click(screen.getByRole('menuitem', { name: 'Update history' }));
  expect(api.listCatalogUpdateAttempts).toHaveBeenCalledWith(TEAM_ID, row('1', '').catalogId, {
    signal: expect.any(AbortSignal)
  });
});
it('opens the same live toggles in details without a separate Save form', async () => {
  const api = client([row('1', 'polo.mp4')], stopped);
  renderDialog(api);
  await userEvent.click(await screen.findByRole('button', { name: /^Actions (for|on) polo/ }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Configure' }));
  const dialogs = screen.getAllByRole('dialog');
  const detail = dialogs.at(-1)!;
  await userEvent.click(
    within(detail).getByRole('button', { name: 'Replace video · Off: polo.mp4 catalog' })
  );
  await waitFor(() => expect(api.patchCatalogUpdateProfile).toHaveBeenCalledTimes(1));
  expect(within(detail).queryByRole('button', { name: 'Save settings' })).toBeNull();
});
it('exposes safe undo after a confirmed write', async () => {
  renderDialog(client([row('1', 'polo.mp4')], stopped));
  await userEvent.click(
    await screen.findByRole('button', { name: 'Replace video · Off: polo.mp4 catalog' })
  );
  expect(await screen.findByRole('button', { name: 'Undo change' })).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Recent changes (1)' }));
  expect(screen.getByRole('heading', { name: 'Recent changes' })).toBeTruthy();
});
it('renders numeric variation changes in recent changes and undoes the original count', async () => {
  vi.stubEnv('VITE_APP_ENVIRONMENT', 'beta');
  try {
    const item = row('1', 'polo.mp4');
    let stored: CatalogUpdateProfile = { ...profileFor(item.catalogId), videoVariantCount: 1 };
    const api = client([item], stopped, {
      listCatalogUpdateProfiles: vi.fn(async () => [stored]),
      patchCatalogUpdateProfile: vi.fn(async (_team, _id, version, patch) => {
        if (version !== stored.version) throw new TeamApiError('STALE_RESULT', false);
        stored = { ...stored, ...patch, version: version + 1 };
        return stored;
      })
    });
    renderDialog(api);
    await userEvent.click(await screen.findByRole('button', { name: /^Actions (for|on) polo/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Configure' }));
    const detail = screen.getAllByRole('dialog').at(-1)!;
    fireEvent.change(within(detail).getByRole('textbox', { name: 'Video variations' }), {
      target: { value: '3' }
    });
    await userEvent.click(within(detail).getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(stored.videoVariantCount).toBe(3));
    await waitFor(() =>
      expect(within(detail).queryByRole('button', { name: 'Save settings' })).toBeNull()
    );
    await userEvent.click(within(detail).getByRole('button', { name: 'Close' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Recent changes (1)' }));
    const recent = screen.getAllByRole('dialog').at(-1)!;
    expect(within(recent).getByText('Video variations: 3')).toBeTruthy();
    await userEvent.click(within(recent).getByRole('button', { name: 'Undo change' }));
    await waitFor(() => expect(stored.videoVariantCount).toBe(1));
  } finally {
    vi.unstubAllEnvs();
  }
});
it('closes an emptied recent-changes dialog after undo and restores focus to the affected catalog field', async () => {
  const item = row('1', 'polo.mp4');
  let stored: CatalogUpdateProfile = profileFor(item.catalogId);
  const api = client([item], stopped, {
    listCatalogUpdateProfiles: vi.fn(async () => [stored]),
    patchCatalogUpdateProfile: vi.fn(async (_team, _id, version, patch) => {
      if (version !== stored.version) throw new TeamApiError('STALE_RESULT', false);
      stored = { ...stored, ...patch, version: version + 1 };
      return stored;
    })
  });
  renderDialog(api);
  await userEvent.click(
    await screen.findByRole('button', { name: 'Replace video · Off: polo.mp4 catalog' })
  );
  await userEvent.click(await screen.findByRole('button', { name: 'Recent changes (1)' }));
  const recent = screen.getAllByRole('dialog').at(-1)!;
  await userEvent.click(within(recent).getByRole('button', { name: 'Undo change' }));
  await waitFor(
    () => expect(screen.queryByRole('heading', { name: 'Recent changes' })).toBeNull(),
    { timeout: 1000 }
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Replace video · Off: polo.mp4 catalog' })
    )
  );
  expect(stored).toMatchObject({ version: 3, restitch: false });
});
it('shows explicit bulk video and schedule choices only after selecting catalogs', async () => {
  renderDialog(client([row('1', 'polo.mp4'), row('2', 'shirt.mp4')], stopped));
  await userEvent.click(await screen.findByLabelText('Select polo.mp4 catalog'));
  await userEvent.click(screen.getByLabelText('Select shirt.mp4 catalog'));
  const bar = screen.getByRole('group', { name: 'Selected catalogs' });
  expect(within(bar).getByRole('button', { name: 'Auto update' })).toBeTruthy();
  await userEvent.click(within(bar).getByRole('button', { name: 'Replace video' }));
  expect(
    within(screen.getAllByRole('dialog').at(-1)!).getByRole('button', {
      name: /Replace video · Off/
    })
  ).toBeTruthy();
});
it('keeps viewers read only while showing every existing value', async () => {
  renderDialog(client([row('1', 'polo.mp4', { updateInterval: '1d' })], running), viewing);
  const group = await screen.findByRole('toolbar', { name: 'What to update: polo.mp4 catalog' });
  for (const button of within(group).getAllByRole('button'))
    expect(button.getAttribute('aria-disabled')).toBe('true');
  expect(screen.queryByRole('button', { name: 'Update polo.mp4 catalog now' })).toBeNull();
});
it('closes from the header', async () => {
  const { onClose } = renderDialog(client([], stopped));
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledTimes(1);
});
it('matches catalog and video names independent of case', () => {
  const items = [row('1', 'Polo.mp4'), row('2', 'Shirt.mp4', { name: 'EG 75_v1_catalog' })];
  expect(filterCatalogRows(items, ' polo ')).toEqual([items[0]]);
  expect(filterCatalogRows(items, 'eg 75')).toEqual([items[1]]);
});
it('keeps recovery and close accessible inside details after an unknown save', async () => {
  const item = row('1', 'polo.mp4');
  const readProfiles = vi
    .fn()
    .mockResolvedValueOnce([profileFor(item.catalogId)])
    .mockRejectedValue(new TypeError('offline'));
  const api = client([item], stopped, {
    listCatalogUpdateProfiles: readProfiles,
    patchCatalogUpdateProfile: vi.fn().mockRejectedValue(new TypeError('offline'))
  });
  renderDialog(api);
  await userEvent.click(await screen.findByRole('button', { name: /^Actions (for|on) polo/ }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Configure' }));
  const detail = screen.getAllByRole('dialog').at(-1)!;
  await userEvent.click(
    within(detail).getByRole('button', { name: 'Replace video · Off: polo.mp4 catalog' })
  );
  expect(
    await within(detail).findByRole('button', { name: 'Check current settings' })
  ).toBeTruthy();
  const close = within(detail).getByRole('button', { name: 'Close' });
  expect((close as HTMLButtonElement).disabled).toBe(false);
  await userEvent.click(close);
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
});
it('explains excluded selected catalogs and runs the available ones', async () => {
  const available = row('1', 'polo.mp4');
  const blocked = row('2', 'shirt.mp4', {
    profile: { ...profileFor(row('2', '').catalogId), reconciliationRequired: true }
  });
  const api = client([available, blocked], stopped);
  renderDialog(api);
  await userEvent.click(await screen.findByLabelText('Select polo.mp4 catalog'));
  await userEvent.click(screen.getByLabelText('Select shirt.mp4 catalog'));
  await userEvent.click(
    within(screen.getByRole('group', { name: 'Selected catalogs' })).getByRole('button', {
      name: 'Update now'
    })
  );
  expect(api.runCatalogUpdateNow).not.toHaveBeenCalled();
  const prompt = screen.getAllByRole('dialog').at(-1)!;
  expect(within(prompt).getByText(/shirt.mp4 catalog:/)).toBeTruthy();
  await userEvent.click(within(prompt).getByRole('button', { name: 'Run available catalogs' }));
  await waitFor(() =>
    expect(api.runCatalogUpdateNow).toHaveBeenCalledWith(TEAM_ID, [available.catalogId])
  );
});
it('keeps focus on the saved toggle and only offers recency and sorting filters', async () => {
  const items = ['first', 'second', 'third'].map((name, index) =>
    row(String(index), name, {
      profile: {
        ...profileFor(row(String(index), '').catalogId),
        restitch: true,
        restitchStatus: 'ready'
      }
    })
  );
  const patch = vi.fn().mockImplementation(async (_team, id, _version, change) => ({
    ...profileFor(id),
    restitch: false,
    ...change,
    version: 2
  }));
  renderDialog(client(items, stopped, { patchCatalogUpdateProfile: patch }));
  await screen.findByLabelText('second catalog');
  await userEvent.click(screen.getByRole('button', { name: 'Filters' }));
  expect(screen.queryByRole('button', { name: 'Update includes' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Frequency' })).toBeNull();
  const toggle = screen.getByRole('button', {
    name: 'Replace video · On · Video ready for the next update: second catalog'
  });
  await userEvent.click(toggle);
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(document.activeElement?.getAttribute('aria-label')).toBe(
      'Replace video · Off: second catalog'
    )
  );
  expect(screen.getByLabelText('second catalog')).toBeTruthy();
});

it('keeps a genuinely unresolved write distinct from normal confirmation progress', async () => {
  const item = row('1', 'polo.mp4', {
    updatePending: true,
    profile: {
      ...profileFor(row('1', '').catalogId),
      reconciliationRequired: true,
      lastResult: 'unknown'
    }
  });
  renderDialog(client([item], running));
  const tableRow = (await screen.findByLabelText('polo.mp4 catalog')).closest('tr')!;
  const result = within(tableRow).getByRole('button', {
    name: 'Result not yet confirmed · details'
  });
  expect(result.className).not.toContain('catalog-verifying-details');
  expect(result.title).toContain('We are checking what was saved automatically');
  expect(screen.getByRole('button', { name: /Needs attention/ })).toBeTruthy();
});

it('shows catalog creation dates and filters inclusively by creation instead of last update', async () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const monthName = new Intl.DateTimeFormat('en-US', { month: 'long' }).format(now);
  const old = row('1', 'old.mp4', {
    createdAt: `${year}-${month}-15T10:00:00Z`,
    lastUpdatedAt: '2026-10-19T10:00:00Z'
  });
  const recent = row('2', 'new.mp4', {
    createdAt: `${year}-${month}-16T10:00:00Z`,
    lastUpdatedAt: '2026-09-01T10:00:00Z'
  });
  renderDialog(client([old, recent], stopped));
  const oldRow = (await screen.findByLabelText('old.mp4 catalog')).closest('tr')!;
  expect(oldRow.querySelector('time')?.getAttribute('datetime')).toBe(old.createdAt);
  expect(oldRow.querySelector('time')?.textContent).toBe(`15/${month}/${year}`);
  await userEvent.click(screen.getByRole('button', { name: 'Creation date' }));
  await userEvent.click(
    screen.getByRole('button', { name: new RegExp(`${monthName} 14, ${year}`) })
  );
  await userEvent.click(
    screen.getByRole('button', { name: new RegExp(`${monthName} 15, ${year}`) })
  );
  expect(screen.queryByLabelText('new.mp4 catalog')).toBeNull();
  expect(screen.getByLabelText('old.mp4 catalog')).toBeTruthy();
  await userEvent.click(screen.getAllByRole('button', { name: 'Clear creation dates' })[0]);
  expect(screen.getByLabelText('new.mp4 catalog')).toBeTruthy();
});
it('keeps save feedback beside the name and reserves action/footer slots through consecutive writes', async () => {
  let finish!: (value: CatalogUpdateProfile) => void;
  const api = client([row('1', 'polo.mp4')], stopped, {
    patchCatalogUpdateProfile: vi.fn(
      () =>
        new Promise<CatalogUpdateProfile>(resolve => {
          finish = resolve;
        })
    )
  });
  renderDialog(api);
  const identity = await screen.findByRole('button', { name: 'polo.mp4 catalog' });
  const tableRow = identity.closest('tr')!;
  const indicator = tableRow.querySelector('.catalog-save-indicator')!;
  const footer = document.querySelector('.catalog-undo-notice');
  const recent = screen.getByRole('button', { name: /Recent changes/ });
  const run = screen.getByRole('button', { name: 'Update polo.mp4 catalog now' });
  await userEvent.click(
    within(tableRow).getByRole('button', { name: 'Replace video · Off: polo.mp4 catalog' })
  );
  expect(indicator.getAttribute('data-phase')).toBe('pending');
  expect(tableRow.querySelector('.catalog-row-feedback')?.textContent).toBe('');
  expect(run.getAttribute('data-setting-save')).toBe('true');
  expect((run as HTMLButtonElement).disabled).toBe(true);
  await act(async () => {
    finish({ ...profileFor(row('1', '').catalogId), restitch: true, version: 2 });
  });
  await waitFor(() => expect(indicator.getAttribute('data-phase')).toBe('saved'));
  expect(tableRow.querySelector('.catalog-save-indicator')).toBe(indicator);
  expect(document.querySelector('.catalog-undo-notice')).toBe(footer);
  expect(screen.getByRole('button', { name: /Recent changes/ })).toBe(recent);
  const undo = screen.getByRole('button', { name: 'Undo change' });
  await userEvent.click(
    within(tableRow).getByRole('button', { name: 'Images · On: polo.mp4 catalog' })
  );
  expect(undo.getAttribute('data-setting-save')).toBe('true');
  expect(tableRow.querySelector('.catalog-row-feedback')?.textContent).toBe('');
  await act(async () => {
    finish({
      ...profileFor(row('1', '').catalogId),
      restitch: true,
      refreshImages: false,
      version: 3
    });
  });
  await waitFor(() => expect(indicator.getAttribute('data-phase')).toBe('saved'));
});

it('keeps valid catalogs visible and explains partial reads without pretending the list is empty', async () => {
  const item = row('1', 'polo.mp4');
  const api = client([item], stopped, {
    listTeamProductCatalogSnapshot: vi.fn().mockResolvedValue({ rows: [item], invalidRowCount: 2 })
  });
  renderDialog(api);
  expect(await screen.findByText(/Some catalog data could not be read/)).toBeTruthy();
  expect(await screen.findByLabelText('Select polo.mp4 catalog')).toBeTruthy();
  expect(screen.queryByText(/No catalogs yet/)).toBeNull();
});

it('refreshes partial trash results and keeps failed and unstarted catalogs selected', async () => {
  const { teamApi } = await import('../apps/web/src/api/team');
  const catalogs = [row('1', 'first.mp4'), row('2', 'second.mp4'), row('3', 'third.mp4')];
  const trash = vi
    .spyOn(teamApi, 'trashMaterial')
    .mockResolvedValueOnce({
      operationId: 'trash-first',
      state: 'succeeded',
      materialId: catalogs[0].catalogId,
      reused: false
    })
    .mockRejectedValueOnce(new TypeError('lost response'));
  const api = client(catalogs, stopped);
  renderDialog(api);
  for (const name of ['first', 'second', 'third']) {
    await userEvent.click(await screen.findByLabelText(`Select ${name}.mp4 catalog`));
  }
  await userEvent.click(screen.getByRole('button', { name: 'Catalog manager actions' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Delete selected' }));
  const confirmation = screen.getAllByRole('dialog').at(-1)!;
  const readsBefore = vi.mocked(api.listTeamProductCatalogs).mock.calls.length;
  await userEvent.click(within(confirmation).getByRole('button', { name: 'Delete selected' }));
  await waitFor(() => expect(trash).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(api.listTeamProductCatalogs).toHaveBeenCalledTimes(readsBefore + 1));
  expect((screen.getByLabelText('Select first.mp4 catalog') as HTMLInputElement).checked).toBe(
    false
  );
  expect((screen.getByLabelText('Select second.mp4 catalog') as HTMLInputElement).checked).toBe(
    true
  );
  expect((screen.getByLabelText('Select third.mp4 catalog') as HTMLInputElement).checked).toBe(
    true
  );
});

it('rediscovers an unfinished hosted catalog batch after reopening without unrelated file batches', async () => {
  const item = row('1', 'polo.mp4');
  const group = {
    id: '47000000-0000-4000-8000-000000000099',
    teamId: TEAM_ID,
    actorId: '47000000-0000-4000-8000-000000000001',
    items: [
      {
        materialId: item.catalogId,
        idempotencyKey: 'catalog-key',
        state: 'unknown' as const,
        errorCode: null
      }
    ]
  };
  hostedWorkspace.value = {
    groups: [],
    startUploadGroup: vi.fn(),
    retryUploadGroup: vi.fn(),
    cancelGroup: vi.fn(),
    bulkTrash: {
      groups: [
        group,
        { ...group, id: 'other-group', items: [{ ...group.items[0]!, materialId: 'other-file' }] }
      ],
      uncertain: true,
      historicalReceipts: new Map(),
      start: vi.fn(),
      retry: vi.fn(),
      refresh: vi.fn(),
      dismiss: vi.fn(),
      acknowledgeVisible: vi.fn(),
      owns: () => true,
      executing: new Set<string>(),
      names: new Map<string, string>(),
      claim: vi.fn(() => () => {}),
      claimed: new Set<string>()
    }
  };
  renderDialog(client([item], stopped));
  await screen.findByLabelText('polo.mp4 catalog');
  expect(screen.getByText('Move files to trash')).toBeTruthy();
  expect(screen.getAllByText('Move files to trash')).toHaveLength(1);
  // One panel, in the corner stack above the dialog, and the Files corner is told to leave it.
  expect(screen.getByText('Move files to trash').closest('.team-updater-dialog')).toBeNull();
  expect(screen.getByText('Move files to trash').closest('.team-process-stack')).toBeTruthy();
  expect(hostedWorkspace.value?.bulkTrash?.claim).toHaveBeenCalledWith([group.id]);
  expect(screen.getAllByText('Awaiting confirmation').length).toBeGreaterThan(0);
  expect(hostedWorkspace.value?.bulkTrash?.start).not.toHaveBeenCalled();
});

it.each([
  { actor: 'new-actor', access: 'same-space-access' },
  { actor: null, access: 'changed-permissions' }
])(
  'clears manager state and suppresses a late command after private scope changes: %j',
  async ({ actor, access }) => {
    let finish!: (count: number) => void;
    const run = vi.fn(
      () =>
        new Promise<number>(resolve => {
          finish = resolve;
        })
    );
    const api = client([row('1', 'polo.mp4')], stopped, { runCatalogUpdateNow: run });
    const { onChanged } = renderDialog(api);
    const selected = await screen.findByLabelText('Select polo.mp4 catalog');
    await userEvent.click(selected);
    await userEvent.type(screen.getByRole('searchbox'), 'polo');
    await userEvent.click(screen.getByRole('button', { name: 'Update polo.mp4 catalog now' }));
    expect(run).toHaveBeenCalledTimes(1);
    await act(async () => {
      setPrivateCacheScope(actor, access);
    });
    await waitFor(() => expect(screen.getByRole('searchbox')).toHaveProperty('value', ''));
    expect(await screen.findByLabelText('Select polo.mp4 catalog')).toHaveProperty(
      'checked',
      false
    );
    await act(async () => {
      finish(1);
    });
    expect(onChanged).not.toHaveBeenCalled();
  }
);

it('keeps an unconfirmed command distinct from a new launch and explains its last known cause', async () => {
  const item = row('1', 'polo.mp4');
  let intent!: import('@video-compressor/shared').CatalogCommandRequest;
  const request = vi.fn(async (_team: string, _actor: string, value: typeof intent) => {
    intent = value;
    throw new TeamApiError('DRIVE_UNAVAILABLE', true);
  });
  const read = vi
    .fn()
    .mockResolvedValueOnce(null)
    .mockImplementation(async () => ({
      commandId: intent.commandId,
      kind: 'run',
      status: 'accepted',
      sourceAttemptId: null,
      requestedCount: 1,
      acceptedCount: 1,
      items: [
        {
          catalogId: item.catalogId,
          accepted: true,
          attemptId: '47000000-0000-4000-8000-000000000009',
          reason: 'accepted'
        }
      ]
    }));
  const api = client([item], stopped, {
    requestCatalogUpdateCommand: request,
    getCatalogUpdateCommand: read
  });
  renderDialog(api);
  await userEvent.click(await screen.findByRole('button', { name: 'Update polo.mp4 catalog now' }));
  const notice = await screen.findByText(
    /The result of the request for 1 catalogs is not confirmed/
  );
  expect(notice.textContent).toContain(item.name);
  const panel = notice.closest<HTMLElement>('[role="status"]')!;
  expect(within(panel).getByText(/Last observed problem:/)).toBeTruthy();
  expect(
    within(panel).getByRole('button', { name: 'Check status' }).getAttribute('aria-describedby')
  ).toBe(notice.id);
  await userEvent.click(within(panel).getByRole('button', { name: 'Check status' }));
  expect(await screen.findByText(/Previous request confirmed. Accepted updates: 1/)).toBeTruthy();
  expect(request).toHaveBeenCalledTimes(1);
  expect(api.runCatalogUpdateNow).not.toHaveBeenCalled();
});

it('ends initial loading on a failed read and retries only the registry read', async () => {
  const catalogs = [row('1', 'recoverable')];
  const read = vi
    .fn()
    .mockRejectedValueOnce(new TeamApiError('TEAM_TRANSPORT_UNAVAILABLE', true))
    .mockResolvedValue(catalogs);
  const api = client(catalogs, stopped, { listTeamProductCatalogs: read });
  renderDialog(api);
  await screen.findByText('Could not load catalogs.');
  expect(screen.queryByText('Loading catalogs…')).toBeNull();
  expect(screen.getByText('Catalogs unavailable')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByLabelText('recoverable catalog');
  expect(api.runCatalogUpdateNow).not.toHaveBeenCalled();
  expect(api.cancelCatalogUpdate).not.toHaveBeenCalled();
});

it('explains a quarantined current round separately from its unchanged historical failure', async () => {
  const item = row('1', 'quarantined', {
    lastUpdateError: 'CATALOG_ATTEMPT_STATE_INCONSISTENT',
    profile: {
      ...profileFor('23000000-0000-4000-8000-000000000001'),
      reconciliationRequired: true,
      lastResult: 'failed'
    }
  });
  const api = client([item], stopped, {
    listCatalogUpdateAttempts: vi.fn().mockResolvedValue([
      {
        attemptId: '47000000-0000-4000-8000-000000000091',
        catalogId: item.catalogId,
        trigger: 'schedule',
        startedAt: '2026-11-01T00:16:00Z',
        endedAt: '2026-11-01T00:24:00Z',
        stage: null,
        result: 'failed',
        failureCode: 'DRIVE_UNAVAILABLE',
        deliveryVerifiedAt: null
      }
    ])
  });
  renderDialog(api);
  await act(async () => {});
  expect(screen.getByLabelText('quarantined catalog')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Requires review · details' }));
  await act(async () => {});
  const current = screen.getByRole('alert');
  expect(current.textContent).toContain('This catalog needs a review of its previous update.');
  expect(current.textContent).not.toContain('Google Drive is not responding');
  expect(screen.getByText(/Google Drive is not responding\. Try again shortly\./)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Try again now' }).hasAttribute('disabled')).toBe(true);
});

it('replaces a client with fresh manager state while an old Stop is pending', async () => {
  let finish!: (value: boolean) => void;
  const stop = vi.fn(
    () =>
      new Promise<boolean>(resolve => {
        finish = resolve;
      })
  );
  const active = row('1', 'polo.mp4', {
    updatePending: true,
    activeRoundAt: '2026-11-05T10:00:00Z',
    activeAttemptId: null
  });
  const first = client([active], running, { cancelCatalogUpdate: stop });
  const next = client([row('1', 'polo.mp4')], stopped);
  const onChanged = vi.fn();
  const surface = (api: DialogClient) => (
    <TeamProvider initialTeams={[owned]} realtime={false}>
      <ToastProvider>
        <CatalogUpdaterDialog
          teamId={TEAM_ID}
          client={api}
          onClose={vi.fn()}
          onChanged={onChanged}
        />
      </ToastProvider>
    </TeamProvider>
  );
  const view = render(surface(first));
  await userEvent.type(await screen.findByRole('searchbox'), 'polo');
  await userEvent.click(screen.getByLabelText('Select polo.mp4 catalog'));
  await userEvent.click(screen.getByRole('button', { name: 'Stop this update' }));
  expect(stop).toHaveBeenCalledTimes(1);
  view.rerender(surface(next));
  expect(screen.getByRole('searchbox')).toHaveProperty('value', '');
  expect(await screen.findByLabelText('Select polo.mp4 catalog')).toHaveProperty('checked', false);
  await act(async () => {
    finish(true);
  });
  expect(onChanged).not.toHaveBeenCalled();
  expect(await screen.findByRole('button', { name: 'Update polo.mp4 catalog now' })).toHaveProperty(
    'disabled',
    false
  );
  expect(next.cancelCatalogUpdate).not.toHaveBeenCalled();
});

it('does not report Stop delivery before a fresh authoritative read and visible feedback', async () => {
  const { analytics } = await import('../apps/web/src/analytics/service');
  const track = vi.spyOn(analytics, 'track').mockImplementation(() => {});
  const attemptId = '47000000-0000-4000-8000-000000000099';
  const active = {
    ...row('1', 'polo.mp4'),
    profile: profileFor(row('1', '').catalogId),
    updatePending: true,
    activeRoundAt: '2026-11-05T10:00:00Z',
    activeAttemptId: attemptId
  };
  let resolve!: (value: { rows: CatalogRegistryRow[]; invalidRowCount: number }) => void;
  let stopped = false;
  const read = vi.fn(() =>
    stopped
      ? new Promise<{ rows: CatalogRegistryRow[]; invalidRowCount: number }>(done => {
          resolve = done;
        })
      : Promise.resolve({ rows: [active], invalidRowCount: 0 })
  );
  const api = client([active], running, {
    listCatalogManagerSnapshot: read,
    cancelCatalogUpdate: vi.fn(async () => {
      stopped = true;
      return true;
    })
  });
  renderDialog(api);
  await userEvent.click(await screen.findByRole('button', { name: 'Stop this update' }));
  await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(1));
  const stopCalls = () =>
    track.mock.calls.filter(
      ([, p]) => (p && 'flow_step' in p ? p.flow_step : undefined) === 'catalog_manager_stop'
    );
  expect(
    stopCalls().some(
      ([, p]) =>
        (p && 'action_identifier' in p ? p.action_identifier : undefined) === 'stop_accepted'
    )
  ).toBe(true);
  expect(stopCalls().some(([event]) => event === 'operation_completed')).toBe(false);
  await act(async () => {
    resolve({
      rows: [{ ...active, updatePending: false, activeRoundAt: null, activeAttemptId: null }],
      invalidRowCount: 0
    });
  });
  // Our own accepted stop ended the round: a success, not a stale target (QA LOW-14).
  expect(await screen.findByText('Update stopped.')).toBeTruthy();
  expect(screen.queryByText('The observed update is no longer active.')).toBeNull();
  const completed = stopCalls().filter(([event]) => event === 'operation_completed');
  expect(completed).toHaveLength(1);
  expect(completed[0]?.[1]).toMatchObject({
    parent_flow_id: attemptId,
    production_completed: false
  });
  expect(api.cancelCatalogUpdate).toHaveBeenCalledTimes(1);
});

it('checks an uncertain Stop without repeating the RPC and compares round timestamps by instant', async () => {
  const { analytics } = await import('../apps/web/src/analytics/service');
  const track = vi.spyOn(analytics, 'track').mockImplementation(() => {});
  const active = row('1', 'polo.mp4', {
    updatePending: true,
    activeRoundAt: '2026-11-05T10:00:00Z',
    activeAttemptId: '47000000-0000-4000-8000-000000000099'
  });
  const api = client([active], running, {
    cancelCatalogUpdate: vi
      .fn()
      .mockRejectedValue(new TeamApiError('TEAM_TRANSPORT_UNAVAILABLE', true))
  });
  renderDialog(api);
  await screen.findByRole('button', { name: 'Stop this update' });
  vi.mocked(api.listTeamProductCatalogs).mockResolvedValue([
    { ...active, activeRoundAt: '2026-11-05T12:00:00+02:00' }
  ]);
  await userEvent.click(screen.getByRole('button', { name: 'Stop this update' }));
  expect(
    await screen.findByText('The stop result is not confirmed yet. Check the current status.')
  ).toBeTruthy();
  expect(screen.queryByText('The observed update is no longer active.')).toBeNull();
  expect(api.cancelCatalogUpdate).toHaveBeenCalledTimes(1);
  vi.mocked(api.listTeamProductCatalogs).mockResolvedValue([
    { ...active, updatePending: false, activeRoundAt: null, activeAttemptId: null }
  ]);
  await userEvent.click(screen.getByRole('button', { name: 'Check status' }));
  expect(await screen.findByText('The observed update is no longer active.')).toBeTruthy();
  expect(api.cancelCatalogUpdate).toHaveBeenCalledTimes(1);
  const stop = track.mock.calls.filter(
    ([, p]) => (p && 'flow_step' in p ? p.flow_step : undefined) === 'catalog_manager_stop'
  );
  expect(
    stop.some(
      ([, p]) =>
        (p && 'action_identifier' in p ? p.action_identifier : undefined) === 'stop_reply_unknown'
    )
  ).toBe(true);
  expect(
    stop.some(
      ([, p]) =>
        (p && 'action_identifier' in p ? p.action_identifier : undefined) === 'stop_check_requested'
    )
  ).toBe(true);
  expect(stop.filter(([name]) => name === 'operation_completed')).toHaveLength(1);
});

it('does not keep the previous actor navigation guard before its effect cleanup', async () => {
  const { BEFORE_NAVIGATION_EVENT } = await import('../apps/web/src/lib/navigation');
  let finish!: (value: CatalogUpdateProfile) => void;
  const api = client([row('1', 'polo.mp4')], stopped, {
    patchCatalogUpdateProfile: vi.fn(
      () =>
        new Promise<CatalogUpdateProfile>(resolve => {
          finish = resolve;
        })
    )
  });
  const { onChanged } = renderDialog(api);
  await userEvent.click(
    await screen.findByRole('button', { name: 'Replace video · Off: polo.mp4 catalog' })
  );
  const own = new Event(BEFORE_NAVIGATION_EVENT, { cancelable: true });
  window.dispatchEvent(own);
  expect(own.defaultPrevented).toBe(true);
  act(() => {
    setPrivateCacheScope('47000000-0000-4000-8000-000000000002', 'owner');
    const other = new Event(BEFORE_NAVIGATION_EVENT, { cancelable: true });
    window.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
  });
  await act(async () => {
    finish({ ...profileFor(row('1', '').catalogId), version: 2, restitch: true });
  });
  expect(onChanged).not.toHaveBeenCalled();
});

it('guards an unconfirmed inline save when closing the manager', async () => {
  const api = client([row('1', 'polo.mp4')], stopped, {
    patchCatalogUpdateProfile: vi.fn().mockRejectedValue(new TypeError('reply lost'))
  });
  const { onClose } = renderDialog(api);
  await userEvent.click(
    await screen.findByRole('button', { name: 'Images · On: polo.mp4 catalog' })
  );
  await screen.findByText('Save result unknown. Check current settings before continuing.');
  await userEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).not.toHaveBeenCalled();
  const prompt = screen.getByRole('dialog', { name: 'Result not confirmed' });
  expect(within(prompt).getByText(/Closing does not cancel it/)).toBeTruthy();
  await userEvent.click(within(prompt).getByRole('button', { name: 'Keep editing' }));
  expect(
    screen.getByText('Save result unknown. Check current settings before continuing.')
  ).toBeTruthy();
  expect(api.patchCatalogUpdateProfile).toHaveBeenCalledOnce();
});
it('guards an unconfirmed inline save during app navigation with the correct explanation', async () => {
  const { BEFORE_NAVIGATION_EVENT } = await import('../apps/web/src/lib/navigation');
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const api = client([row('1', 'polo.mp4')], stopped, {
    patchCatalogUpdateProfile: vi.fn().mockRejectedValue(new TypeError('reply lost'))
  });
  renderDialog(api);
  await userEvent.click(
    await screen.findByRole('button', { name: 'Images · On: polo.mp4 catalog' })
  );
  await screen.findByText('Save result unknown. Check current settings before continuing.');
  const navigation = new Event(BEFORE_NAVIGATION_EVENT, { cancelable: true });
  window.dispatchEvent(navigation);
  expect(navigation.defaultPrevented).toBe(true);
  expect(confirm).toHaveBeenCalledOnce();
  expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/Closing does not cancel it/));
  expect(api.patchCatalogUpdateProfile).toHaveBeenCalledOnce();
});
