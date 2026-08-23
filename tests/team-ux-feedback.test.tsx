// @vitest-environment jsdom
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEAM_ERROR_CODES } from '@video-compressor/shared';
import { ToastProvider } from '../apps/web/src/components/toast';
import { SyncProgress } from '../apps/web/src/team/SyncProgress';
import { ProvenancePanel } from '../apps/web/src/team/catalog/ProvenancePanel';
import { MaterialRowMenu } from '../apps/web/src/team/catalog/MaterialRowMenu';
import { teamErrorMessage } from '../apps/web/src/team/errors';
import { translationKeys, translate } from '../apps/web/src/i18n';
import type { MaterialActionsClient } from '../apps/web/src/team/catalog/material-actions-client';
import { RealtimeChip } from '../apps/web/src/team/workspace/RealtimeChip';
import { MembershipLostNotice } from '../apps/web/src/team/TeamSpace';
import { TeamContextOverride, type TeamContextValue } from '../apps/web/src/team/TeamContext';
import type { TeamRealtimeState } from '../apps/web/src/team/useTeamRealtime';

/**
 * US3 — every action has a visible result.
 *
 * The findings behind these: raw machine codes rendered into the page (S1),
 * silent no-ops (S2), a sync banner that could contradict itself and never
 * showed failure (S4), and a channel that could drop without a word (S5).
 */

const TEAM_ID = '20000000-0000-4000-8000-000000000001';

afterEach(() => {
  vi.restoreAllMocks();
});

/** The slice of team context these two components actually read. */
function teamContext(realtimeState: TeamRealtimeState): TeamContextValue {
  return {
    teams: [],
    activeTeamId: TEAM_ID,
    activeTeam: null,
    permissions: null,
    loading: false,
    error: null,
    revision: 0,
    realtimeState,
    membershipLostTeamId: null,
    acknowledgeMembershipLoss: vi.fn(),
    hasEnteredSpace: true,
    setActiveTeamId: vi.fn(),
    enterSpace: vi.fn(),
    leaveSpace: vi.fn(),
    replaceTeams: vi.fn(),
    refreshTeams: vi.fn().mockResolvedValue(undefined),
    notifyStateChanged: vi.fn(),
    can: () => false
  };
}

const permissions = {
  view: true,
  download: true,
  upload: true,
  edit: true,
  delete: true,
  process: true,
  manage_members: false,
  manage_metadata: false
};

const material = {
  id: 'material-1',
  teamId: TEAM_ID,
  name: 'launch.mp4',
  kind: 'file' as const,
  fileExtension: 'mp4',
  sizeBytes: 1024
};

function actionsClient(): MaterialActionsClient {
  return {
    uploadFile: vi.fn(),
    requestDownload: vi.fn(),
    downloadWithAgent: vi.fn(),
    renameMaterial: vi.fn().mockResolvedValue({ operationId: 'op', state: 'succeeded' }),
    moveMaterial: vi.fn(),
    trashMaterial: vi.fn().mockResolvedValue({ operationId: 'op', state: 'succeeded' }),
    restoreMaterial: vi.fn()
  };
}

async function openMenu(client: MaterialActionsClient) {
  render(
    <ToastProvider>
      <MaterialRowMenu
        teamId={TEAM_ID}
        material={material}
        permissions={permissions}
        client={client}
        browseClient={{ listMaterials: vi.fn().mockResolvedValue([]) }}
        onChanged={vi.fn()}
      />
    </ToastProvider>
  );
  await userEvent.click(screen.getByRole('button', { name: 'Actions for launch.mp4' }));
}

describe('every action reports its outcome', () => {
  it('confirms a success out loud', async () => {
    const client = actionsClient();
    await openMenu(client);

    await userEvent.click(screen.getByRole('button', { name: 'Move to trash' }));
    expect(await screen.findByText('Moved to trash')).toBeTruthy();
  });

  it('turns a failure code into a sentence, and never shows the code itself', async () => {
    const client = actionsClient();
    vi.mocked(client.trashMaterial).mockRejectedValue(new Error('PERMISSION_DENIED'));
    await openMenu(client);

    await userEvent.click(screen.getByRole('button', { name: 'Move to trash' }));
    expect(await screen.findByText('You do not have permission for this.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('PERMISSION_DENIED');
  });

  it('says something human even for a code it has never met', async () => {
    const client = actionsClient();
    vi.mocked(client.trashMaterial).mockRejectedValue(new Error('SOMETHING_NEW_FROM_A_MIGRATION'));
    await openMenu(client);

    await userEvent.click(screen.getByRole('button', { name: 'Move to trash' }));
    expect(await screen.findByText('Something went wrong. Try again in a moment.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('SOMETHING_NEW');
  });
});

describe('the code→copy mapper', () => {
  it('has a sentence for every code in the shared contract', () => {
    const t = (key: (typeof translationKeys)[number]) => translate('en', key);
    const generic = t('teamErrorUnknown');
    for (const code of TEAM_ERROR_CODES) {
      expect(teamErrorMessage(code, t), code).not.toBe(generic);
    }
  });

  it('falls back rather than leaking an unknown code', () => {
    const t = (key: (typeof translationKeys)[number]) => translate('en', key);
    expect(teamErrorMessage('NOT_A_REAL_CODE', t)).toBe(t('teamErrorUnknown'));
    expect(teamErrorMessage(null, t)).toBe(t('teamErrorUnknown'));
  });
});

describe('the sync banner', () => {
  const freshness = (state: 'ready' | 'failed' | 'unavailable' | 'scanning') => ({
    state,
    lastSyncedAt: null,
    discoveredCount: 0,
    foldersRemaining: null,
    lastProgressAt: null
  });

  it('renders a failed sync with a way to try again', async () => {
    const onRetry = vi.fn();
    render(<SyncProgress freshness={freshness('failed')} onRetry={onRetry} />);

    expect(screen.getByText('The last sync with Google Drive failed')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('explains an unreachable Drive, without offering a retry that cannot help', () => {
    render(<SyncProgress freshness={freshness('unavailable')} />);

    expect(screen.getByText('Google Drive is not reachable')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('stays quiet when everything is up to date', () => {
    const { container } = render(<SyncProgress freshness={freshness('ready')} />);
    expect(container.textContent).toBe('');
  });
});

describe('provenance', () => {
  it('says the history is empty rather than rendering nothing', () => {
    render(<ProvenancePanel materialId="material-1" entries={[]} onNavigate={vi.fn()} />);
    expect(screen.getByText('No history was recorded for this file.')).toBeTruthy();
  });
});

describe('toasts', () => {
  it('can be dismissed by the reader', async () => {
    const client = actionsClient();
    vi.mocked(client.trashMaterial).mockRejectedValue(new Error('RATE_LIMITED'));
    await openMenu(client);
    await userEvent.click(screen.getByRole('button', { name: 'Move to trash' }));

    expect(await screen.findByText('Too many requests. Wait a moment and try again.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    await waitFor(() =>
      expect(screen.queryByText('Too many requests. Wait a moment and try again.')).toBeNull()
    );
  });
});

describe('the realtime chip', () => {
  it('stays quiet on a healthy channel and speaks on a degraded one', async () => {
    const healthy = render(
      <TeamContextOverride value={teamContext('connected')}>
        <RealtimeChip />
      </TeamContextOverride>
    );
    expect(healthy.container.textContent).toBe('');
    healthy.unmount();

    render(
      <TeamContextOverride value={teamContext('disabled')}>
        <RealtimeChip />
      </TeamContextOverride>
    );
    expect(await screen.findByText('Live updates off')).toBeTruthy();
  });
});

describe('losing membership mid-session', () => {
  it('explains it, and the explanation does not dismiss itself', async () => {
    const acknowledge = vi.fn();
    render(
      <TeamContextOverride
        value={{
          ...teamContext('connected'),
          membershipLostTeamId: TEAM_ID,
          acknowledgeMembershipLoss: acknowledge
        }}
      >
        <ToastProvider>
          <MembershipLostNotice />
        </ToastProvider>
      </TeamContextOverride>
    );

    expect(
      await screen.findByText('You were removed from this space, so it is no longer open.')
    ).toBeTruthy();
    // Acknowledged so it cannot fire again; sticky so it outlives the screen
    // changing underneath it.
    expect(acknowledge).toHaveBeenCalledOnce();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(
      screen.getByText('You were removed from this space, so it is no longer open.')
    ).toBeTruthy();
  });
});
