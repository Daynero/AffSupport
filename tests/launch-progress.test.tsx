// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LaunchGenerationProgress } from '../apps/web/src/team/launches/LaunchGenerationProgress';
import type { LaunchGeneration } from '../packages/shared/src/team/launches';
const child = vi.hoisted(() => ({
  operation: null as { progress: number; state: string } | null,
  localState: null as string | null,
  localErrorCode: null as string | null,
  streamDisconnected: false,
  localProgress: null as { stage: string; progress: number } | null
}));
const workspace = vi.hoisted(() => ({
  realtimeState: 'connected',
  realtimeConnectionState: 'connected'
}));
vi.mock('../apps/web/src/team/TeamContext', () => ({ useOptionalTeam: () => workspace }));
vi.mock('../apps/web/src/team/processing/useTeamOperation', () => ({
  useTeamOperation: () => child
}));
afterEach(() => {
  cleanup();
  child.operation = null;
  child.localProgress = null;
  child.localState = null;
  child.localErrorCode = null;
  child.streamDisconnected = false;
  workspace.realtimeState = 'connected';
  workspace.realtimeConnectionState = 'connected';
  vi.useRealTimers();
});
const generation = {
  id: 'generation',
  state: 'running',
  stage: 'catalog_creating',
  progress: null
} as LaunchGeneration;
it('keeps catalog progress steady through cache invalidation and preserves it on a real disconnect', () => {
  const props = {
    generation: {
      ...generation,
      progress: { completed: 2, total: 4, unit: 'items', source: 'worker' }
    },
    onCancel: vi.fn(),
    disabled: false
  };
  const view = render(<LaunchGenerationProgress {...props} />);
  const catalog = screen.getAllByRole('listitem').find(item => item.textContent === 'Catalog')!;
  const fill = () => catalog.querySelector('.is-measured')?.getAttribute('style');
  const confirmed = fill();
  for (let update = 0; update < 6; update++) {
    workspace.realtimeState = update % 2 ? 'connected' : 'reconnecting';
    view.rerender(<LaunchGenerationProgress {...props} />);
    expect(catalog.dataset.state).toBe('active');
    expect(fill()).toBe(confirmed);
    expect(screen.getByRole('progressbar')).toBeTruthy();
    expect(screen.queryByText(/Live progress is unavailable/u)).toBeNull();
  }
  workspace.realtimeConnectionState = 'reconnecting';
  view.rerender(<LaunchGenerationProgress {...props} />);
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.getByText(/Live progress is unavailable/u)).toBeTruthy();
  expect(catalog.dataset.state).toBe('active');
  expect(fill()).toBe(confirmed);
  workspace.realtimeConnectionState = 'connected';
  view.rerender(<LaunchGenerationProgress {...props} />);
  expect(fill()).toBe(confirmed);
  view.rerender(
    <LaunchGenerationProgress
      {...props}
      generation={{ ...props.generation, state: 'failed', errorCode: 'DRIVE_UNAVAILABLE' }}
    />
  );
  expect(catalog.dataset.state).toBe('attention');
  expect(screen.getByRole('alert')).toBeTruthy();
});

it('retains measured fill through missing or older samples and resets it for another attempt', () => {
  const props = { onCancel: vi.fn(), disabled: false };
  const measured = {
    ...generation,
    progress: { completed: 3, total: 4, unit: 'items', source: 'worker' }
  };
  const view = render(<LaunchGenerationProgress {...props} generation={measured} />);
  const catalog = screen.getAllByRole('listitem').find(item => item.textContent === 'Catalog')!;
  const fill = () => catalog.querySelector('.is-measured')?.getAttribute('style');
  const confirmed = fill();
  view.rerender(
    <LaunchGenerationProgress {...props} generation={{ ...measured, progress: null }} />
  );
  expect(fill()).toBe(confirmed);
  const restarted = { ...measured, progress: { ...measured.progress, completed: 1 } };
  view.rerender(<LaunchGenerationProgress {...props} generation={restarted} />);
  expect(fill()).toBe(confirmed);
  view.rerender(
    <LaunchGenerationProgress
      {...props}
      generation={{
        ...restarted,
        steps: [
          {
            id: 'retry',
            stage: 'catalog_creating',
            state: 'running',
            attemptNo: 2,
            errorCode: null
          }
        ]
      }}
    />
  );
  expect(fill()).toContain('0.0625');
});
it('shows indeterminate progress without inventing a percentage', () => {
  const cancel = vi.fn();
  render(<LaunchGenerationProgress generation={generation} onCancel={cancel} disabled={false} />);
  expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false);
  expect(screen.queryByText(/\d+%/u)).toBeNull();
  fireEvent.click(screen.getByRole('button'));
  expect(cancel).toHaveBeenCalledTimes(1);
});
it('does not repeat the generic preparing status while a request is unresolved', () => {
  render(<LaunchGenerationProgress generation={null} onCancel={vi.fn()} disabled={false} />);
  expect(screen.getAllByText('Checking values')).toHaveLength(1);
  expect(screen.queryByText('Preparing launch…')).toBeNull();
});
it('explains invalid re-stitch settings and stops presenting the operation as active work', () => {
  render(
    <LaunchGenerationProgress
      generation={{
        ...generation,
        state: 'waiting_dependency',
        stage: 'restitch_preparing',
        errorCode: 'RESTITCH_INVALID'
      }}
      onCancel={vi.fn()}
      disabled={false}
    />
  );
  expect(screen.getByRole('alert').textContent).toContain(
    'Re-stitching settings are missing or invalid'
  );
  expect(screen.queryByRole('progressbar')).toBeNull();
});
it('keeps a stage indeterminate when its measured total is unavailable', () => {
  render(
    <LaunchGenerationProgress
      generation={{
        ...generation,
        progress: { completed: 0, total: 0, unit: 'files', source: 'provider' }
      }}
      onCancel={vi.fn()}
      disabled={false}
    />
  );
  expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false);
  expect(screen.queryByText(/NaN|Infinity|0 \/ 0/u)).toBeNull();
});
it('hides stale measured work and prevents repeated cancellation', () => {
  const cancel = vi.fn();
  render(
    <LaunchGenerationProgress
      generation={{
        ...generation,
        state: 'cancel_requested',
        progress: { completed: 2, total: 5, unit: 'files', source: 'provider' }
      }}
      onCancel={cancel}
      disabled={false}
    />
  );
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
  expect(cancel).not.toHaveBeenCalled();
});

it('keeps cancellation available after failure without showing work as still running', () => {
  const cancel = vi.fn();
  render(
    <LaunchGenerationProgress
      generation={{
        ...generation,
        state: 'failed',
        stage: 'restitch_processing',
        errorCode: 'SOURCE_CHANGED'
      }}
      onCancel={cancel}
      disabled={false}
    />
  );
  expect(screen.queryByRole('progressbar')).toBeNull();
  fireEvent.click(screen.getByRole('button'));
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('names unresolved cancellation without claiming that cleanup already finished', () => {
  render(
    <LaunchGenerationProgress
      generation={{
        ...generation,
        state: 'canceled_with_cleanup_pending',
        stage: 'cleanup',
        errorCode: 'LAUNCH_RESULT_UNCERTAIN'
      }}
      onCancel={vi.fn()}
      disabled={false}
    />
  );
  expect(screen.getByText(/waiting for safe cleanup/u)).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByRole('progressbar')).toBeNull();
});

it('lists only authoritative stages from the current attempt without inventing restitch work', () => {
  render(
    <LaunchGenerationProgress
      generation={{
        ...generation,
        stepsTruncated: true,
        steps: [
          {
            id: 'older',
            stage: 'restitch_processing',
            state: 'failed',
            attemptNo: 1,
            errorCode: 'PROCESS_FAILED'
          },
          {
            id: 'plan',
            stage: 'catalog_planning',
            state: 'succeeded',
            attemptNo: 2,
            errorCode: null
          },
          {
            id: 'create',
            stage: 'catalog_creating',
            state: 'running',
            attemptNo: 2,
            errorCode: null
          }
        ]
      }}
      onCancel={vi.fn()}
      disabled={false}
    />
  );
  const steps = screen.getByRole('list', { name: 'Generation steps' });
  expect(steps.textContent).toContain('Catalog');
  expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toContain(
    'Creating catalog'
  );
  expect(steps.textContent).not.toContain('Re-stitching video');
  expect(steps.querySelectorAll('li')).toHaveLength(3);
  expect(screen.getByText('Earlier steps are not shown.')).toBeTruthy();
  expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false);
});

it('shows the observed native child progress during re-stitching instead of another generic spinner', () => {
  child.localProgress = { stage: 'processing', progress: 63 };
  render(
    <LaunchGenerationProgress
      generation={{
        ...generation,
        state: 'waiting_dependency',
        stage: 'restitch_processing',
        restitchOperationId: 'child'
      }}
      onCancel={vi.fn()}
      disabled={false}
      teamId="team"
    />
  );
  expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false);
  expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toContain('63%');
});

it('does not pretend that an early catalog preflight completed the optional video', () => {
  render(
    <LaunchGenerationProgress
      generation={{
        ...generation,
        state: 'accepted',
        stage: 'catalog_planning',
        steps: [
          {
            id: 'plan',
            stage: 'catalog_planning',
            state: 'succeeded',
            attemptNo: 1,
            errorCode: null
          }
        ]
      }}
      restitchEnabled
      onCancel={vi.fn()}
      disabled={false}
    />
  );
  const items = screen.getAllByRole('listitem');
  expect(items).toHaveLength(4);
  expect(items[0].getAttribute('aria-current')).toBe('step');
  expect(items[1].textContent).toBe('Video');
  expect(items[2].textContent).toBe('Catalog');
});

it('omits both video and catalog stages from a launch without a catalog', () => {
  render(
    <LaunchGenerationProgress
      generation={null}
      method="other"
      restitchEnabled={false}
      onCancel={vi.fn()}
      disabled={false}
    />
  );
  expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual([
    'Preparation',
    'Result'
  ]);
});

it('stops active progress immediately when the observed child failed but the parent is stale', () => {
  child.localState = 'failed';
  child.localErrorCode = 'PROCESS_FAILED';
  render(
    <LaunchGenerationProgress
      generation={{
        ...generation,
        state: 'waiting_dependency',
        stage: 'restitch_processing',
        restitchOperationId: 'child'
      }}
      onCancel={vi.fn()}
      disabled={false}
      teamId="team"
    />
  );
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.getByRole('alert')).toBeTruthy();
  expect(screen.getByText(/Last confirmed/u)).toBeTruthy();
});

it('keeps a finished video separate from the still unconfirmed catalog result', () => {
  child.localState = 'succeeded';
  render(
    <LaunchGenerationProgress
      generation={{
        ...generation,
        state: 'waiting_dependency',
        stage: 'restitch_processing',
        restitchOperationId: 'child'
      }}
      onCancel={vi.fn()}
      disabled={false}
      teamId="team"
    />
  );
  expect(screen.getByText('Video is ready. Waiting for server confirmation.')).toBeTruthy();
  const items = screen.getAllByRole('listitem');
  expect(items.find(item => item.textContent?.startsWith('Video'))?.textContent).toContain('✓');
  expect(items.find(item => item.textContent?.startsWith('Result'))?.textContent).not.toContain(
    '✓'
  );
});

it('labels disconnected progress as unconfirmed and leaves an explicit status read available', () => {
  child.streamDisconnected = true;
  child.localProgress = { stage: 'uploading', progress: 90 };
  const refresh = vi.fn().mockResolvedValue(undefined);
  render(
    <LaunchGenerationProgress
      generation={{
        ...generation,
        state: 'waiting_dependency',
        stage: 'restitch_processing',
        restitchOperationId: 'child'
      }}
      onRefresh={refresh}
      onCancel={vi.fn()}
      disabled={false}
      teamId="team"
    />
  );
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.getByText(/Live progress is unavailable/u)).toBeTruthy();
  expect(screen.queryByText('90%')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
});

it('shows the last confirmed action after quiet time without announcing a fabricated failure', async () => {
  vi.useFakeTimers();
  const refresh = vi.fn().mockResolvedValue(undefined);
  render(
    <LaunchGenerationProgress
      generation={generation}
      onRefresh={refresh}
      onCancel={vi.fn()}
      disabled={false}
    />
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(45_000);
  });
  expect(refresh).toHaveBeenCalledOnce();
  expect(screen.getByText('Last confirmed: Creating catalog')).toBeTruthy();
  expect(screen.getByText(/No new confirmation yet/u)).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('progressbar')).toBeNull();
});

it('fills catalog cells from measured work and keeps encoding completion below video delivery', () => {
  const view = render(
    <LaunchGenerationProgress
      generation={{
        ...generation,
        progress: { completed: 2, total: 4, unit: 'items', source: 'worker' }
      }}
      onCancel={vi.fn()}
      disabled={false}
    />
  );
  const catalog = screen.getAllByRole('listitem').find(item => item.textContent === 'Catalog')!;
  expect(catalog.querySelector('.is-measured')?.getAttribute('style')).toContain('0.125');
  child.localProgress = { stage: 'processing', progress: 100 };
  view.rerender(
    <LaunchGenerationProgress
      generation={{
        ...generation,
        state: 'waiting_dependency',
        stage: 'restitch_processing',
        restitchOperationId: 'child'
      }}
      teamId="team"
      onCancel={vi.fn()}
      disabled={false}
    />
  );
  const video = screen.getAllByRole('listitem').find(item => item.textContent === 'Video')!;
  expect(video.querySelector('.is-measured')?.getAttribute('style')).toContain('0.5');
  expect(video.dataset.state).toBe('active');
  child.localProgress = { stage: 'uploading', progress: 40 };
  view.rerender(
    <LaunchGenerationProgress
      generation={{
        ...generation,
        state: 'waiting_dependency',
        stage: 'restitch_processing',
        restitchOperationId: 'child'
      }}
      teamId="team"
      onCancel={vi.fn()}
      disabled={false}
    />
  );
  expect(screen.getByText('Saving video')).toBeTruthy();
  expect(video.querySelector('.is-measured')?.getAttribute('style')).toContain('0.6');
});

it('offers image settings for a durable or immediate missing-image failure', () => {
  const open = vi.fn();
  const view = render(
    <LaunchGenerationProgress
      generation={{
        ...generation,
        state: 'failed',
        stage: 'restitch_preparing',
        errorCode: 'RESTITCH_POOL_EMPTY'
      }}
      onCancel={vi.fn()}
      disabled={false}
      onOpenRestitchSettings={open}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Choose re-stitching images' }));
  expect(open).toHaveBeenCalledOnce();
  view.rerender(
    <LaunchGenerationProgress
      generation={null}
      requestError="Missing images"
      requestErrorCode="RESTITCH_IMAGE_UNAVAILABLE"
      onCancel={vi.fn()}
      disabled={false}
      onOpenRestitchSettings={open}
    />
  );
  expect(screen.getByRole('button', { name: 'Choose re-stitching images' })).toBeTruthy();
  expect(screen.queryByRole('progressbar')).toBeNull();
});

it('keeps a durably finalized video complete when catalog planning resumes', () => {
  render(
    <LaunchGenerationProgress
      generation={{
        ...generation,
        stage: 'catalog_planning',
        steps: [
          {
            id: 'video',
            stage: 'restitch_processing',
            state: 'succeeded',
            attemptNo: 1,
            errorCode: null
          }
        ]
      }}
      restitchEnabled
      onCancel={vi.fn()}
      disabled={false}
    />
  );
  const video = screen
    .getAllByRole('listitem')
    .find(item => item.textContent?.startsWith('Video'))!;
  expect(video.dataset.state).toBe('complete');
  expect(
    screen.getAllByRole('listitem').find(item => item.textContent === 'Catalog')?.dataset.state
  ).toBe('active');
});
