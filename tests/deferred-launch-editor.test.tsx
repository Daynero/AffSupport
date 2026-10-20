// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  DeferredLaunchEditor,
  type LaunchEditorLoader
} from '../apps/web/src/team/launches/DeferredLaunchEditor';
import { launchConfig } from './fixtures/launches';
import { analytics } from '../apps/web/src/analytics/service';
import { sanitizeAnalyticsProperties } from '../apps/web/src/analytics/events';
import { lookupCodeLocations } from '../scripts/analytics/code-map';
import { COVERAGE_REGISTRY } from '../scripts/analytics/coverage-registry';
vi.mock('../apps/web/src/analytics/service', () => ({ analytics: { track: vi.fn() } }));

type LoadEvent =
  | 'operation_started'
  | 'operation_completed'
  | 'operation_failed'
  | 'operation_cancelled'
  | 'error_occurred';

/** Narrow generic tracker calls through the actual event and validated wire shape. */
function loadProps(name: LoadEvent, index = 0) {
  const call = vi.mocked(analytics.track).mock.calls.filter(([event]) => event === name)[index];
  if (!call || call[0] !== name) throw new Error(`Missing ${name} call ${index}`);
  const properties = sanitizeAnalyticsProperties(call[1], name);
  if (
    typeof properties.flow_id !== 'string' ||
    typeof properties.attempt_id !== 'string' ||
    typeof properties.flow_step !== 'string' ||
    (name === 'error_occurred' && typeof properties.error_fingerprint !== 'string')
  )
    throw new Error(`Invalid ${name} diagnostic shape`);
  return {
    ...properties,
    flow_id: properties.flow_id,
    attempt_id: properties.attempt_id,
    flow_step: properties.flow_step,
    error_fingerprint:
      typeof properties.error_fingerprint === 'string' ? properties.error_fingerprint : undefined
  };
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const props = {
  teamId: 'team',
  config: launchConfig(),
  sources: null,
  accounts: [],
  offers: [],
  buyers: [],
  disabled: false,
  onChange: vi.fn(),
  onRefreshSources: vi.fn()
};

function deferredEditor() {
  let resolve!: (module: Awaited<ReturnType<LaunchEditorLoader>>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Awaited<ReturnType<LaunchEditorLoader>>>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it('requests the editor only when settings open and uses the latest props after loading', async () => {
  const deferred = deferredEditor();
  const loader = vi.fn(() => deferred.promise);
  function Host() {
    const [open, setOpen] = React.useState(false);
    const [age, setAge] = React.useState(30);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open settings</button>
        <button onClick={() => setAge(50)}>Change while loading</button>
        {open && (
          <DeferredLaunchEditor {...props} config={{ ...props.config, age }} loader={loader} />
        )}
      </>
    );
  }
  render(<Host />);
  expect(loader).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Open settings'));
  expect(loader).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('status')).toBeTruthy();
  fireEvent.click(screen.getByText('Change while loading'));
  await act(async () =>
    deferred.resolve({ LaunchEditor: ({ config }) => <p>Editor age {config.age}</p> })
  );
  expect(screen.getByText('Editor age 50')).toBeTruthy();
  const started = vi
    .mocked(analytics.track)
    .mock.calls.find(([name]) => name === 'operation_started');
  const completed = vi
    .mocked(analytics.track)
    .mock.calls.find(([name]) => name === 'operation_completed');
  expect(completed?.[1]).toMatchObject({ ...started?.[1], outcome: 'success', success: true });
  expect(loadProps('operation_started').flow_step).toBe('launch_settings_editor');
});

it('shows a local failure and retries without losing the surrounding launch session', async () => {
  const loader = vi
    .fn<LaunchEditorLoader>()
    .mockRejectedValueOnce(new Error('CHUNK_LOAD_FAILED'))
    .mockResolvedValueOnce({ LaunchEditor: () => <p>Settings ready</p> });
  render(
    <>
      <p>Saved launch result</p>
      <DeferredLaunchEditor {...props} loader={loader} />
    </>
  );
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  expect(screen.getByText('Saved launch result')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Repeat' }));
  await screen.findByText('Settings ready');
  expect(loader).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).toBeNull();
  const calls = vi.mocked(analytics.track).mock.calls;
  const starts = calls.filter(([name]) => name === 'operation_started');
  expect(starts).toHaveLength(2);
  expect(loadProps('operation_started', 0).flow_id).toBe(loadProps('operation_started', 1).flow_id);
  expect(loadProps('operation_started', 0).attempt_id).not.toBe(
    loadProps('operation_started', 1).attempt_id
  );
  expect(loadProps('operation_failed').attempt_id).toBe(
    loadProps('operation_started', 0).attempt_id
  );
  expect(loadProps('operation_completed').attempt_id).toBe(
    loadProps('operation_started', 1).attempt_id
  );
  expect(calls.filter(([name]) => name === 'operation_cancelled')).toHaveLength(0);
});

it('allows closing while pending and ignores an editor response for the closed session', async () => {
  const deferred = deferredEditor();
  const loader = vi.fn(() => deferred.promise);
  const mounted = vi.fn();
  function Host() {
    const [open, setOpen] = React.useState(true);
    return (
      <>
        <p>Launch list</p>
        <button onClick={() => setOpen(false)}>Close launch</button>
        {open && <DeferredLaunchEditor {...props} loader={loader} />}
      </>
    );
  }
  render(<Host />);
  fireEvent.click(screen.getByText('Close launch'));
  await act(async () =>
    deferred.resolve({
      LaunchEditor: () => {
        React.useEffect(mounted, []);
        return <p>Stale settings</p>;
      }
    })
  );
  expect(screen.getByText('Launch list')).toBeTruthy();
  expect(screen.queryByText('Stale settings')).toBeNull();
  expect(mounted).not.toHaveBeenCalled();
  const calls = vi.mocked(analytics.track).mock.calls;
  expect(calls.filter(([name]) => name === 'operation_cancelled')).toHaveLength(1);
  expect(
    calls.some(([name]) => name === 'operation_completed' || name === 'operation_failed')
  ).toBe(false);
  expect(loadProps('operation_cancelled').attempt_id).toBe(
    loadProps('operation_started').attempt_id
  );
});

it('proves completion only after the editor DOM commit and exposes a safe diagnosable import failure', async () => {
  const deferred = deferredEditor();
  const committed: boolean[] = [];
  vi.mocked(analytics.track).mockImplementation(name => {
    if (name === 'operation_completed')
      committed.push(Boolean(screen.queryByText('Committed settings')));
  });
  const view = render(<DeferredLaunchEditor {...props} loader={() => deferred.promise} />);
  expect(committed).toEqual([]);
  await act(async () => deferred.resolve({ LaunchEditor: () => <p>Committed settings</p> }));
  expect(committed).toEqual([true]);
  view.unmount();
  expect(
    vi.mocked(analytics.track).mock.calls.some(([name]) => name === 'operation_cancelled')
  ).toBe(false);
  vi.mocked(analytics.track).mockClear();
  const loader = vi
    .fn<LaunchEditorLoader>()
    .mockRejectedValue(
      new Error('https://provider.invalid/private-chunk.js?secret=token USER-CONTENT')
    );
  render(<DeferredLaunchEditor {...props} loader={loader} />);
  await screen.findByRole('alert');
  const calls = vi.mocked(analytics.track).mock.calls;
  const error = calls.find(([name]) => name === 'error_occurred');
  expect(error?.[1]).toMatchObject({
    error_code: 'LAUNCH_EDITOR_LOAD_FAILED',
    error_fingerprint: 'team:library:LAUNCH_EDITOR_LOAD_FAILED',
    retryable: true
  });
  expect(sanitizeAnalyticsProperties(error?.[1], 'error_occurred')).toMatchObject({
    error_code: 'LAUNCH_EDITOR_LOAD_FAILED',
    attempt_id: expect.any(String),
    flow_id: expect.any(String)
  });
  const location = lookupCodeLocations(loadProps('error_occurred').error_fingerprint ?? '');
  expect(location?.matched).toBe('team:library:LAUNCH_EDITOR_LOAD_FAILED');
  expect(location?.files).toContain('apps/web/src/team/launches/DeferredLaunchEditor.tsx');
  expect(COVERAGE_REGISTRY.find(capability => capability.id === 'team.launches')?.note).toContain(
    'flow_step=launch_settings_editor'
  );
  expect(JSON.stringify(calls)).not.toMatch(
    /provider.invalid|private-chunk|secret|USER-CONTENT|teamId/
  );
});

it('keeps load, retry, editing and pending cleanup usable when telemetry throws', async () => {
  vi.mocked(analytics.track).mockImplementation(() => {
    throw new Error('telemetry unavailable');
  });
  const loader = vi
    .fn<LaunchEditorLoader>()
    .mockRejectedValueOnce(new Error('chunk import failed'))
    .mockResolvedValueOnce({
      LaunchEditor: ({ onChange, config }) => (
        <button onClick={() => onChange(config)}>Edit loaded settings</button>
      )
    });
  const view = render(<DeferredLaunchEditor {...props} loader={loader} />);
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Repeat' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit loaded settings' }));
  expect(props.onChange).toHaveBeenCalledWith(props.config);
  expect(loader).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(() => view.unmount()).not.toThrow();
  const pending = deferredEditor();
  const pendingView = render(<DeferredLaunchEditor {...props} loader={() => pending.promise} />);
  expect(() => pendingView.unmount()).not.toThrow();
  await act(async () => pending.resolve({ LaunchEditor: () => <p>Late editor</p> }));
  expect(screen.queryByText('Late editor')).toBeNull();
});
