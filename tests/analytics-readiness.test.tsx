// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { ReactNode } from 'react';
import type { LandingPreviewState } from '@video-compressor/shared';

/**
 * 031 T009 / FR-051 — `tool_ready`: once per transition into `connected`, `success` on the
 * first read that lands, `failure` once the read's retries are spent; for the three tool
 * pages through `useToolStateRead`, the landing preview through `useLandingViewer`, and the
 * compressor from the snapshot the provider applied before it reported `connected`.
 */

vi.mock('../apps/web/src/api/client.js', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  request: vi.fn(async () => new Promise(() => {})),
  requestBody: vi.fn(),
  toolEventUrl: () => '/events'
}));
vi.mock('../apps/web/src/api/useAgentEventStream.js', () => ({ useAgentEventStream: () => {} }));

import { analytics } from '../apps/web/src/analytics/service';
import { trackToolReady } from '../apps/web/src/analytics/readiness';
import { AgentContextOverride, type AgentContextValue } from '../apps/web/src/AgentContext';
import {
  STATE_READ_RETRIES,
  STATE_READ_RETRY_MS,
  useToolStateRead
} from '../apps/web/src/lib/use-tool-state-read';
import { useLandingViewer } from '../apps/web/src/landing-viewer/useLandingViewer';
import { emptyState, type LandingViewerSource } from '../apps/web/src/landing-viewer/types';
import CompressorPage from '../apps/web/src/App';
import { fakeAgentValue } from './support/fake-agent';

type Track = MockInstance<typeof analytics.track>;
let track: Track;

beforeEach(() => {
  localStorage.setItem('language', 'en');
  track = vi.spyOn(analytics, 'track').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

function ready(): Array<Record<string, unknown>> {
  return track.mock.calls
    .filter(([name]) => name === 'tool_ready')
    .map(([, properties]) => properties as unknown as Record<string, unknown>);
}

/** A hook host whose agent value the test can swap between renders. */
function agentHost() {
  let value: AgentContextValue = fakeAgentValue();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AgentContextOverride value={value}>{children}</AgentContextOverride>
  );
  return {
    wrapper,
    set(overrides: Partial<AgentContextValue>) {
      value = fakeAgentValue(overrides);
    }
  };
}

describe('trackToolReady', () => {
  it('sends the closed shape, clamps the duration and never a message as the code', () => {
    const tracker = { track: vi.fn() };
    trackToolReady({ tool: 'stitcher', outcome: 'success', durationMs: 12.6 }, tracker);
    trackToolReady(
      {
        tool: 'transcription',
        outcome: 'failure',
        durationMs: -5,
        stage: 'initial_read',
        errorCode: 'Could not read /Users/someone/secret.mov'
      },
      tracker
    );
    trackToolReady(
      { tool: 'landing-preview', outcome: 'failure', durationMs: 9e12, errorCode: 'TIMEOUT' },
      tracker
    );
    expect(tracker.track.mock.calls).toEqual([
      ['tool_ready', { tool_identifier: 'stitcher', outcome: 'success', duration_ms: 13 }],
      [
        'tool_ready',
        {
          tool_identifier: 'transcription',
          outcome: 'failure',
          duration_ms: 0,
          error_stage: 'initial_read',
          error_code: 'unknown'
        }
      ],
      [
        'tool_ready',
        {
          tool_identifier: 'landing-preview',
          outcome: 'failure',
          duration_ms: 86_400_000,
          error_code: 'TIMEOUT'
        }
      ]
    ]);
  });
});

describe('useToolStateRead · tool_ready', () => {
  it('reports one success per connected period, not per re-read', async () => {
    const host = agentHost();
    const read = vi.fn(async () => 'snapshot');
    const view = renderHook(() => useToolStateRead(read, () => {}, { tool: 'transcription' }), {
      wrapper: host.wrapper
    });
    await waitFor(() => expect(ready()).toHaveLength(1));
    expect(ready()[0]).toMatchObject({ tool_identifier: 'transcription', outcome: 'success' });

    // A manual retry while still connected re-reads and stays one verdict.
    act(() => view.result.current.retry());
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    view.rerender();
    expect(ready()).toHaveLength(1);

    // Losing the link and getting it back is a new period, and a new verdict.
    host.set({ connection: 'disconnected' });
    view.rerender();
    host.set({ connection: 'connected' });
    view.rerender();
    await waitFor(() => expect(ready()).toHaveLength(2));
  });

  it('reports failure with its code once the retries are spent', async () => {
    vi.useFakeTimers();
    const host = agentHost();
    const read = vi.fn(async () => {
      throw new Error('CONNECTION_FAILED');
    });
    renderHook(() => useToolStateRead(read, () => {}, { tool: 'stitcher' }), {
      wrapper: host.wrapper
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATE_READ_RETRY_MS * (STATE_READ_RETRIES + 1));
    });
    expect(read).toHaveBeenCalledTimes(STATE_READ_RETRIES + 1);
    expect(ready()).toEqual([
      expect.objectContaining({
        tool_identifier: 'stitcher',
        outcome: 'failure',
        error_stage: 'initial_read',
        error_code: 'CONNECTION_FAILED'
      })
    ]);
  });

  it('tracks nothing without a tool', async () => {
    const host = agentHost();
    const read = vi.fn(async () => 'snapshot');
    renderHook(() => useToolStateRead(read, () => {}), { wrapper: host.wrapper });
    await waitFor(() => expect(read).toHaveBeenCalled());
    expect(ready()).toEqual([]);
  });
});

describe('useLandingViewer · tool_ready', () => {
  function source(fetchState: () => Promise<LandingPreviewState>): LandingViewerSource {
    return {
      capabilities: {
        chooseFolder: false,
        openPaths: false,
        refresh: false,
        cancel: false,
        reveal: false,
        openExtracted: false,
        clearCache: false,
        removeCatalog: false,
        settings: false
      },
      fetchState,
      subscribe: () => () => {},
      imageUrl: () => null,
      activate: async () => emptyState
    };
  }

  it('reports the landing preview ready after its first state, once', async () => {
    const landing = source(async () => emptyState);
    const view = renderHook(
      ({ enabled }) =>
        useLandingViewer({ source: landing, enabled, readinessTool: 'landing-preview' }),
      { initialProps: { enabled: false } }
    );
    expect(ready()).toEqual([]);
    view.rerender({ enabled: true });
    await waitFor(() => expect(ready()).toHaveLength(1));
    view.rerender({ enabled: true });
    expect(ready()[0]).toMatchObject({ tool_identifier: 'landing-preview', outcome: 'success' });
    expect(ready()).toHaveLength(1);
  });

  it('reports a failed first read as failure at initial_read', async () => {
    const landing = source(async () => {
      throw new Error('TIMEOUT');
    });
    renderHook(() => useLandingViewer({ source: landing, readinessTool: 'landing-preview' }));
    await waitFor(() => expect(ready()).toHaveLength(1));
    expect(ready()[0]).toMatchObject({
      outcome: 'failure',
      error_stage: 'initial_read',
      error_code: 'TIMEOUT'
    });
  });
});

describe('compressor · tool_ready', () => {
  function page(connection: AgentContextValue['connection']) {
    return (
      <AgentContextOverride value={fakeAgentValue({ connection })}>
        <CompressorPage />
      </AgentContextOverride>
    );
  }

  it('reports ready on the first connected render, once per connected period', () => {
    const view = render(page('checking'));
    expect(ready()).toEqual([]);
    view.rerender(page('connected'));
    view.rerender(page('connected'));
    expect(ready()).toEqual([
      expect.objectContaining({ tool_identifier: 'compressor', outcome: 'success' })
    ]);
    view.rerender(page('disconnected'));
    view.rerender(page('connected'));
    expect(ready()).toHaveLength(2);
  });
});
