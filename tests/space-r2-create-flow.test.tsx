// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const address = vi.hoisted(() => ({
  channel: 'next' as 'next' | 'production' | 'other',
  environment: 'production' as 'production' | 'beta'
}));
vi.mock('../apps/web/src/lib/config', async importOriginal => ({
  ...(await importOriginal<typeof import('../apps/web/src/lib/config')>()),
  siteChannel: () => address.channel,
  configuredEnvironment: () => address.environment
}));
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/lib/supabase', async importOriginal => ({
  ...(await importOriginal<typeof import('../apps/web/src/lib/supabase')>()),
  withFreshSession: <T,>(run: () => PromiseLike<T>) => run(),
  requireSupabaseClient: () => ({ rpc })
}));

import { r2SpaceCreationAvailable } from '../apps/web/src/api/space-storage';
import type { TeamContextSnapshot } from '../apps/web/src/api/team';
import { AuthContextOverride } from '../apps/web/src/auth/AuthContext';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { CreateSpaceWizard } from '../apps/web/src/team/create/CreateSpaceWizard';
import { spaceReadiness } from '../apps/web/src/team/lobby/SpaceCard';
import { makeClient } from './team-space-fixtures';
import { adminAuthStub } from './support/auth-stub';

/**
 * 057 T017 — creating a space on Soty storage (R2) from the web (T018). The choice is offered
 * on the `next` address to a pilot only and never on the production address; an R2 space is
 * ready without a Drive folder; the team list asks v2 away from production and falls back to
 * the old list on a database without it.
 */

const ALL = {
  view: true,
  download: true,
  upload: true,
  edit: true,
  delete: true,
  process: true,
  manage_members: true,
  manage_metadata: true
};
const R2_SPACE: TeamContextSnapshot = {
  id: '05713000-0000-4000-8000-000000000011',
  name: 'My space',
  role: 'owner',
  permissions: ALL,
  connectionState: 'none',
  storageBackend: 'r2'
};

beforeEach(() => {
  localStorage.setItem('language', 'en');
  address.channel = 'next';
  address.environment = 'production';
});
afterEach(() => {
  cleanup();
  rpc.mockReset();
});

describe('where «On Soty storage» may be offered', () => {
  it('on next to a pilot, never on production, never to someone without the permit', () => {
    expect(
      r2SpaceCreationAvailable({ channel: 'next', environment: 'production', pilot: true })
    ).toBe(true);
    expect(
      r2SpaceCreationAvailable({ channel: 'next', environment: 'production', pilot: false })
    ).toBe(false);
    expect(
      r2SpaceCreationAvailable({ channel: 'production', environment: 'production', pilot: true })
    ).toBe(false);
    // The Agent's own copy of the production site is not next.
    expect(
      r2SpaceCreationAvailable({ channel: 'other', environment: 'production', pilot: true })
    ).toBe(false);
    // A beta stack proves the pilot before next.
    expect(r2SpaceCreationAvailable({ channel: 'other', environment: 'beta', pilot: true })).toBe(
      true
    );
  });
});

function wizard(client: ReturnType<typeof makeClient>, onCreated = vi.fn()) {
  return render(
    <AuthContextOverride value={adminAuthStub()}>
      <TeamProvider realtime={false}>
        <CreateSpaceWizard
          client={client}
          resumeTeamId={null}
          onCancel={() => {}}
          onCreated={onCreated}
        />
      </TeamProvider>
    </AuthContextOverride>
  );
}

describe('the create wizard', () => {
  it('offers a pilot on next the space on Soty storage, with no folder step', async () => {
    const createR2Space = vi.fn(async () => R2_SPACE);
    const client = makeClient({ isStorageR2Pilot: vi.fn(async () => true), createR2Space });
    const onCreated = vi.fn();
    wizard(client, onCreated);
    const choice = await screen.findByLabelText(/On Soty storage/u);
    expect(screen.getByText('Step 1 of 2')).toBeTruthy();
    fireEvent.click(choice);
    expect(screen.getByText('Step 1 of 1')).toBeTruthy();
    expect(screen.getByText(/ready as soon as it has a name/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(R2_SPACE.id));
    expect(createR2Space).toHaveBeenCalledWith(
      'My space',
      expect.stringMatching(/^[0-9a-f-]{36}$/u)
    );
    expect(client.createTeam).not.toHaveBeenCalled();
    expect(screen.queryByText(/Connect a Google Drive folder/u)).toBeNull();
  });

  it('keeps the Drive path as it was when the pilot leaves the choice on Drive', async () => {
    const client = makeClient({
      isStorageR2Pilot: vi.fn(async () => true),
      createR2Space: vi.fn(),
      createTeam: vi.fn(async () => ({ ...R2_SPACE, storageBackend: undefined }))
    });
    wizard(client);
    await screen.findByLabelText(/On Soty storage/u);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(client.createTeam).toHaveBeenCalledWith('My space'));
    expect(client.createR2Space).not.toHaveBeenCalled();
  });

  it('shows nothing new to someone without the permit on next', async () => {
    const isStorageR2Pilot = vi.fn(async () => false);
    wizard(makeClient({ isStorageR2Pilot, createR2Space: vi.fn() }));
    await waitFor(() => expect(isStorageR2Pilot).toHaveBeenCalled());
    expect(screen.queryByLabelText(/On Soty storage/u)).toBeNull();
    expect(screen.getByText('Step 1 of 2')).toBeTruthy();
  });

  it('on the production address does not even ask for the permit', async () => {
    address.channel = 'production';
    const isStorageR2Pilot = vi.fn(async () => true);
    wizard(makeClient({ isStorageR2Pilot, createR2Space: vi.fn() }));
    await screen.findByLabelText(/Space name/u);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(isStorageR2Pilot).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/On Soty storage/u)).toBeNull();
  });
});

describe('readiness of an R2 space', () => {
  it('is ready without any Drive connection, for its owner and its members', () => {
    expect(spaceReadiness(R2_SPACE)).toBe('ready');
    expect(spaceReadiness({ ...R2_SPACE, role: 'viewer' })).toBe('ready');
    // A Drive space without a folder is still unfinished, as before.
    expect(spaceReadiness({ ...R2_SPACE, storageBackend: undefined })).toBe('setup_incomplete');
    expect(spaceReadiness({ ...R2_SPACE, storageBackend: 'drive', role: 'viewer' })).toBe(
      'preparing'
    );
  });
});

describe('teamApi.listTeams', () => {
  const row = (fields: Record<string, unknown> = {}) => ({
    id: R2_SPACE.id,
    name: 'Pilot',
    role: 'owner',
    permissions: ALL,
    connection_state: 'none',
    ...fields
  });

  async function freshApi() {
    vi.resetModules();
    return (await import('../apps/web/src/api/team')).teamApi;
  }

  it('away from production asks v2 and keeps the backend of each space', async () => {
    rpc.mockImplementation(async (name: string) =>
      name === 'list_my_teams_v2'
        ? {
            data: [row({ storage_backend: 'r2', storage_pilot: true, content_revision: 0 })],
            error: null
          }
        : { data: [], error: null }
    );
    const teams = await (await freshApi()).listTeams();
    expect(rpc).toHaveBeenCalledWith('list_my_teams_v2', {});
    expect(teams).toEqual([expect.objectContaining({ id: R2_SPACE.id, storageBackend: 'r2' })]);
  });

  it('on the production address asks only the old list, which has no R2 space', async () => {
    address.channel = 'production';
    rpc.mockImplementation(async () => ({ data: [row()], error: null }));
    const teams = await (await freshApi()).listTeams();
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['list_my_teams']);
    expect(teams[0]?.storageBackend).toBeUndefined();
  });

  it('falls back to list_my_teams on PGRST202, and stays there', async () => {
    rpc.mockImplementation(async (name: string) =>
      name === 'list_my_teams_v2'
        ? { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }
        : { data: [row()], error: null }
    );
    const api = await freshApi();
    expect(await api.listTeams()).toHaveLength(1);
    expect(await api.listTeams()).toHaveLength(1);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      'list_my_teams_v2',
      'list_my_teams',
      'list_my_teams'
    ]);
  });

  it('any other v2 failure is a failure, not a silent fallback', async () => {
    rpc.mockImplementation(async () => ({
      data: null,
      error: { code: '42501', message: 'PERMISSION_DENIED' }
    }));
    await expect((await freshApi()).listTeams()).rejects.toMatchObject({
      code: 'PERMISSION_DENIED'
    });
  });

  it('refuses a backend it does not know', async () => {
    rpc.mockImplementation(async () => ({ data: [row({ storage_backend: 's3' })], error: null }));
    await expect((await freshApi()).listTeams()).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    });
  });
});
