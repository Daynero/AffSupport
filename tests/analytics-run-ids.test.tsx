// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type {
  CompressionJob,
  LandingJob,
  LandingState,
  QueueState,
  TranscriptionJob,
  TranscriptionModelInfo,
  TranscriptionState
} from '@video-compressor/shared';
import type { StitchJob, StitcherState } from '../packages/shared/src/stitcher.js';

/**
 * 031 T008 / FR-050 — every local tool's run carries its job id as `run_id`, and the start
 * and the terminal of one run carry the same one. Driven through the real pages: a queue
 * snapshot changes, the page derives its lifecycle, and the events are read off
 * `analytics.track`.
 */

const api = vi.hoisted(() => ({ request: vi.fn(), requestBody: vi.fn() }));
const streams = vi.hoisted(() => new Map<string, (message: unknown) => void>());
const stitcherApi = vi.hoisted(() => ({
  startStitchJobs: vi.fn(),
  fetchCompressorState: vi.fn(async () => new Promise(() => {}))
}));

vi.mock('../apps/web/src/api/client.js', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  request: api.request,
  requestBody: api.requestBody,
  toolEventUrl: () => '/events',
  imageContentUrl: async () => null
}));
vi.mock('../apps/web/src/api/useAgentEventStream.js', () => ({
  useAgentEventStream: (options: { channel: string; onMessage: (message: unknown) => void }) => {
    streams.set(options.channel, options.onMessage);
  }
}));
vi.mock('../apps/web/src/api/useSubresourceUrl', () => ({ useSubresourceUrl: () => null }));
vi.mock('../apps/web/src/stitcher/api', () => ({
  inspectStitchSource: vi.fn(),
  addStitchFiles: vi.fn(),
  startStitchJobs: stitcherApi.startStitchJobs,
  selectStitchSources: vi.fn(),
  resolveDroppedVideo: vi.fn(),
  selectStitchFolder: vi.fn(),
  cancelStitch: vi.fn(),
  fetchStitcherState: vi.fn(),
  updateStitcherSettings: vi.fn(),
  revealStitchOutput: vi.fn(),
  openStitchOutput: vi.fn(),
  repeatStitch: vi.fn(),
  removeStitch: vi.fn(),
  clearFinishedStitches: vi.fn(),
  fetchCompressorState: stitcherApi.fetchCompressorState,
  updateCompressorSettings: vi.fn(),
  uploadScreenImage: vi.fn(),
  removeScreenImage: vi.fn()
}));

import { analytics } from '../apps/web/src/analytics/service';
import { AgentContextOverride } from '../apps/web/src/AgentContext';
import CompressorPage from '../apps/web/src/App';
import TranscriptionPage from '../apps/web/src/transcription/TranscriptionPage';
import LandingOptimizerPage from '../apps/web/src/landing/LandingOptimizerPage';
import { Stitcher } from '../apps/web/src/stitcher/StitcherPage';
import {
  StitcherContextOverride,
  type StitcherStore
} from '../apps/web/src/stitcher/StitcherContext';
import { fakeAgentValue, fakeQueueState } from './support/fake-agent';
import { makeJob } from './helpers';

const RUN = '7a1e2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b';

type Track = MockInstance<typeof analytics.track>;
let track: Track;

beforeEach(() => {
  localStorage.setItem('language', 'en');
  streams.clear();
  api.request.mockReset();
  api.requestBody.mockReset();
  track = vi.spyOn(analytics, 'track').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

/** Every tracked event of these names, with its properties. */
function events(...names: string[]): Array<{ name: string; properties: Record<string, unknown> }> {
  return track.mock.calls
    .filter(([name]) => names.includes(name))
    .map(([name, properties]) => ({
      name,
      properties: properties as unknown as Record<string, unknown>
    }));
}

function runIdsOf(...names: string[]): unknown[] {
  return events(...names).map(event => event.properties.run_id);
}

async function push(channel: string, message: unknown) {
  await act(async () => {
    streams.get(channel)?.(message);
  });
}

describe('compressor', () => {
  function page(jobs: CompressionJob[]) {
    return (
      <AgentContextOverride
        value={fakeAgentValue({ state: fakeQueueState({ jobs }) as QueueState })}
      >
        <CompressorPage />
      </AgentContextOverride>
    );
  }

  it('starts and ends a compression on the job id, estimates included', () => {
    const view = render(page([makeJob(RUN, 'ready')]));
    view.rerender(page([makeJob(RUN, 'ready', { estimateStatus: 'estimating' })]));
    view.rerender(
      page([
        // 033 FR-007: the agent's code is read, never the message beside it.
        makeJob(RUN, 'ready', {
          estimateStatus: 'unavailable',
          estimateError: 'Too few representative samples could be read.',
          estimateErrorCode: 'ESTIMATE_SAMPLES_UNREADABLE'
        })
      ])
    );
    view.rerender(page([makeJob(RUN, 'processing', { estimateStatus: 'unavailable' })]));
    view.rerender(page([makeJob(RUN, 'failed', { errorCode: 'DISK_FULL' })]));

    expect(runIdsOf('estimate_started', 'estimate_failed')).toEqual([RUN, RUN]);
    expect(events('estimate_failed')[0]!.properties).toMatchObject({
      error_code: 'ESTIMATE_SAMPLES_UNREADABLE'
    });
    expect(runIdsOf('compression_started', 'compression_failed')).toEqual([RUN, RUN]);
    expect(events('compression_failed')[0]!.properties).toMatchObject({ error_code: 'DISK_FULL' });
  });
});

describe('stitcher', () => {
  function stitch(status: StitchJob['status']): StitchJob {
    return {
      id: RUN,
      sourcePath: '/Users/x/Movies/creative.mp4',
      sourceName: 'creative.mp4',
      plan: null,
      detected: null,
      operation: 'restitch',
      destination: { kind: 'beside' },
      outputSuffix: '',
      status,
      stage: null,
      outputPath: null,
      elapsedMs: null,
      error: status === 'failed' ? 'STITCH_VERIFY_FAILED' : null,
      verification: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      source: null,
      result: null
    } as unknown as StitchJob;
  }

  function store(jobs: StitchJob[]): StitcherStore {
    const state: StitcherState = {
      settings: { destination: { kind: 'beside' }, outputSuffix: '' },
      jobs,
      busy: false
    };
    return {
      state,
      connected: true,
      refresh: vi.fn(),
      applyState: vi.fn(),
      updateSettings: vi.fn()
    };
  }

  function page(jobs: StitchJob[]) {
    return (
      <AgentContextOverride value={fakeAgentValue({ capabilities: ['stitcher'] })}>
        <StitcherContextOverride value={store(jobs)}>
          <Stitcher />
        </StitcherContextOverride>
      </AgentContextOverride>
    );
  }

  it('gives stitch_started, operation_* and stitch_completed one run_id', async () => {
    stitcherApi.startStitchJobs.mockResolvedValue({
      state: store([stitch('queued')]).state,
      failures: []
    });
    const view = render(page([stitch('ready')]));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'creative.mp4' }));
    fireEvent.click(screen.getByRole('button', { name: 'Re-stitch (1)' }));
    await waitFor(() => expect(events('stitch_started')).toHaveLength(1));

    view.rerender(page([stitch('running')]));
    view.rerender(page([stitch('done')]));

    expect(runIdsOf('stitch_started')).toEqual([RUN]);
    expect(runIdsOf('operation_started', 'operation_completed')).toEqual([RUN, RUN]);
    expect(events('stitch_completed')).toEqual([
      {
        name: 'stitch_completed',
        properties: { tool_identifier: 'stitcher', file_count: 1, run_id: RUN }
      }
    ]);
  });

  it('ends a failed stitch with stitch_failed on the same run_id', () => {
    const view = render(page([stitch('running')]));
    view.rerender(page([stitch('running')]));
    view.rerender(page([stitch('failed')]));
    expect(runIdsOf('operation_failed', 'stitch_failed')).toEqual([RUN, RUN]);
  });
});

const MODEL: TranscriptionModelInfo = {
  present: true,
  downloading: false,
  progress: 100,
  sizeBytes: 1,
  downloadedBytes: 1,
  label: 'installed',
  error: null
};

describe('transcription', () => {
  function transcription(status: TranscriptionJob['status']): TranscriptionJob {
    return {
      id: RUN,
      inputPath: '',
      fileName: 'interview.mp4',
      sourceKind: 'local',
      sourceKey: null,
      durationSeconds: 1,
      status,
      progress: null,
      requestedLanguage: 'uk',
      detectedLanguage: null,
      text: null,
      characters: null,
      error: status === 'failed' ? 'The transcription engine failed.' : null,
      errorCode: status === 'failed' ? 'TRANSCRIBE_FAILED' : null,
      errorDetails: null,
      batchId: null,
      createdAt: 1,
      startedAt: null,
      finishedAt: null
    } as TranscriptionJob;
  }

  function state(revision: number, job: TranscriptionJob): TranscriptionState {
    return {
      revision,
      jobs: [job],
      running: job.status === 'processing',
      tools: { ffmpeg: true, whisper: true, model: true },
      model: MODEL,
      translatorModel: MODEL,
      translatorRuntime: MODEL,
      alignmentModel: MODEL,
      settings: { language: 'uk', translationLanguage: 'uk', quality: 'fast' }
    } as TranscriptionState;
  }

  it('starts and fails a transcription on the job id', async () => {
    api.request.mockResolvedValue(state(1, transcription('ready')));
    render(
      <AgentContextOverride value={fakeAgentValue()}>
        <TranscriptionPage />
      </AgentContextOverride>
    );
    await waitFor(() => expect(events('input_add_completed')).toHaveLength(1));
    await push('transcription', { state: state(2, transcription('processing')) });
    await push('transcription', { state: state(3, transcription('failed')) });

    expect(runIdsOf('input_add_completed', 'operation_started', 'operation_failed')).toEqual([
      RUN,
      RUN,
      RUN
    ]);
    expect(events('error_occurred').map(event => event.properties)).toEqual([
      expect.objectContaining({
        tool_identifier: 'transcription',
        run_id: RUN,
        error_code: 'TRANSCRIBE_FAILED',
        error_fingerprint: 'transcription:transcribe:TRANSCRIBE_FAILED'
      })
    ]);
  });
});

describe('landing optimizer', () => {
  function landing(status: LandingJob['status']): LandingJob {
    return {
      id: RUN,
      name: 'promo-landing',
      sourceKind: 'zip',
      status,
      phase: status === 'processing' ? 'optimizing' : status,
      progress: 0,
      completedAssets: 0,
      totalAssets: 1,
      currentAssetId: null,
      settings: {
        imageQuality: 'optimal',
        videoQuality: 'optimal',
        archive: true,
        optimizeImages: true,
        optimizeVideos: true,
        stripMetadata: false,
        renameMedia: false,
        outputMode: 'next-to-originals',
        outputFolder: null
      },
      assets: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          relPath: 'images/hero.jpg',
          fileName: 'hero.jpg',
          type: 'image',
          status: 'pending',
          originalSize: 1_000,
          optimizedSize: null,
          savedBytes: null,
          savedPercent: null,
          progress: null,
          newRelPath: null,
          note: null,
          preview: null
        }
      ],
      imagesOptimized: 0,
      videosOptimized: 0,
      filesSkipped: 0,
      filesFailed: 0,
      referencesUpdated: 0,
      originalMediaSize: 0,
      optimizedMediaSize: 0,
      savedBytes: 0,
      savedPercent: 0,
      outputPath: null,
      outputIsArchive: true,
      paused: false,
      repeatable: false,
      error: null,
      warnings: [],
      createdAt: 1,
      startedAt: null,
      finishedAt: null
    } as unknown as LandingJob;
  }

  function state(revision: number, job: LandingJob): LandingState {
    return {
      revision,
      jobs: [job],
      job,
      settings: job.settings,
      tools: { ffmpeg: true, ffprobe: true },
      running: job.status === 'processing'
    } as LandingState;
  }

  it('starts and completes an optimization on the job id, on both event families', async () => {
    api.request.mockImplementation(async (url: string) =>
      url.endsWith('/start') ? state(2, landing('queued')) : state(1, landing('ready'))
    );
    render(
      <AgentContextOverride value={fakeAgentValue()}>
        <LandingOptimizerPage />
      </AgentContextOverride>
    );
    await waitFor(() => expect(events('input_add_completed')).toHaveLength(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Optimize landing' }));
    await waitFor(() => expect(events('landing_optimization_started')).toHaveLength(1));
    await push('landing', { state: state(3, landing('processing')) });
    await push('landing', { state: state(4, landing('completed')) });

    expect(runIdsOf('landing_optimization_started', 'landing_optimization_completed')).toEqual([
      RUN,
      RUN
    ]);
    expect(runIdsOf('operation_started', 'operation_completed')).toEqual([RUN, RUN]);
  });
});
