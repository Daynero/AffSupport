// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RELEASE_DOWNLOAD_URL, type StableReleaseManifest } from '../packages/shared/src/release';
import { AgentContextOverride, type AgentContextValue } from '../apps/web/src/AgentContext';
import LocalAppDialog from '../apps/web/src/components/LocalAppDialog';
import { emptyQueueState } from './web-auth-helpers';

const WINDOWS_ARTIFACT_URL = 'https://example.com/Wishly-Agent-v0.9.0-Windows-x64.exe';
const MAC_ARTIFACT_URL = 'https://example.com/Wishly-Agent-v0.9.0-macOS-arm64.dmg';

function manifestWith(artifacts: StableReleaseManifest['artifacts']): StableReleaseManifest {
  return {
    schemaVersion: 1,
    channel: 'stable',
    version: '0.9.0',
    buildNumber: '30',
    buildId: '0.9.0+30',
    apiVersion: 5,
    minimumSupportedVersion: '0.4.0',
    publishedAt: '2026-07-29T00:00:00.000Z',
    artifacts,
    toolRequirements: {
      compressor: {},
      landingOptimizer: {},
      landingPreview: {},
      transcription: {}
    }
  };
}

function mockNavigator(platform: string, userAgent: string) {
  vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue(platform);
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(userAgent);
}

function agentValue(): AgentContextValue {
  return {
    connection: 'not_installed_or_not_running',
    state: emptyQueueState,
    setState: vi.fn(),
    connectedOnce: false,
    agentVersion: null,
    agentBuildId: null,
    agentChannel: null,
    agentApiVersion: null,
    capabilities: [],
    toolContracts: {},
    releaseManifest: { status: 'unavailable', manifest: null },
    toolAvailable: () => false,
    reconnect: vi.fn()
  };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('language', 'uk');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('local app platform choices', () => {
  it('always offers Apple Silicon and explains that Windows is still in development', async () => {
    mockNavigator('Win32', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');

    render(
      <AgentContextOverride value={agentValue()}>
        <LocalAppDialog tool="compressor" connection="not_installed_or_not_running" />
      </AgentContextOverride>
    );

    const macLink = screen.getByRole('link', { name: 'Mac (Apple Silicon)' });
    expect(macLink.getAttribute('href')).toBe(RELEASE_DOWNLOAD_URL);

    await userEvent.click(screen.getByRole('button', { name: 'Windows' }));
    expect(screen.getByRole('heading', { name: 'Soty для Windows' })).toBeTruthy();
    expect(screen.getByText('На жаль, версія Soty для Windows ще в розробці.')).toBeTruthy();

    await userEvent.click(screen.getByText('Закрити', { selector: 'button' }));
    expect(screen.queryByText('На жаль, версія Soty для Windows ще в розробці.')).toBeNull();
  });

  it('keeps both platform downloads equally prominent for Windows visitors once shipped', () => {
    mockNavigator('Win32', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    const value = agentValue();
    value.releaseManifest = {
      status: 'ready',
      manifest: manifestWith({
        'macos-arm64': { url: MAC_ARTIFACT_URL, sha256: null },
        'windows-x64': { url: WINDOWS_ARTIFACT_URL, sha256: null }
      })
    };

    render(
      <AgentContextOverride value={value}>
        <LocalAppDialog tool="compressor" connection="not_installed_or_not_running" />
      </AgentContextOverride>
    );

    const windowsLink = screen.getByRole('link', { name: 'Windows' });
    expect(windowsLink.getAttribute('href')).toBe(WINDOWS_ARTIFACT_URL);
    expect(windowsLink.className).toContain('platform-download-button');
    const macLink = screen.getByRole('link', { name: 'Mac (Apple Silicon)' });
    expect(macLink.getAttribute('href')).toBe(MAC_ARTIFACT_URL);
    expect(macLink.className).toContain('platform-download-button');
    // The coming-soon trigger is gone once the artifact exists.
    expect(screen.queryByRole('button', { name: 'Windows' })).toBeNull();
  });

  it('keeps both platform downloads equally prominent for Mac visitors', () => {
    mockNavigator('MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
    const value = agentValue();
    value.releaseManifest = {
      status: 'ready',
      manifest: manifestWith({
        'macos-arm64': { url: MAC_ARTIFACT_URL, sha256: null },
        'windows-x64': { url: WINDOWS_ARTIFACT_URL, sha256: null }
      })
    };

    render(
      <AgentContextOverride value={value}>
        <LocalAppDialog tool="compressor" connection="not_installed_or_not_running" />
      </AgentContextOverride>
    );

    const macLink = screen.getByRole('link', { name: 'Mac (Apple Silicon)' });
    expect(macLink.getAttribute('href')).toBe(MAC_ARTIFACT_URL);
    expect(macLink.className).toContain('platform-download-button');
    const windowsLink = screen.getByRole('link', { name: 'Windows' });
    expect(windowsLink.getAttribute('href')).toBe(WINDOWS_ARTIFACT_URL);
    expect(windowsLink.className).toContain('platform-download-button');
  });
});
