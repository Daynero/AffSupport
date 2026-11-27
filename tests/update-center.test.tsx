// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StableReleaseManifest } from '../packages/shared/src/release';
import { AgentContextOverride, type AgentContextValue } from '../apps/web/src/AgentContext';
import { fakeAgentValue } from './support/fake-agent';
import { nativeCandidate, nativeSnapshot } from './support/native-app-updates';
import { UpdateCenterProvider } from '../apps/web/src/updates/UpdateCenter';
import { HeaderUpdateButton } from '../apps/web/src/updates/HeaderUpdateButton';
import { WhatsNewOverlay } from '../apps/web/src/updates/WhatsNewOverlay';
import { OPEN_NATIVE_APP_UPDATE } from '../apps/web/src/updates/openNativeAppUpdate';
import { analytics } from '../apps/web/src/analytics/service';

const mock = vi.hoisted(() => ({ hook: vi.fn(), act: vi.fn(), refresh: vi.fn() }));
vi.mock('../apps/web/src/updates/useNativeAppUpdate', () => ({ useNativeAppUpdate: mock.hook }));

const SEEN = 'soty.whats-new.seen.v1';

function manifest(version = '0.6.2', build = '14'): StableReleaseManifest {
  return {
    schemaVersion: 1,
    channel: 'stable',
    version,
    buildNumber: build,
    buildId: `${version}+${build}`,
    apiVersion: 5,
    minimumSupportedVersion: '0.4.0',
    publishedAt: '2026-07-21T12:00:00.000Z',
    summary: { en: 'Faster catalogs.', uk: 'Швидші каталоги.' },
    artifacts: {
      'macos-arm64': {
        url: `https://github.com/Daynero/AffSupport/releases/download/v${version}/Soty-v${version}.dmg`,
        sha256: 'a'.repeat(64)
      }
    },
    toolRequirements: {
      compressor: { compressor: 2 },
      landingOptimizer: { landingOptimizer: 2 },
      landingPreview: { landingPreview: 1 },
      transcription: { transcription: 5 },
      teamWorkspace: {},
      stitcher: {}
    }
  };
}

function agent(overrides: Partial<AgentContextValue> = {}): AgentContextValue {
  return fakeAgentValue({
    agentRuntime: { platform: 'macos', architecture: 'arm64' },
    agentVersion: '0.6.1',
    agentBuildId: '0.6.1+13',
    releaseManifest: { status: 'ready', manifest: manifest() },
    ...overrides
  });
}

function page(value: AgentContextValue) {
  return (
    <AgentContextOverride value={value}>
      <UpdateCenterProvider>
        <header>
          <HeaderUpdateButton />
        </header>
        <WhatsNewOverlay />
      </UpdateCenterProvider>
    </AgentContextOverride>
  );
}

function native(overrides: Partial<ReturnType<typeof nativeSnapshot>> | null) {
  const state = overrides === null ? null : { ...nativeSnapshot(), ...overrides };
  mock.hook.mockReturnValue({
    state,
    pending: false,
    error: false,
    act: mock.act,
    refresh: mock.refresh
  });
  return state;
}

const header = () => screen.getByRole('banner');
const updateButton = () => header().querySelector<HTMLButtonElement>('[data-update-button]');

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('language', 'en');
  mock.act.mockReset();
  mock.act.mockResolvedValue(undefined);
  mock.refresh.mockReset();
  mock.refresh.mockResolvedValue(undefined);
  native(null);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('074 — the update in the header and «What’s new»', () => {
  it('shows «What’s new» once per build and keeps the header button after «Later»', async () => {
    const track = vi.spyOn(analytics, 'track');
    const view = render(page(agent()));
    const dialog = await screen.findByRole('dialog', { name: 'Soty 0.6.2 is ready' });
    expect(dialog.textContent).toContain('Faster catalogs.');
    expect(localStorage.getItem(SEEN)).toBe('0.6.2+14');
    expect(track).toHaveBeenCalledWith('update_prompt_shown', {});
    await userEvent.click(screen.getByRole('button', { name: 'Later' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(track).toHaveBeenCalledWith('update_dismissed', {});
    // Put away into the header: the button stays and glows.
    expect(updateButton()).toBeTruthy();
    await waitFor(() => expect(updateButton()?.dataset.glow).toBe('true'));
    view.unmount();
    render(page(agent()));
    expect(updateButton()).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('waits for another open dialog before it shows', async () => {
    localStorage.setItem(SEEN, 'older');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const other = document.createElement('div');
      other.setAttribute('aria-modal', 'true');
      document.body.append(other);
      render(page(agent()));
      expect(screen.queryByRole('dialog', { name: 'Soty 0.6.2 is ready' })).toBeNull();
      other.remove();
      await act(async () => {
        vi.advanceTimersByTime(2_100);
      });
      expect(screen.getByRole('dialog', { name: 'Soty 0.6.2 is ready' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts an installer update from the header in one press', async () => {
    localStorage.setItem(SEEN, '0.6.2+14');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const track = vi.spyOn(analytics, 'track');
    render(page(agent()));
    const button = updateButton()!;
    expect(button.getAttribute('aria-label')).toContain('Update');
    await userEvent.click(button);
    expect(click).toHaveBeenCalledOnce();
    expect(track).toHaveBeenCalledWith('update_started', { installer_target: 'macos-arm64' });
    expect(updateButton()?.textContent).toContain('Open the installer');
  });

  it('downloads and then installs a native update after one press', async () => {
    localStorage.setItem(SEEN, '9.0.0+999');
    native({ stage: 'offered', availableActions: ['prepare', 'defer'], downloadedBytes: 0 });
    const value = agent({
      capabilities: ['native-app-updates-v1'],
      agentRuntime: { platform: 'macos', architecture: 'arm64', packageTarget: 'macos-arm64' },
      releaseManifest: {
        status: 'ready',
        manifest: { ...manifest(), nativeUpdates: { 'macos-arm64': nativeCandidate() } }
      }
    });
    const view = render(page(value));
    await userEvent.click(updateButton()!);
    expect(mock.act).toHaveBeenCalledExactlyOnceWith('prepare');
    native({
      stage: 'preparing',
      availableActions: ['cancel'],
      downloadedBytes: 2,
      totalBytes: 4,
      revision: 2
    });
    view.rerender(page(value));
    expect(updateButton()?.dataset.phase).toBe('downloading');
    expect(updateButton()?.dataset.ring).toBe('');
    native({ stage: 'prepared', availableActions: ['accept', 'defer', 'cancel'], revision: 3 });
    view.rerender(page(value));
    await waitFor(() => expect(mock.act).toHaveBeenLastCalledWith('accept'));
    view.rerender(page(value));
    expect(mock.act.mock.calls.filter(([step]) => step === 'accept')).toHaveLength(1);
  });

  it('opens the details while an update runs, and warns when it needs attention', async () => {
    native({ stage: 'draining', availableActions: ['cancel'] });
    const value = agent({
      capabilities: ['native-app-updates-v1'],
      agentRuntime: { platform: 'macos', architecture: 'arm64', packageTarget: 'macos-arm64' }
    });
    const opened = vi.fn();
    window.addEventListener(OPEN_NATIVE_APP_UPDATE, opened);
    const view = render(page(value));
    expect(updateButton()?.dataset.phase).toBe('waiting');
    await userEvent.click(updateButton()!);
    expect(opened).toHaveBeenCalledOnce();
    expect(mock.act).not.toHaveBeenCalled();
    native({ stage: 'failed', code: 'APP_UPDATE_DOWNLOAD_FAILED', availableActions: ['prepare'] });
    view.rerender(page(value));
    expect(updateButton()?.dataset.phase).toBe('attention');
    window.removeEventListener(OPEN_NATIVE_APP_UPDATE, opened);
  });

  it('has nothing to show on an up-to-date or absent app', () => {
    render(page(agent({ agentVersion: '0.6.2' })));
    expect(updateButton()).toBeNull();
    cleanup();
    render(page(agent({ connection: 'not_installed_or_not_running', agentVersion: null })));
    expect(updateButton()).toBeNull();
  });
});
