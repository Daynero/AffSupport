// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { TeamSpace } from '../apps/web/src/team/TeamSpace';
import { makeClient, makeTeam } from './team-space-fixtures';

/**
 * Coming back from Google must land where the press came from.
 *
 * The OAuth callback is a server redirect built from one configured site URL,
 * so it returns to the bare `/team?drive=connected` and the space is not in
 * the address. The resolver used to guess: resume "the first owned space that
 * is not ready". On an account with any half-made space that sent the wrong
 * screen for the wrong space — the create-space wizard — and the wizard's own
 * state outlived the redirect meant to take the person back. Reported from
 * production as authorizing in Google and arriving back at "connect with
 * Google", in circles, with no way through.
 *
 * The press now writes down which space and which screen it was, and these
 * tests are about reading that note rather than guessing again.
 */

const ACTIVE_TEAM_KEY = 'wishly.active-team.v1';
const AUTHORIZATION_KEY = 'wishly.drive-authorization.v1';

const CONNECTED = '20000000-0000-4000-8000-000000000001';
const HALF_MADE = '20000000-0000-4000-8000-0000000000aa';

function note(teamId: string, intent: 'wizard' | 'space', ageMs = 0) {
  sessionStorage.setItem(
    AUTHORIZATION_KEY,
    JSON.stringify({ teamId, intent, at: Date.now() - ageMs })
  );
}

/** The two spaces the old rule confused: a working one, and a draft. */
const connectedSpace = () =>
  makeTeam({ id: CONNECTED, name: 'Media buyers', connectionState: 'connected' });
const halfMadeSpace = () => makeTeam({ id: HALF_MADE, name: 'Half made', connectionState: 'none' });

function returnFromGoogle(teams: ReturnType<typeof makeTeam>[]) {
  window.history.replaceState(null, '', '/team?drive=connected');
  const client = makeClient({
    listTeams: vi.fn().mockResolvedValue(teams),
    listMaterials: vi.fn().mockResolvedValue([])
  });
  render(
    <TeamProvider realtime={false}>
      <TeamSpace client={client} directAddMode="disabled" />
    </TeamProvider>
  );
  return client;
}

const wizardTitle = () => screen.queryByRole('heading', { name: 'Create a space' });

beforeEach(() => {
  // Remembered from a previous visit, as it would be in a real browser — and
  // the bait for the old rule, which preferred the draft over it.
  localStorage.setItem(ACTIVE_TEAM_KEY, CONNECTED);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

describe('returning from a Drive authorization', () => {
  it('reopens the space whose settings asked for it, not a half-made one', async () => {
    note(CONNECTED, 'space');
    returnFromGoogle([connectedSpace(), halfMadeSpace()]);

    // The space itself, at its settings, with the code still attached so the
    // Drive panel knows to offer the folder chooser.
    await waitFor(() => {
      expect(window.location.pathname).toContain(CONNECTED);
    });
    const params = new URLSearchParams(window.location.search);
    expect(params.get('settings')).toBe('1');
    expect(params.get('drive')).toBe('connected');
    expect(wizardTitle()).toBeNull();
  });

  it('resumes the folder step of the space that was being created', async () => {
    note(HALF_MADE, 'wizard');
    returnFromGoogle([connectedSpace(), halfMadeSpace()]);

    expect(await screen.findByRole('heading', { name: 'Create a space' })).toBeTruthy();
    expect(await screen.findByText('Step 2 of 2')).toBeTruthy();
    // Named, so it is visibly the draft that was authorized rather than
    // whichever unfinished space happened to be listed first.
    expect(screen.getByText('Half made')).toBeTruthy();
    // Authorized already: the next press is the chooser, not Google again.
    expect(
      await screen.findByRole('button', { name: 'Choose folder in Google Drive' })
    ).toBeTruthy();
  });

  it('leaves the wizard alone when the draft is not the space that was authorized', async () => {
    // A second draft exists. Under the old rule this one — first in the list —
    // was the one resumed, whoever the authorization actually belonged to.
    const other = makeTeam({
      id: '20000000-0000-4000-8000-0000000000bb',
      name: 'Someone elses draft',
      connectionState: 'none'
    });
    note(HALF_MADE, 'wizard');
    returnFromGoogle([other, halfMadeSpace()]);

    expect(await screen.findByRole('heading', { name: 'Create a space' })).toBeTruthy();
    expect(screen.getByText('Half made')).toBeTruthy();
    expect(screen.queryByText('Someone elses draft')).toBeNull();
  });

  it('enters a space rather than the wizard when there is no note to read', async () => {
    // Storage a private window refused to write, or a return opened in a
    // second tab. Somewhere is better than a circle: the remembered space
    // opens at its settings, where the Drive panel is.
    returnFromGoogle([connectedSpace(), halfMadeSpace()]);

    await waitFor(() => {
      expect(window.location.pathname).toContain(CONNECTED);
    });
    expect(wizardTitle()).toBeNull();
  });

  it('ignores a note left behind by a much older trip', async () => {
    note(HALF_MADE, 'wizard', 60 * 60 * 1000);
    returnFromGoogle([connectedSpace(), halfMadeSpace()]);

    await waitFor(() => {
      expect(window.location.pathname).toContain(CONNECTED);
    });
    expect(wizardTitle()).toBeNull();
  });
});
