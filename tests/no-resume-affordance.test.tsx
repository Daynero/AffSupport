// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPRESSION_LIFECYCLE,
  defaultImageEmbeddingSettings,
  isSettled,
  statesOf,
  type JobStatus,
  type QueueState
} from '@video-compressor/shared';
import { makeJob, optimalSettings } from './helpers.js';

const api = vi.hoisted(() => ({
  addLocalFiles: vi.fn(),
  agentUrl: 'http://127.0.0.1:43120',
  imageContentUrl: vi.fn(() => ''),
  markAgentInstallStarted: vi.fn(),
  request: vi.fn(),
  requestBody: vi.fn(),
  uploadFile: vi.fn(),
  uploadImage: vi.fn()
}));

const agent = vi.hoisted(() => ({ state: null as unknown as QueueState }));

vi.mock('../apps/web/src/api/client.js', () => api);
vi.mock('../apps/web/src/AgentContext.js', () => ({
  useAgent: () => ({
    connection: 'connected',
    connectedOnce: true,
    state: agent.state,
    setState: vi.fn(),
    capabilities: [],
    reconnect: vi.fn()
  })
}));
vi.mock('../apps/web/src/analytics/service.js', () => ({
  analytics: { setLocale: vi.fn(), track: vi.fn() }
}));

import CompressorPage from '../apps/web/src/App.js';

function queueState(jobs: QueueState['jobs']): QueueState {
  return {
    jobs,
    settings: { ...optimalSettings, imageEmbedding: defaultImageEmbeddingSettings() },
    tools: { ffmpeg: true, ffprobe: true },
    running: false,
    batch: null,
    warning: null
  };
}

/** Every way a run can end short of finishing — asked of the table, not listed by hand. */
const stoppedStates = statesOf(COMPRESSION_LIFECYCLE).filter(
  status => isSettled(COMPRESSION_LIFECYCLE, status) && status !== 'completed'
) as JobStatus[];

beforeEach(() => {
  localStorage.setItem('language', 'en');
  api.request.mockReset();
  api.requestBody.mockReset();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/**
 * No resume exists anywhere in the local application (FR-008).
 *
 * A stop tears down the encoder and unlinks the partial output; there is nothing left to
 * carry on from. So an interface that offered to continue a stopped run would be making a
 * promise the machine underneath it cannot keep — the same class of untruth as a screen
 * that says "processing" about a process that is gone.
 *
 * Asserted rather than audited once, because this is exactly the kind of affordance that
 * arrives later as an innocent-looking label.
 */
describe('a stopped run is re-run, never resumed', () => {
  it('offers a re-run and nothing that implies continuing', () => {
    expect(stoppedStates.length).toBeGreaterThan(0);
    for (const status of stoppedStates) {
      agent.state = queueState([makeJob('stopped', status)]);
      const view = render(<CompressorPage />);
      expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /resume|continue/i })).toBeNull();
      view.unmount();
    }
  });

  it('starts the whole job over rather than picking up where it stopped', async () => {
    agent.state = queueState([makeJob('stopped', 'cancelled')]);
    api.request.mockResolvedValue(agent.state);
    render(<CompressorPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    // `retry`, not a resume endpoint — the agent has none, and this is what keeps the
    // interface from acquiring one by way of a button that needs it.
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith('/api/jobs/stopped/retry', 'POST')
    );
  });
});
