// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ROLE_PERMISSIONS,
  type CatalogVideoR2Availability,
  type CatalogVideoR2State
} from '@video-compressor/shared';
import type { CatalogVideoR2Client } from '../apps/web/src/api/team-catalog-video-r2';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { CatalogVideoR2Toggle } from '../apps/web/src/team/product-catalog/CatalogVideoR2Toggle';
import { CatalogVideoR2UsageSection } from '../apps/web/src/team/tariffs/CatalogVideoR2UsageSection';
import { TeamApiError } from '../apps/web/src/api/team';

const TEAM = '50000000-0000-4000-8000-000000000601';
const CATALOG = '50000000-0000-4000-8000-000000000602';

const available = (canManage = true): CatalogVideoR2Availability => ({
  available: true,
  canManage,
  contractVersion: 1
});
const state = (overrides: Partial<CatalogVideoR2State> = {}): CatalogVideoR2State => ({
  catalogMaterialId: CATALOG,
  enabled: false,
  link: 'drive',
  lastSuccessfulUpdateAt: null,
  copy: null,
  reason: null,
  usedBytes: 0,
  quotaBytes: 50_000_000_000,
  canManage: true,
  revision: 1,
  ...overrides
});
function client(overrides: Partial<CatalogVideoR2Client> = {}): CatalogVideoR2Client {
  return {
    availability: vi.fn(async () => available()),
    readState: vi.fn(async () => state()),
    setPreference: vi.fn(async (_id, input) => ({
      enabled: input.enabled,
      revision: 2,
      updatedAt: '2026-11-10T09:00:00Z'
    })),
    readUsage: vi.fn(async () => ({
      usedBytes: 0,
      quotaBytes: 50_000_000_000,
      readyCopies: 0,
      retiringCopies: 0,
      enabledCatalogs: 0
    })),
    ...overrides
  };
}
function mount(node: React.ReactNode, role: 'owner' | 'viewer' = 'owner') {
  return render(
    <TeamProvider
      realtime={false}
      initialTeams={[
        {
          id: TEAM,
          name: 'Space',
          role,
          permissions: DEFAULT_ROLE_PERMISSIONS[role],
          connectionState: 'connected'
        }
      ]}
    >
      {node}
    </TeamProvider>
  );
}
afterEach(cleanup);

describe('CatalogVideoR2Toggle', () => {
  it('appears only when the server says the feature is available, and ticks in one click at creation', async () => {
    const onChange = vi.fn();
    const api = client();
    mount(
      <CatalogVideoR2Toggle
        mode="create"
        teamId={TEAM}
        checked={false}
        onChange={onChange}
        client={api}
      />
    );
    const box = await screen.findByRole('checkbox', { name: 'Copy the video to R2' });
    expect((box as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.getByText(/Only the active version is kept/u)).toBeTruthy();
    cleanup();
    const hidden = client({
      availability: vi.fn(async (): Promise<CatalogVideoR2Availability> => ({
        available: false,
        reason: 'VIDEO_R2_POLICY_PENDING',
        canManage: true,
        contractVersion: 1
      }))
    });
    mount(
      <CatalogVideoR2Toggle
        mode="create"
        teamId={TEAM}
        checked={false}
        onChange={onChange}
        client={hidden}
      />
    );
    await waitFor(() => expect(hidden.availability).toHaveBeenCalled());
    expect(screen.queryByRole('checkbox')).toBeNull();
    cleanup();
    const failing = client({
      availability: vi.fn(async () => {
        throw new TeamApiError('TEAM_TRANSPORT_UNAVAILABLE', true);
      })
    });
    mount(
      <CatalogVideoR2Toggle
        mode="create"
        teamId={TEAM}
        checked={false}
        onChange={onChange}
        client={failing}
      />
    );
    await waitFor(() => expect(failing.availability).toHaveBeenCalled());
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('is disabled without the catalog settings permission and says why', async () => {
    mount(
      <CatalogVideoR2Toggle
        mode="create"
        teamId={TEAM}
        checked={false}
        onChange={vi.fn()}
        client={client({ availability: vi.fn(async () => available(false)) })}
      />,
      'viewer'
    );
    const box = await screen.findByRole('checkbox');
    expect((box as HTMLInputElement).disabled).toBe(true);
    expect(
      screen.getByText('Only a member who can change the catalog settings can turn this on.')
    ).toBeTruthy();
  });

  it('saves the option of an existing catalog in one click and shows the link source and reason', async () => {
    const api = client({
      readState: vi.fn(async () =>
        state({
          enabled: true,
          link: 'drive',
          reason: 'VIDEO_R2_QUOTA_EXCEEDED',
          copy: { state: 'failed', readyAt: null, fullHashVerified: false },
          lastSuccessfulUpdateAt: '2026-11-10T08:30:00Z'
        })
      )
    });
    const onSaved = vi.fn();
    mount(
      <CatalogVideoR2Toggle
        mode="catalog"
        teamId={TEAM}
        catalogMaterialId={CATALOG}
        client={api}
        onSaved={onSaved}
      />
    );
    const box = await screen.findByRole('checkbox', { name: 'Copy the video to R2' });
    await waitFor(() => expect((box as HTMLInputElement).checked).toBe(true));
    expect(screen.getByTestId('catalog-video-r2-status').textContent).toBe('Drive link kept');
    expect(screen.getByTestId('catalog-video-r2-reason').textContent).toMatch(/R2 video limit/u);
    expect(screen.getByTestId('catalog-video-r2-last-update').textContent).toMatch(
      /Last successful update: /u
    );
    fireEvent.click(box);
    await waitFor(() =>
      expect(api.setPreference).toHaveBeenCalledWith(CATALOG, { enabled: false })
    );
    await waitFor(() => expect((box as HTMLInputElement).checked).toBe(false));
    expect(onSaved).toHaveBeenCalledWith(false);
    expect(screen.getByText('Saved. The catalog link changes automatically.')).toBeTruthy();
  });

  it('shows R2 as the source with the partial-proof note, and surfaces a refused save as a code message', async () => {
    const api = client({
      readState: vi.fn(async () =>
        state({
          enabled: true,
          link: 'r2',
          copy: { state: 'ready', readyAt: '2026-11-10T08:00:00Z', fullHashVerified: false }
        })
      ),
      setPreference: vi.fn(async () => {
        throw new TeamApiError('PERMISSION_DENIED', false);
      })
    });
    mount(
      <CatalogVideoR2Toggle mode="catalog" teamId={TEAM} catalogMaterialId={CATALOG} client={api} />
    );
    const box = await screen.findByRole('checkbox');
    await waitFor(() =>
      expect(screen.getByTestId('catalog-video-r2-status').textContent).toBe('R2')
    );
    expect(screen.getByText(/full checksum could not be compared/u)).toBeTruthy();
    fireEvent.click(box);
    await screen.findByRole('alert');
    expect((box as HTMLInputElement).checked).toBe(true);
  });
});

describe('CatalogVideoR2UsageSection', () => {
  it('shows bytes against the limit with an estimate and hides when nothing is stored and the feature is off', async () => {
    const api = client({
      readUsage: vi.fn(async () => ({
        usedBytes: 10_000_000_000,
        quotaBytes: 50_000_000_000,
        readyCopies: 3,
        retiringCopies: 1,
        enabledCatalogs: 2
      }))
    });
    mount(<CatalogVideoR2UsageSection teamId={TEAM} client={api} />);
    const block = await screen.findByTestId('catalog-video-r2-usage');
    expect(block.textContent).toContain('10 GB of 50 GB');
    expect(block.textContent).toContain('3 active, 1 awaiting deletion');
    expect(block.textContent).toMatch(/About 0[.,]15–0[.,]18 USD per month/u);
    cleanup();
    const off = client({
      availability: vi.fn(async (): Promise<CatalogVideoR2Availability> => ({
        available: false,
        reason: 'VIDEO_R2_DISABLED',
        canManage: true,
        contractVersion: 1
      }))
    });
    mount(<CatalogVideoR2UsageSection teamId={TEAM} client={off} />);
    await waitFor(() => expect(off.readUsage).toHaveBeenCalled());
    expect(screen.queryByTestId('catalog-video-r2-usage')).toBeNull();
  });
});
