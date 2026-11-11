// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { StableReleaseManifest } from '../packages/shared/src/release';
import { AgentContextOverride } from '../apps/web/src/AgentContext';
import { fakeAgentValue } from './support/fake-agent.js';
import { emptyQueueState } from './web-auth-helpers';

/**
 * Feature 051 screens: the badge on `next`, the gate for non-testers there, and
 * the main site's offer to return to the stable agent after a rollback.
 */

const page = vi.hoisted(() => ({
  channel: 'next' as 'next' | 'production' | 'other',
  tester: 'tester' as 'checking' | 'tester' | 'not_tester'
}));

vi.mock('../apps/web/src/lib/config', async importOriginal => ({
  ...(await importOriginal<typeof import('../apps/web/src/lib/config')>()),
  siteChannel: () => page.channel
}));
vi.mock('../apps/web/src/lib/release-tester', () => ({
  useReleaseTester: (enabled: boolean) => (enabled ? page.tester : 'not_tester')
}));

const { NextChannelBadge } = await import('../apps/web/src/components/NextChannelBadge');
const { ReleaseTesterGate } = await import('../apps/web/src/components/ReleaseTesterGate');
const { default: ReleaseUpdateNotice } =
  await import('../apps/web/src/components/ReleaseUpdateNotice');

function manifest(version: string): StableReleaseManifest {
  return {
    schemaVersion: 1,
    channel: 'stable',
    version,
    buildNumber: '80',
    buildId: `${version}+80`,
    apiVersion: 6,
    minimumSupportedVersion: '1.0.0',
    publishedAt: '2026-11-11T00:00:00.000Z',
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
  } as StableReleaseManifest;
}

function notice(installed: string, stable: string) {
  return render(
    <AgentContextOverride
      value={fakeAgentValue({
        connection: 'connected',
        state: emptyQueueState,
        setState: vi.fn(),
        connectedOnce: true,
        releaseBlocked: false,
        agentRuntime: { platform: 'macos', architecture: 'arm64' },
        agentVersion: installed,
        agentBuildId: `${installed}+81`,
        agentChannel: 'stable',
        agentApiVersion: 6,
        capabilities: [],
        toolContracts: { compressor: 2 },
        releaseManifest: { status: 'ready', manifest: manifest(stable) },
        toolAvailable: () => true,
        reconnect: vi.fn()
      })}
    >
      <ReleaseUpdateNotice />
    </AgentContextOverride>
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('language', 'uk');
  page.channel = 'next';
  page.tester = 'tester';
});
afterEach(cleanup);

describe('next address', () => {
  it('marks the test version with its build, and nothing on the main site', () => {
    render(<NextChannelBadge />);
    expect(screen.getByRole('status').textContent).toMatch(/^Тестова версія · збірка \d/);
    cleanup();
    page.channel = 'production';
    render(<NextChannelBadge />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('lets a tester in and sends anyone else to the main site', () => {
    render(
      <ReleaseTesterGate>
        <p>app</p>
      </ReleaseTesterGate>
    );
    expect(screen.getByText('app')).toBeTruthy();
    cleanup();
    page.tester = 'not_tester';
    render(
      <ReleaseTesterGate>
        <p>app</p>
      </ReleaseTesterGate>
    );
    expect(screen.queryByText('app')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Це тестова версія Soty' })).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Перейти на основний сайт' }).getAttribute('href')
    ).toBe('https://soty.pp.ua');
  });

  it('never gates the main site', () => {
    page.channel = 'production';
    page.tester = 'not_tester';
    render(
      <ReleaseTesterGate>
        <p>app</p>
      </ReleaseTesterGate>
    );
    expect(screen.getByText('app')).toBeTruthy();
  });
});

describe('return to the stable agent after a rollback', () => {
  it('offers the stable build on the main site when the installed agent is newer', () => {
    page.channel = 'production';
    page.tester = 'not_tester';
    notice('1.5.0', '1.4.2');
    expect(screen.getByRole('region', { name: 'Поверніться на Soty 1.4.2' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Завантажити стабільну версію' })).toBeTruthy();
  });

  it('does not nag a tester, or anyone on next', () => {
    page.channel = 'production';
    page.tester = 'tester';
    notice('1.5.0', '1.4.2');
    expect(screen.queryByRole('region')).toBeNull();
    cleanup();
    page.channel = 'next';
    page.tester = 'not_tester';
    notice('1.5.0', '1.4.2');
    expect(screen.queryByRole('region')).toBeNull();
  });
});
