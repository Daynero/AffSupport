import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LandingOptimizer } from '../apps/agent/src/landing/optimizer.js';
import { JobQueue } from '../apps/agent/src/queue/queue.js';
import { TranscriptionQueue } from '../apps/agent/src/queue/transcription-queue.js';
import type { TranscriptionJob } from '@video-compressor/shared';
import { makeJob, optimalSettings } from './helpers.js';

let directory = '';

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'stop-all-'));
  process.env.AGENT_TRANSCRIBE_DOCUMENTS_PATH = path.join(directory, 'docs');
  process.env.AGENT_TRANSLATION_CACHE_PATH = path.join(directory, 'cache');
  process.env.AGENT_TRANSCRIBE_PREVIEWS_PATH = path.join(directory, 'previews');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  delete process.env.AGENT_TRANSCRIBE_DOCUMENTS_PATH;
  delete process.env.AGENT_TRANSLATION_CACHE_PATH;
  delete process.env.AGENT_TRANSCRIBE_PREVIEWS_PATH;
  await rm(directory, { recursive: true, force: true });
  directory = '';
});

function transcriptionJob(
  overrides: Partial<TranscriptionJob> & { id: string; inputPath: string }
): TranscriptionJob {
  return {
    fileName: path.basename(overrides.inputPath),
    sourceKind: 'local',
    sourceKey: null,
    durationSeconds: 10,
    status: 'ready',
    progress: null,
    requestedLanguage: 'auto',
    detectedLanguage: null,
    text: null,
    characters: null,
    translation: null,
    error: null,
    errorDetails: null,
    batchId: null,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    ...overrides
  };
}

describe('compressor stop all', () => {
  it('cancels every queued and processing job the tool shows', async () => {
    const batch = {
      id: 'batch-1',
      jobIds: ['running', 'waiting-1', 'waiting-2'],
      startedAt: Date.now(),
      finishedAt: null
    };
    const queue = new JobQueue(
      { ffmpeg: false, ffprobe: false },
      () => {},
      [
        makeJob('running', 'processing', { batchId: batch.id, startedAt: Date.now() }),
        makeJob('waiting-1', 'queued', { batchId: batch.id }),
        makeJob('waiting-2', 'queued', { batchId: batch.id }),
        makeJob('done', 'completed'),
        makeJob('untouched', 'ready')
      ],
      optimalSettings,
      batch
    );

    expect(await queue.cancelAll()).toBe(3);
    const byId = new Map(queue.state().jobs.map(job => [job.id, job.status]));
    expect(byId.get('running')).toBe('cancelled');
    expect(byId.get('waiting-1')).toBe('cancelled');
    expect(byId.get('waiting-2')).toBe('cancelled');
    // Terminal and untouched rows keep their state — this is a stop, not a reset.
    expect(byId.get('done')).toBe('completed');
    expect(byId.get('untouched')).toBe('ready');
    expect(queue.state().running).toBe(false);
  });

  it('closes the batch it emptied, so nothing keeps watching for work', async () => {
    // With every job cancelled the drain loop has nothing left to finish on, so
    // the batch would keep its null `finishedAt` and the watchdog would tick for
    // the rest of the session looking for a queue that is already empty.
    const batch = { id: 'batch-2', jobIds: ['waiting'], startedAt: Date.now(), finishedAt: null };
    const queue = new JobQueue(
      { ffmpeg: false, ffprobe: false },
      () => {},
      [makeJob('waiting', 'queued', { batchId: batch.id })],
      optimalSettings,
      batch
    );

    expect(await queue.cancelAll()).toBe(1);
    expect(queue.state().batch?.finishedAt).toBeTruthy();
    expect(queue.state().running).toBe(false);
  });

  it('broadcasts once for the whole batch, not once per file', async () => {
    // Cancelling job by job pushed a full QueueState — a clone of every job —
    // down every open SSE connection for each one.
    let frames = 0;
    const jobs = Array.from({ length: 12 }, (_, index) =>
      makeJob(`job-${index}`, 'queued', { batchId: 'batch-3' })
    );
    const batch = {
      id: 'batch-3',
      jobIds: jobs.map(job => job.id),
      startedAt: Date.now(),
      finishedAt: null
    };
    const queue = new JobQueue(
      { ffmpeg: false, ffprobe: false },
      () => {
        frames += 1;
      },
      jobs,
      optimalSettings,
      batch
    );

    expect(await queue.cancelAll()).toBe(12);
    expect(frames).toBeLessThanOrEqual(2);
  });

  it('leaves invisible Team Workspace jobs running', async () => {
    const video = path.join(directory, 'team.mp4');
    expect(await makeVideo(video, 2)).toBe(0);
    const settings = {
      ...optimalSettings,
      outputMode: 'chosen-folder' as const,
      outputFolder: directory
    };
    const queue = new JobQueue({ ffmpeg: true, ffprobe: true }, () => {}, [], settings);
    await queue.addTeamUploaded(video, 'team-source.mp4', 'team:op-1', settings);
    const teamJob = queue.teamJob('team:op-1');
    expect(teamJob).not.toBeNull();
    await queue.start([teamJob!.id]);
    await until(() => queue.teamJob('team:op-1')?.status === 'processing');

    // The compressor list is empty, so its "stop all" has nothing to stop and
    // must not reach into the team job it cannot even show.
    expect(queue.state().jobs).toHaveLength(0);
    expect(await queue.cancelAll()).toBe(0);
    expect(queue.teamJob('team:op-1')?.status).toBe('processing');

    await queue.discardTeamJob(teamJob!.id);
    await until(() => !queue.state().running);
  }, 20_000);
});

describe('transcription stop all', () => {
  it('cancels queued and processing jobs and leaves finished ones alone', async () => {
    const source = path.join(directory, 'talk.mp3');
    await writeFile(source, 'media');
    const queue = new TranscriptionQueue({ ffmpeg: false, whisper: false }, () => {}, [
      transcriptionJob({ id: 'running', inputPath: source, status: 'processing' }),
      transcriptionJob({ id: 'waiting', inputPath: source, status: 'queued' }),
      transcriptionJob({ id: 'done', inputPath: source, status: 'completed', characters: 5 }),
      transcriptionJob({ id: 'fresh', inputPath: source })
    ]);

    expect(queue.cancelAll()).toBe(2);
    const byId = new Map(queue.state().jobs.map(job => [job.id, job.status]));
    expect(byId.get('running')).toBe('cancelled');
    expect(byId.get('waiting')).toBe('cancelled');
    expect(byId.get('done')).toBe('completed');
    expect(byId.get('fresh')).toBe('ready');

    await queue.shutdown();
  });

  it('broadcasts once for the whole queue, not once per file', async () => {
    const source = path.join(directory, 'many.mp3');
    await writeFile(source, 'media');
    let frames = 0;
    const queue = new TranscriptionQueue(
      { ffmpeg: false, whisper: false },
      () => {
        frames += 1;
      },
      Array.from({ length: 12 }, (_, index) =>
        transcriptionJob({ id: `job-${index}`, inputPath: source, status: 'queued' })
      )
    );

    expect(queue.cancelAll()).toBe(12);
    expect(frames).toBeLessThanOrEqual(2);

    await queue.shutdown();
  });
});

describe('transcribing a finished file again', () => {
  it('keeps the previous transcript until a new one replaces it', async () => {
    // Deleting the sidecar up front made "Transcribe again" destructive the
    // moment it was pressed: a run that then failed, was cancelled, or died
    // with the agent left the user with no transcript at all. Nothing shows
    // the old text while the job is re-queued — it is no longer `completed` —
    // so keeping it costs nothing and saves the run that goes wrong.
    const source = path.join(directory, 'keep.mp3');
    await writeFile(source, 'media');
    const documents = path.join(directory, 'docs');
    await mkdir(documents, { recursive: true });
    const sidecar = path.join(documents, 'done.json');
    await writeFile(sidecar, JSON.stringify({ jobId: 'done', segments: [] }));

    const queue = new TranscriptionQueue({ ffmpeg: false, whisper: false }, () => {}, [
      transcriptionJob({ id: 'done', inputPath: source, status: 'completed', characters: 9 })
    ]);
    expect(await queue.start(['done'])).toBe(true);
    expect(existsSync(sidecar)).toBe(true);

    await queue.shutdown();
  });

  it("resets the job's own summary of the run it is replacing", async () => {
    const source = path.join(directory, 'interview.mp3');
    await writeFile(source, 'media');
    const queue = new TranscriptionQueue({ ffmpeg: false, whisper: false }, () => {}, [
      transcriptionJob({
        id: 'done',
        inputPath: source,
        status: 'completed',
        progress: 100,
        detectedLanguage: 'uk',
        characters: 12,
        finishedAt: Date.now()
      })
    ]);

    expect(await queue.start(['done'])).toBe(true);
    const job = queue.state().jobs[0];
    expect(job.status).toBe('queued');
    expect(job.characters).toBeNull();
    expect(job.detectedLanguage).toBeNull();
    expect(job.translation).toBeNull();
    expect(job.finishedAt).toBeNull();

    await queue.shutdown();
  });
});

describe('landing optimizer stop all', () => {
  it('stops the running landing and drops the ones still waiting', async () => {
    vi.stubEnv('AGENT_LANDING_WORKSPACE', path.join(directory, 'workspaces'));
    const first = await landingFixture('first');
    const second = await landingFixture('second');
    const optimizer = new LandingOptimizer({ ffmpeg: true, ffprobe: true }, () => {});
    optimizer.updateSettings({ archive: false });
    await optimizer.prepareFromFolderPath(first);
    await optimizer.prepareFromFolderPath(second);
    const ids = optimizer.state().jobs.map(job => job.id);

    // start() resolves only when the batch drains, so the stop has to be sent
    // while it is still in flight — exactly what the button does.
    const running = optimizer.start(ids);
    await until(() => optimizer.state().jobs.some(job => job.status === 'processing'));
    expect(await optimizer.cancelAll()).toBe(2);
    await running;

    expect(optimizer.state().jobs.map(job => job.status)).toEqual(['cancelled', 'cancelled']);
    expect(optimizer.state().jobs.every(job => job.error === null)).toBe(true);
    expect(optimizer.state().running).toBe(false);

    // A cancelled landing is finished work: clearing the list removes it.
    await optimizer.clearFinished();
    expect(optimizer.state().jobs).toEqual([]);
    await optimizer.shutdown();
  }, 30_000);
});

async function landingFixture(name: string) {
  const folder = path.join(directory, name);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'index.html'), '<!doctype html><video src="clip.mp4"></video>');
  expect(await makeVideo(path.join(folder, 'clip.mp4'), 3)).toBe(0);
  return folder;
}

function makeVideo(file: string, duration: number) {
  return new Promise<number | null>((resolve, reject) => {
    const encoder = spawn(
      'ffmpeg',
      // prettier-ignore
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
        '-t', String(duration), '-c:v', 'libx264', '-an', file
      ],
      { shell: false }
    );
    encoder.on('error', reject);
    encoder.on('close', resolve);
  });
}

async function until(check: () => boolean) {
  const end = Date.now() + 12_000;
  while (!check()) {
    if (Date.now() > end) throw new Error('Timed out');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
