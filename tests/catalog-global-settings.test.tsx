// @vitest-environment jsdom
import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { beforeEach, it, expect, vi } from 'vitest';
import {
  DEFAULT_ROLE_PERMISSIONS,
  type CatalogUpdateProfile,
  type GlobalImageReadiness
} from '@video-compressor/shared';
import {
  TeamProvider,
  TeamContextOverride,
  useTeam,
  useLegacyCatalogImageSettings
} from '../apps/web/src/team/TeamContext';
import { ToastProvider } from '../apps/web/src/components/toast';
import { ProductCatalogSettingsSection } from '../apps/web/src/team/product-catalog/ProductCatalogSettingsSection';
import { CatalogProfileEditor } from '../apps/web/src/team/catalog-updater/CatalogProfileEditor';
import { CatalogIconControls } from '../apps/web/src/team/catalog-updater/CatalogIconControls';
const teamId = '52000000-0000-4000-8000-000000000001';
function GlobalPolicy({ children }: { children: React.ReactNode }) {
  const team = useTeam();
  return (
    <TeamContextOverride
      value={{
        ...team,
        globalImagePolicy: {
          contractVersion: 3,
          policyEpoch: 1,
          state: 'active',
          usable: true,
          reason: null,
          observedAt: new Date().toISOString()
        }
      }}
    >
      {children}
    </TeamContextOverride>
  );
}
function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <TeamProvider
      initialTeams={[
        {
          id: teamId,
          name: 'Global',
          role: 'owner',
          permissions: DEFAULT_ROLE_PERMISSIONS.owner,
          connectionState: 'connected'
        }
      ]}
      realtime={false}
    >
      <GlobalPolicy>
        <ToastProvider>{children}</ToastProvider>
      </GlobalPolicy>
    </TeamProvider>
  );
}
beforeEach(() => {
  vi.useRealTimers();
  localStorage.setItem('wishly.active-team.v1', teamId);
  localStorage.setItem('language', 'en');
});
it('keeps a keyboard entry point when cutover removes a toolbar field', () => {
  const profile: CatalogUpdateProfile = {
    catalogId: teamId,
    updatedAt: new Date().toISOString(),
    version: 1,
    refreshImages: true,
    refreshTexts: true,
    growProducts: false,
    randomLinkVariation: true,
    restitch: false
  };
  function Toolbar({ active }: { active: boolean }) {
    const team = useTeam();
    return (
      <TeamContextOverride
        value={{
          ...team,
          globalImagePolicy: {
            contractVersion: 3,
            policyEpoch: active ? 1 : 0,
            state: active ? 'active' : 'prepared',
            usable: true,
            reason: null,
            observedAt: new Date().toISOString()
          }
        }}
      >
        <CatalogIconControls profile={profile} name="Catalog" onChange={vi.fn()} />
      </TeamContextOverride>
    );
  }
  const view = render(
    <Wrap>
      <Toolbar active={false} />
    </Wrap>
  );
  const last = screen.getAllByRole('button').at(-1)!;
  act(() => last.focus());
  expect(last.tabIndex).toBe(0);
  view.rerender(
    <Wrap>
      <Toolbar active />
    </Wrap>
  );
  expect(screen.getAllByRole('button')).toHaveLength(4);
  expect(last.tabIndex).toBe(0);
  fireEvent.keyDown(last, { key: 'Home' });
  expect(document.activeElement).toBe(screen.getAllByRole('button')[0]);
});
it('does not mount private gallery/import/source/fallback URL settings after T0', async () => {
  const sources = vi.fn(),
    pool = vi.fn();
  render(
    <Wrap>
      <ProductCatalogSettingsSection
        teamId={teamId}
        client={{
          getProductCatalogSettings: vi.fn().mockResolvedValue({
            title: 'Generic',
            description: 'Item',
            price: 10,
            priceMin: 10,
            priceMax: 20,
            imageLink: 'https://old.example.test/image.jpg',
            updatedAt: new Date().toISOString()
          }),
          setProductCatalogSettings: vi.fn(),
          listProductCatalogImageSources: sources,
          listProductCatalogPoolNames: pool
        }}
      />
    </Wrap>
  );
  await waitFor(() =>
    expect(screen.getByRole('heading', { name: 'Catalog settings' })).toBeTruthy()
  );
  expect(screen.queryByLabelText('Image link')).toBeNull();
  expect(sources).not.toHaveBeenCalled();
  expect(pool).not.toHaveBeenCalled();
});
it('preserves text/video controls while removing the image-refresh switch', () => {
  const profile: CatalogUpdateProfile = {
    catalogId: teamId,
    updatedAt: new Date().toISOString(),
    version: 1,
    refreshImages: false,
    refreshTexts: true,
    growProducts: false,
    randomLinkVariation: true,
    restitch: false
  };
  render(
    <Wrap>
      <CatalogProfileEditor
        profile={profile}
        catalogName="Catalog"
        interval={null}
        save={vi.fn()}
        onSaved={vi.fn()}
        onClose={vi.fn()}
      />
    </Wrap>
  );
  expect(screen.queryByText('Refresh images')).toBeNull();
  expect(screen.getAllByRole('checkbox').length).toBe(4);
});

it('saves text without a hidden legacy URL or private image readiness dependency', async () => {
  const stored = {
    title: 'Generic',
    description: 'Item',
    price: 10,
    priceMin: 10,
    priceMax: 20,
    imageLink: 'invalid stale draft',
    updatedAt: new Date().toISOString()
  };
  const save = vi.fn().mockResolvedValue({ ...stored, title: 'Updated', imageLink: null });
  render(
    <Wrap>
      <ProductCatalogSettingsSection
        teamId={teamId}
        openEditor="product-catalog-fallback-title"
        client={{
          getProductCatalogSettings: vi.fn().mockResolvedValue(stored),
          setProductCatalogSettings: save
        }}
      />
    </Wrap>
  );
  const title = await screen.findByLabelText('Title');
  await waitFor(() => expect(title).toHaveProperty('value', 'Generic'));
  fireEvent.change(title, { target: { value: 'Updated' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save the fallbacks' }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(teamId, {
      title: 'Updated',
      description: 'Item',
      priceMin: 10,
      priceMax: 20
    })
  );
  expect(screen.getByText('When names are missing')).toBeTruthy();
  expect(screen.queryByText('Image link')).toBeNull();
});
function PolicyProbe() {
  const { globalImagePolicy, notifyStateChanged } = useTeam();
  const legacy = useLegacyCatalogImageSettings();
  return (
    <>
      <output data-testid="global-policy">
        {globalImagePolicy?.state ?? 'unknown'}:{legacy ? 'legacy' : 'hidden'}
      </output>
      <button onClick={notifyStateChanged}>Revalidate policy</button>
    </>
  );
}
it('keeps an authoritative active epoch when an older prepared reply arrives late and recovers a failed foreground read', async () => {
  const snapshot = {
    id: teamId,
    name: 'Global',
    role: 'owner' as const,
    permissions: DEFAULT_ROLE_PERMISSIONS.owner,
    connectionState: 'connected' as const
  };
  const active: GlobalImageReadiness = {
    contractVersion: 3,
    policyEpoch: 1,
    state: 'active',
    usable: true,
    reason: null,
    observedAt: '2026-11-12T12:00:01Z'
  };
  const prepared: GlobalImageReadiness = {
    ...active,
    policyEpoch: 0,
    state: 'prepared',
    usable: false,
    reason: 'GLOBAL_IMAGE_READINESS_UNKNOWN',
    observedAt: '2026-11-12T12:00:00Z'
  };
  let oldReply!: (value: GlobalImageReadiness) => void;
  const read = vi
    .fn<(id: string) => Promise<GlobalImageReadiness>>()
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          oldReply = resolve;
        })
    )
    .mockResolvedValue(active);
  const client = { listTeams: vi.fn(async () => [snapshot]), getGlobalCatalogImageReadiness: read };
  const view = render(
    <TeamProvider initialTeams={[snapshot]} client={client} realtime={false}>
      <PolicyProbe />
    </TeamProvider>
  );
  expect(screen.getByTestId('global-policy').textContent).toBe('unknown:hidden');
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  fireEvent(window, new Event('focus'));
  await waitFor(() =>
    expect(screen.getByTestId('global-policy').textContent).toBe('active:hidden')
  );
  await act(async () => oldReply(prepared));
  expect(screen.getByTestId('global-policy').textContent).toBe('active:hidden');
  read.mockResolvedValueOnce(prepared);
  fireEvent(window, new Event('focus'));
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByTestId('global-policy').textContent).toBe('active:hidden');
  read.mockResolvedValueOnce({
    ...active,
    usable: false,
    reason: 'GLOBAL_IMAGE_READINESS_UNKNOWN',
    observedAt: prepared.observedAt
  });
  fireEvent(window, new Event('focus'));
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByTestId('global-policy').textContent).toBe('active:hidden');
  read.mockRejectedValueOnce(new Error('synthetic foreground failure'));
  fireEvent.click(screen.getByRole('button', { name: 'Revalidate policy' }));
  await waitFor(() =>
    expect(screen.getByTestId('global-policy').textContent).toBe('unknown:hidden')
  );
  read.mockResolvedValueOnce(prepared);
  fireEvent(window, new Event('focus'));
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByTestId('global-policy').textContent).toBe('unknown:hidden');
  const prior = read.mock.calls.length;
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  fireEvent(document, new Event('visibilitychange'));
  expect(read).toHaveBeenCalledTimes(prior);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  fireEvent(document, new Event('visibilitychange'));
  await waitFor(() =>
    expect(screen.getByTestId('global-policy').textContent).toBe('active:hidden')
  );
  view.unmount();
  const calls = read.mock.calls.length;
  fireEvent(window, new Event('focus'));
  expect(read).toHaveBeenCalledTimes(calls);
});
