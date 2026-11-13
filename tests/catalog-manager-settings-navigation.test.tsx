// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { TeamSpace } from '../apps/web/src/team/TeamSpace';
import { parseTeamRoute } from '../apps/web/src/team/routes';
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
            navigateTo(
              `/team/${teamId}?folder=original-folder&updater=1&settings=1&tab=product-catalog`
            )
          }
        >
          Open old catalog bookmark
        </button>
      </div>
    );
  }
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  window.history.replaceState(null, '', '/team');
  vi.restoreAllMocks();
});

it.each(['updater=1', 'settings=1&tab=product-catalog'])(
  'opens and retains the manager for %s without catalog settings reads or drafts',
  async query => {
    const team = makeTeam();
    const api = Object.assign(makeClient({ listTeams: vi.fn().mockResolvedValue([team]) }), {
      getProductCatalogSettings: vi
        .fn()
        .mockRejectedValue(new Error('retired settings unavailable')),
      setProductCatalogSettings: vi
        .fn()
        .mockRejectedValue(new Error('retired settings unavailable'))
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    localStorage.setItem('wishly.active-team.v1', team.id);
    localStorage.setItem('language', 'en');
    window.history.replaceState(null, '', `/team/${team.id}?folder=original-folder&${query}`);
    const user = userEvent.setup();
    render(
      <TeamProvider realtime={false}>
        <TeamSpace client={api} directAddMode="disabled" />
      </TeamProvider>
    );
    const search = await screen.findByRole('textbox', { name: 'Manager search' });
    await user.type(search, 'EG 75');
    await user.click(screen.getByRole('button', { name: 'Open old catalog bookmark' }));
    await waitFor(() =>
      expect(parseTeamRoute(window.location.pathname + window.location.search)).toMatchObject({
        kind: 'space',
        query: { folderId: 'original-folder', updater: true, settings: false, settingsTab: null }
      })
    );
    expect(screen.queryByRole('dialog', { name: 'Space settings' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Manager search' })).toBe(search);
    expect((search as HTMLInputElement).value).toBe('EG 75');
    expect(confirm).not.toHaveBeenCalled();
    expect(api.getProductCatalogSettings).not.toHaveBeenCalled();
    expect(api.setProductCatalogSettings).not.toHaveBeenCalled();
  }
);
