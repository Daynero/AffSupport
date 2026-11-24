// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentContextOverride, type AgentContextValue } from '../apps/web/src/AgentContext';
import type { ConnectionState } from '../apps/web/src/connection';
import LocalAppDialog from '../apps/web/src/components/LocalAppDialog';
import { InstallerDownload } from '../apps/web/src/components/InstallerDownload';
import { emptyQueueState } from './web-auth-helpers';
import { fakeAgentValue } from './support/fake-agent';

const navigation = vi.hoisted(() => ({ navigateTo: vi.fn() }));
vi.mock('../apps/web/src/lib/navigation', async original => ({
  ...(await original<typeof import('../apps/web/src/lib/navigation')>()),
  navigateTo: navigation.navigateTo
}));

const { useInstallHandoff, markInstallStartedHere, takeInstallHandoff } =
  await import('../apps/web/src/lib/install-handoff');

/*
 * The tab Soty was downloaded from moves on into the space once the app it fetched connects,
 * so it and the tab the app's first start opens end at the same place (070, owner 2026-11-24).
 */

function agentValue(connection: ConnectionState): AgentContextValue {
  if (connection === 'connected') return fakeAgentValue({ connection, state: emptyQueueState });
  return fakeAgentValue({
    connection,
    state: emptyQueueState,
    connectedOnce: false,
    toolAvailable: () => false,
    toolAvailability: () => 'disconnected',
    teamWorkspaceAvailable: false,
    teamWorkspaceAvailability: 'disconnected'
  });
}

/** The shell's half: the watcher the application already mounts, with its route. */
function Shell({ connection, path }: { connection: ConnectionState; path: string }) {
  useInstallHandoff(connection, path);
  return (
    <AgentContextOverride value={agentValue(connection)}>
      {path === '/' && connection !== 'connected' && (
        <LocalAppDialog tool="compressor" connection={connection} />
      )}
    </AgentContextOverride>
  );
}

function blockDownloadNavigation() {
  const stop = (event: MouseEvent) => {
    if ((event.target as Element | null)?.closest('a[href^="https://"]')) event.preventDefault();
  };
  document.addEventListener('click', stop);
  return () => document.removeEventListener('click', stop);
}

let unblock = () => {};
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('language', 'uk');
  navigation.navigateTo.mockReset();
  unblock = blockDownloadNavigation();
});

afterEach(() => {
  unblock();
  cleanup();
  vi.restoreAllMocks();
});

describe('the download tab follows the app into the space', () => {
  it('moves on to the spaces route once the app it downloaded connects', async () => {
    const view = render(<Shell connection="not_installed_or_not_running" path="/" />);
    await userEvent.click(screen.getByRole('link', { name: 'Mac (Apple Silicon)' }));
    expect(navigation.navigateTo).not.toHaveBeenCalled();

    view.rerender(<Shell connection="connecting" path="/" />);
    expect(navigation.navigateTo).not.toHaveBeenCalled();

    view.rerender(<Shell connection="connected" path="/" />);
    expect(navigation.navigateTo).toHaveBeenCalledTimes(1);
    expect(navigation.navigateTo).toHaveBeenCalledWith('/team');

    // Once: a later reconnect is not a fresh install.
    view.rerender(<Shell connection="disconnected" path="/" />);
    view.rerender(<Shell connection="connected" path="/" />);
    expect(navigation.navigateTo).toHaveBeenCalledTimes(1);
  });

  it('stays put when nobody downloaded Soty from this tab', () => {
    const view = render(<Shell connection="not_installed_or_not_running" path="/" />);
    view.rerender(<Shell connection="connected" path="/" />);
    expect(navigation.navigateTo).not.toHaveBeenCalled();
  });

  it('leaves a tool page to open its tool, and does not carry the wait elsewhere', () => {
    markInstallStartedHere();
    const view = render(<Shell connection="not_installed_or_not_running" path="/compressor" />);
    view.rerender(<Shell connection="connected" path="/compressor" />);
    expect(navigation.navigateTo).not.toHaveBeenCalled();
    expect(takeInstallHandoff()).toBe(false);
  });

  it('forgets a download older than a day', () => {
    markInstallStartedHere();
    expect(takeInstallHandoff(Date.now() + 25 * 60 * 60 * 1000)).toBe(false);
  });

  it('the onboarding installer marks the wait too, an update does not', async () => {
    const away = render(
      <AgentContextOverride value={agentValue('not_installed_or_not_running')}>
        <InstallerDownload>Download</InstallerDownload>
      </AgentContextOverride>
    );
    await userEvent.click(screen.getAllByRole('link')[0]!);
    expect(takeInstallHandoff()).toBe(true);
    away.unmount();

    render(
      <AgentContextOverride value={agentValue('connected')}>
        <InstallerDownload intent="update">Update</InstallerDownload>
      </AgentContextOverride>
    );
    await userEvent.click(screen.getAllByRole('link')[0]!);
    expect(takeInstallHandoff()).toBe(false);
  });
});
