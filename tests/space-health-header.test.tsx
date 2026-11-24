// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { StorageHealth } from '@video-compressor/shared';
import { AgentContextOverride, type AgentContextValue } from '../apps/web/src/AgentContext';
import type { CatalogUpdaterState } from '../apps/web/src/api/team';
import { ToastProvider } from '../apps/web/src/components/toast';
import { TeamContextOverride, type TeamContextValue } from '../apps/web/src/team/TeamContext';
import type { TeamRealtimeState } from '../apps/web/src/team/useTeamRealtime';
import { SpaceHealth, type SpaceHealthProps } from '../apps/web/src/team/workspace/SpaceHealth';
import { fakeAgentValue } from './support/fake-agent';

/**
 * The quiet header (070, US5, T028, T031): one indicator while everything works, the source's
 * own chip — word and action — when something needs a person, never more than two, and the rest
 * in the panel. A reconnect pressed in the panel is counted on the same surface as the chip's.
 */

const TEAM_ID = '20000000-0000-4000-8000-000000000070';
const connected: StorageHealth = { kind: 'connected', lastReconciledAt: new Date().toISOString() };

function teamContext(realtimeState: TeamRealtimeState = 'connected'): TeamContextValue {
  return {
    teams: [],
    activeTeamId: TEAM_ID,
    activeTeam: null,
    permissions: null,
    loading: false,
    error: null,
    revision: 0,
    realtimeState,
    realtimeConnectionState: realtimeState,
    membershipLostTeamId: null,
    acknowledgeMembershipLoss: vi.fn(),
    hasEnteredSpace: true,
    setActiveTeamId: vi.fn(),
    enterSpace: vi.fn(),
    leaveSpace: vi.fn(),
    replaceTeams: vi.fn(),
    refreshTeams: vi.fn().mockResolvedValue(undefined),
    notifyStateChanged: vi.fn(),
    retryRealtime: vi.fn(),
    can: () => false
  };
}

const updater = (overrides: Partial<CatalogUpdaterState> = {}): CatalogUpdaterState => ({
  state: 'running',
  interval: { kind: 'hours', value: 6 } as CatalogUpdaterState['interval'],
  restitch: false,
  nextRunAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
  startedAt: new Date().toISOString(),
  catalogCount: 2,
  failingCount: 0,
  spareReadyCount: null,
  activeCount: 0,
  restitchBlockedCode: null,
  serverNow: new Date().toISOString(),
  ...overrides
});

function props(overrides: Partial<SpaceHealthProps> = {}): SpaceHealthProps {
  return {
    teamId: TEAM_ID,
    client: {},
    storage: connected,
    staleSince: null,
    onRefreshStorage: vi.fn(),
    isOwner: true,
    canManage: true,
    settingsHref: '/settings',
    storageOpen: false,
    onStorageOpenChange: vi.fn(),
    updater: updater(),
    updaterOffsetMs: 0,
    updaterHref: '/updater',
    onUpdaterNavigate: vi.fn(),
    onOpenProcess: vi.fn(),
    ...overrides
  };
}

function renderHealth(
  overrides: Partial<SpaceHealthProps> = {},
  {
    agent = fakeAgentValue(),
    realtime = 'connected' as TeamRealtimeState
  }: { agent?: AgentContextValue; realtime?: TeamRealtimeState } = {}
) {
  return render(
    <ToastProvider>
      <AgentContextOverride value={agent}>
        <TeamContextOverride value={teamContext(realtime)}>
          <SpaceHealth {...props(overrides)} />
        </TeamContextOverride>
      </AgentContextOverride>
    </ToastProvider>
  );
}

const lostAgent = (reconnect = vi.fn()) =>
  fakeAgentValue({
    connection: 'disconnected',
    teamWorkspaceAvailable: false,
    teamWorkspaceAvailability: 'disconnected',
    reconnect
  });

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('language', 'en');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the space health in the header', () => {
  it('is one indicator and no chip while everything works (SC-005)', () => {
    const view = renderHealth();
    expect(view.container.querySelectorAll('.ui-chip')).toHaveLength(0);
    // The schedule waiting for its next run is not news; it is a row in the panel.
    expect(screen.queryByText('Scheduled')).toBeNull();
    const indicator = screen.getByRole('button', { name: 'Space status: all working' });
    expect(indicator.textContent).toContain('All working');

    fireEvent.click(indicator);
    const panel = screen.getByRole('dialog', { name: 'Space status' });
    const rows = within(panel).getAllByRole('listitem');
    expect(rows.map(row => row.querySelector('strong')?.textContent)).toEqual([
      'Storage',
      'Soty on this computer',
      'Live updates',
      'Processing',
      'Catalog updates'
    ]);
    expect(rows.every(row => row.getAttribute('data-tone') === 'ok')).toBe(true);
    expect(within(panel).getByText('Nothing is running')).toBeTruthy();
  });

  it('shows the one source that needs a person as its own chip, with a word and an action', () => {
    const view = renderHealth({}, { agent: lostAgent() });
    expect(screen.queryByRole('button', { name: 'Space status: all working' })).toBeNull();
    expect(screen.getByText('Connect Soty')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
    expect(view.container.querySelectorAll('.ui-chip')).toHaveLength(1);
  });

  it('shows at most two chips and folds the rest into «N more», which opens the panel', () => {
    const view = renderHealth(
      {
        storage: { kind: 'attention', reason: 'needs_reauth', fixer: 'owner' },
        updater: updater({ failingCount: 1 })
      },
      { agent: lostAgent(), realtime: 'disabled' }
    );
    const chips = [...view.container.querySelectorAll('.team-space-health .ui-chip')];
    expect(chips.map(chip => chip.textContent)).toEqual([
      'View only · Drive disconnected',
      'Connect Soty',
      '2 more'
    ]);
    fireEvent.click(screen.getByRole('button', { name: /2 more need attention/u }));
    const panel = screen.getByRole('dialog', { name: 'Space status' });
    const tones = within(panel)
      .getAllByRole('listitem')
      .map(row => row.getAttribute('data-tone'));
    expect(tones).toEqual(['attention', 'attention', 'attention', 'ok', 'attention']);
    expect(within(panel).getByText('Live updates off')).toBeTruthy();
  });

  it('says several jobs once: one chip with the count', () => {
    renderHealth({
      storage: { kind: 'indexing', indexedFolders: 1, totalFolders: 4, files: 10 },
      updater: updater({ activeCount: 2 })
    });
    expect(screen.getByText('Background work · 2')).toBeTruthy();
    expect(screen.queryByText(/Indexing/u)).toBeNull();
  });

  it('lets one job speak for itself', () => {
    renderHealth({ storage: { kind: 'indexing', indexedFolders: 1, totalFolders: 4, files: 10 } });
    expect(screen.getByText(/Indexing/u)).toBeTruthy();
    expect(screen.queryByText(/Background work/u)).toBeNull();
  });

  it('opens the storage detail from the panel row, through its address', () => {
    const onStorageOpenChange = vi.fn();
    renderHealth({ onStorageOpenChange });
    fireEvent.click(screen.getByRole('button', { name: 'Space status: all working' }));
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(onStorageOpenChange).toHaveBeenCalledWith(true);
  });
});

describe('the header’s analytics after the move (T031)', () => {
  it('counts a reconnect from the panel on the team shell surface, as the chip did', () => {
    const reconnect = vi.fn();
    // Three sources need a person, so the agent's chip is folded into the panel.
    renderHealth(
      {
        storage: { kind: 'attention', reason: 'needs_reauth', fixer: 'owner' },
        updater: updater({ failingCount: 1 })
      },
      { agent: lostAgent(reconnect), realtime: 'disabled' }
    );
    // The chip is the first two: storage and the agent. Folding moves live updates and the
    // updater; the agent's reconnect is in the panel too, on the same surface.
    fireEvent.click(screen.getByRole('button', { name: /more need attention/u }));
    const panel = screen.getByRole('dialog', { name: 'Space status' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Reconnect' }));
    expect(reconnect).toHaveBeenCalledWith('team_shell');
  });
});
