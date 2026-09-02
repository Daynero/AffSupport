// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { StableReleaseManifest } from '../packages/shared/src/release';
import { AgentContextOverride, type AgentContextValue } from '../apps/web/src/AgentContext';
import LocalAppDialog from '../apps/web/src/components/LocalAppDialog';
import { emptyQueueState } from './web-auth-helpers';

const WINDOWS_ARTIFACT_URL = 'https://example.com/Soty-v1.0.0-Windows-x64.exe';
const MAC_ARTIFACT_URL = 'https://example.com/Soty-v1.0.0-macOS-arm64.dmg';

const WINDOWS_X64_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
const WINDOWS_32BIT_UA = 'Mozilla/5.0 (Windows NT 10.0)';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';

function manifestWith(artifacts: StableReleaseManifest['artifacts']): StableReleaseManifest {
  return {
    schemaVersion: 1,
    channel: 'stable',
    version: '1.0.0',
    buildNumber: '58',
    buildId: '1.0.0+58',
    apiVersion: 5,
    minimumSupportedVersion: '0.4.0',
    publishedAt: '2026-08-19T00:00:00.000Z',
    artifacts,
    toolRequirements: {
      compressor: {},
      landingOptimizer: {},
      landingPreview: {},
      transcription: {},
      teamWorkspace: {},
      stitcher: {}
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

function bothPlatformsPublished(): AgentContextValue {
  const value = agentValue();
  value.releaseManifest = {
    status: 'ready',
    manifest: manifestWith({
      'macos-arm64': { url: MAC_ARTIFACT_URL, sha256: null },
      'windows-x64': { url: WINDOWS_ARTIFACT_URL, sha256: null }
    })
  };
  return value;
}

function renderDialog(value: AgentContextValue) {
  render(
    <AgentContextOverride value={value}>
      <LocalAppDialog tool="compressor" connection="not_installed_or_not_running" />
    </AgentContextOverride>
  );
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('language', 'en');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('unsigned installer guidance', () => {
  it('tells a Windows visitor exactly which SmartScreen button to press', () => {
    mockNavigator('Win32', WINDOWS_X64_UA);
    renderDialog(bothPlatformsPublished());

    expect(screen.getByText(/Windows protected your PC/u)).toBeTruthy();
    expect(screen.getByText(/Run anyway/u)).toBeTruthy();
    expect(screen.getByText(/Requires 64-bit Windows 10 or 11/u)).toBeTruthy();
  });

  it('shows the guidance in Ukrainian too', () => {
    localStorage.setItem('language', 'uk');
    mockNavigator('Win32', WINDOWS_X64_UA);
    renderDialog(bothPlatformsPublished());

    expect(screen.getByText(/Виконати в будь-якому разі/u)).toBeTruthy();
  });

  it('gives a macOS visitor the Gatekeeper equivalent, not the Windows one', () => {
    mockNavigator('MacIntel', MAC_UA);
    renderDialog(bothPlatformsPublished());

    expect(screen.getByText(/Open Anyway/u)).toBeTruthy();
    expect(screen.queryByText(/Windows protected your PC/u)).toBeNull();
  });

  it('warns a 32-bit Windows visitor instead of promising the download works', () => {
    mockNavigator('Win32', WINDOWS_32BIT_UA);
    renderDialog(bothPlatformsPublished());

    expect(screen.getByText(/64-bit \(x64\) version of Windows/u)).toBeTruthy();
    expect(screen.queryByText(/Windows protected your PC/u)).toBeNull();
  });

  it('offers the Windows download first once the artifact is published', () => {
    mockNavigator('Win32', WINDOWS_X64_UA);
    renderDialog(bothPlatformsPublished());

    const downloads = screen.getAllByRole('link');
    expect(downloads[0].getAttribute('href')).toBe(WINDOWS_ARTIFACT_URL);
    expect(screen.queryByRole('button', { name: 'Windows' })).toBeNull();
  });

  it('falls back to the waitlist, with no install guidance, when nothing is published', () => {
    mockNavigator('Win32', WINDOWS_X64_UA);
    renderDialog(agentValue());

    expect(screen.getByRole('button', { name: 'Windows' })).toBeTruthy();
    expect(screen.queryByText(/Windows protected your PC/u)).toBeNull();
  });
});
