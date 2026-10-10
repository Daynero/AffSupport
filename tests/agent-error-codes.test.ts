import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ESTIMATE_ERROR_CODES,
  LANDING_ERROR_CODES,
  STITCH_ERROR_CODES,
  TRANSCRIPTION_ERROR_CODES,
  type SourceProfile,
  type StitchJob,
  type StitchVerification
} from '@video-compressor/shared';
import { EstimateCache } from '../apps/agent/src/estimate/cache.js';
import {
  EstimateFailure,
  EstimationWorker,
  estimateErrorCode
} from '../apps/agent/src/estimate/worker.js';
import { ImageAssetError } from '../apps/agent/src/images/store.js';
import { LandingOptimizer, landingErrorCode } from '../apps/agent/src/landing/optimizer.js';
import { loadState, saveState, defaultSettings } from '../apps/agent/src/queue/store.js';
import {
  TranscriptionQueue,
  transcriptionRunErrorCode,
  transcriptionThrownErrorCode
} from '../apps/agent/src/queue/transcription-queue.js';
import { loadTranscriptionState } from '../apps/agent/src/queue/transcription-store.js';
import { PreparedBodyCache } from '../apps/agent/src/stitcher/body-cache.js';
import type { StitchPipeline } from '../apps/agent/src/stitcher/pipeline.js';
import { StitchQueue, stitchErrorCode } from '../apps/agent/src/stitcher/queue.js';
import { loadStitcherState, stitcherStatePath } from '../apps/agent/src/stitcher/store.js';
import { makeJob } from './helpers';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import { waitFor } from './support/wait.js';

/**
 * 033 T006 / FR-007 — every tool's failed job carries a code from its closed list: a failure
 * sets the right one, a retry clears it, and a persisted store gives back only a known one.
 */

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) await removeTemporaryDirectory(directory);
});

async function scratch(prefix: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function errno(code: string) {
  return Object.assign(new Error(`${code}: /Users/someone/secret.mov`), { code });
}

describe('transcription', () => {
  it('names each run failure from the result, never from its text', () => {
    const run = (failedStage: 'extract' | 'transcribe' | null, spawn: string | null, stderr = '') =>
      transcriptionRunErrorCode({ failedStage, spawnErrorCode: spawn, stderr });
    expect(run('extract', null)).toBe('AUDIO_EXTRACT_FAILED');
    expect(run('transcribe', null)).toBe('TRANSCRIBE_FAILED');
    expect(run('extract', 'ENOENT')).toBe('MEDIA_TOOL_UNAVAILABLE');
    expect(run('transcribe', null, 'write: No space left on device')).toBe('DISK_FULL');
    expect(transcriptionThrownErrorCode(errno('ENOSPC'))).toBe('DISK_FULL');
    // A cause the error does not name is left without a code.
    expect(transcriptionThrownErrorCode(new Error('anything'))).toBeNull();
    for (const code of [run('extract', null), run('transcribe', null), run(null, 'EACCES')]) {
      expect(TRANSCRIPTION_ERROR_CODES).toContain(code);
    }
  });

  it('sets MODEL_MISSING on a run whose model is gone, and clears it when the run is retried', async () => {
    const directory = await scratch('soty-codes-transcription-');
    vi.stubEnv('AGENT_TRANSCRIBE_DOCUMENTS_PATH', path.join(directory, 'docs'));
    vi.stubEnv('AGENT_TRANSLATION_CACHE_PATH', path.join(directory, 'cache'));
    vi.stubEnv('AGENT_TRANSCRIBE_PREVIEWS_PATH', path.join(directory, 'previews'));
    vi.stubEnv('WHISPER_MODEL_PATH', path.join(directory, 'no-such-model.bin'));
    const media = path.join(directory, 'clip.wav');
    await writeFile(media, Buffer.alloc(64));
    const seen: { status: string; errorCode: unknown }[] = [];
    const queue: TranscriptionQueue = new TranscriptionQueue(
      { ffmpeg: true, whisper: true },
      () => {
        const job = queue?.state().jobs[0];
        if (job) seen.push({ status: job.status, errorCode: job.errorCode });
      }
    );
    try {
      expect(await queue.add([media])).toEqual([]);
      const [job] = queue.state().jobs;
      expect(job!.errorCode).toBeNull();
      expect(await queue.start([job!.id], 'accurate')).toBe(true);
      await vi.waitFor(() => expect(queue.state().jobs[0]!.status).toBe('failed'));
      expect(queue.state().jobs[0]!.errorCode).toBe('MODEL_MISSING');

      seen.length = 0;
      expect(await queue.retry(job!.id)).toBe(true);
      // The retry's first frame is a queued job with no code; the run then fails again.
      expect(seen[0]).toEqual({ status: 'queued', errorCode: null });
      await vi.waitFor(() => expect(queue.state().jobs[0]!.status).toBe('failed'));
      expect(queue.state().jobs[0]!.errorCode).toBe('MODEL_MISSING');
    } finally {
      await queue.shutdown();
    }
  });

  it('restores only a known code, and names an interrupted run', async () => {
    const directory = await scratch('soty-codes-transcription-store-');
    const media = path.join(directory, 'clip.wav');
    await writeFile(media, Buffer.alloc(16));
    const base = {
      inputPath: media,
      fileName: 'clip.wav',
      sourceKind: 'local',
      requestedLanguage: 'auto',
      error: 'The transcription engine failed.',
      createdAt: 1
    };
    const file = path.join(directory, 'state.json');
    await writeFile(
      file,
      JSON.stringify({
        settings: {},
        jobs: [
          { ...base, id: 'known', status: 'failed', errorCode: 'TRANSCRIBE_FAILED' },
          { ...base, id: 'unknown', status: 'failed', errorCode: 'NOT_A_CODE' },
          { ...base, id: 'text', status: 'failed', errorCode: '/Users/someone/secret.mov' },
          { ...base, id: 'cut', status: 'processing' }
        ]
      })
    );
    const jobs = new Map((await loadTranscriptionState(file)).jobs.map(job => [job.id, job]));
    expect(jobs.get('known')!.errorCode).toBe('TRANSCRIBE_FAILED');
    expect(jobs.get('unknown')!.errorCode).toBeNull();
    expect(jobs.get('text')!.errorCode).toBeNull();
    expect(jobs.get('cut')).toMatchObject({ status: 'interrupted', errorCode: 'INTERRUPTED' });
  });
});

describe('stitcher', () => {
  const PASSING: StitchVerification = {
    durationSeconds: 20,
    frameCount: 600,
    videoTrackSeconds: 20,
    audioTrackSeconds: 20,
    videoCodec: 'h264',
    audioCodec: 'aac',
    width: 1080,
    height: 1080,
    pixelFormat: 'yuv420p',
    withinTolerance: true,
    mismatches: []
  };

  function profileFor(source: string): SourceProfile {
    return {
      path: source,
      sizeBytes: 1_000,
      modifiedAtMs: 1_700_000_000,
      container: 'mov,mp4,m4a,3gp,3g2,mj2',
      videoCodec: 'h264',
      profile: 'High',
      level: 32,
      width: 1080,
      height: 1080,
      pixelFormat: 'yuv420p',
      colorRange: 'tv',
      frameRate: 30,
      variableFrameRate: false,
      videoTimescale: 15360,
      durationSeconds: 20,
      hasAudio: true,
      audioCodec: 'aac',
      audioSampleRate: 48000,
      audioChannels: 2,
      audioBitrateKbps: 96,
      keyframeTimes: [0]
    };
  }

  it('normalises every pipeline and planner failure into the closed list', () => {
    expect(stitchErrorCode('BODY_JOIN_FAILED')).toBe('BODY_JOIN_FAILED');
    expect(stitchErrorCode('STITCH_PLAN_VIDEO-CODEC')).toBe('STITCH_PLAN_VIDEO_CODEC');
    expect(stitchErrorCode('STITCH_PLAN_NOTHING-TO-REMOVE')).toBe('STITCH_PLAN_NOTHING_TO_REMOVE');
    expect(stitchErrorCode('MEDIA_TOOL_UNAVAILABLE')).toBe('MEDIA_TOOL_UNAVAILABLE');
    expect(stitchErrorCode('SOMETHING_NEW')).toBeNull();
    expect(stitchErrorCode(null)).toBeNull();
    for (const reason of [
      'video-codec',
      'audio-codec',
      'variable-frame-rate',
      'container',
      'unreadable',
      'nothing-to-remove',
      'no-screens'
    ]) {
      expect(STITCH_ERROR_CODES).toContain(stitchErrorCode(`STITCH_PLAN_${reason.toUpperCase()}`));
    }
  });

  it('sets the code on a failed run and clears it when the row runs again', async () => {
    const workspace = await scratch('soty-codes-stitch-');
    const source = path.join(workspace, 'creative.mp4');
    await writeFile(source, 'not really a video');
    let runs = 0;
    const pipeline: StitchPipeline = async context => {
      runs += 1;
      if (runs === 1) return { ok: false, error: 'BODY_JOIN_FAILED' };
      const staged = path.join(context.workDir, 'result.mp4');
      await writeFile(staged, 'stitched');
      return { ok: true, stagedPath: staged, verification: PASSING };
    };
    const queue = new StitchQueue({
      imagePathFor: async () => path.join(workspace, 'photo.png'),
      onChange: () => {},
      bodies: new PreparedBodyCache({ root: workspace }),
      pipeline
    });
    const request = {
      profile: profileFor(source),
      detected: { startSeconds: 0, endSeconds: 0, adjustedByUser: false },
      screens: {
        startImageId: null,
        endImageId: 'photo',
        fitMode: 'cover' as const,
        endDurationSeconds: 45 * 60,
        startDurationSeconds: null
      },
      operation: 'stitch' as const,
      destination: { kind: 'beside' as const },
      outputSuffix: '-codes'
    };
    const [job] = queue.add([{ profile: request.profile }]);
    expect(job!.errorCode ?? null).toBeNull();
    queue.start(job!.id, request);
    await waitFor(() => queue.state().jobs[0]!.status === 'failed', { describe: 'the failure' });
    expect(queue.state().jobs[0]).toMatchObject({
      error: 'BODY_JOIN_FAILED',
      errorCode: 'BODY_JOIN_FAILED'
    });

    expect(queue.start(job!.id, request)).toBe(true);
    expect(queue.state().jobs[0]!.errorCode).toBeNull();
    await waitFor(() => queue.state().jobs[0]!.status === 'done', { describe: 'the retry' });
    expect(queue.state().jobs[0]).toMatchObject({ error: null, errorCode: null });
    await queue.shutdown();
  });

  it('marks a run cut short by a restart, and restores only known codes', async () => {
    const root = await scratch('soty-codes-stitch-store-');
    const row = (id: string, status: StitchJob['status'], errorCode: unknown) => ({
      id,
      sourcePath: '/tmp/creative.mp4',
      sourceName: 'creative.mp4',
      status,
      error: typeof errorCode === 'string' ? errorCode : null,
      errorCode
    });
    await mkdir(path.dirname(stitcherStatePath(root)), { recursive: true });
    await writeFile(
      stitcherStatePath(root),
      JSON.stringify({
        jobs: [
          row('known', 'failed', 'STITCH_OUTPUT_UNWRITABLE'),
          row('unknown', 'failed', 'NOT_A_CODE'),
          row('running', 'running', null)
        ]
      })
    );
    const restored = await loadStitcherState(root);
    const byId = new Map(restored.jobs.map(job => [job.id, job]));
    expect(byId.get('known')!.errorCode).toBe('STITCH_OUTPUT_UNWRITABLE');
    expect(byId.get('unknown')!.errorCode).toBeNull();

    const queue = new StitchQueue({
      imagePathFor: async () => null,
      onChange: () => {},
      jobs: restored.jobs
    });
    expect(queue.state().jobs.find(job => job.id === 'running')).toMatchObject({
      status: 'failed',
      errorCode: 'STITCH_INTERRUPTED'
    });
    await queue.shutdown();
  });
});

describe('landing optimizer', () => {
  it('names a failure by the file system first, then by the step the run was in', () => {
    expect(landingErrorCode(errno('ENOSPC'), 'packaging')).toBe('DISK_FULL');
    expect(landingErrorCode(errno('EACCES'), 'packaging')).toBe('DESTINATION_NOT_WRITABLE');
    expect(landingErrorCode(new Error('x'), 'optimizing')).toBe('LANDING_OPTIMIZE_FAILED');
    expect(landingErrorCode(new Error('x'), 'rewriting')).toBe('LANDING_REWRITE_FAILED');
    expect(landingErrorCode(null, 'packaging')).toBe('LANDING_PACKAGE_FAILED');
    for (const step of ['optimizing', 'rewriting', 'packaging'] as const) {
      expect(LANDING_ERROR_CODES).toContain(landingErrorCode(new Error('x'), step));
    }
  });

  it('sets the code on a landing the machine cannot process; a fresh landing has none', async () => {
    const root = await scratch('soty-codes-landing-');
    vi.stubEnv('AGENT_LANDING_WORKSPACE', path.join(root, 'workspaces'));
    vi.stubEnv('AGENT_LANDING_SETTINGS_PATH', path.join(root, 'settings.json'));
    const source = path.join(root, 'promo');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'index.html'), '<html><img src="a.png"></html>');
    await writeFile(path.join(source, 'a.png'), Buffer.alloc(32));
    const optimizer = new LandingOptimizer({ ffmpeg: false, ffprobe: false }, () => {});
    try {
      await optimizer.prepareFromFolderPath(source);
      const job = optimizer.state().jobs[0]!;
      expect(job.errorCode).toBeNull();
      await optimizer.start([job.id]);
      expect(optimizer.state().jobs[0]).toMatchObject({
        status: 'failed',
        error: 'MEDIA_TOOL_UNAVAILABLE',
        errorCode: 'MEDIA_TOOL_UNAVAILABLE'
      });
    } finally {
      await optimizer.shutdown();
    }
  });
});

describe('compressor estimate', () => {
  it('names each estimator failure from its typed error, never from free text', () => {
    expect(estimateErrorCode(new EstimateFailure('ESTIMATE_SAMPLES_UNREADABLE', 'x'))).toBe(
      'ESTIMATE_SAMPLES_UNREADABLE'
    );
    expect(estimateErrorCode(new ImageAssetError('IMAGE_DAMAGED'))).toBe('IMAGE_DAMAGED');
    expect(estimateErrorCode(new ImageAssetError('IMAGE_TOO_LARGE'))).toBeNull();
    expect(estimateErrorCode(errno('ENOSPC'))).toBe('DISK_FULL');
    expect(estimateErrorCode(new Error('Estimate unavailable.'))).toBeNull();
    // The sentence beside the code is kept as it was.
    expect(
      new EstimateFailure('ESTIMATE_INSUFFICIENT_DATA', 'Not enough sample data.').message
    ).toBe('Not enough sample data.');
  });

  it('sets SOURCE_NOT_FOUND for a source that is gone, and clears it when invalidated', async () => {
    const directory = await scratch('soty-codes-estimate-');
    const jobs = [
      makeJob('gone', 'ready', {
        inputPath: path.join(directory, 'gone.mp4'),
        outputPath: path.join(directory, 'gone.out.mp4'),
        fileName: 'gone.mp4',
        durationSeconds: null,
        estimateStatus: 'waiting'
      })
    ];
    const worker = new EstimationWorker(
      () => jobs,
      (id, patch) =>
        Object.assign(
          jobs.find(job => job.id === id)!,
          patch
        ),
      () => false,
      new EstimateCache(path.join(directory, 'cache.json'))
    );
    await worker.init();
    try {
      await waitFor(() => jobs[0]!.estimateStatus === 'unavailable', {
        describe: 'the estimate to fail'
      });
      expect(jobs[0]!.estimateErrorCode).toBe('SOURCE_NOT_FOUND');
      worker.invalidate();
      expect(jobs[0]).toMatchObject({ estimateStatus: 'waiting', estimateErrorCode: null });
    } finally {
      await worker.shutdown();
    }
  });

  it('restores only a known estimate code, and only beside an unavailable estimate', async () => {
    const directory = await scratch('soty-codes-estimate-store-');
    const source = path.join(directory, 'source.mp4');
    await writeFile(source, Buffer.alloc(16));
    const job = (id: string, estimateErrorCode: unknown, estimateStatus = 'unavailable') =>
      makeJob(id, 'ready', {
        inputPath: source,
        outputPath: `${source}.${id}.mp4`,
        estimateStatus: estimateStatus as 'unavailable',
        estimateError: 'Too few representative samples could be read.',
        estimateErrorCode: estimateErrorCode as 'ESTIMATE_SAMPLES_UNREADABLE'
      });
    const file = path.join(directory, 'state.json');
    await saveState(
      {
        settings: defaultSettings,
        jobs: [
          job('known', 'ESTIMATE_SAMPLES_UNREADABLE'),
          job('unknown', 'NOT_A_CODE'),
          job('stale', 'ESTIMATE_SAMPLES_UNREADABLE', 'estimated')
        ],
        batch: null
      } as Parameters<typeof saveState>[0],
      file
    );
    const restored = new Map((await loadState(file)).jobs.map(entry => [entry.id, entry]));
    expect(restored.get('known')!.estimateErrorCode).toBe('ESTIMATE_SAMPLES_UNREADABLE');
    expect(restored.get('unknown')!.estimateErrorCode).toBeUndefined();
    expect(restored.get('stale')!.estimateErrorCode).toBeUndefined();
    expect(ESTIMATE_ERROR_CODES).toContain(restored.get('known')!.estimateErrorCode);
  });
});
