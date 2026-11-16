// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ROLE_PERMISSIONS,
  type CatalogImageCapabilities,
  type GlobalImagePolicyState
} from '@video-compressor/shared';
import type { CatalogImageClient } from '../apps/web/src/api/team-catalog-images';
import { TeamContextOverride, TeamProvider, useTeam } from '../apps/web/src/team/TeamContext';
import { ToastProvider } from '../apps/web/src/components/toast';
import {
  CatalogSettingsSection,
  type CatalogSettingsClient
} from '../apps/web/src/team/workspace/CatalogSettingsSection';

/*
 * The Catalog tab of space settings came back after 055 with the space's own pictures and the
 * update defaults only. Which of the two picture surfaces it shows follows the shared-pool policy:
 * a space the pool does not serve keeps its gallery, a pool space gets one line instead.
 */

// The update defaults only accept a read made under a signed-in person.
const auth = vi.hoisted(() => ({ user: { id: '57000000-0000-4000-8000-0000000000a1' } }));
vi.mock('../apps/web/src/auth/AuthContext', async importOriginal => ({
  ...(await importOriginal<typeof import('../apps/web/src/auth/AuthContext')>()),
  useOptionalAuth: () => auth
}));

const TEAM = '57000000-0000-4000-8000-000000000001';
const POOL_NOTE = /take images from the shared Soty pool/;

const emptyPage = () => ({ items: [], total: 0, revision: 1, hasMore: false, nextCursor: null });
function imageClient(): CatalogImageClient {
  const unused = vi.fn(async () => {
    throw new Error('not used by this test');
  });
  return {
    capabilities: vi.fn(async (): Promise<CatalogImageCapabilities> => ({
      enabled: true,
      importEnabled: true,
      canManage: true,
      contractVersion: 2,
      mode: 'v2'
    })),
    readStorage: vi.fn(async () => ({
      limitBytes: 100_000_000,
      limitImages: 500,
      usedBytes: 0,
      reservedBytes: 0,
      pendingDeletionBytes: 0,
      retainedBytes: 0,
      libraryBytes: 0,
      totalImages: 0,
      availableBytes: 100_000_000,
      teamBytes: 0,
      otherTeamBytes: 0
    })),
    readLibrary: vi.fn(async () => emptyPage()),
    dictionary: vi.fn(async () => emptyPage()),
    inventory: vi.fn(async () => ({ revision: 1, pairs: [], unclassified: 0, total: 0 })),
    listImports: vi.fn(async () => ({ items: [], hasMore: false, nextCursor: null })),
    continueImport: unused,
    beginImport: unused,
    appendManifest: unused,
    seal: unused,
    grant: unused,
    delivered: unused,
    getImport: unused,
    cancel: unused,
    retry: unused,
    remove: unused,
    revoke: unused
  } as unknown as CatalogImageClient;
}

function client(): CatalogSettingsClient & { catalogImages: CatalogImageClient } {
  const flag = (value: boolean) => vi.fn(async () => value);
  return {
    catalogImages: imageClient(),
    getCatalogUpdaterRestitchDefault: flag(false),
    setCatalogUpdaterRestitch: flag(true),
    getCatalogUpdaterRandomLinkVariation: flag(true),
    setCatalogUpdaterRandomLinkVariation: flag(true),
    getCatalogUpdaterRefreshImages: flag(true),
    setCatalogUpdaterRefreshImages: flag(true),
    getCatalogUpdaterRefreshTexts: flag(true),
    setCatalogUpdaterRefreshTexts: flag(true),
    getCatalogUpdaterGrow: flag(false),
    setCatalogUpdaterGrow: flag(true)
  };
}

function Policy({
  state,
  children
}: {
  state: GlobalImagePolicyState | null;
  children: React.ReactNode;
}) {
  const team = useTeam();
  return (
    <TeamContextOverride
      value={{
        ...team,
        globalImagePolicy: state && {
          contractVersion: 3,
          policyEpoch: state === 'prepared' ? 0 : 1,
          state,
          usable: state !== 'prepared',
          reason: null,
          observedAt: new Date().toISOString()
        }
      }}
    >
      {children}
    </TeamContextOverride>
  );
}

function mount(
  state: GlobalImagePolicyState | null,
  api = client(),
  onDraftChange?: (state: { dirty: boolean; saving: boolean }) => void
) {
  render(
    <TeamProvider
      realtime={false}
      initialTeams={[
        {
          id: TEAM,
          name: 'Space',
          role: 'owner',
          permissions: DEFAULT_ROLE_PERMISSIONS.owner,
          connectionState: 'connected'
        }
      ]}
    >
      <Policy state={state}>
        <ToastProvider>
          <CatalogSettingsSection teamId={TEAM} client={api} onDraftChange={onDraftChange} />
        </ToastProvider>
      </Policy>
    </TeamProvider>
  );
  return api;
}

beforeEach(() => {
  localStorage.setItem('wishly.active-team.v1', TEAM);
  localStorage.setItem('language', 'en');
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('space settings Catalog tab', () => {
  it("shows the space's own images and the update defaults where the shared pool is not active", async () => {
    const api = mount('prepared');
    const images = await screen.findByRole('button', { name: /^Images/ });
    await waitFor(() => expect(api.catalogImages.capabilities).toHaveBeenCalledWith(TEAM));
    fireEvent.click(images);
    expect(await screen.findByRole('button', { name: 'Add images' })).toBeTruthy();
    expect(screen.queryByText(POOL_NOTE)).toBeNull();
    const defaults = await screen.findByRole('button', { name: /Updates for new catalogs/ });
    fireEvent.click(defaults);
    expect(await screen.findByRole('checkbox', { name: 'Change images' })).toBeTruthy();
  });

  it.each(['active', 'draining'] as const)(
    'replaces the upload surface with a note for a %s shared-pool space',
    async state => {
      const api = mount(state);
      expect(await screen.findByText(POOL_NOTE)).toBeTruthy();
      expect(screen.queryByRole('button', { name: /^Images/ })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Add images' })).toBeNull();
      expect(api.catalogImages.capabilities).not.toHaveBeenCalled();
      // The update defaults stay; only the image refresh, which the pool owns, is gone.
      fireEvent.click(await screen.findByRole('button', { name: /Updates for new catalogs/ }));
      expect(
        await screen.findByRole('checkbox', { name: 'Change names, descriptions and prices' })
      ).toBeTruthy();
      expect(screen.queryByRole('checkbox', { name: 'Change images' })).toBeNull();
    }
  );

  it('shows neither the gallery nor the note while the pool policy is unknown', async () => {
    const api = mount(null);
    expect(await screen.findByRole('button', { name: /Updates for new catalogs/ })).toBeTruthy();
    expect(screen.queryByText(POOL_NOTE)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Images/ })).toBeNull();
    expect(api.catalogImages.capabilities).not.toHaveBeenCalled();
  });

  it('reports an unsaved update default so the settings can ask before leaving', async () => {
    const onDraftChange = vi.fn();
    mount('active', client(), onDraftChange);
    fireEvent.click(await screen.findByRole('button', { name: /Updates for new catalogs/ }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Prepare a new video copy' }));
    await waitFor(() =>
      expect(onDraftChange).toHaveBeenLastCalledWith({ dirty: true, saving: false })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(onDraftChange).toHaveBeenLastCalledWith({ dirty: false, saving: false })
    );
  });
});
