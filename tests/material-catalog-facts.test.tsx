// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogRegistryRow } from '../apps/web/src/api/team';
import { MaterialCatalogFacts } from '../apps/web/src/team/materials/MaterialCatalogFacts';

/**
 * Feature 024 (US23): a catalog sheet, selected in Files, says what it is. It used to say
 * "Google document, opens in Google Drive" — true of every sheet in the space.
 */

const row = (patch: Partial<CatalogRegistryRow> = {}): CatalogRegistryRow =>
  ({
    catalogId: 'c1',
    name: 'clip_v2_catalog',
    sheetUrl: 'https://docs.google.test/c1',
    videoId: 'v1',
    videoName: ' clip.MP4 ',
    folderName: 'Creatives',
    productCount: 5,
    createdAt: '2026-09-17T10:00:00.000Z',
    lastUpdatedAt: '2026-09-17T18:32:00.000Z',
    updateCount: 2,
    inUpdater: true,
    lastUpdateError: null,
    updateInterval: null,
    nextRunAt: null,
    ...patch
  }) as CatalogRegistryRow;

beforeEach(() => {
  localStorage.setItem('language', 'en');
  window.history.replaceState(null, '', '/team/space');
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('a catalog sheet in its card', () => {
  it('names its video, counts its products and offers the updater', async () => {
    render(
      <MaterialCatalogFacts
        teamId="team-1"
        material={{ id: 'c1', name: 'clip_v2_catalog' }}
        client={{ listTeamProductCatalogs: vi.fn(async () => [row()]) }}
      />
    );
    expect(await screen.findByText('A catalog for “clip.MP4”')).toBeTruthy();
    expect(screen.getByText(/Products: 5/)).toBeTruthy();
    expect(screen.getByText(/updated/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the updater' }).getAttribute('href')).toBe(
      '/team/space?updater=1'
    );
  });

  it('says nothing for a file that is not a catalog, and reads nothing for it', async () => {
    const listTeamProductCatalogs = vi.fn(async () => [row()]);
    const { container } = render(
      <MaterialCatalogFacts
        teamId="team-1"
        material={{ id: 'm1', name: 'clip.MP4' }}
        client={{ listTeamProductCatalogs }}
      />
    );
    await vi.waitFor(() => expect(container.textContent).toBe(''));
    expect(listTeamProductCatalogs).not.toHaveBeenCalled();
  });
});
