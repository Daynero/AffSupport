// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RELEASE_DOWNLOAD_URL } from '../packages/shared/src/release';
import { AgentContextOverride, type AgentContextValue } from '../apps/web/src/AgentContext';
import LocalAppDialog from '../apps/web/src/components/LocalAppDialog';
import { emptyQueueState } from './web-auth-helpers';

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
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32');
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    );

    render(
      <AgentContextOverride value={agentValue()}>
        <LocalAppDialog tool="compressor" connection="not_installed_or_not_running" />
      </AgentContextOverride>
    );

    const macLink = screen.getByRole('link', { name: 'Mac (Apple Silicon)' });
    expect(macLink.getAttribute('href')).toBe(RELEASE_DOWNLOAD_URL);

    await userEvent.click(screen.getByRole('button', { name: 'Windows' }));
    expect(screen.getByRole('heading', { name: 'Wishly для Windows' })).toBeTruthy();
    expect(screen.getByText('На жаль, версія Wishly для Windows ще в розробці.')).toBeTruthy();

    await userEvent.click(screen.getByText('Закрити', { selector: 'button' }));
    expect(screen.queryByText('На жаль, версія Wishly для Windows ще в розробці.')).toBeNull();
  });
});
