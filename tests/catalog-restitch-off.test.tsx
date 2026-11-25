// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  DEFAULT_ROLE_PERMISSIONS,
  RESTITCH_BUILTIN_SCREENS,
  parseTeamRestitchDefaults,
  type TeamRestitchDefaults
} from '@video-compressor/shared';
import type {
  CatalogRegistryRow,
  CatalogUpdaterState,
  TeamContextSnapshot
} from '../apps/web/src/api/team';

/**
 * Production 2026-11-25: a catalog update with re-stitching in a space whose re-stitch settings
 * could not produce a screen waited «Готуємо відео…» for ever. Re-stitching now works out of the
 * box with Soty's standard pictures; the one case it cannot is a space with both the start and
 * the end turned off (effective settings null). The manager refuses such a run where it was
 * pressed, says why, and opens the «Перезашивка» settings.
 */

vi.mock('../apps/web/src/team/explorer/WorkspaceOperationsProvider', () => ({
  useOptionalWorkspaceOperations: () => null
}));
vi.mock('../apps/web/src/auth/AuthContext', () => ({
  useOptionalAuth: () => ({ user: { id: '47000000-0000-4000-8000-000000000001' } })
}));

const { setPrivateCacheScope } = await import('../apps/web/src/team/private-cache-scope');
const { TeamProvider } = await import('../apps/web/src/team/TeamContext');
const { ToastProvider } = await import('../apps/web/src/components/toast');
const { CatalogUpdaterDialog } =
  await import('../apps/web/src/team/catalog-updater/CatalogUpdaterDialog');
type DialogClient = NonNullable<Parameters<typeof CatalogUpdaterDialog>[0]['client']>;

const TEAM_ID = '23000000-0000-4000-8000-0000000000aa';
const owned: TeamContextSnapshot = {
  id: TEAM_ID,
  name: 'Creatives',
  role: 'owner',
  permissions: DEFAULT_ROLE_PERMISSIONS.owner,
  connectionState: 'connected'
};
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
const saved: TeamRestitchDefaults = {
  operation: 'restitch',
  startImageIds: [],
  endImageIds: [],
  fitMode: 'cover',
  finalDurationMode: 'random-40-50',
  customFinalDurationSeconds: 2700,
  sourceMode: 'drive',
  configured: true,
  builtin: { version: 1, start: true, end: true },
  updatedAt: '',
  updatedBy: null
};

function row(id: string, videoName: string, patch: Partial<CatalogRegistryRow> = {}) {
  const catalogId = `23000000-0000-4000-8000-00000000000${id}`;
  return {
    catalogId,
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
    profile: {
      catalogId,
      refreshImages: true,
      refreshTexts: true,
      growProducts: false,
      randomLinkVariation: true,
      restitch: true,
      version: 1,
      updatedAt: '2026-09-15T10:00:00.000Z'
    },
    ...patch
  } satisfies CatalogRegistryRow;
}

beforeEach(() => {
  setPrivateCacheScope('47000000-0000-4000-8000-000000000001', 'owner');
  localStorage.setItem('wishly.active-team.v1', TEAM_ID);
  localStorage.setItem('language', 'en');
  localStorage.setItem('catalog-icon-legend-seen', '1');
  window.history.replaceState(null, '', `/team/${TEAM_ID}?updater=1`);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

function client(
  rows: CatalogRegistryRow[],
  defaults: TeamRestitchDefaults | null,
  overrides: Partial<DialogClient> = {}
): DialogClient {
  const api: DialogClient = {
    getCatalogUpdater: vi.fn().mockResolvedValue(stopped),
    listTeamProductCatalogs: vi.fn().mockResolvedValue(rows),
    setCatalogUpdateInterval: vi.fn().mockResolvedValue(stopped),
    listCatalogUpdateProfiles: vi.fn().mockResolvedValue(rows.map(item => item.profile)),
    patchCatalogUpdateProfile: vi.fn(),
    runCatalogUpdateNow: vi.fn().mockResolvedValue(1),
    cancelCatalogUpdate: vi.fn().mockResolvedValue(true),
    setCatalogUpdaterRestitch: vi.fn().mockResolvedValue(stopped),
    getRestitchDefaults: vi.fn().mockResolvedValue(defaults),
    ...overrides
  };
  api.requestCatalogUpdateCommand ??= async (_team, _actor, intent) => {
    const count = await api.runCatalogUpdateNow(_team, intent.catalogIds);
    return {
      commandId: intent.commandId,
      kind: 'run',
      status: 'accepted',
      sourceAttemptId: null,
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

function renderDialog(api: DialogClient) {
  render(
    <TeamProvider initialTeams={[owned]} realtime={false}>
      <ToastProvider>
        <CatalogUpdaterDialog teamId={TEAM_ID} client={api} onClose={vi.fn()} />
      </ToastProvider>
    </TeamProvider>
  );
}

const OFF = /Re-stitching is off in this workspace/;

it('refuses a re-stitching run in a space with both screens off and opens the setting', async () => {
  const api = client([row('1', 'polo.mp4')], null);
  renderDialog(api);
  await userEvent.click(await screen.findByRole('button', { name: 'Update polo.mp4 catalog now' }));
  const alert = await screen.findByText(OFF);
  expect(api.runCatalogUpdateNow).not.toHaveBeenCalled();
  const container = alert.closest('[role="alert"]') as HTMLElement;
  await userEvent.click(
    within(container).getByRole('button', { name: 'Open re-stitching settings' })
  );
  const address = new URLSearchParams(window.location.search);
  expect(address.get('settings')).toBe('1');
  expect(address.get('tab')).toBe('restitch');
  // The manager stays underneath the settings it opened.
  expect(address.get('updater')).toBe('1');
});

it('runs re-stitching out of the box when the effective settings exist', async () => {
  const api = client([row('1', 'polo.mp4')], saved);
  renderDialog(api);
  await userEvent.click(await screen.findByRole('button', { name: 'Update polo.mp4 catalog now' }));
  await waitFor(() => expect(api.runCatalogUpdateNow).toHaveBeenCalledTimes(1));
  expect(screen.queryByText(OFF)).toBeNull();
});

it('reads the settings again before refusing, so a stale answer never blocks', async () => {
  const getRestitchDefaults = vi
    .fn<NonNullable<DialogClient['getRestitchDefaults']>>()
    .mockResolvedValueOnce(null)
    .mockResolvedValue(saved);
  const api = client([row('1', 'polo.mp4')], null, { getRestitchDefaults });
  renderDialog(api);
  await waitFor(() => expect(getRestitchDefaults).toHaveBeenCalled());
  await userEvent.click(await screen.findByRole('button', { name: 'Update polo.mp4 catalog now' }));
  await waitFor(() => expect(api.runCatalogUpdateNow).toHaveBeenCalledTimes(1));
});

it('lets a catalog without re-stitching run whatever the settings say', async () => {
  const plain = row('1', 'polo.mp4');
  const api = client([{ ...plain, profile: { ...plain.profile, restitch: false } }], null);
  renderDialog(api);
  await userEvent.click(await screen.findByRole('button', { name: 'Update polo.mp4 catalog now' }));
  await waitFor(() => expect(api.runCatalogUpdateNow).toHaveBeenCalledTimes(1));
});

it('says why the server ended a round instead of «preparing», until the setting is fixed', async () => {
  const failed = row('1', 'polo.mp4', { lastUpdateError: 'RESTITCH_INVALID' });
  renderDialog(client([failed], null));
  expect(await screen.findByText(OFF)).toBeTruthy();
  expect(screen.queryByText('Preparing the replacement video…')).toBeNull();
  cleanup();
  renderDialog(client([failed], saved));
  await screen.findByRole('button', { name: 'Update polo.mp4 catalog now' });
  await waitFor(() => expect(screen.queryByText(OFF)).toBeNull());
});

it('warns over the list when scheduled catalogs would re-stitch with both screens off', async () => {
  renderDialog(
    client(
      [
        row('1', 'first.mp4', { updateInterval: '1d' }),
        row('2', 'second.mp4', { updateInterval: '6h' }),
        row('3', 'third.mp4')
      ],
      null
    )
  );
  expect(await screen.findByText(/Catalogs re-stitched on a schedule: 2\./)).toBeTruthy();
});

it('keeps the built-in pictures and their marker through the shared parser', () => {
  const parsed = parseTeamRestitchDefaults({
    ...saved,
    startEnabled: false,
    endEnabled: true,
    automaticEndFrame: true
  });
  expect(parsed.ok && parsed.value.configured).toBe(true);
  expect(parsed.ok && parsed.value.builtin).toEqual({ version: 1, start: true, end: true });
  expect(parsed.ok && parsed.value.automaticEndFrame).toBe(true);
  expect(RESTITCH_BUILTIN_SCREENS.start.path).toBe('/restitch/soty-restitch-start.v1.png');
  expect(RESTITCH_BUILTIN_SCREENS.end.path).toBe('/restitch/soty-restitch-end.v1.png');
  const noMarker = parseTeamRestitchDefaults({ ...saved, builtin: 'yes' });
  expect(noMarker.ok && 'builtin' in noMarker.value).toBe(false);
});
