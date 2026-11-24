// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { ToastProvider } from '../apps/web/src/components/toast';
import {
  TeamPreferencesSection,
  type TeamPreferencesClient
} from '../apps/web/src/team/workspace/TeamPreferencesSection';

/**
 * A settings panel says what became of a change (070, T052; FR-025): "Saved" or "Could not
 * save" on its title line, the failure beside the field, and the value kept on screen rather
 * than put back silently — which is what the space preferences used to do.
 */

const TEAM_ID = '18000000-0000-4000-8000-000000000070';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function wrap(client: TeamPreferencesClient) {
  localStorage.setItem('wishly.active-team.v1', TEAM_ID);
  const team = {
    id: TEAM_ID,
    name: 'Preferences',
    role: 'owner' as const,
    permissions: DEFAULT_ROLE_PERMISSIONS.owner,
    connectionState: 'connected' as const
  };
  return render(
    <ToastProvider>
      <TeamProvider initialTeams={[team]} realtime={false}>
        <TeamPreferencesSection teamId={TEAM_ID} client={client} />
      </TeamProvider>
    </ToastProvider>
  );
}

function client(overrides: Partial<TeamPreferencesClient> = {}): TeamPreferencesClient {
  return {
    getTranscriptDeletePref: vi.fn().mockResolvedValue('ask'),
    setTranscriptDeletePref: vi.fn().mockResolvedValue(undefined),
    getTaskProgressMaxDefault: vi.fn().mockResolvedValue(100),
    setTaskProgressMaxDefault: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

describe('space preferences', () => {
  it('says a kept task maximum is saved', async () => {
    const user = userEvent.setup();
    const api = client();
    wrap(api);
    const field = await screen.findByLabelText('Slider maximum in new tasks');
    await user.clear(field);
    await user.type(field, '250{Enter}');
    await waitFor(() => expect(api.setTaskProgressMaxDefault).toHaveBeenCalledWith(TEAM_ID, 250));
    expect(await screen.findByText('Saved')).toBeTruthy();
  });

  it('keeps a refused task maximum on screen and says it was not saved', async () => {
    const user = userEvent.setup();
    const api = client({
      setTaskProgressMaxDefault: vi.fn().mockRejectedValue(new Error('offline'))
    });
    wrap(api);
    const field = await screen.findByLabelText('Slider maximum in new tasks');
    await user.clear(field);
    await user.type(field, '250');
    await user.tab();
    expect((await screen.findByText('Could not save')).getAttribute('role')).toBe('alert');
    expect(screen.getByText('Could not save. The value is still here — try again.')).toBeTruthy();
    expect((field as HTMLInputElement).value).toBe('250');
  });

  it('refuses a figure out of range beside the field instead of writing it', async () => {
    const user = userEvent.setup();
    const api = client();
    wrap(api);
    const field = await screen.findByLabelText('Slider maximum in new tasks');
    await user.clear(field);
    await user.type(field, '0');
    await user.tab();
    expect(await screen.findByText('Enter a whole number from 1 to 10000.')).toBeTruthy();
    expect(api.setTaskProgressMaxDefault).not.toHaveBeenCalled();
  });

  it('keeps a refused transcript choice and says so', async () => {
    const user = userEvent.setup();
    const api = client({
      setTranscriptDeletePref: vi.fn().mockRejectedValue(new Error('offline'))
    });
    wrap(api);
    await user.click(
      await screen.findByRole('button', { name: /The transcript, when you delete its video/u })
    );
    await user.click(await screen.findByRole('option', { name: 'Delete the transcript too' }));
    await waitFor(() => expect(api.setTranscriptDeletePref).toHaveBeenCalledWith('delete'));
    expect((await screen.findByText('Could not save')).getAttribute('role')).toBe('alert');
    expect(screen.getByRole('button', { name: /Delete the transcript too/u })).toBeTruthy();
  });
});
