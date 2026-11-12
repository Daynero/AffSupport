// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TeamPermissions } from '@video-compressor/shared';
import { ToastProvider } from '../apps/web/src/components/toast.js';
import { teamApi } from '../apps/web/src/api/team.js';
import { setPrivateCacheScope } from '../apps/web/src/team/private-cache-scope.js';
import type { MaterialActionsClient } from '../apps/web/src/team/catalog/material-actions-client.js';
import type { MaterialRef } from '../apps/web/src/team/materials/actions.js';
import { MaterialSurface, clickMaterialAction } from './support/material-surface.js';

/**
 * Owner decision 2026-11-11: a catalog with its video in R2 is deleted for good, and the person
 * is told so first. The manager's bulk delete and the catalogs dialog warned; the shared file
 * menu ("Move to trash"), used by the explorer and every manager row, did not (2026-11-12).
 */
const TEAM = '11111111-1111-4111-8111-111111111111';
const CATALOG: MaterialRef = {
  id: '22222222-2222-4222-8222-222222222222',
  teamId: TEAM,
  name: 'PK_1_v1_catalog',
  kind: 'file',
  category: 'other',
  sizeBytes: 1024,
  fileExtension: null
};
const permissions = {
  view: true,
  upload: true,
  edit: true,
  delete: true,
  process: true,
  manage_members: false,
  manage_metadata: true
} as TeamPermissions;

function client(): MaterialActionsClient {
  return {
    uploadFile: vi.fn(),
    requestDownload: vi.fn(),
    downloadWithAgent: vi.fn(),
    renameMaterial: vi.fn(),
    moveMaterial: vi.fn(),
    trashMaterial: vi.fn().mockResolvedValue({
      operationId: 'trash-operation',
      state: 'succeeded',
      materialId: CATALOG.id
    }),
    restoreMaterial: vi.fn()
  } as unknown as MaterialActionsClient;
}
const signals = (enabled: boolean) =>
  vi.spyOn(teamApi.catalogVideoR2, 'listSignals').mockResolvedValue([
    {
      catalogMaterialId: CATALOG.id,
      enabled,
      link: enabled ? 'r2' : 'drive',
      copyState: enabled ? 'ready' : null,
      reason: null,
      lastSuccessfulUpdateAt: null,
      revision: 1
    }
  ] as never);

beforeEach(() => {
  localStorage.setItem('language', 'en');
  setPrivateCacheScope('33333333-3333-4333-8333-333333333333', 'allowed');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function trashFromMenu(api: MaterialActionsClient) {
  render(
    <ToastProvider>
      <MaterialSurface teamId={TEAM} material={CATALOG} permissions={permissions} client={api} />
    </ToastProvider>
  );
  await userEvent.click(screen.getByRole('button', { name: `Actions for ${CATALOG.name}` }));
  await clickMaterialAction('Move to trash');
}

it('asks before trashing a catalog whose video is in R2, and deletes only on confirm', async () => {
  signals(true);
  const api = client();
  await trashFromMenu(api);
  expect(await screen.findByText('Delete the catalog for good?')).toBeTruthy();
  expect(api.trashMaterial).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Delete for good' }));
  await waitFor(() => expect(api.trashMaterial).toHaveBeenCalledOnce());
});

it('trashes a catalog without R2 at once, as before', async () => {
  signals(false);
  const api = client();
  await trashFromMenu(api);
  await waitFor(() => expect(api.trashMaterial).toHaveBeenCalledOnce());
  expect(screen.queryByText('Delete the catalog for good?')).toBeNull();
});
