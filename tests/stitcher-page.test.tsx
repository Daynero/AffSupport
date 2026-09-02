// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { StitchJob, StitchPlan, StitcherState } from '../packages/shared/src/stitcher.js';

/**
 * The promise the tool makes to the user: pick a video, pick a photo, press start.
 *
 * The list is the compressor's queue, so the two halves are asserted separately — choosing a
 * file adds a row and runs nothing, and starting runs the selection and nothing else.
 */

const inspectStitchSource = vi.hoisted(() => vi.fn());
const addStitchFiles = vi.hoisted(() => vi.fn());
const startStitchJobs = vi.hoisted(() => vi.fn());
const selectStitchSources = vi.hoisted(() => vi.fn());
const request = vi.hoisted(() => vi.fn());

vi.mock('../apps/web/src/stitcher/api', () => ({
  inspectStitchSource,
  addStitchFiles,
  startStitchJobs,
  selectStitchSources,
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
  // The screens are the compressor's library, read through its own endpoints.
  fetchCompressorState: vi.fn(async () => ({
    settings: { imageEmbedding: EMBEDDING }
  })),
  updateCompressorSettings: vi.fn(),
  uploadScreenImage: vi.fn(),
  removeScreenImage: vi.fn()
}));
vi.mock('../apps/web/src/api/client', () => ({
  request,
  imageContentPath: (id: string) => `/api/images/${id}/content`,
  imageContentUrl: vi.fn(async () => null),
  toolEventUrl: () => 'http://127.0.0.1:43140/api/stitcher/events'
}));
// The tile thumbnails ask for a ticketed URL; the page under test is not about images.
vi.mock('../apps/web/src/api/useSubresourceUrl', () => ({ useSubresourceUrl: () => null }));
vi.mock('../apps/web/src/api/useAgentEventStream', () => ({ useAgentEventStream: () => {} }));

import { AgentContextOverride } from '../apps/web/src/AgentContext';
import {
  StitcherContextOverride,
  type StitcherStore
} from '../apps/web/src/stitcher/StitcherContext';
import { agentContextStub } from './support/agent-stub.js';

const { Stitcher } = await import('../apps/web/src/stitcher/StitcherPage');

const PLAN: StitchPlan = {
  operation: 'restitch',
  bodyStartSeconds: 0.033333,
  bodyEndSeconds: 20.033333,
  headReencodeUntilSeconds: 8.333333,
  startScreen: { frames: 2, frameRate: 30, durationSeconds: 0.066667, aacFrames: 3 },
  endScreen: { frames: 45, frameRate: 1, durationSeconds: 45, aacFrames: 2109 },
  promisedDurationSeconds: 65.066667,
  promisedFrameCount: 647
};

const EMBEDDING = {
  enabled: true,
  startEnabled: true,
  endEnabled: true,
  startImages: [],
  endImages: [] as unknown[],
  disabledImageIds: [],
  replaceExisting: true,
  finalDurationMode: 'random-40-50',
  customFinalDurationSeconds: 45 * 60,
  startDurationMode: 'one-frame',
  customStartDurationMs: 100,
  fitMode: 'cover'
};

const IMAGES = [
  {
    id: 'end-photo',
    fileName: 'promo.png',
    width: 1080,
    height: 1080,
    size: 1024,
    mimeType: 'image/png' as const,
    extension: '.png' as const
  }
];

function stitcherStore(jobs: StitchJob[] = []): StitcherStore {
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

function job(overrides: Partial<StitchJob>): StitchJob {
  return {
    id: 'job-1',
    sourcePath: '/Users/x/Movies/creative.mp4',
    sourceName: 'creative.mp4',
    plan: PLAN,
    detected: { startSeconds: 0.033333, endSeconds: 30, adjustedByUser: false },
    destination: { kind: 'beside' },
    outputSuffix: '',
    status: 'done',
    stage: null,
    outputPath: '/Users/x/Movies/creative_stitched.mp4',
    elapsedMs: 1144,
    error: null,
    verification: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    source: {
      sizeBytes: 7_356_009,
      durationSeconds: 50,
      width: 1080,
      height: 1080,
      frameRate: 30,
      codec: 'h264'
    },
    result: {
      sizeBytes: 8_780_000,
      durationSeconds: 2947,
      width: 1080,
      height: 1080,
      frameRate: 30,
      codec: 'h264'
    },
    ...overrides
  };
}

function renderPage(store = stitcherStore()) {
  return render(
    <AgentContextOverride
      value={agentContextStub({ capabilities: ['native-file-picker', 'stitcher'] })}
    >
      <StitcherContextOverride value={store}>
        <Stitcher />
      </StitcherContextOverride>
    </AgentContextOverride>
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('language', 'en');
  inspectStitchSource.mockReset();
  addStitchFiles.mockReset();
  startStitchJobs.mockReset();
  selectStitchSources.mockReset();
  request.mockReset();
  EMBEDDING.endImages = IMAGES;
  selectStitchSources.mockResolvedValue({ paths: ['/Users/x/Movies/creative.mp4'] });
  inspectStitchSource.mockResolvedValue({
    profile: { path: '/Users/x/Movies/creative.mp4' },
    detected: { startSeconds: 0.033333, endSeconds: 30, adjustedByUser: false },
    plan: PLAN
  });
  addStitchFiles.mockResolvedValue({ state: stitcherStore().state, refused: [] });
  startStitchJobs.mockResolvedValue({ state: stitcherStore().state, failures: [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the first thing the page asks for', () => {
  it('offers to choose a video, and nothing else is required', async () => {
    renderPage();
    // The drop zone is the control, exactly as on the compressor.
    expect(await screen.findByRole('button', { name: /Drag a video here/i })).toBeTruthy();
  });

  it('adds the chosen video to the list instead of running it', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Drag a video here/i }));
    await waitFor(() => expect(addStitchFiles).toHaveBeenCalled());
    expect(addStitchFiles.mock.calls[0]?.[0]).toEqual(['/Users/x/Movies/creative.mp4']);
    // Choosing a file starts nothing: the compressor's rule, and the reason rows can be
    // selected at all.
    expect(startStitchJobs).not.toHaveBeenCalled();
  });

  it('runs the selection, and names the operation on the button', async () => {
    const ready = job({ status: 'ready', outputPath: null, result: null, elapsedMs: null });
    renderPage(stitcherStore([ready]));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'creative.mp4' }));
    fireEvent.click(screen.getByRole('button', { name: 'Re-stitch (1)' }));
    await waitFor(() => expect(startStitchJobs).toHaveBeenCalled());
    expect(startStitchJobs.mock.calls[0]).toEqual([['job-1'], 'restitch']);
  });

  it('starts nothing while nothing is selected', async () => {
    const ready = job({ status: 'ready', outputPath: null, result: null, elapsedMs: null });
    renderPage(stitcherStore([ready]));
    // Two controls carry the operation's name — the picto that chooses it and the button
    // that runs it — so the one in the action bar is named by where it sits.
    const start = screen
      .getAllByRole('button', { name: 'Re-stitch' })
      .find(button => button.closest('.primary-actions'));
    expect((start as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('the runs list', () => {
  it('says what a previous run found, and claims nothing before the first', async () => {
    const ready = { status: 'ready' as const, outputPath: null, result: null, elapsedMs: null };
    renderPage(stitcherStore([job(ready)]));
    expect(await screen.findByText('Photo screens found in this video')).toBeTruthy();
    expect(screen.getByText('Ready to start')).toBeTruthy();

    // A row that has only just been added has not been looked at — the search happens when
    // the run starts, so that dropping a file is instant.
    cleanup();
    renderPage(stitcherStore([job({ ...ready, detected: null })]));
    expect(await screen.findByText('Ready to start')).toBeTruthy();
    expect(screen.queryByText('Photo screens found in this video')).toBeNull();
    expect(screen.queryByText('No photo screens found')).toBeNull();
  });

  it('reports how long a finished run took', async () => {
    renderPage(stitcherStore([job({})]));
    expect(await screen.findByText('Done in 1.1s')).toBeTruthy();
  });

  it('turns a failure code into one sentence', async () => {
    renderPage(
      stitcherStore([
        job({ status: 'failed', error: 'STITCH_VERIFICATION_FAILED', outputPath: null })
      ])
    );
    expect(await screen.findByText(/did not match what was promised/i)).toBeTruthy();
  });

  it('offers to stop a run that is still going, and nothing else', async () => {
    renderPage(stitcherStore([job({ status: 'running', stage: 'joining', outputPath: null })]));
    expect(await screen.findByText('Joining…')).toBeTruthy();
    // The compressor's rule: while a run is going, nothing competes with stopping it.
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Show in folder/i })).toBeNull();
  });

  it('shows what the file was and what it became', async () => {
    renderPage(stitcherStore([job({})]));
    expect(await screen.findByText('Ready file')).toBeTruthy();
    // Both panels carry the same facts, so each label appears twice.
    expect(screen.getAllByText('Resolution')).toHaveLength(2);
    // Once per panel, plus the tile caption in the gallery.
    expect(screen.getAllByText('1080×1080').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('button', { name: /Show in folder/i })).toBeTruthy();
  });
});

describe('when the local app cannot open a file dialog', () => {
  it('says so instead of offering a button that does nothing', async () => {
    render(
      <AgentContextOverride value={agentContextStub({ capabilities: ['stitcher'] })}>
        <StitcherContextOverride value={stitcherStore()}>
          <Stitcher />
        </StitcherContextOverride>
      </AgentContextOverride>
    );
    expect(await screen.findByText(/needs the Soty app running/i)).toBeTruthy();
  });
});
