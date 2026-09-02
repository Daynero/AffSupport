// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';
import type { TeamContextSnapshot } from '../apps/web/src/api/team';

/**
 * The space's re-stitching settings, as a member meets them.
 *
 * What is worth proving here is the three states a person can actually be in — nobody has set
 * this up, somebody has, and I am not allowed to — and that saving records the photos the
 * library currently has switched on. The controls themselves are the stitcher's own and are
 * tested where they live; re-asserting them here would only assert the import.
 */

const compressorState = vi.hoisted(() => vi.fn());
const updateCompressorSettings = vi.hoisted(() => vi.fn());

vi.mock('../apps/web/src/stitcher/api', () => ({
  fetchCompressorState: compressorState,
  updateCompressorSettings,
  uploadScreenImage: vi.fn(),
  removeScreenImage: vi.fn()
}));
vi.mock('../apps/web/src/api/useSubresourceUrl', () => ({ useSubresourceUrl: () => null }));

const { TeamProvider } = await import('../apps/web/src/team/TeamContext');
const { ToastProvider } = await import('../apps/web/src/components/toast');
const { AgentContextOverride } = await import('../apps/web/src/AgentContext');
const { RestitchDefaultsSection } = await import(
  '../apps/web/src/team/workspace/RestitchDefaultsSection'
);
type RestitchDefaultsClient = Parameters<typeof RestitchDefaultsSection>[0]['client'];
const { agentContextStub } = await import('./support/agent-stub.js');

const TEAM_ID = '21000000-0000-4000-8000-000000000001';

const owned: TeamContextSnapshot = {
  id: TEAM_ID,
  name: 'Creatives',
  role: 'owner',
  permissions: DEFAULT_ROLE_PERMISSIONS.owner,
  connectionState: 'connected'
};

const viewing: TeamContextSnapshot = {
  ...owned,
  role: 'viewer',
  permissions: DEFAULT_ROLE_PERMISSIONS.viewer
};

const image = (id: string) => ({
  id,
  fileName: `${id}.png`,
  width: 1080,
  height: 1080,
  size: 1024,
  mimeType: 'image/png' as const,
  extension: '.png' as const
});

const library = {
  enabled: true,
  startEnabled: true,
  endEnabled: true,
  startImages: [image('start-a')],
  endImages: [image('end-a'), image('end-b')],
  // One photo is switched off in the gallery; the space must not record it.
  disabledImageIds: ['end-b'],
  replaceExisting: true,
  finalDurationMode: 'random-30-40' as const,
  customFinalDurationSeconds: 2700,
  startDurationMode: 'one-frame' as const,
  customStartDurationMs: 100,
  fitMode: 'cover' as const
};

const stored = {
  operation: 'restitch' as const,
  startImageIds: ['start-a'],
  endImageIds: ['end-a'],
  fitMode: 'cover' as const,
  finalDurationMode: 'random-30-40' as const,
  customFinalDurationSeconds: 2700,
  configured: true,
  updatedAt: '2026-09-02T00:00:00.000Z',
  updatedBy: 'someone'
};

beforeEach(() => {
  localStorage.setItem('wishly.active-team.v1', TEAM_ID);
  localStorage.setItem('language', 'en');
  compressorState.mockResolvedValue({ settings: { imageEmbedding: library } });
  updateCompressorSettings.mockResolvedValue({ settings: { imageEmbedding: library } });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function renderSection(client: RestitchDefaultsClient, team: TeamContextSnapshot = owned) {
  return render(
    <AgentContextOverride value={agentContextStub({ capabilities: ['stitcher'] })}>
      <TeamProvider initialTeams={[team]} realtime={false}>
        <ToastProvider>
          <RestitchDefaultsSection teamId={TEAM_ID} client={client} />
        </ToastProvider>
      </TeamProvider>
    </AgentContextOverride>
  );
}

describe('a space’s re-stitching settings', () => {
  it('says so when nobody has set them up', async () => {
    renderSection({
      getRestitchDefaults: vi.fn().mockResolvedValue(null),
      setRestitchDefaults: vi.fn()
    });
    expect(await screen.findByText('Not set up yet')).toBeTruthy();
  });

  it('summarises what is set without opening anything', async () => {
    renderSection({
      getRestitchDefaults: vi.fn().mockResolvedValue(stored),
      setRestitchDefaults: vi.fn()
    });
    // Two photos, the chosen operation and the hold range, in one line. Read from the first
    // status line specifically: the panel also explains what preparing does, and that
    // sentence mentions re-stitching too.
    const summary = (await screen.findAllByRole('status'))[0] as HTMLElement;
    expect(summary.textContent).toContain('2');
    expect(summary.textContent).toContain('30–40');
  });

  it('records the photos the library currently has switched on', async () => {
    const setRestitchDefaults = vi.fn().mockResolvedValue(stored);
    renderSection({ getRestitchDefaults: vi.fn().mockResolvedValue(null), setRestitchDefaults });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Save' }));

    await waitFor(() => expect(setRestitchDefaults).toHaveBeenCalled());
    expect(setRestitchDefaults.mock.calls[0]?.[1]).toMatchObject({
      operation: 'restitch',
      startImageIds: ['start-a'],
      // `end-b` is switched off in the gallery, so the space never draws it.
      endImageIds: ['end-a'],
      fitMode: 'cover',
      finalDurationMode: 'random-30-40'
    });
  });

  it('is readable, and not editable, without permission to manage the space', async () => {
    renderSection(
      {
        getRestitchDefaults: vi.fn().mockResolvedValue(stored),
        setRestitchDefaults: vi.fn()
      },
      viewing
    );
    expect(await screen.findByText('Only a space manager can change these.')).toBeTruthy();
    // The reason is shown; the control is simply not there to press.
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('says what is missing when the local app is not running', async () => {
    render(
      <AgentContextOverride value={agentContextStub({ connection: 'disconnected' })}>
        <TeamProvider initialTeams={[owned]} realtime={false}>
          <ToastProvider>
            <RestitchDefaultsSection
              teamId={TEAM_ID}
              client={{
                getRestitchDefaults: vi.fn().mockResolvedValue(null),
                setRestitchDefaults: vi.fn()
              }}
            />
          </ToastProvider>
        </TeamProvider>
      </AgentContextOverride>
    );
    expect(
      await screen.findByText('This needs the Soty app running on this computer.')
    ).toBeTruthy();
  });
});

describe('a member who meets a space nobody has set up', () => {
  it('is offered the way in, and is told who can when it is not them', async () => {
    const { RestitchDeliveryNotices } = await import(
      '../apps/web/src/team/restitch/RestitchDeliveryNotices'
    );
    const onConfigure = vi.fn();
    const states = { 'material-1': { kind: 'unconfigured' as const } };

    const view = render(
      <TeamProvider initialTeams={[owned]} realtime={false}>
        <ToastProvider>
          <RestitchDeliveryNotices states={states} onConfigure={onConfigure} />
        </ToastProvider>
      </TeamProvider>
    );

    const user = userEvent.setup();
    expect(
      await screen.findByText('Re-stitching is not set up for this space')
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Set it up now' }));
    // The action opens the settings; it does not navigate away and it does not run anything.
    expect(onConfigure).toHaveBeenCalledTimes(1);

    view.unmount();
    cleanup();

    // A member who cannot change the space is told who can, rather than handed a control that
    // would refuse them (FR-012).
    render(
      <TeamProvider initialTeams={[viewing]} realtime={false}>
        <ToastProvider>
          <RestitchDeliveryNotices states={states} onConfigure={onConfigure} />
        </ToastProvider>
      </TeamProvider>
    );
    expect(await screen.findByText(/A space manager can set it up\./)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set it up now' })).toBeNull();
  });

  it('leaves a running delivery to the panel, and speaks only when it is done', async () => {
    const { RestitchDeliveryNotices } = await import(
      '../apps/web/src/team/restitch/RestitchDeliveryNotices'
    );
    const view = render(
      <TeamProvider initialTeams={[owned]} realtime={false}>
        <ToastProvider>
          <RestitchDeliveryNotices
            states={{
              'material-1': { kind: 'running', phase: 'inspecting', fileName: 'creative.mp4' }
            }}
            onConfigure={null}
          />
        </ToastProvider>
      </TeamProvider>
    );
    // The step, the bar and the way to stop belong to the process panel. Saying the same
    // sentence here as well put it on screen twice and parked a toast over the panel's own
    // buttons.
    expect(screen.queryByText('Looking at the video…')).toBeNull();

    view.rerender(
      <TeamProvider initialTeams={[owned]} realtime={false}>
        <ToastProvider>
          <RestitchDeliveryNotices
            states={{ 'material-1': { kind: 'delivered', fileName: 'creative_restitched.mp4' } }}
            onConfigure={null}
          />
        </ToastProvider>
      </TeamProvider>
    );
    // What the panel cannot say, because by then it is gone: the file has landed.
    expect(await screen.findByText('Saved as creative_restitched.mp4')).toBeTruthy();
  });
});
