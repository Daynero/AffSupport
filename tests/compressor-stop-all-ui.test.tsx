// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultImageEmbeddingSettings, type QueueState } from '@video-compressor/shared';
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
    running: jobs.some(job => ['processing', 'queued'].includes(job.status)),
    batch: null,
    warning: null
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

describe('compressor stop all button', () => {
  it('appears only while the queue has work and cancels the whole batch', async () => {
    agent.state = queueState([makeJob('done', 'completed'), makeJob('waiting', 'ready')]);
    const idle = render(<CompressorPage />);
    expect(screen.queryByRole('button', { name: 'Stop all' })).toBeNull();
    idle.unmount();

    agent.state = queueState([makeJob('running', 'processing'), makeJob('queued-1', 'queued')]);
    api.request.mockResolvedValue(agent.state);
    render(<CompressorPage />);

    fireEvent.click(screen.getByRole('button', { name: /Stop all/ }));
    await waitFor(() => expect(api.request).toHaveBeenCalledWith('/api/queue/cancel-all', 'POST'));
  });
});
