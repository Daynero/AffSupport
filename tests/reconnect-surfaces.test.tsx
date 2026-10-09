// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Session, User } from '@supabase/supabase-js';
import type { CatalogMaterialItem, LandingPreviewState } from '@video-compressor/shared';
import type { Profile } from '../apps/web/src/lib/database.types';
import type { AgentContextValue } from '../apps/web/src/AgentContext';
import type { LandingViewerSource } from '../apps/web/src/landing-viewer/types.js';
import { fakeAgentValue } from './support/fake-agent';
import { emptyQueueState } from './web-auth-helpers';

/**
 * 032, US2 / FR-010 / FR-011: the way back sits beside every "not connected".
 *
 * One mutable fake of the local app for the whole file, read on every render,
 * so a test can let the link drop, press the action, let the attempt run and
 * end, and look at what each surface said at each step.
 */
const current = vi.hoisted(() => ({ value: null as unknown as AgentContextValue }));
vi.mock('../apps/web/src/AgentContext.js', async importOriginal => {
  const real = await importOriginal<typeof import('../apps/web/src/AgentContext.js')>();
  return {
    ...real,
    useAgent: () => current.value,
    useOptionalAgent: () => current.value,
    useAgentStatus: () => current.value
  };
});
vi.mock('../apps/web/src/analytics/service.js', () => ({
  analytics: { track: vi.fn(), setLocale: vi.fn(), setAgentContext: vi.fn() }
}));
vi.mock('../apps/web/src/lib/supabase', () => ({
  withFreshSession: <T,>(run: () => PromiseLike<T>) => run(),
  requireSupabaseClient: () => ({ rpc: vi.fn() })
}));
// The stitcher page's library and transport: not what this file is about.
vi.mock('../apps/web/src/stitcher/api', () => ({
  inspectStitchSource: vi.fn(),
  addStitchFiles: vi.fn(),
  startStitchJobs: vi.fn(),
  selectStitchSources: vi.fn(),
  resolveDroppedVideo: vi.fn(),
  selectStitchFolder: vi.fn(),
  cancelStitch: vi.fn(),
  fetchStitcherState: vi.fn(),
  updateStitcherSettings: vi.fn(),
  revealStitchOutput: vi.fn(),
  openStitchOutput: vi.fn(),
  repeatStitch: vi.fn(),
  removeStitch: vi.fn(),
  clearFinishedStitches: vi.fn(),
  fetchCompressorState: vi.fn(async () => ({ settings: { imageEmbedding: null } })),
  updateCompressorSettings: vi.fn(),
  uploadScreenImage: vi.fn(),
  removeScreenImage: vi.fn()
}));
vi.mock('../apps/web/src/api/useSubresourceUrl', () => ({ useSubresourceUrl: () => null }));
vi.mock('../apps/web/src/api/useAgentEventStream', () => ({ useAgentEventStream: () => {} }));
vi.mock('../apps/web/src/api/stream-client.js', () => ({
  streamClient: { subscribe: vi.fn(() => () => {}), watchConnection: vi.fn(() => () => {}) }
}));

import { ConnectionBadge } from '../apps/web/src/App';
import { ReconnectAction } from '../apps/web/src/components/ReconnectAction';
import LocalAppDialog from '../apps/web/src/components/LocalAppDialog';
import { PowerReadout } from '../apps/web/src/components/PowerReadout';
import { PowerContextOverride, type PowerContextValue } from '../apps/web/src/lib/power';
import { AuthContextOverride, type AuthContextValue } from '../apps/web/src/auth/AuthContext';
import { adminAuthStub } from './support/auth-stub.js';
import AccountPage from '../apps/web/src/pages/AccountPage';
import { Stitcher } from '../apps/web/src/stitcher/StitcherPage';
import {
  StitcherContextOverride,
  type StitcherStore
} from '../apps/web/src/stitcher/StitcherContext';
import { LandingViewer } from '../apps/web/src/landing-viewer/LandingViewer.js';
import { useLandingViewer } from '../apps/web/src/landing-viewer/useLandingViewer.js';
import { AgentLinkChip } from '../apps/web/src/team/workspace/AgentLinkChip';
import {
  MaterialPreview,
  type MaterialPreviewClient
} from '../apps/web/src/team/preview/MaterialPreview';
import { translate, type TranslationKey } from '../apps/web/src/i18n';

const t = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate('uk', key, values);

const RECONNECT = 'Перепідключити';
const RECONNECTING = 'Перепідключаємось…';

/** A link that was there and dropped: the state every surface here is about. */
function lost(overrides: Partial<AgentContextValue> = {}): AgentContextValue {
  return fakeAgentValue({
    connection: 'disconnected',
    reason: 'not_running',
    state: emptyQueueState,
    toolAvailable: () => false,
    toolAvailability: () => 'disconnected',
    teamWorkspaceAvailable: false,
    teamWorkspaceAvailability: 'disconnected',
    lastKnownAgent: {
      version: '1.0.3',
      buildId: 'test-build',
      instanceId: 'run-one',
      channel: 'stable',
      capabilities: [],
      toolContracts: {},
      seenAt: Date.now()
    },
    reconnect: vi.fn(),
    ...overrides
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('language', 'uk');
  history.replaceState(null, '', '/');
  current.value = lost();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the reconnect action', () => {
  it('asks the context to reconnect from its surface, and is never disabled', () => {
    render(<ReconnectAction surface="home" />);
    const button = screen.getByRole('button', { name: RECONNECT });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    expect(current.value.reconnect).toHaveBeenCalledWith('home');
  });

  it('shows the attempt while one runs and stays pressable so a second press joins it', () => {
    current.value = lost({
      attempt: { id: 'a1', startedAt: 1, trigger: 'manual', stage: 'probe', joined: false }
    });
    render(<ReconnectAction surface="stitcher" />);
    const button = screen.getByRole('button', { name: RECONNECTING });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.querySelector('.ui-spinner')).not.toBeNull();
    fireEvent.click(button);
    expect(current.value.reconnect).toHaveBeenCalledWith('stitcher');
  });

  it('says "connected" for a moment when the attempt it asked for succeeds', () => {
    vi.useFakeTimers();
    const view = render(<ReconnectAction surface="account" />);
    fireEvent.click(screen.getByRole('button', { name: RECONNECT }));

    current.value = lost({
      connection: 'connecting',
      attempt: { id: 'a2', startedAt: 1, trigger: 'manual', stage: 'health', joined: false }
    });
    view.rerender(<ReconnectAction surface="account" />);
    expect(screen.getByRole('button', { name: RECONNECTING })).toBeTruthy();

    current.value = fakeAgentValue({ reconnect: current.value.reconnect });
    view.rerender(<ReconnectAction surface="account" />);
    expect(screen.getByRole('status').textContent).toBe('Підключено');
    // The action does not vanish once the link is back (FR-011).
    expect(screen.getByRole('button', { name: RECONNECT })).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('names the reason when the attempt fails', () => {
    const view = render(<ReconnectAction surface="power" />);
    fireEvent.click(screen.getByRole('button', { name: RECONNECT }));
    current.value = lost({
      attempt: { id: 'a3', startedAt: 1, trigger: 'manual', stage: 'probe', joined: false }
    });
    view.rerender(<ReconnectAction surface="power" />);
    current.value = lost({ reason: 'pairing_rejected' });
    view.rerender(<ReconnectAction surface="power" />);
    expect(screen.getByRole('status').textContent).toBe(t('linkReasonPairingRejected'));
  });
});

describe('the header badge', () => {
  it('carries the action when the link is lost, and not while it is there', () => {
    const view = render(<ConnectionBadge state="disconnected" t={t} />);
    expect(screen.getByRole('button', { name: RECONNECT })).toBeTruthy();
    view.rerender(<ConnectionBadge state="connected" t={t} />);
    expect(screen.queryByRole('button', { name: RECONNECT })).toBeNull();
  });

  it('offers the Agent copy of this page, not a retry, when the browser blocks loopback', () => {
    history.replaceState(null, '', '/transcription');
    render(<ConnectionBadge state="connection_blocked" t={t} />);
    expect(screen.getByText('Браузер блокує з’єднання з Soty')).toBeTruthy();
    expect(screen.queryByRole('button', { name: RECONNECT })).toBeNull();
    expect(screen.getByRole('link', { name: 'Відкрити в Soty' }).getAttribute('href')).toBe(
      'http://127.0.0.1:43120/local?to=%2Ftranscription'
    );
  });
});

describe('the account page', () => {
  const user = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'owner@example.com',
    app_metadata: { provider: 'google' },
    user_metadata: {},
    aud: 'authenticated',
    created_at: '2026-07-18T00:00:00.000Z'
  } as User;
  const session = { user, access_token: 't', refresh_token: 't', expires_in: 3600 } as Session;
  const profile: Profile = {
    id: user.id,
    email: user.email ?? null,
    display_name: 'Owner',
    avatar_url: null,
    language: 'uk',
    plan: 'free',
    account_status: 'active',
    marketing_consent: false,
    marketing_consent_at: null,
    created_at: '2026-07-18T00:00:00.000Z',
    updated_at: '2026-07-18T00:00:00.000Z',
    last_seen_at: '2026-07-18T00:00:00.000Z',
    onboarding_completed: true
  };
  const auth = (): AuthContextValue => adminAuthStub({ user, session, profile, isAdmin: false });

  it('keeps the action after a loss and marks the version as last seen, not current', () => {
    // The version is kept across a loss so other screens can choose between
    // "open" and "download"; here it used to hide Connect for ever and show the
    // old version as the current one (032 W8).
    current.value = lost({ agentVersion: '1.0.3' });
    render(
      <AuthContextOverride value={auth()}>
        <AccountPage />
      </AuthContextOverride>
    );
    const section = document.querySelector('.account-local-app') as HTMLElement;
    expect(within(section).getByRole('button', { name: RECONNECT })).toBeTruthy();
    expect(within(section).getByText('Востаннє бачили версію 1.0.3')).toBeTruthy();
    expect(within(section).getByText(t('accountLocalAppStateOffline'))).toBeTruthy();
  });

  it('shows the version as current, and no action, while connected', () => {
    current.value = fakeAgentValue({ state: emptyQueueState });
    render(
      <AuthContextOverride value={auth()}>
        <AccountPage />
      </AuthContextOverride>
    );
    const section = document.querySelector('.account-local-app') as HTMLElement;
    expect(within(section).queryByRole('button', { name: RECONNECT })).toBeNull();
    expect(within(section).getByText('1.0.3')).toBeTruthy();
  });
});

describe('the other surfaces', () => {
  it('local app dialog', () => {
    render(<LocalAppDialog tool="compressor" connection="disconnected" />);
    expect(screen.getByRole('button', { name: RECONNECT })).toBeTruthy();
  });

  it('power panel', () => {
    const value: PowerContextValue = {
      state: null,
      status: 'offline',
      limitPercent: 100,
      setLimit: vi.fn(),
      watch: vi.fn(() => () => {}),
      error: null,
      limitApplied: false
    };
    render(
      <PowerContextOverride value={value}>
        <PowerReadout />
      </PowerContextOverride>
    );
    expect(screen.getByText(t('powerAgentOffline'))).toBeTruthy();
    expect(screen.getByRole('button', { name: RECONNECT })).toBeTruthy();
  });

  it('stitcher', () => {
    const store: StitcherStore = {
      state: {
        settings: { destination: { kind: 'beside' }, outputSuffix: '' },
        jobs: [],
        busy: false
      },
      connected: false,
      refresh: vi.fn(),
      applyState: vi.fn(),
      updateSettings: vi.fn()
    };
    render(
      <StitcherContextOverride value={store}>
        <Stitcher />
      </StitcherContextOverride>
    );
    expect(screen.getByText(t('agentDisconnected'))).toBeTruthy();
    expect(screen.getByRole('button', { name: RECONNECT })).toBeTruthy();
  });

  it('landing preview, when the live stream reports the link lost', async () => {
    const state: LandingPreviewState = {
      catalogs: [
        { id: 'c1', name: 'Team space', landingCount: 1, lastOpenedAt: 1, sourceAvailable: true }
      ],
      activeCatalogId: 'c1',
      activeCatalogName: 'Team space',
      landings: [
        {
          id: 'landing-a',
          name: 'Acme',
          relativePath: 'acme',
          sourceKind: 'team',
          sourceRelativePath: 'acme',
          archiveRoot: null,
          extractedAvailable: false,
          status: 'ready',
          stale: false,
          previewAvailable: true,
          previewWidth: 1440,
          previewHeight: 2200,
          renderedAt: 10,
          blockedExternalRequests: 0,
          warning: null,
          error: null
        }
      ],
      running: false,
      progress: { phase: 'completed', completed: 1, total: 1, currentLandingId: null },
      renderer: { available: true, error: null },
      settings: { device: 'desktop', colorScheme: 'light' },
      warnings: [],
      error: null,
      updatedAt: Date.now()
    };
    let onStatus: ((status: 'open' | 'lost') => void) | null = null;
    const source: LandingViewerSource = {
      capabilities: {
        chooseFolder: false,
        openPaths: false,
        refresh: false,
        cancel: false,
        reveal: false,
        openExtracted: false,
        clearCache: false,
        removeCatalog: false,
        settings: false
      },
      fetchState: () => Promise.resolve(state),
      subscribe: ({ onStatus: listener }) => {
        onStatus = listener as typeof onStatus;
        return () => {};
      },
      imageUrl: () => 'mem://',
      activate: () => Promise.resolve(state),
      refresh: () => Promise.resolve(state),
      cancel: () => Promise.resolve(state)
    };
    function Harness() {
      const viewer = useLandingViewer({ source });
      return <LandingViewer viewer={viewer} />;
    }
    render(<Harness />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole('button', { name: RECONNECT })).toBeNull();
    act(() => onStatus?.('lost'));
    expect(screen.getByText(t('landingGalleryConnectionLost'))).toBeTruthy();
    expect(screen.getByRole('button', { name: RECONNECT })).toBeTruthy();
  });

  it('team workspace chip: lost asks for the link back; too old asks for the update', () => {
    const view = render(<AgentLinkChip />);
    expect(screen.getByText('Підключіть Soty')).toBeTruthy();
    expect(screen.getByRole('button', { name: RECONNECT })).toBeTruthy();

    current.value = fakeAgentValue({
      teamWorkspaceAvailable: false,
      teamWorkspaceAvailability: 'too_old',
      state: emptyQueueState
    });
    view.rerender(<AgentLinkChip />);
    expect(screen.getByText(t('localAppUpdateTitle'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: RECONNECT })).toBeNull();
    expect(screen.queryByText('Підключіть Soty')).toBeNull();

    current.value = fakeAgentValue({ state: emptyQueueState });
    view.rerender(<AgentLinkChip />);
    expect(view.container.textContent).toBe('');
  });

  it('team material preview, when the local app could not be reached', async () => {
    const client: MaterialPreviewClient = {
      requestPreview: vi.fn().mockRejectedValue(new Error('CONNECTION_FAILED')),
      openAgentArchive: vi.fn(),
      openAgentLanding: vi.fn(),
      closeAgentPreview: vi.fn().mockResolvedValue(undefined)
    };
    const material: CatalogMaterialItem = {
      id: 'material-video',
      teamId: '42000000-0000-4000-8000-000000000001',
      name: 'creative.mp4',
      kind: 'file',
      category: 'video',
      mimeType: 'video/mp4',
      fileExtension: 'mp4',
      classificationVersion: 1,
      classificationSource: 'mime',
      sizeBytes: 1024,
      modifiedAt: '2026-08-01T12:00:00.000Z',
      geo: null,
      language: null,
      offer: null,
      tags: [],
      transcriptIngestState: 'not_applicable',
      transcriptTruncated: false,
      previewState: 'ready',
      lineage: { hasSource: false, hasDerivatives: false, isVersion: false }
    };
    render(
      <MaterialPreview
        teamId={material.teamId}
        material={material}
        client={client}
        onClose={vi.fn()}
      />
    );
    expect(await screen.findByText(t('teamPreviewAgentRequired'))).toBeTruthy();
    expect(screen.getByRole('button', { name: RECONNECT })).toBeTruthy();
  });
});
