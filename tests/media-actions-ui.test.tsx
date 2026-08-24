// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultImageEmbeddingSettings,
  type MediaActionJob,
  type MediaActionState,
  type QueueState
} from '@video-compressor/shared';
import { optimalSettings } from './helpers.js';

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

function conversion(id: string, status: MediaActionJob['status']): MediaActionJob {
  return {
    id,
    kind: 'image-conversion',
    inputPath: `/Users/someone/Pictures/${id}.png`,
    outputPath: `/Users/someone/Pictures/${id}.jpg`,
    targetFormat: 'jpeg',
    status,
    errorCode: null,
    error: null,
    createdAt: 0,
    startedAt: null,
    finishedAt: null
  };
}

function queueState(mediaActions?: MediaActionState): QueueState {
  return {
    jobs: [],
    settings: { ...optimalSettings, imageEmbedding: defaultImageEmbeddingSettings() },
    tools: { ffmpeg: true, ffprobe: true },
    running: false,
    batch: null,
    warning: null,
    ...(mediaActions ? { mediaActions } : {})
  };
}

beforeEach(() => {
  localStorage.setItem('language', 'en');
  api.request.mockReset();
  api.requestBody.mockReset();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('conversions started outside this window', () => {
  it('says nothing at all on an agent that does not offer them', () => {
    agent.state = queueState();
    render(<CompressorPage />);
    expect(screen.queryByRole('heading', { name: 'Image conversions' })).toBeNull();
  });

  it('says nothing when none have run this session', () => {
    agent.state = queueState({ running: false, jobs: [] });
    render(<CompressorPage />);
    expect(screen.queryByRole('heading', { name: 'Image conversions' })).toBeNull();
  });

  it('shows a running conversion and stops the one that was asked for', async () => {
    agent.state = queueState({
      running: true,
      jobs: [conversion('running', 'processing'), conversion('waiting', 'queued')]
    });
    api.request.mockResolvedValue({ state: queueState({ running: false, jobs: [] }) });
    render(<CompressorPage />);

    // A conversion started from the file manager has no window of its own. Before this it
    // was invisible here, and a wedged one could only be stopped by quitting (A3).
    expect(screen.getByRole('heading', { name: 'Image conversions' })).toBeTruthy();
    expect(screen.getByText('running.png')).toBeTruthy();
    expect(screen.getByText('Converting…')).toBeTruthy();

    const [first] = screen.getAllByRole('button', { name: 'Stop conversion' });
    fireEvent.click(first);
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith('/api/media-actions/running/cancel', 'POST')
    );
  });

  it('offers to stop everything only while something can still be stopped', () => {
    agent.state = queueState({
      running: false,
      jobs: [conversion('done', 'completed'), conversion('stopped', 'cancelled')]
    });
    const settled = render(<CompressorPage />);
    expect(screen.queryByRole('button', { name: 'Stop all conversions' })).toBeNull();
    // Still listed, though — a conversion that finished while no window was open is the
    // only place the user learns it happened at all.
    expect(screen.getByText('Converted')).toBeTruthy();
    expect(screen.getByText('Stopped')).toBeTruthy();
    settled.unmount();

    agent.state = queueState({ running: true, jobs: [conversion('running', 'processing')] });
    render(<CompressorPage />);
    expect(screen.getByRole('button', { name: 'Stop all conversions' })).toBeTruthy();
  });

  it('says the list is session-scoped rather than letting it empty itself silently', () => {
    agent.state = queueState({ running: true, jobs: [conversion('running', 'processing')] });
    render(<CompressorPage />);
    // Deliberately not persisted — that would be new capability. Saying so is what keeps
    // an empty list after a restart from reading as work that was lost.
    expect(
      screen.getByText('Started from Finder or Explorer. This list is cleared when Soty quits.')
    ).toBeTruthy();
  });
});
