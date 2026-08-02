// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { TeamSpace } from '../apps/web/src/team/TeamSpace';
import { makeClient, makeTeam } from './team-space-fixtures';

const STORAGE_KEY = 'wishly.active-team.v1';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function renderEnteredSpace(client: ReturnType<typeof makeClient>, teamId: string) {
  localStorage.setItem(STORAGE_KEY, teamId);
  return render(
    <TeamProvider realtime={false}>
      <TeamSpace client={client} directAddMode="disabled" />
    </TeamProvider>
  );
}

describe('content-first workspace shell', () => {
  it('opens an empty space with no filters and no side panels, management behind settings', async () => {
    const team = makeTeam();
    const client = makeClient({
      listTeams: vi.fn().mockResolvedValue([team]),
      listMaterials: vi.fn().mockResolvedValue([])
    });
    const user = userEvent.setup();
    renderEnteredSpace(client, team.id);

    // Content-first: the folder browser is the default, showing the empty state.
    expect(await screen.findByRole('heading', { name: 'Media buyers' })).toBeTruthy();
    expect(await screen.findByText('No visible materials in this folder yet.')).toBeTruthy();

    // Empty space → zero filter controls and no revealed search affordance.
    expect(screen.queryByText('GEO')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Search & filter' })).toBeNull();

    // Management is not shown beside the content by default.
    expect(screen.queryByRole('heading', { name: 'Google Drive storage' })).toBeNull();

    // It is one click away behind the single "Space settings" entry.
    await user.click(screen.getByRole('button', { name: 'Space settings' }));
    expect(await screen.findByRole('heading', { name: 'Google Drive storage' })).toBeTruthy();
  });
});
