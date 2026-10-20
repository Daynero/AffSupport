// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { analytics } from '../apps/web/src/analytics/service';
import { sanitizeAnalyticsProperties } from '../apps/web/src/analytics/events';
import { lookupCodeLocations } from '../scripts/analytics/code-map';
vi.mock('../apps/web/src/analytics/service', () => ({ analytics: { track: vi.fn() } }));
import {
  DeferredLaunchSession,
  type LaunchSessionLoader
} from '../apps/web/src/team/launches/DeferredLaunchSession';

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

function sessionProps() {
  return {
    teamId: 'team',
    detail: null,
    defaults: null,
    accounts: [],
    offers: [],
    buyers: [],
    editable: true,
    manage: true,
    deletable: true,
    tab: 'settings' as const,
    revisionId: null,
    historical: false,
    onTab: vi.fn(),
    onRevision: vi.fn(),
    onChange: vi.fn(),
    onClose: vi.fn(),
    closeRequestRef: { current: () => {} },
    onDictionaries: vi.fn(async () => {})
  };
}

function pendingSession() {
  let resolve!: (value: Awaited<ReturnType<LaunchSessionLoader>>) => void;
  const promise = new Promise<Awaited<ReturnType<LaunchSessionLoader>>>(yes => {
    resolve = yes;
  });
  return { promise, resolve };
}

it('does not load a session on the list and exposes both modal-close and visible close while pending', async () => {
  const pending = pendingSession();
  const loader = vi.fn(() => pending.promise);
  const props = sessionProps();
  function Host() {
    const [open, setOpen] = React.useState(false);
    return (
      <>
        <p>Launch list</p>
        <button onClick={() => setOpen(true)}>Open launch</button>
        {open && <DeferredLaunchSession {...props} loader={loader} />}
      </>
    );
  }
  render(<Host />);
  expect(loader).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Open launch'));
  expect(loader).toHaveBeenCalledTimes(1);
  act(() => props.closeRequestRef.current());
  expect(props.onClose).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: /^Close$/ }));
  expect(props.onClose).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Launch list')).toBeTruthy();
  await act(async () => pending.resolve({ LaunchSession: () => <p>Ready</p> }));
});

it('keeps failure local and retries the import with current permissions and route props', async () => {
  const loader = vi
    .fn<LaunchSessionLoader>()
    .mockRejectedValueOnce(new Error('CHUNK_LOAD_FAILED'))
    .mockResolvedValueOnce({
      LaunchSession: ({ teamId, editable, tab }) => (
        <p>{`${teamId}/${editable ? 'editor' : 'viewer'}/${tab}`}</p>
      )
    });
  const props = sessionProps();
  const view = render(<DeferredLaunchSession {...props} loader={loader} />);
  await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: /^Close$/ })).toBeTruthy();
  view.rerender(<DeferredLaunchSession {...props} editable={false} tab="result" loader={loader} />);
  fireEvent.click(screen.getByRole('button', { name: 'Repeat' }));
  await screen.findByText('team/viewer/result');
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
  expect(calls.some(([name]) => name === 'operation_cancelled')).toBe(false);
});

it('ignores late imports after the modal closed instead of mounting stale launch state', async () => {
  const pending = pendingSession();
  const loader = vi.fn(() => pending.promise);
  const mounted = vi.fn();
  const props = sessionProps();
  function Host() {
    const [open, setOpen] = React.useState(true);
    return open ? (
      <DeferredLaunchSession {...props} onClose={() => setOpen(false)} loader={loader} />
    ) : (
      <p>Launch list</p>
    );
  }
  render(<Host />);
  act(() => props.closeRequestRef.current());
  await act(async () =>
    pending.resolve({
      LaunchSession: () => {
        React.useEffect(mounted, []);
        return <p>Stale launch</p>;
      }
    })
  );
  expect(screen.getByText('Launch list')).toBeTruthy();
  expect(mounted).not.toHaveBeenCalled();
  const calls = vi.mocked(analytics.track).mock.calls;
  expect(calls.filter(([name]) => name === 'operation_cancelled')).toHaveLength(1);
  expect(
    calls.some(([name]) => name === 'operation_failed' || name === 'operation_completed')
  ).toBe(false);
  expect(loadProps('operation_cancelled').attempt_id).toBe(
    loadProps('operation_started').attempt_id
  );
});

it('preserves mounted draft identity across tabs and never overwrites the session dirty-close guard', async () => {
  const pending = pendingSession();
  const loader = vi.fn(() => pending.promise);
  const guard = vi.fn();
  const mounted = vi.fn();
  const props = sessionProps();
  const view = render(<DeferredLaunchSession {...props} loader={loader} />);
  await act(async () =>
    pending.resolve({
      LaunchSession: ({ tab, closeRequestRef }) => {
        const [draft, setDraft] = React.useState('original');
        React.useEffect(mounted, []);
        closeRequestRef.current = guard;
        return (
          <>
            <p>{tab}</p>
            <input aria-label="Draft" value={draft} onChange={e => setDraft(e.target.value)} />
          </>
        );
      }
    })
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'Draft' }), {
    target: { value: 'unsaved edit' }
  });
  view.rerender(<DeferredLaunchSession {...props} tab="result" loader={loader} />);
  expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveProperty('value', 'unsaved edit');
  expect(screen.getByText('result')).toBeTruthy();
  expect(mounted).toHaveBeenCalledTimes(1);
  expect(loader).toHaveBeenCalledTimes(1);
  act(() => props.closeRequestRef.current());
  expect(guard).toHaveBeenCalledTimes(1);
  expect(props.onClose).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
});

it('proves the session DOM committed and diagnoses import failure without collecting its URL', async () => {
  const pending = pendingSession();
  const committed: boolean[] = [];
  vi.mocked(analytics.track).mockImplementation(name => {
    if (name === 'operation_completed')
      committed.push(Boolean(screen.queryByText('Committed launch detail')));
  });
  const view = render(<DeferredLaunchSession {...sessionProps()} loader={() => pending.promise} />);
  expect(committed).toEqual([]);
  await act(async () => pending.resolve({ LaunchSession: () => <p>Committed launch detail</p> }));
  expect(committed).toEqual([true]);
  view.unmount();
  expect(
    vi.mocked(analytics.track).mock.calls.some(([name]) => name === 'operation_cancelled')
  ).toBe(false);
  vi.mocked(analytics.track).mockClear();
  const loader = vi
    .fn<LaunchSessionLoader>()
    .mockRejectedValue(
      new Error('https://provider.invalid/private-session.js?secret=token USER-CONTENT')
    );
  render(<DeferredLaunchSession {...sessionProps()} loader={loader} />);
  await screen.findByRole('alert');
  const calls = vi.mocked(analytics.track).mock.calls;
  const error = calls.find(([name]) => name === 'error_occurred');
  expect(error?.[1]).toMatchObject({
    error_code: 'LAUNCH_SESSION_LOAD_FAILED',
    error_fingerprint: 'team:library:LAUNCH_SESSION_LOAD_FAILED',
    flow_step: 'launch_detail_session',
    retryable: true
  });
  expect(sanitizeAnalyticsProperties(error?.[1], 'error_occurred')).toMatchObject({
    error_code: 'LAUNCH_SESSION_LOAD_FAILED',
    attempt_id: expect.any(String),
    flow_id: expect.any(String)
  });
  expect(lookupCodeLocations(loadProps('error_occurred').error_fingerprint ?? '')?.files).toContain(
    'apps/web/src/team/launches/DeferredLaunchSession.tsx'
  );
  expect(JSON.stringify(calls)).not.toMatch(
    /provider.invalid|private-session|secret|USER-CONTENT|teamId/
  );
});

it('keeps load, retry, close and pending cleanup usable when telemetry throws', async () => {
  vi.mocked(analytics.track).mockImplementation(() => {
    throw new Error('telemetry unavailable');
  });
  const props = sessionProps();
  const loader = vi
    .fn<LaunchSessionLoader>()
    .mockRejectedValueOnce(new Error('chunk import failed'))
    .mockResolvedValueOnce({
      LaunchSession: ({ onClose }) => <button onClick={onClose}>Close loaded detail</button>
    });
  const view = render(<DeferredLaunchSession {...props} loader={loader} />);
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Repeat' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Close loaded detail' }));
  expect(props.onClose).toHaveBeenCalledTimes(1);
  expect(loader).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(() => view.unmount()).not.toThrow();
  const pending = pendingSession();
  const pendingProps = sessionProps();
  const pendingView = render(
    <DeferredLaunchSession {...pendingProps} loader={() => pending.promise} />
  );
  act(() => pendingProps.closeRequestRef.current());
  expect(pendingProps.onClose).toHaveBeenCalledTimes(1);
  expect(() => pendingView.unmount()).not.toThrow();
  await act(async () => pending.resolve({ LaunchSession: () => <p>Late detail</p> }));
  expect(screen.queryByText('Late detail')).toBeNull();
});
