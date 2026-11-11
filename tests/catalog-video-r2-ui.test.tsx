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
import {
  CatalogIconControls,
  CatalogIconLegend,
  catalogVideoR2Sentence
} from '../apps/web/src/team/catalog-updater/CatalogIconControls';
import type { CatalogVideoR2Row } from '../apps/web/src/team/product-catalog/useCatalogVideoR2Team';
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
    listSignals: vi.fn(async () => []),
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
    // The explanation lives in the help hint beside the control, not in a block of text.
    expect(screen.getByLabelText(/Only the active version is kept/u)).toBeTruthy();
    expect(screen.queryByText(/Only the active version is kept/u)).toBeNull();
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

describe('CatalogVideoR2Toggle as a switch', () => {
  it('renders the same kind of control as the re-stitch switch beside it', async () => {
    const onChange = vi.fn();
    mount(
      <CatalogVideoR2Toggle
        mode="create"
        control="switch"
        teamId={TEAM}
        checked={false}
        onChange={onChange}
        client={client()}
      />
    );
    const toggle = await screen.findByRole('switch', { name: 'Copy the video to R2' });
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});

describe('R2 icon in the catalog toolbar', () => {
  const profile = {
    catalogId: CATALOG,
    refreshImages: true,
    refreshTexts: false,
    growProducts: false,
    randomLinkVariation: true,
    restitch: false,
    version: 1,
    updatedAt: '2026-11-10T10:00:00Z'
  };
  const row = (overrides: Partial<CatalogVideoR2Row> = {}): CatalogVideoR2Row => ({
    enabled: false,
    link: 'drive',
    copyState: null,
    reason: null,
    pending: false,
    error: null,
    ...overrides
  });
  it('is a sixth toggle with its state in the tip, and turns the option on in one press', () => {
    const onToggle = vi.fn();
    render(
      <CatalogIconControls
        profile={profile}
        name="Catalog"
        onChange={vi.fn()}
        videoR2={{ row: row(), onToggle }}
      />
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(6);
    const r2 = buttons[5]!;
    expect(r2.getAttribute('aria-pressed')).toBe('false');
    expect(r2.getAttribute('aria-label')).toMatch(/^Copy the video to R2 · .* · Drive: Catalog$/u);
    fireEvent.click(r2);
    expect(onToggle).toHaveBeenCalledWith(true);
    buttons[0]!.focus();
    fireEvent.keyDown(buttons[0]!, { key: 'End' });
    expect(document.activeElement).toBe(r2);
  });
  it('says where the link is and why it stayed on Drive, and is locked without the permission', () => {
    const onToggle = vi.fn();
    const view = render(
      <CatalogIconControls
        profile={profile}
        name="Catalog"
        onChange={vi.fn()}
        videoR2={{ row: row({ enabled: true, link: 'r2', copyState: 'ready' }), onToggle }}
      />
    );
    expect(screen.getAllByRole('button')[5]!.getAttribute('aria-label')).toMatch(
      / · R2: Catalog$/u
    );
    // A finished copy whose sheet still holds Drive links says so, not "in progress".
    view.rerender(
      <CatalogIconControls
        profile={profile}
        name="Catalog"
        onChange={vi.fn()}
        videoR2={{ row: row({ enabled: true, copyState: 'ready' }), onToggle }}
      />
    );
    expect(screen.getAllByRole('button')[5]!.getAttribute('aria-label')).toMatch(
      / · Copy ready, sheet still on Drive: Catalog$/u
    );
    expect(catalogVideoR2Sentence(row({ enabled: true, copyState: 'ready' }), key => key)).toBe(
      'catalogVideoR2PanelCopied'
    );
    view.rerender(
      <CatalogIconControls
        profile={profile}
        name="Catalog"
        onChange={vi.fn()}
        videoR2={{
          row: row({ enabled: true, reason: 'VIDEO_R2_QUOTA_EXCEEDED' }),
          disabledReason: 'No permission',
          onToggle
        }}
      />
    );
    const locked = screen.getAllByRole('button')[5]!;
    expect(locked.getAttribute('aria-label')).toMatch(/R2 video limit.*No permission/u);
    fireEvent.click(locked);
    expect(onToggle).not.toHaveBeenCalled();
  });
  it('appears in the icon legend only where R2 is offered', () => {
    const view = render(<CatalogIconLegend teamId={TEAM} onOpenSettings={vi.fn()} />);
    expect(screen.queryByText('Copy the video to R2')).toBeNull();
    view.rerender(<CatalogIconLegend teamId={TEAM} onOpenSettings={vi.fn()} videoR2 />);
    expect(screen.getByText('Copy the video to R2')).toBeTruthy();
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
