// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentContextOverride, type AgentContextValue } from '../apps/web/src/AgentContext';
import { fakeAgentValue } from './support/fake-agent';
import { nativeSnapshot } from './support/native-app-updates';
import ReleaseUpdateNotice from '../apps/web/src/components/ReleaseUpdateNotice';
import { NativeAppUpdateNotice } from '../apps/web/src/components/NativeAppUpdateNotice';
import LocalAppDialog from '../apps/web/src/components/LocalAppDialog';
import { openNativeAppUpdate } from '../apps/web/src/updates/openNativeAppUpdate';
const mock = vi.hoisted(() => ({ hook: vi.fn(), act: vi.fn(), refresh: vi.fn() }));
vi.mock('../apps/web/src/updates/useNativeAppUpdate', () => ({ useNativeAppUpdate: mock.hook }));
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('language', 'en');
  mock.act.mockReset();
  mock.refresh.mockReset();
  snapshot();
});
afterEach(cleanup);

function snapshot(overrides: Partial<ReturnType<typeof nativeSnapshot>> = {}, error = false) {
  const state = { ...nativeSnapshot(), ...overrides };
  mock.hook.mockReturnValue({ state, pending: false, error, act: mock.act, refresh: mock.refresh });
  return state;
}
function tree(overrides: Partial<AgentContextValue> = {}) {
  return (
    <AgentContextOverride
      value={fakeAgentValue({
        capabilities: ['event-stream', 'native-app-updates-v1'],
        ...overrides
      })}
    >
      <ReleaseUpdateNotice />
    </AgentContextOverride>
  );
}
const show = (overrides: Partial<AgentContextValue> = {}) => render(tree(overrides));
async function openUpdate() {
  await userEvent.click(screen.getByRole('button', { name: 'View update' }));
  return within(screen.getByRole('dialog'));
}

describe('native update window', () => {
  it('keeps success visible on a fresh page after automatic acknowledgement and remembers only its dismissal', async () => {
    snapshot({ stage: 'ui_visible', nativeSuccess: true, uiSuccess: true, availableActions: [] });
    const page = render(
      <>
        <main>
          <button>Continue working</button>
        </main>
        {tree()}
      </>
    );
    expect(screen.getByText('The updated app and its local tools are ready.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('region')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Continue working' }));
    page.unmount();
    const nextPage = show();
    expect(screen.queryByRole('region')).toBeNull();
    snapshot({
      stage: 'ui_visible',
      nativeSuccess: true,
      uiSuccess: true,
      attemptId: '10000000-0000-4000-8000-000000000004',
      availableActions: []
    });
    nextPage.rerender(tree());
    expect(screen.getByText('The updated app and its local tools are ready.')).toBeTruthy();
  });
  it('routes a required tool upgrade into the same native window while the old host is reachable', async () => {
    render(
      <AgentContextOverride
        value={fakeAgentValue({
          connection: 'agent_update_required',
          capabilities: ['native-app-updates-v1'],
          toolAvailability: () => 'too_old'
        })}
      >
        <LocalAppDialog tool="compressor" connection="agent_update_required" />
        <ReleaseUpdateNotice />
      </AgentContextOverride>
    );
    const setup = within(screen.getByRole('dialog'));
    expect(setup.queryByRole('link', { name: 'Download latest version' })).toBeNull();
    const toolTrigger = setup.getByRole('button', { name: 'View update' });
    await userEvent.click(toolTrigger);
    const update = within(screen.getByRole('dialog', { name: 'Soty 9.0.0 is available' }));
    expect(update.getByRole('button', { name: 'Update when tasks finish' })).toHaveProperty(
      'disabled',
      false
    );
    expect(mock.hook).toHaveBeenLastCalledWith(true, true, expect.anything());
    expect(mock.act).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    expect(document.activeElement).toBe(toolTrigger);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('can open an idle updater from a tool gate and check without installing', async () => {
    snapshot({ stage: 'idle', candidate: null, candidateId: null, availableActions: ['check'] });
    show();
    expect(screen.queryByRole('region')).toBeNull();
    // This trigger stands in for another existing application surface.
    const launch = render(<button onClick={openNativeAppUpdate}>Open updates</button>);
    await userEvent.click(screen.getByRole('button', { name: 'Open updates' }));
    const dialog = within(screen.getByRole('dialog'));
    await userEvent.click(dialog.getByRole('button', { name: 'Check for updates' }));
    expect(mock.act).toHaveBeenCalledExactlyOnceWith('check');
    launch.unmount();
  });
  it('opens on intent and accepts exactly one native update without an installer download', async () => {
    show();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mock.act).not.toHaveBeenCalled();
    const dialog = await openUpdate();
    expect(dialog.getByText('Ready to install')).toBeTruthy();
    await userEvent.click(dialog.getByRole('button', { name: 'Update when tasks finish' }));
    expect(mock.act).toHaveBeenCalledExactlyOnceWith('accept');
    expect(dialog.getByText(/macOS may ask/)).toBeTruthy();
    expect(dialog.queryByRole('link')).toBeNull();
  });

  it.each([
    'install_committed',
    'replacement_started',
    'replacement_committed',
    'relaunch_requested',
    'target_started'
  ] as const)(
    'keeps %s visible as installation and never offers cancellation or premature success',
    async stage => {
      snapshot({ stage, lastProvenStage: stage, availableActions: [] });
      show();
      const dialog = await openUpdate();
      expect(dialog.getByText(/will reopen automatically/)).toBeTruthy();
      expect(dialog.getByText(/You can close this window/)).toBeTruthy();
      expect(dialog.queryByRole('button', { name: 'Update when tasks finish' })).toBeNull();
      expect(dialog.queryByRole('button', { name: 'Cancel update' })).toBeNull();
      expect(dialog.queryByText('The updated app and its local tools are ready.')).toBeNull();
    }
  );

  it('closing the window preserves accepted work and returns keyboard focus', async () => {
    snapshot({ stage: 'draining', lastProvenStage: 'draining', availableActions: ['defer'] });
    show();
    const trigger = screen.getByRole('button', { name: 'View update' });
    await openUpdate();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mock.act).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it.each(['unknown', 'recovering'] as const)(
    'reconciles %s without replay or a reinstall shortcut',
    async stage => {
      snapshot({
        stage,
        lastProvenStage: 'replacement_started',
        availableActions: [],
        code: 'APP_UPDATE_REPLACEMENT_UNKNOWN'
      });
      show();
      const dialog = await openUpdate();
      expect(dialog.getByText(/outcome is not confirmed yet/)).toBeTruthy();
      expect(dialog.queryByRole('link')).toBeNull();
      expect(dialog.queryByText(/Additional recovery/)).toBeNull();
      await userEvent.click(dialog.getByRole('button', { name: 'Refresh update status' }));
      expect(mock.refresh).toHaveBeenCalledOnce();
      expect(mock.act).not.toHaveBeenCalled();
    }
  );

  it('offers a native retry for failed download only after explicit intent', async () => {
    snapshot({
      stage: 'failed',
      lastProvenStage: 'preparing',
      code: 'APP_UPDATE_DOWNLOAD_FAILED',
      availableActions: ['check', 'prepare', 'cancel']
    });
    show();
    const dialog = await openUpdate();
    expect(dialog.getByText(/Check your internet connection/)).toBeTruthy();
    expect(mock.act).not.toHaveBeenCalled();
    await userEvent.click(dialog.getByRole('button', { name: 'Try again' }));
    expect(mock.act).toHaveBeenCalledExactlyOnceWith('prepare');
    expect(dialog.queryByRole('link')).toBeNull();
  });

  it('names a recoverable disk-space problem in Ukrainian without raw codes', async () => {
    localStorage.setItem('language', 'uk');
    snapshot({
      stage: 'failed',
      lastProvenStage: 'preparing',
      code: 'APP_UPDATE_DISK_FULL',
      availableActions: ['check', 'prepare']
    });
    show();
    await userEvent.click(screen.getByRole('button', { name: 'Переглянути оновлення' }));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText(/бракує вільного місця/)).toBeTruthy();
    expect(dialog.queryByText(/APP_UPDATE/)).toBeNull();
    await userEvent.click(dialog.getByRole('button', { name: 'Перевірити оновлення' }));
    expect(mock.act).toHaveBeenCalledExactlyOnceWith('check');
  });

  it('says a busy refusal kept the work and can be tried again', async () => {
    snapshot({
      stage: 'failed',
      lastProvenStage: 'draining',
      code: 'APP_UPDATE_BUSY',
      availableActions: ['check', 'cancel']
    });
    show();
    const dialog = await openUpdate();
    expect(dialog.getByText(/still finishing background work/)).toBeTruthy();
    expect(dialog.queryByText(/APP_UPDATE/)).toBeNull();
  });
  it('reopens a cancelled update on intent and checks again', async () => {
    snapshot({ stage: 'cancelled', availableActions: ['check'] });
    show();
    expect(screen.queryByRole('region')).toBeNull();
    const launch = render(<button onClick={openNativeAppUpdate}>Open updates</button>);
    await userEvent.click(screen.getByRole('button', { name: 'Open updates' }));
    const dialog = within(screen.getByRole('dialog'));
    await userEvent.click(dialog.getByRole('button', { name: 'Check for updates' }));
    expect(mock.act).toHaveBeenCalledExactlyOnceWith('check');
    launch.unmount();
  });
  it('keeps an unreadable initial status visible and recoverable', async () => {
    mock.hook.mockReturnValue({
      state: null,
      pending: false,
      error: true,
      act: mock.act,
      refresh: mock.refresh
    });
    show();
    const dialog = await openUpdate();
    expect(dialog.getByText(/status could not be read/)).toBeTruthy();
    await userEvent.click(dialog.getByRole('button', { name: 'Refresh update status' }));
    expect(mock.refresh).toHaveBeenCalledOnce();
  });

  it('keeps reconnecting distinct from failure and disables native commands offline', async () => {
    show({ connection: 'not_installed_or_not_running' });
    const dialog = await openUpdate();
    expect(dialog.getByText(/Reconnecting to Soty/)).toBeTruthy();
    expect(dialog.getByRole('button', { name: 'Update when tasks finish' })).toHaveProperty(
      'disabled',
      true
    );
    expect(dialog.queryByRole('link')).toBeNull();
  });

  it('keeps confirmed success in an open window until Done, even after visible acknowledgement', async () => {
    render(
      <main>
        <button>Return to work</button>
      </main>
    );
    const view = show();
    await openUpdate();
    snapshot({
      stage: 'ui_visible',
      lastProvenStage: 'ui_visible',
      nativeSuccess: true,
      uiSuccess: true,
      availableActions: ['check']
    });
    view.rerender(tree());
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText('The updated app and its local tools are ready.')).toBeTruthy();
    await userEvent.click(dialog.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('region')).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Return to work' }))
    );
  });

  it.each([false, true])(
    'requires nativeSuccess=%s evidence independently of the stage name',
    async nativeSuccess => {
      snapshot({
        stage: 'native_ready',
        lastProvenStage: 'native_ready',
        nativeSuccess,
        availableActions: ['ack-visible']
      });
      show();
      const dialog = await openUpdate();
      expect(Boolean(dialog.queryByText('The updated app and its local tools are ready.'))).toBe(
        nativeSuccess
      );
      expect(Boolean(dialog.queryByRole('button', { name: 'Done' }))).toBe(nativeSuccess);
      if (!nativeSuccess) expect(dialog.getByText(/has not yet confirmed/)).toBeTruthy();
    }
  );

  it('keeps a deliberate repair option only for a runtime that disabled its updater', async () => {
    mock.hook.mockReturnValue({
      state: null,
      pending: false,
      error: false,
      act: mock.act,
      refresh: mock.refresh
    });
    show({
      capabilities: ['event-stream'],
      agentRuntime: {
        platform: 'macos',
        architecture: 'arm64',
        nativeAppUpdateStatus: 'recovery_required'
      }
    });
    const dialog = await openUpdate();
    expect(dialog.queryByRole('button', { name: 'Refresh update status' })).toBeNull();
    const recovery = dialog.getByText('Additional recovery options').closest('details');
    expect(recovery?.open).toBe(false);
    await userEvent.click(dialog.getByText('Additional recovery options'));
    expect(recovery?.open).toBe(true);
    expect(dialog.getByRole('link', { name: 'Restore Soty' })).toBeTruthy();
  });

  it('does not let an idle native updater hide the existing rollback notice', () => {
    snapshot({ stage: 'idle', availableActions: ['check'] });
    render(
      <AgentContextOverride
        value={fakeAgentValue({
          capabilities: ['native-app-updates-v1'],
          agentVersion: '10.0.0',
          agentChannel: 'stable',
          releaseManifest: {
            status: 'ready',
            manifest: {
              schemaVersion: 1,
              channel: 'stable',
              version: '9.0.0',
              buildNumber: '999',
              buildId: '9.0.0+999',
              apiVersion: 5,
              minimumSupportedVersion: '0.4.0',
              publishedAt: '2026-11-14T00:00:00.000Z',
              artifacts: {},
              toolRequirements: {
                compressor: {},
                landingOptimizer: {},
                landingPreview: {},
                transcription: {},
                teamWorkspace: {},
                stitcher: {}
              }
            }
          }
        })}
      >
        <NativeAppUpdateNotice fallback={<p>Signed rollback</p>} />
      </AgentContextOverride>
    );
    expect(screen.getByText('Signed rollback')).toBeTruthy();
    expect(mock.act).not.toHaveBeenCalled();
  });
});
