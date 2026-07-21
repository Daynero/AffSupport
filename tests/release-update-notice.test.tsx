// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { StableReleaseManifest } from '../packages/shared/src/release';
import { AgentContextOverride, type AgentContextValue } from '../apps/web/src/AgentContext';
import ReleaseUpdateNotice from '../apps/web/src/components/ReleaseUpdateNotice';
import { emptyQueueState } from './web-auth-helpers';

const DISMISSED_RELEASE_KEY = 'wishly.release-notice.dismissed.v1';

function releaseManifest(
  version = '0.6.2',
  buildNumber = '14',
  summary: StableReleaseManifest['summary'] = {
    en: 'A new transcription tool is available.',
    uk: 'Додано новий інструмент транскрипції.'
  }
): StableReleaseManifest {
  return {
    schemaVersion: 1,
    channel: 'stable',
    version,
    buildNumber,
    buildId: `${version}+${buildNumber}`,
    apiVersion: 5,
    minimumSupportedVersion: '0.4.0',
    publishedAt: '2026-07-21T12:00:00.000Z',
    summary,
    artifacts: {
      'macos-arm64': {
        url: `https://example.test/Wishly-Agent-v${version}.dmg`,
        sha256: 'a'.repeat(64)
      }
    },
    toolRequirements: {
      compressor: { compressor: 2 },
      landingOptimizer: { landingOptimizer: 2 }
    }
  };
}

function agentValue(manifest = releaseManifest()): AgentContextValue {
  return {
    connection: 'connected',
    state: emptyQueueState,
    setState: vi.fn(),
    connectedOnce: true,
    agentVersion: '0.6.1',
    agentBuildId: '0.6.1+13',
    agentChannel: 'stable',
    agentApiVersion: 5,
    capabilities: [],
    toolContracts: { compressor: 2 },
    releaseManifest: { status: 'ready', manifest },
    toolAvailable: () => true,
    reconnect: vi.fn()
  };
}

function renderNotice(value = agentValue()) {
  return render(
    <AgentContextOverride value={value}>
      <ReleaseUpdateNotice />
    </AgentContextOverride>
  );
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

describe('release update notice', () => {
  it('shows a localized summary and the immutable release download', () => {
    const manifest = releaseManifest();
    renderNotice(agentValue(manifest));

    expect(screen.getByRole('region', { name: 'Вийшла Wishly 0.6.2' })).toBeTruthy();
    expect(screen.getByText('Додано новий інструмент транскрипції.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Завантажити оновлення' }).getAttribute('href')).toBe(
      manifest.artifacts['macos-arm64']?.url
    );
  });

  it('remembers Later for one build and shows the next release again', async () => {
    const view = renderNotice();
    await userEvent.click(screen.getByRole('button', { name: 'Пізніше' }));

    expect(screen.queryByRole('region')).toBeNull();
    expect(localStorage.getItem(DISMISSED_RELEASE_KEY)).toBe('0.6.2+14');

    view.unmount();
    renderNotice();
    expect(screen.queryByRole('region')).toBeNull();

    cleanup();
    renderNotice(agentValue(releaseManifest('0.6.3', '15')));
    expect(screen.getByRole('region', { name: 'Вийшла Wishly 0.6.3' })).toBeTruthy();
  });

  it('uses the generic maintenance copy when a release has no summary', () => {
    renderNotice(agentValue({ ...releaseManifest('0.6.2', '14'), summary: undefined }));
    expect(screen.getByText('Виправлено деякі помилки.')).toBeTruthy();
  });

  it('stays hidden when the installed Agent is already current', () => {
    const manifest = releaseManifest('0.6.1', '13');
    renderNotice({ ...agentValue(manifest), agentVersion: '0.6.1' });
    expect(screen.queryByRole('region')).toBeNull();
  });
});
