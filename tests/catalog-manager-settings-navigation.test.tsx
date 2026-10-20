// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { TeamSpace } from '../apps/web/src/team/TeamSpace';
import { spaceRouteFor } from '../apps/web/src/team/SpaceSettingsLink';
import { navigateTo } from '../apps/web/src/lib/navigation';
import { makeClient, makeTeam } from './team-space-fixtures';

vi.mock('../apps/web/src/team/catalog-updater/CatalogUpdaterDialog', () => ({
  CatalogUpdaterDialog: ({ teamId }: { teamId: string }) => {
    const [value, setValue] = useState('');
    return (
      <div data-testid="retained-manager">
        <input
          aria-label="Manager search"
          value={value}
          onChange={event => setValue(event.target.value)}
        />
        <button
          onClick={() =>
            navigateTo(spaceRouteFor(teamId, { kind: 'settings', tab: 'product-catalog' }))
          }
        >
          Open catalog defaults
        </button>
      </div>
    );
  }
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  window.history.replaceState(null, '', '/team');
});

it('layers catalog settings over the retained manager and restores its context on return', async () => {
  const team = makeTeam();
  const api = makeClient({ listTeams: vi.fn().mockResolvedValue([team]) });
  localStorage.setItem('wishly.active-team.v1', team.id);
  localStorage.setItem('language', 'en');
  window.history.replaceState(null, '', `/team/${team.id}?folder=original-folder&updater=1`);
  const user = userEvent.setup();
  render(
    <TeamProvider realtime={false}>
      <TeamSpace client={api} directAddMode="disabled" />
    </TeamProvider>
  );
  const search = await screen.findByRole('textbox', { name: 'Manager search' });
  await user.type(search, 'EG 75');
  await user.click(screen.getByRole('button', { name: 'Open catalog defaults' }));
  const settings = await screen.findByRole('dialog', { name: 'Space settings' });
  expect(settings.closest('.modal-backdrop-nested')).toBeTruthy();
  expect(screen.getByRole('textbox', { name: 'Manager search' })).toBe(search);
  await user.click(within(settings).getByRole('tab', { name: 'General' }));
  expect(new URLSearchParams(window.location.search).get('updater')).toBe('1');
  await user.click(within(settings).getByRole('button', { name: 'Back to space' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Space settings' })).toBeNull());
  expect(screen.getByRole('textbox', { name: 'Manager search' })).toBe(search);
  expect((search as HTMLInputElement).value).toBe('EG 75');
  expect(new URLSearchParams(window.location.search).get('folder')).toBe('original-folder');
  expect(new URLSearchParams(window.location.search).get('updater')).toBe('1');
});
