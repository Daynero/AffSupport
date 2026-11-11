// @vitest-environment jsdom
import { catalogForegroundPreparationFailure } from '../apps/web/src/api/catalog-video-foreground';
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setPrivateCacheScope } from '../apps/web/src/team/private-cache-scope';
const m = vi.hoisted(() => ({ read: vi.fn(), start: vi.fn(), cancel: vi.fn() }));
vi.mock('../apps/web/src/api/team', () => ({
  teamApi: {
    readCatalogUpdaterVariants: m.read,
    startCatalogUpdaterVariants: m.start,
    cancelCatalogUpdaterVariants: m.cancel
  }
}));
vi.mock('../apps/web/src/team/TeamContext', () => ({ useTeam: () => ({ updaterRevision: 0 }) }));
vi.mock('../apps/web/src/api/useAgentEventStream', () => ({ useAgentEventStream: () => {} }));
import { CatalogVideoVariationsDialog } from '../apps/web/src/team/catalog-updater/CatalogVideoVariationsDialog';
import type { CatalogRegistryRow } from '../apps/web/src/api/team';
const actor = '47000000-0000-4000-8000-000000000001',
  team = '47000000-0000-4000-8000-000000000002',
  catalog = '47000000-0000-4000-8000-000000000003';
const row: CatalogRegistryRow = {
  catalogId: catalog,
  name: 'Synthetic',
  sheetUrl: 'https://docs.google.com/spreadsheets/d/synthetic/edit',
  videoId: actor,
  videoName: 'Synthetic',
  folderName: null,
  productCount: 5,
  createdAt: '2026-11-08T00:00:00Z',
  lastUpdatedAt: null,
  updateCount: 0,
  inUpdater: true,
  lastUpdateError: null,
  updateInterval: null,
  nextRunAt: null,
  updatePending: false,
  updateStage: null,
  restitchProgress: null,
  restitchStage: null,
  folderDriveId: null,
  profile: {
    catalogId: catalog,
    refreshImages: false,
    refreshTexts: false,
    growProducts: false,
    randomLinkVariation: true,
    restitch: true,
    version: 3,
    updatedAt: '2026-11-08T00:00:00Z'
  }
};
const state = {
  requestId: actor,
  setId: team,
  state: 'preparing',
  requestedCount: 5,
  registeredCount: 2,
  recipeRevision: 1,
  profileVersion: 3,
  serverNow: Date.now()
};
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('language', 'en');
  setPrivateCacheScope(actor, 'owner');
  m.read.mockReset().mockResolvedValue(null);
  m.start.mockReset();
  m.cancel.mockReset();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});
const show = () =>
  render(
    <CatalogVideoVariationsDialog teamId={team} row={row} onClose={() => {}} onChanged={() => {}} />
  );
it('bounds count by products and sends the observed profile version', async () => {
  m.start.mockImplementation(async input => ({ ...state, requestId: input.requestId }));
  show();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Create video variations' })).toHaveProperty(
      'disabled',
      false
    )
  );
  const input = screen.getByRole('textbox', { name: 'Video variations' });
  await userEvent.clear(input);
  await userEvent.type(input, '6');
  expect(screen.getByRole('button', { name: 'Create video variations' })).toHaveProperty(
    'disabled',
    true
  );
  await userEvent.clear(input);
  await userEvent.type(input, '5');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Create video variations' })).toHaveProperty(
      'disabled',
      false
    )
  );
  await userEvent.click(screen.getByRole('button', { name: 'Create video variations' }));
  expect(await screen.findByText('Videos ready: 2 of 5')).toBeTruthy();
  expect(m.start).toHaveBeenCalledWith(
    expect.objectContaining({ requestedCount: 5, profileVersion: 3, catalogMaterialId: catalog }),
    expect.any(Object)
  );
  expect(screen.queryByText(/All 5 videos are ready/)).toBeNull();
});
it('reopens a lost admission reply by original read rather than starting again', async () => {
  m.start.mockRejectedValue(Error('PROCESS_RESULT_UNCERTAIN'));
  const h = show();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Create video variations' })).toHaveProperty(
      'disabled',
      false
    )
  );
  await userEvent.click(screen.getByRole('button', { name: 'Create video variations' }));
  await screen.findByText(/result is not confirmed/);
  const id = m.start.mock.calls[0]![0].requestId;
  h.unmount();
  m.read.mockResolvedValue({ ...state, requestId: id });
  show();
  await waitFor(() =>
    expect(m.read).toHaveBeenLastCalledWith(team, catalog, id, expect.any(Object))
  );
  expect(await screen.findByText('Videos ready: 2 of 5')).toBeTruthy();
  expect(m.start).toHaveBeenCalledTimes(1);
});

it('releases only a proved missing paired executor refusal and preserves editable manager settings', async () => {
  m.start.mockRejectedValue(
    Object.assign(Error('AGENT_REQUIRED'), { code: 'AGENT_REQUIRED', retryable: false })
  );
  show();
  const button = await screen.findByRole('button', { name: 'Create video variations' });
  await waitFor(() => expect(button).toHaveProperty('disabled', false));
  await userEvent.click(button);
  await screen.findByText(/open the latest Soty app and connect it to this browser/);
  expect(button).toHaveProperty('disabled', false);
  expect(screen.getByRole('textbox', { name: 'Video variations' })).toHaveProperty(
    'disabled',
    false
  );
  const original = m.start.mock.calls[0][0].requestId;
  expect(Object.values(localStorage)).not.toContain(original);
  expect(m.start).toHaveBeenCalledOnce();
});

it('unlocks only a locally branded preparation failure, preserving the original count', async () => {
  m.start.mockRejectedValue(catalogForegroundPreparationFailure(Error('INVALID_RESPONSE')));
  show();
  const button = await screen.findByRole('button', { name: 'Create video variations' });
  await waitFor(() => expect(button).toHaveProperty('disabled', false));
  await userEvent.click(button);
  await waitFor(() => expect(m.start).toHaveBeenCalledOnce());
  await waitFor(() => expect(button).toHaveProperty('disabled', false));
  expect(screen.getByRole('textbox', { name: 'Video variations' })).toHaveProperty(
    'disabled',
    false
  );
  expect(Object.values(localStorage)).not.toContain(m.start.mock.calls[0][0].requestId);
});

it.each(['INVALID_RESPONSE', 'PROCESS_RESULT_UNCERTAIN'])(
  'retains a canonical admission with an unbranded %s response',
  async code => {
    m.start.mockRejectedValue(Error(code));
    show();
    const button = await screen.findByRole('button', { name: 'Create video variations' });
    await waitFor(() => expect(button).toHaveProperty('disabled', false));
    await userEvent.click(button);
    await screen.findByText(/result is not confirmed/);
    expect(screen.getByRole('textbox', { name: 'Video variations' })).toHaveProperty(
      'disabled',
      true
    );
    expect(Object.values(localStorage)).toContain(m.start.mock.calls[0][0].requestId);
  }
);

it('keeps the last progress and a calm note when a read fails on a loaded server, then recovers', async () => {
  // 1.4.2 prod: a poll lost on a loaded server read as a hard failure mid-run.
  localStorage.setItem(`soty:catalog-video-manager:v1:${actor}:${team}:${catalog}`, actor);
  m.read.mockResolvedValue(state);
  show();
  expect(await screen.findByText('Videos ready: 2 of 5')).toBeTruthy();
  m.read.mockRejectedValueOnce(
    Object.assign(Error('TEAM_TRANSPORT_UNAVAILABLE'), { code: 'TEAM_TRANSPORT_UNAVAILABLE' })
  );
  await userEvent.click(screen.getByRole('button', { name: 'Check status' }));
  expect(await screen.findByText(/connection to the server dropped/)).toBeTruthy();
  expect(screen.getByText('Videos ready: 2 of 5')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  m.read.mockResolvedValue({ ...state, registeredCount: 3 });
  await userEvent.click(screen.getByRole('button', { name: 'Check status' }));
  expect(await screen.findByText('Videos ready: 3 of 5')).toBeTruthy();
  expect(screen.queryByText(/connection to the server dropped/)).toBeNull();
});

it('still shows a final refusal as an error during a run', async () => {
  localStorage.setItem(`soty:catalog-video-manager:v1:${actor}:${team}:${catalog}`, actor);
  m.read.mockResolvedValue(state);
  show();
  expect(await screen.findByText('Videos ready: 2 of 5')).toBeTruthy();
  m.read.mockRejectedValueOnce(
    Object.assign(Error('PERMISSION_DENIED'), { code: 'PERMISSION_DENIED' })
  );
  await userEvent.click(screen.getByRole('button', { name: 'Check status' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.queryByText(/connection to the server dropped/)).toBeNull();
});
