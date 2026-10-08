// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';
import type { RestitchSourcesListing } from '@video-compressor/shared';
import type { TeamContextSnapshot } from '../apps/web/src/api/team';

/**
 * The space's re-stitching settings, as a member meets them (015, redrawn by 030).
 *
 * What is worth proving here is the states a person can actually be in — nobody has set this
 * up, somebody has, I am not allowed to, I inherit the owner's, the space still points at an
 * old library — and that saving writes the form and the pools, never a library and never a
 * picture. The stitcher's controls are its own and are tested where they live.
 */

vi.mock('../apps/web/src/api/useSubresourceUrl', () => ({ useSubresourceUrl: () => null }));
const track = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/analytics/service', () => ({ analytics: { track } }));

const { TeamProvider } = await import('../apps/web/src/team/TeamContext');
const { CatalogFreshness, CatalogFreshnessContext } =
  await import('../apps/web/src/team/catalog/CatalogFreshness');
const { ToastProvider } = await import('../apps/web/src/components/toast');
const { AgentContextOverride } = await import('../apps/web/src/AgentContext');
const { RestitchDefaultsSection } =
  await import('../apps/web/src/team/workspace/RestitchDefaultsSection');
type RestitchDefaultsClient = Parameters<typeof RestitchDefaultsSection>[0]['client'];
const { agentContextStub } = await import('./support/agent-stub.js');

const TEAM_ID = '21000000-0000-4000-8000-000000000001';

const owned: TeamContextSnapshot = {
  id: TEAM_ID,
  name: 'Creatives',
  role: 'owner',
  permissions: DEFAULT_ROLE_PERMISSIONS.owner,
  connectionState: 'connected'
};

const viewing: TeamContextSnapshot = {
  ...owned,
  role: 'viewer',
  permissions: DEFAULT_ROLE_PERMISSIONS.viewer
};

const stored = {
  operation: 'restitch' as const,
  startImageIds: [],
  endImageIds: [],
  fitMode: 'contain' as const,
  finalDurationMode: 'random-30-40' as const,
  customFinalDurationSeconds: 2700,
  startEnabled: true,
  endEnabled: true,
  startDurationMode: 'one-frame' as const,
  customStartDurationMs: 100,
  sourceMode: 'drive' as const,
  configured: true,
  updatedAt: '2026-10-08T00:00:00.000Z',
  updatedBy: 'someone'
};

const listing: RestitchSourcesListing = {
  sourceMode: 'drive',
  legacyImageCount: 0,
  pools: {
    start: {
      state: 'ready',
      overLimit: false,
      eligibleCount: 3,
      sources: [
        {
          materialId: 'folder-1',
          driveFileId: null,
          kind: 'folder',
          name: 'Openers',
          availability: 'available',
          imageCount: 3,
          skipped: { format: 0, size: 0, animated: 0 }
        }
      ]
    },
    end: { state: 'empty', overLimit: false, eligibleCount: 0, sources: [] }
  }
};

const legacyListing: RestitchSourcesListing = {
  ...listing,
  sourceMode: 'legacy',
  legacyImageCount: 2,
  pools: {
    start: { state: 'empty', overLimit: false, eligibleCount: 0, sources: [] },
    end: { state: 'empty', overLimit: false, eligibleCount: 0, sources: [] }
  }
};

function client(overrides: Partial<RestitchDefaultsClient> = {}): RestitchDefaultsClient {
  return {
    getRestitchDefaults: vi.fn().mockResolvedValue(stored),
    setRestitchDefaults: vi.fn().mockResolvedValue(stored),
    listRestitchSources: vi.fn().mockResolvedValue(listing),
    setRestitchSources: vi.fn().mockResolvedValue(listing),
    setMemberRestitchSources: vi.fn().mockResolvedValue(listing),
    listMaterials: vi.fn().mockResolvedValue([]),
    ...overrides
  };
}

beforeEach(() => {
  localStorage.setItem('wishly.active-team.v1', TEAM_ID);
  localStorage.setItem('language', 'en');
  track.mockReset();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function renderSection(
  value: RestitchDefaultsClient,
  team: TeamContextSnapshot = owned,
  connection: 'connected' | 'disconnected' = 'connected'
) {
  return render(
    <AgentContextOverride value={agentContextStub({ capabilities: ['stitcher'], connection })}>
      <TeamProvider initialTeams={[team]} realtime={false}>
        <ToastProvider>
          <RestitchDefaultsSection teamId={TEAM_ID} client={value} />
        </ToastProvider>
      </TeamProvider>
    </AgentContextOverride>
  );
}

describe('a space’s re-stitching settings', () => {
  it('says so when nobody has set them up', async () => {
    renderSection(client({ getRestitchDefaults: vi.fn().mockResolvedValue(null) }));
    expect(await screen.findByText('Not set up yet')).toBeTruthy();
  });

  it('names every operation on its own segment', async () => {
    renderSection(client());
    const chosen = await screen.findByRole('radio', { name: 'Re-stitch' });
    expect(chosen.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Stitch' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Remove the stitching' })).toBeTruthy();
  });

  it('shows the pools where the galleries would be, read from the space', async () => {
    const value = client();
    renderSection(value);
    expect(await screen.findByText('Openers')).toBeTruthy();
    expect(screen.getByText(/3 pictures ready to draw from/)).toBeTruthy();
    expect(screen.getByText(/this slot is off/)).toBeTruthy();
    expect(value.listRestitchSources).toHaveBeenCalledWith(TEAM_ID, 'owner');
    // The form is the saved settings', not a library's: the stored fit is what is selected.
    expect(
      screen.getByRole('button', { name: 'Fit completely' }).getAttribute('aria-pressed')
    ).toBe('true');
  });

  it('saves the form with no ids and no pictures, and works without the app running', async () => {
    const value = client();
    renderSection(value, owned, 'disconnected');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Fill and crop' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(value.setRestitchDefaults).toHaveBeenCalled());
    expect(vi.mocked(value.setRestitchDefaults).mock.calls[0]?.[1]).toMatchObject({
      operation: 'restitch',
      sourceMode: 'drive',
      startImageIds: [],
      endImageIds: [],
      fitMode: 'cover',
      finalDurationMode: 'random-30-40',
      startEnabled: true,
      endEnabled: true,
      startDurationMode: 'one-frame',
      customStartDurationMs: 100
    });
    await waitFor(() => expect(value.listRestitchSources).toHaveBeenCalledTimes(2));
    expect(track).toHaveBeenCalledWith('setting_changed', {
      setting_name: 'team_restitch_defaults',
      setting_value: 'restitch',
      file_count: 3
    });
  });

  it('writes a pool the moment a source is removed', async () => {
    const value = client();
    renderSection(value);
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Remove Openers from the pictures' }));
    await waitFor(() =>
      expect(value.setRestitchSources).toHaveBeenCalledWith(TEAM_ID, 'start', [])
    );
    expect(value.setMemberRestitchSources).not.toHaveBeenCalled();
  });

  it('tells a space saved the old way to pick from the space, naming the pictures this computer has', async () => {
    const legacyDefaults = {
      ...stored,
      sourceMode: 'legacy' as const,
      startImageIds: ['old-1'],
      endImageIds: ['old-2']
    };
    const value = client({
      getRestitchDefaults: vi.fn().mockResolvedValue(legacyDefaults),
      listRestitchSources: vi.fn().mockResolvedValue(legacyListing),
      localLibrary: vi.fn().mockResolvedValue({
        settings: {
          imageEmbedding: {
            startImages: [{ id: 'old-1', fileName: 'opener.png' }],
            endImages: [
              { id: 'old-2', fileName: 'closer.jpg' },
              { id: 'other', fileName: 'x.png' }
            ]
          }
        }
      })
    });
    renderSection(value);
    expect(await screen.findByText(/still points at 2 pictures/)).toBeTruthy();
    expect(await screen.findByText(/opener\.png, closer\.jpg/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pick from the space' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Move the old pictures into the space' })
    ).toBeTruthy();
  });

  it('moves the old pictures into the space on the owner’s word and re-reads the pools', async () => {
    const legacyDefaults = {
      ...stored,
      sourceMode: 'legacy' as const,
      startImageIds: ['old-1'],
      endImageIds: []
    };
    const transferLegacyImages = vi.fn(
      async (_team: string, _defaults: unknown, onProgress: (d: number, t: number) => void) => {
        onProgress(1, 1);
        return { moved: 1, missing: 0 };
      }
    );
    const value = client({
      getRestitchDefaults: vi.fn().mockResolvedValueOnce(legacyDefaults).mockResolvedValue(stored),
      listRestitchSources: vi.fn().mockResolvedValueOnce(legacyListing).mockResolvedValue(listing),
      transferLegacyImages
    });
    renderSection(value, owned, 'disconnected');
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Move the old pictures into the space' }));
    await waitFor(() =>
      expect(transferLegacyImages).toHaveBeenCalledWith(
        TEAM_ID,
        legacyDefaults,
        expect.any(Function)
      )
    );
    expect(await screen.findByText('Openers')).toBeTruthy();
    expect(screen.queryByText(/still points at/)).toBeNull();
  });

  it('inherits owner settings by default, showing the owner’s pools without controls', async () => {
    const value = client({
      getMemberRestitchPreference: vi.fn().mockResolvedValue({
        ownerId: 'owner',
        sourceUserId: 'owner',
        useOwner: true,
        personalConfigured: false
      }),
      setMemberRestitchUseOwner: vi.fn()
    });
    renderSection(value, viewing);
    expect(await screen.findByRole('checkbox', { name: "Use owner's settings" })).toHaveProperty(
      'checked',
      true
    );
    expect(await screen.findByText('Openers')).toBeTruthy();
    expect(screen.getByText(/These are the owner’s pools/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add pictures' })).toBeNull();
    expect(value.listRestitchSources).toHaveBeenCalledWith(TEAM_ID, 'owner');
  });

  it('opens personal settings and pools when a member unchecks inheritance', async () => {
    const setMemberRestitchUseOwner = vi.fn().mockResolvedValue(undefined);
    const value = client({
      getMemberRestitchPreference: vi.fn().mockResolvedValue({
        ownerId: 'owner',
        sourceUserId: 'owner',
        useOwner: true,
        personalConfigured: false
      }),
      setMemberRestitchUseOwner,
      setMemberRestitchDefaults: vi.fn().mockResolvedValue(stored)
    });
    renderSection(value, viewing);
    await userEvent
      .setup()
      .click(await screen.findByRole('checkbox', { name: "Use owner's settings" }));
    await waitFor(() => expect(setMemberRestitchUseOwner).toHaveBeenCalledWith(TEAM_ID, false));
    expect(await screen.findByRole('radio', { name: 'Re-stitch' })).toBeTruthy();
    await waitFor(() => expect(value.listRestitchSources).toHaveBeenCalledWith(TEAM_ID, 'self'));
  });

  it('saves personal settings and pools without touching the owner’s', async () => {
    const value = client({
      getMemberRestitchPreference: vi.fn().mockResolvedValue({
        ownerId: 'owner',
        sourceUserId: 'member',
        useOwner: false,
        personalConfigured: true
      }),
      setMemberRestitchUseOwner: vi.fn(),
      setMemberRestitchDefaults: vi.fn().mockResolvedValue(stored)
    });
    renderSection(value, viewing);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(value.setMemberRestitchDefaults).toHaveBeenCalled());
    expect(value.setRestitchDefaults).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Remove Openers from the pictures' }));
    await waitFor(() =>
      expect(value.setMemberRestitchSources).toHaveBeenCalledWith(TEAM_ID, 'start', [])
    );
    expect(value.setRestitchSources).not.toHaveBeenCalled();
  });

  it('only the preparation needs the app running, and says so there', async () => {
    renderSection(client(), owned, 'disconnected');
    expect(
      await screen.findByText('This needs the Soty app running on this computer.')
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false);
  });
});

describe('the pools follow the catalog (030)', () => {
  it('re-reads the pools when the catalog says it moved, through the one realtime seam', async () => {
    const value = client();
    const freshness = new CatalogFreshness();
    render(
      <AgentContextOverride value={agentContextStub({ capabilities: ['stitcher'] })}>
        <TeamProvider initialTeams={[owned]} realtime={false}>
          <CatalogFreshnessContext.Provider value={freshness}>
            <ToastProvider>
              <RestitchDefaultsSection teamId={TEAM_ID} client={value} />
            </ToastProvider>
          </CatalogFreshnessContext.Provider>
        </TeamProvider>
      </AgentContextOverride>
    );
    expect(await screen.findByText('Openers')).toBeTruthy();
    await waitFor(() => expect(freshness.isFresh(TEAM_ID)).toBe(true));
    expect(value.listRestitchSources).toHaveBeenCalledTimes(1);
    // A folder renamed, a picture binned: the explorer invalidates, and the panel re-reads.
    act(() => freshness.invalidate(TEAM_ID));
    await waitFor(() => expect(value.listRestitchSources).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(freshness.isFresh(TEAM_ID)).toBe(true));
  });
});
