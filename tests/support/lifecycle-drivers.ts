import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CompressionJob, TranscriptionJob } from '../../packages/shared/src/types.js';
import type { StitchPipeline } from '../../apps/agent/src/stitcher/pipeline.js';
import type { StitchRunRequest } from '../../apps/agent/src/stitcher/queue.js';
import type { MediaInfo } from '../../apps/agent/src/ffmpeg/tools.js';
import { observedEdges, resetObservedEdges } from '../../apps/agent/src/queue/transitions.js';
import { makeJob, optimalSettings } from '../helpers.js';
import { writeStubTool } from './stub-tools/index.js';
import { waitFor } from './wait.js';

/**
 * A named way to actually perform each declared transition.
 *
 * A table that only tests itself proves nothing — it would pass just as well if the running
 * code never took any of the edges it declares. So every edge gets a driver that puts a
 * **real** queue instance into the `from` state and performs the move, and
 * `tests/lifecycle-transitions.test.ts` asserts the map covers the table in both directions:
 * a missing driver fails, and a driver for an edge nobody declares fails too, which is what
 * catches a table going stale after a state is removed.
 *
 * A driver reports what it observed rather than what it intended. `before` is read from the
 * status the queue was actually in, so a driver that quietly starts from the wrong state
 * fails loudly rather than passing for the wrong reason.
 */

export type EdgeKey = `${string}->${string}`;

export interface DriverResult {
  /** The state the entity was actually in before the driver acted. */
  before: string;
  /** The state it was actually in afterwards. */
  after: string;
}

export type Driver = () => Promise<DriverResult>;

/**
 * `Partial` on purpose. Edges are a computed set, not a union, so completeness cannot be a
 * compile-time fact here — it is asserted at run time in both directions instead.
 */
export type DriverMap = Partial<Record<EdgeKey, Driver>>;

/**
 * One installed encoder for the whole file, whose behaviour is read from a file per run.
 *
 * `ffmpeg/tools.ts` captures `FFMPEG_PATH` into a module constant the first time it is
 * imported, so a driver cannot point it somewhere else per case without rebuilding the whole
 * module graph — and rebuilding it inside a driver would give each one its own `JobQueue`
 * class, which is not the class the enumeration test is checking. Setting the variable once,
 * before the first import, and varying a small JSON file instead keeps one queue
 * implementation under test while letting the encoder succeed for one edge and fail for the
 * next.
 */
const workspace = await mkdtemp(path.join(os.tmpdir(), 'lifecycle-drivers-'));
const behaviourFile = path.join(workspace, 'behaviour.json');
process.env.FFMPEG_PATH = await writeStubTool(workspace, 'stub-ffmpeg', {
  behaviourFile,
  writeOutput: true,
  durationMs: 50
});
// `probeDuration` spawns FFprobe and reads a bare number. Without a stand-in every driver
// below would depend on whatever FFprobe happens to be installed on the machine running it.
process.env.FFPROBE_PATH = await writeStubTool(workspace, 'stub-ffprobe', {
  stdoutText: '12.5',
  durationMs: 5
});
/**
 * Fields a behaviour file may override.
 *
 * Only the fields it names: everything else keeps the value baked into the stub at write
 * time. A file that sets an exit code but forgets `hang: false` describes a tool that exits
 * with that code and also never gets there.
 */
interface Behaviour {
  exitCode?: number;
  hang?: boolean;
  durationMs?: number;
  stderr?: string;
  stdoutBase64?: string;
}

const whisperBehaviour = path.join(workspace, 'whisper-behaviour.json');
process.env.WHISPER_PATH = await writeStubTool(workspace, 'stub-whisper', {
  behaviourFile: whisperBehaviour,
  hang: true
});
// Transcription deliberately refuses to enter `processing` until its model is
// present. A developer machine may already have the real 3 GB model downloaded,
// but a clean CI runner does not; use a tiny fixture because the stub binary
// never reads model contents.
const whisperModel = path.join(workspace, 'ggml-large-v3.bin');
await writeFile(whisperModel, 'test model', 'utf8');
process.env.WHISPER_MODEL_PATH = whisperModel;

/** Points the whisper stand-in at one behaviour for the next run. */
async function whisperBehaves(behaviour: Behaviour): Promise<void> {
  await writeFile(whisperBehaviour, JSON.stringify(behaviour), 'utf8');
}
// Imported *after* the variable is set, and dynamically. `ffmpeg/tools.ts` reads
// `FFMPEG_PATH` into a module constant the first time it is evaluated, so a static import at
// the top of this file would capture the real encoder and every driver below would be
// driving FFmpeg against a text file instead of the stub.
// Transcription writes documents, translation caches and previews under the user's real
// Application Support directory unless told otherwise. Redirected before the modules that
// read them are evaluated, so a driver can never touch the developer's own data.
process.env.AGENT_TRANSCRIBE_DOCUMENTS_PATH = path.join(workspace, 'documents');
process.env.AGENT_TRANSLATION_CACHE_PATH = path.join(workspace, 'translation-cache');
process.env.AGENT_TRANSCRIBE_PREVIEWS_PATH = path.join(workspace, 'previews');
process.env.AGENT_TRANSCRIBE_IMPORT_PATH = path.join(workspace, 'imports');
process.env.AGENT_LANDING_WORKSPACE = path.join(workspace, 'landing-workspaces');

const { MediaToolUnavailableError } = await import('../../apps/agent/src/ffmpeg/tools.js');
const { JobQueue } = await import('../../apps/agent/src/queue/queue.js');
const { TranscriptionQueue } = await import('../../apps/agent/src/queue/transcription-queue.js');
const { loadTranscriptionState } =
  await import('../../apps/agent/src/queue/transcription-store.js');
const { LandingOptimizer } = await import('../../apps/agent/src/landing/optimizer.js');
const { MediaActionQueue } = await import('../../apps/agent/src/media-actions/queue.js');
const { LandingPreviewCatalog } = await import('../../apps/agent/src/landing-preview/catalog.js');
// Dynamic like the rest: a static import would pull `ffmpeg/tools.js` in before the stub
// binaries above are installed, and that module captures the paths once.
const { StitchQueue } = await import('../../apps/agent/src/stitcher/queue.js');
const { PreparedBodyCache } = await import('../../apps/agent/src/stitcher/body-cache.js');
const { TranscriptionDocumentStore } =
  await import('../../apps/agent/src/transcription/document-store.js');

/** Removes everything the drivers wrote. Call from the suite's teardown. */
export async function cleanUpDrivers(): Promise<void> {
  await rm(workspace, { recursive: true, force: true });
}

async function behave(behaviour: Behaviour): Promise<void> {
  await writeFile(behaviourFile, JSON.stringify(behaviour), 'utf8');
}

/** Probe output that passes both source validation and output validation. */
function goodMedia(overrides: Partial<MediaInfo> = {}): MediaInfo {
  return {
    duration: 10,
    videoDuration: 10,
    width: 1920,
    height: 1080,
    frameRate: 30,
    nominalFrameRate: 30,
    bitrate: 2_000_000,
    codec: 'h264',
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    hasAudio: true,
    audioCodec: 'aac',
    audioDuration: 10,
    audioBitrate: 128_000,
    audioSampleRate: 48_000,
    audioChannels: 2,
    audioLayout: 'stereo',
    ...overrides
  };
}

/** The marker `pauseForRuntimeFailure` leaves for the next start to pick up. */
function recoveryMarker(phase: 'input-analysis' | 'encoding' | 'output-validation') {
  return JSON.stringify({ code: 'MEDIA_TOOL_UNAVAILABLE', phase, tool: 'ffprobe' });
}

interface Harness {
  queue: InstanceType<typeof JobQueue>;
  directory: string;
  source: string;
}

async function harness(
  jobs: CompressionJob[],
  probe: () => Promise<MediaInfo | null> = async () => goodMedia()
): Promise<Harness> {
  const directory = await mkdtemp(path.join(workspace, 'run-'));
  const source = path.join(directory, 'clip.mov');
  await writeFile(source, 'source');
  for (const job of jobs) {
    job.inputPath = source;
    job.outputPath = path.join(directory, `${job.id}_compressed.mp4`);
  }

  const queue = new JobQueue(
    { ffmpeg: true, ffprobe: true },
    () => {},
    jobs,
    { ...optimalSettings, outputMode: 'chosen-folder', outputFolder: directory },
    null,
    undefined,
    Math.random,
    { probeMedia: probe as never }
  );
  return { queue, directory, source };
}

/**
 * Performs `act` and reports the edge that actually took a job into `to`.
 *
 * Read from the queue's own transition seam rather than from the broadcasts. Two transitions
 * can happen between one broadcast and the next — a re-run goes `completed → ready → queued`
 * inside a single `start()` — so a driver that sampled the status at notify boundaries would
 * miss the intermediate state entirely and report an edge the code never took. The seam
 * records every applied transition, which is exactly the question a driver is asking.
 */
async function driveEdge(
  lifecycleId: string,
  to: string,
  act: () => Promise<unknown>
): Promise<DriverResult> {
  resetObservedEdges();
  await act();
  let edge = '';
  await waitFor(
    () => {
      // The first recorded edge into `to`, in insertion order — the one this action caused.
      edge =
        [...observedEdges()].find(
          candidate => candidate.startsWith(`${lifecycleId}:`) && candidate.endsWith(`->${to}`)
        ) ?? '';
      return edge !== '';
    },
    { timeoutMs: 20_000, describe: `a ${lifecycleId} transition into ${to}` }
  );
  const [before, after] = (edge.split(':')[1] as string).split('->');
  return { before: before as string, after: after as string };
}

/** `driveEdge` bound to one lifecycle, so a driver names its edge and nothing else. */
function driverFor(lifecycleId: string) {
  return (to: string, act: () => Promise<unknown>) => driveEdge(lifecycleId, to, act);
}

const compressionEdge = driverFor('compression');

/** Stops anything a driver left running, so the next one starts from a quiet machine. */
async function quiesce(harnessed: Harness): Promise<void> {
  await harnessed.queue.cancelAll();
  await harnessed.queue.shutdown();
}

const COMPRESSION_DRIVERS: DriverMap = {
  'analyzing->ready': async () => {
    const harnessed = await harness([]);
    return compressionEdge('ready', () => harnessed.queue.add([harnessed.source]));
  },

  'analyzing->failed': async () => {
    // A file the probe cannot make sense of. The job is created optimistically and then
    // rejected, which is why `analyzing` exists at all.
    const harnessed = await harness([], async () => goodMedia({ codec: null, width: null }));
    return compressionEdge('failed', () => harnessed.queue.add([harnessed.source]));
  },

  'ready->queued': async () => {
    await behave({ hang: true });
    const harnessed = await harness([makeJob('ready-job', 'ready')]);
    const result = await compressionEdge('queued', () => harnessed.queue.start(['ready-job']));
    await quiesce(harnessed);
    return result;
  },

  'queued->processing': async () => {
    await behave({ hang: true });
    const harnessed = await harness([makeJob('starting', 'ready')]);
    const result = await compressionEdge('processing', () => harnessed.queue.start(['starting']));
    await quiesce(harnessed);
    return result;
  },

  'queued->cancelled': async () => {
    const harnessed = await harness([makeJob('waiting', 'queued')]);
    return compressionEdge('cancelled', () => harnessed.queue.cancel('waiting'));
  },

  'queued->ready': async () => {
    // The batch being abandoned out from under a job that never started. The media engine
    // disappearing mid-run tears the whole batch down, and a job still waiting its turn is
    // returned to `ready` rather than left queued against a batch nobody will drain.
    await behave({ exitCode: 0, durationMs: 10 });
    const harnessed = await harness(
      [makeJob('running', 'ready'), makeJob('sibling', 'ready')],
      async () => {
        // The encode succeeds; the probe that validates its output is what finds the engine
        // gone, which is the `output-validation` half of the recovery.
        throw new MediaToolUnavailableError('ffprobe', 'ENOENT');
      }
    );
    const result = await compressionEdge('ready', () =>
      harnessed.queue.start(['running', 'sibling'])
    );
    await quiesce(harnessed);
    return result;
  },

  'processing->completed': async () => {
    await behave({ exitCode: 0, durationMs: 10 });
    const harnessed = await harness([makeJob('finishing', 'ready')]);
    const result = await compressionEdge('completed', () => harnessed.queue.start(['finishing']));
    await quiesce(harnessed);
    return result;
  },

  'processing->failed': async () => {
    await behave({ exitCode: 3, durationMs: 10, stderr: 'the encoder gave up' });
    const harnessed = await harness([makeJob('breaking', 'ready')]);
    const result = await compressionEdge('failed', () => harnessed.queue.start(['breaking']));
    await quiesce(harnessed);
    return result;
  },

  'processing->cancelled': async () => {
    await behave({ hang: true });
    const harnessed = await harness([makeJob('stopping', 'ready')]);
    const result = await compressionEdge('cancelled', async () => {
      await harnessed.queue.start(['stopping']);
      await waitFor(() => harnessed.queue.state().jobs[0].status === 'processing', {
        describe: 'the encode to start'
      });
      await harnessed.queue.cancel('stopping');
    });
    await quiesce(harnessed);
    return result;
  },

  'processing->interrupted': async () => {
    // The media engine disappearing between the encode finishing and its output being
    // validated. The encode succeeded; only the check did not run.
    await behave({ exitCode: 0, durationMs: 10 });
    const harnessed = await harness([makeJob('interrupting', 'ready')], async () => {
      throw new MediaToolUnavailableError('ffprobe', 'ENOENT');
    });
    const result = await compressionEdge('interrupted', () =>
      harnessed.queue.start(['interrupting'])
    );
    await quiesce(harnessed);
    return result;
  },

  'processing->analyzing': async () => {
    // A run that was already interrupted once, whose recovery finds the engine still gone
    // while re-reading the *source*. There is no output to validate at that point, so the
    // job goes back to being analysed rather than to interrupted a second time.
    const harnessed = await harness(
      [makeJob('reanalysing', 'processing', { errorDetails: recoveryMarker('input-analysis') })],
      async () => {
        throw new MediaToolUnavailableError('ffprobe', 'ENOENT');
      }
    );
    return compressionEdge('analyzing', () => harnessed.queue.recoverRuntimeInterruptedJobs());
  },

  'completed->ready': async () => {
    await behave({ hang: true });
    const harnessed = await harness([makeJob('again', 'completed')]);
    const result = await compressionEdge('ready', () => harnessed.queue.start(['again']));
    await quiesce(harnessed);
    return result;
  },

  'failed->ready': async () => {
    await behave({ hang: true });
    const harnessed = await harness([makeJob('retrying', 'failed')]);
    const result = await compressionEdge('ready', () => harnessed.queue.start(['retrying']));
    await quiesce(harnessed);
    return result;
  },

  'cancelled->ready': async () => {
    await behave({ hang: true });
    const harnessed = await harness([makeJob('rerunning', 'cancelled')]);
    const result = await compressionEdge('ready', () => harnessed.queue.start(['rerunning']));
    await quiesce(harnessed);
    return result;
  },

  'interrupted->ready': async () => {
    const harnessed = await harness([
      makeJob('recovering', 'interrupted', { errorDetails: recoveryMarker('input-analysis') })
    ]);
    return compressionEdge('ready', () => harnessed.queue.recoverRuntimeInterruptedJobs());
  },

  'interrupted->completed': async () => {
    const harnessed = await harness([
      makeJob('recovered', 'interrupted', { errorDetails: recoveryMarker('output-validation') })
    ]);
    // The encode had finished; only the probe that checks it was interrupted. The output has
    // to exist for the re-probe to find.
    await writeFile(harnessed.queue.state().jobs[0].outputPath, 'a complete encode', 'utf8');
    return compressionEdge('completed', () => harnessed.queue.recoverRuntimeInterruptedJobs());
  },

  'interrupted->failed': async () => {
    const harnessed = await harness(
      [makeJob('unreadable', 'interrupted', { errorDetails: recoveryMarker('input-analysis') })],
      async () => goodMedia({ codec: null, width: null, height: null })
    );
    return compressionEdge('failed', () => harnessed.queue.recoverRuntimeInterruptedJobs());
  }
};

/**
 * A translator whose every call is resolved by hand.
 *
 * The three translation outcomes — finished, failed, preempted — differ only in what happens
 * to a call already in flight, so a driver needs to hold one open and then decide.
 */
class GatedTranslator {
  readonly calls: {
    request: { onSegment?: (segment: unknown, index: number) => void };
    resolve: (out: unknown[]) => void;
    reject: (error: Error) => void;
  }[] = [];

  available(): boolean {
    return true;
  }

  modelVersion(): string {
    return 'driver-1';
  }

  translate(
    request: { onSegment?: (segment: unknown, index: number) => void },
    signal: AbortSignal
  ): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      this.calls.push({ request, resolve: resolve as never, reject });
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  }

  /**
   * Finishes a call the way the real translator does — segment first, then the whole output.
   *
   * The pipelined alignment and progress both hang off `onSegment`, so resolving without it
   * produces a translation that never reports itself finished.
   */
  finish(index: number, jobId: string, text: string): void {
    const segment = { sourceSegmentId: `${jobId}-s0`, translatedText: text, alignments: [] };
    this.calls[index]?.request.onSegment?.(segment, 0);
    this.calls[index]?.resolve([segment]);
  }
}

interface TranscriptionHarness {
  queue: InstanceType<typeof TranscriptionQueue>;
  jobId: string;
  media: string;
  translator: GatedTranslator;
}

/** A transcription queue holding one analysed file, with a transcript already on disk. */
async function transcriptionHarness(): Promise<TranscriptionHarness> {
  await behave({ hang: false, exitCode: 0, durationMs: 10 });
  const directory = await mkdtemp(path.join(workspace, 'transcription-'));
  const media = path.join(directory, 'interview.mp3');
  await writeFile(media, 'audio');

  // Per harness, not per file. These paths are read when they are used rather than at import,
  // and a shared translation cache makes the second driver a cache hit: the translator is
  // never called, the edge never happens, and the driver times out describing a state the
  // code was right not to enter.
  const documents = path.join(directory, 'documents');
  process.env.AGENT_TRANSCRIBE_DOCUMENTS_PATH = documents;
  process.env.AGENT_TRANSLATION_CACHE_PATH = path.join(directory, 'translation-cache');
  process.env.AGENT_TRANSCRIBE_PREVIEWS_PATH = path.join(directory, 'previews');

  const queue = new TranscriptionQueue({ ffmpeg: true, whisper: true }, () => {});
  await queue.add([media]);
  const jobId = queue.state().jobs[0].id;

  // A transcript has to exist before anything can be translated from it.
  await new TranscriptionDocumentStore(documents).save({
    jobId,
    sourceLanguage: 'en',
    modelVersion: 'large-v3',
    segments: [
      { id: `${jobId}-s0`, startMs: 0, endMs: 1_000, sourceText: 'Hello world.', words: [] }
    ],
    translations: {}
  });

  const translator = new GatedTranslator();
  queue.setTranslator(translator as never);
  return { queue, jobId, media, translator };
}

/** Requests a translation and waits until the translator has actually been called. */
async function translationInFlight(harnessed: TranscriptionHarness): Promise<void> {
  await harnessed.queue.requestTranslation(harnessed.jobId, 'uk');
  await waitFor(() => harnessed.translator.calls.length > 0, {
    describe: 'the translator to be called'
  });
}

const translationEdge = driverFor('translation');

const TRANSLATION_DRIVERS: DriverMap = {
  'queued->processing': async () => {
    const harnessed = await transcriptionHarness();
    const result = await translationEdge('processing', () => translationInFlight(harnessed));
    await harnessed.queue.shutdown();
    return result;
  },

  'processing->completed': async () => {
    const harnessed = await transcriptionHarness();
    await translationInFlight(harnessed);
    const result = await translationEdge('completed', async () => {
      harnessed.translator.finish(0, harnessed.jobId, 'Привіт, світе.');
    });
    await harnessed.queue.shutdown();
    return result;
  },

  'processing->failed': async () => {
    const harnessed = await transcriptionHarness();
    await translationInFlight(harnessed);
    const result = await translationEdge('failed', async () => {
      harnessed.translator.calls[0]?.reject(new Error('the translator gave up'));
    });
    await harnessed.queue.shutdown();
    return result;
  },

  'failed->queued': async () => {
    const harnessed = await transcriptionHarness();
    await translationInFlight(harnessed);
    harnessed.translator.calls[0]?.reject(new Error('the translator gave up'));
    await waitFor(() => harnessed.queue.state().jobs[0]?.translation?.status === 'failed', {
      describe: 'the first translation to fail'
    });
    const result = await translationEdge('queued', () =>
      harnessed.queue.requestTranslation(harnessed.jobId, 'uk', 'retry')
    );
    await harnessed.queue.shutdown();
    return result;
  },

  'processing->queued': async () => {
    // Preemption, not failure. A translation yields the machine to the transcription it
    // belongs to and resumes from the segments it had already produced — recording that as a
    // failure would show the user an error for something the application did deliberately.
    const harnessed = await transcriptionHarness();
    await translationInFlight(harnessed);
    const result = await translationEdge('queued', () => harnessed.queue.start([harnessed.jobId]));
    await harnessed.queue.shutdown();
    return result;
  }
};

const transcriptionEdge = driverFor('transcription');

/** A transcription queue holding jobs seeded into known states. */
async function seededTranscription(jobs: Partial<TranscriptionJob>[]) {
  // Reset the encoder, not just the transcriber. Transcription extracts audio with FFmpeg
  // before whisper ever runs, and the compression drivers leave the shared stand-in in
  // whatever state their own edge needed — a hanging encoder means the extract never
  // finishes and the transcription never reaches the state this driver is about.
  await behave({ hang: false, exitCode: 0, durationMs: 10 });
  const directory = await mkdtemp(path.join(workspace, 'transcription-state-'));
  process.env.AGENT_TRANSCRIBE_DOCUMENTS_PATH = path.join(directory, 'documents');
  process.env.AGENT_TRANSLATION_CACHE_PATH = path.join(directory, 'translation-cache');
  process.env.AGENT_TRANSCRIBE_PREVIEWS_PATH = path.join(directory, 'previews');
  const media = path.join(directory, 'interview.mp3');
  await writeFile(media, 'audio');

  const seeded = jobs.map((job, index) => ({
    id: job.id ?? `job-${index}`,
    inputPath: media,
    fileName: 'interview.mp3',
    sourceKind: 'local' as const,
    sourceKey: null,
    durationSeconds: 12.5,
    status: 'ready' as const,
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
    ...job
  })) as TranscriptionJob[];

  const queue = new TranscriptionQueue({ ffmpeg: true, whisper: true }, () => {}, seeded);
  return { queue, media, directory };
}

const TRANSCRIPTION_DRIVERS: DriverMap = {
  'analyzing->ready': async () => {
    const { queue, media } = await seededTranscription([]);
    const result = await transcriptionEdge('ready', () => queue.add([media]));
    await queue.shutdown();
    return result;
  },

  'ready->queued': async () => {
    const { queue } = await seededTranscription([{ id: 'starting', status: 'ready' }]);
    const result = await transcriptionEdge('queued', () => queue.start(['starting']));
    await queue.cancelAll();
    await queue.shutdown();
    return result;
  },

  'queued->processing': async () => {
    const { queue } = await seededTranscription([{ id: 'running', status: 'ready' }]);
    const result = await transcriptionEdge('processing', () => queue.start(['running']));
    await queue.cancelAll();
    await queue.shutdown();
    return result;
  },

  'queued->cancelled': async () => {
    const { queue } = await seededTranscription([{ id: 'waiting', status: 'queued' }]);
    const result = await transcriptionEdge('cancelled', async () => queue.cancel('waiting'));
    await queue.shutdown();
    return result;
  },

  'processing->cancelled': async () => {
    const { queue } = await seededTranscription([{ id: 'stopping', status: 'ready' }]);
    const result = await transcriptionEdge('cancelled', async () => {
      await queue.start(['stopping']);
      await waitFor(() => queue.state().jobs[0]?.status === 'processing', {
        describe: 'the transcription to start'
      });
      await queue.cancel('stopping');
    });
    await queue.shutdown();
    return result;
  },

  'completed->queued': async () => {
    const { queue } = await seededTranscription([{ id: 'again', status: 'completed' }]);
    const result = await transcriptionEdge('queued', () => queue.start(['again']));
    await queue.cancelAll();
    await queue.shutdown();
    return result;
  },

  'failed->queued': async () => {
    const { queue } = await seededTranscription([{ id: 'retrying', status: 'failed' }]);
    const result = await transcriptionEdge('queued', () => queue.retry('retrying'));
    await queue.cancelAll();
    await queue.shutdown();
    return result;
  },

  'cancelled->queued': async () => {
    const { queue } = await seededTranscription([{ id: 'rerunning', status: 'cancelled' }]);
    const result = await transcriptionEdge('queued', () => queue.retry('rerunning'));
    await queue.cancelAll();
    await queue.shutdown();
    return result;
  },

  'interrupted->queued': async () => {
    const { queue } = await seededTranscription([{ id: 'resuming', status: 'interrupted' }]);
    const result = await transcriptionEdge('queued', () => queue.retry('resuming'));
    await queue.cancelAll();
    await queue.shutdown();
    return result;
  },

  'processing->failed': async () => {
    // Whisper exiting non-zero. The transcript never arrives, and the job says so.
    // `hang: false` explicitly: the behaviour file overrides only the fields it names, and
    // the stand-in is baked to hang so that every other driver can stop it mid-run.
    await whisperBehaves({ hang: false, exitCode: 2, durationMs: 10, stderr: 'whisper gave up' });
    const { queue } = await seededTranscription([{ id: 'breaking', status: 'ready' }]);
    const result = await transcriptionEdge('failed', () => queue.start(['breaking']));
    await whisperBehaves({ hang: true });
    await queue.shutdown();
    return result;
  },

  'processing->completed': async () => {
    await whisperBehaves({ hang: false, exitCode: 0, durationMs: 10 });
    const { queue } = await seededTranscription([{ id: 'finishing', status: 'ready' }]);
    const result = await transcriptionEdge('completed', () => queue.start(['finishing']));
    await whisperBehaves({ hang: true });
    await queue.shutdown();
    return result;
  },

  'processing->interrupted': async () => {
    // The one transition that happens across a restart. A run still `processing` when the
    // agent stopped is resolved by the store on the next launch, and it is a real move of a
    // real job — the restart is only where it takes place.
    const directory = await mkdtemp(path.join(workspace, 'transcription-restart-'));
    const stateFile = path.join(directory, 'transcription-state.json');
    const media = path.join(directory, 'interview.mp3');
    await writeFile(media, 'audio');
    await writeFile(
      stateFile,
      JSON.stringify({
        settings: { language: 'auto', translationLanguage: 'uk' },
        jobs: [
          {
            id: 'mid-run',
            inputPath: media,
            fileName: 'interview.mp3',
            status: 'processing',
            createdAt: Date.now()
          }
        ]
      }),
      'utf8'
    );
    return transcriptionEdge('interrupted', () => loadTranscriptionState(stateFile));
  }
};

/** A real one-pixel PNG, for the frame the encoder is asked to decode. */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const landingJobEdge = driverFor('landing-job');
const landingAssetEdge = driverFor('landing-asset');

/** A folder that looks like a landing page: one rewritable document, one image. */
async function landingFolder(name: string, extras: Record<string, string> = {}): Promise<string> {
  const directory = await mkdtemp(path.join(workspace, `landing-${name}-`));
  const site = path.join(directory, 'site');
  await mkdir(site, { recursive: true });
  await writeFile(path.join(site, 'index.html'), '<html><body><img src="logo.svg"></body></html>');
  await writeFile(
    path.join(site, 'logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>'
  );
  // A raster image as well. Vector and already-optimal files are recorded as `skipped`
  // before any work starts, so a folder of those alone can never drive an asset into
  // `processing` — the state most of this lifecycle is about.
  //
  // Padded far beyond the pixel it contains: whether an asset ends up `optimized` or
  // `skipped` is decided by comparing the encoded result against the size of the file on
  // disk, so a one-pixel image that is also one pixel on disk can only ever be "no gain".
  await writeFile(
    path.join(site, 'photo.png'),
    Buffer.concat([ONE_PIXEL_PNG, Buffer.alloc(40_000)])
  );
  for (const [relative, content] of Object.entries(extras))
    await writeFile(path.join(site, relative), content);
  return site;
}

async function landingOptimizer() {
  // The image encoder runs through the same shared stand-in, so its behaviour has to be
  // reset for the same reason the transcription harness resets it — and it has to answer
  // with a decodable frame, because the optimiser parses what comes back rather than
  // trusting the exit code.
  await behave({
    hang: false,
    exitCode: 0,
    durationMs: 10,
    stdoutBase64: ONE_PIXEL_PNG.toString('base64')
  });
  const optimizer = new LandingOptimizer({ ffmpeg: true, ffprobe: true }, () => {});
  optimizer.updateSettings({ archive: false });
  return optimizer;
}

/** Prepares one landing and returns the optimizer with it ready to start. */
async function preparedLanding(name: string) {
  const optimizer = await landingOptimizer();
  await optimizer.prepareFromFolderPath(await landingFolder(name));
  const jobId = optimizer.state().jobs[0]?.id as string;
  return { optimizer, jobId };
}

const LANDING_JOB_DRIVERS: DriverMap = {
  'preparing->ready': async () => {
    const optimizer = await landingOptimizer();
    const folder = await landingFolder('preparing');
    const result = await landingJobEdge('ready', () => optimizer.prepareFromFolderPath(folder));
    await optimizer.shutdown();
    return result;
  },

  'ready->queued': async () => {
    const { optimizer, jobId } = await preparedLanding('queueing');
    // Not awaited: `start` does not resolve until the whole batch has drained, and the edge
    // this driver is about happens on the way in.
    const result = await landingJobEdge('queued', async () => {
      void optimizer.start([jobId]);
    });
    await optimizer.cancelAll();
    await optimizer.shutdown();
    return result;
  },

  'queued->processing': async () => {
    const { optimizer, jobId } = await preparedLanding('processing');
    const result = await landingJobEdge('processing', async () => {
      void optimizer.start([jobId]);
    });
    await optimizer.cancelAll();
    await optimizer.shutdown();
    return result;
  },

  'queued->cancelled': async () => {
    // Two landings, one queue. The second is still waiting its turn when it is stopped,
    // which is the only way to reach this edge — a single landing goes straight to
    // processing.
    const { optimizer, jobId } = await preparedLanding('first');
    await optimizer.prepareFromFolderPath(await landingFolder('second'));
    const second = optimizer.state().jobs[1]?.id as string;
    const result = await landingJobEdge('cancelled', async () => {
      void optimizer.start([jobId, second]);
      await waitFor(
        () => optimizer.state().jobs.some(job => job.id === second && job.status === 'queued'),
        { describe: 'the second landing to be queued' }
      );
      await optimizer.cancel(second);
    });
    await optimizer.cancelAll();
    await optimizer.shutdown();
    return result;
  },

  'processing->cancelled': async () => {
    const { optimizer, jobId } = await preparedLanding('stopping');
    const result = await landingJobEdge('cancelled', async () => {
      void optimizer.start([jobId]);
      await waitFor(
        () => optimizer.state().jobs.some(job => job.id === jobId && job.status === 'processing'),
        { describe: 'the landing to start' }
      );
      await optimizer.cancel(jobId);
    });
    await optimizer.shutdown();
    return result;
  },

  'processing->completed': async () => {
    const { optimizer, jobId } = await preparedLanding('finishing');
    const result = await landingJobEdge('completed', () => optimizer.start([jobId]));
    await optimizer.shutdown();
    return result;
  },

  'processing->failed': async () => {
    // The optimised copy cannot be written out. One asset failing leaves the landing
    // finished-with-notes; the *output* failing is the whole job failing, and the two must
    // not look the same to the user.
    const optimizer = await landingOptimizer();
    const site = await landingFolder('unwritable');
    await optimizer.prepareFromFolderPath(site);
    const jobId = optimizer.state().jobs[0]?.id as string;

    const destination = path.dirname(site);
    await chmod(destination, 0o555);
    try {
      return await landingJobEdge('failed', () => optimizer.start([jobId]));
    } finally {
      // Restored whatever happened, or the workspace cannot be cleaned up afterwards.
      await chmod(destination, 0o755);
      await optimizer.shutdown();
    }
  }
};

const LANDING_ASSET_DRIVERS: DriverMap = {
  'pending->processing': async () => {
    const { optimizer, jobId } = await preparedLanding('assets');
    const result = await landingAssetEdge('processing', async () => {
      void optimizer.start([jobId]);
    });
    await optimizer.cancelAll();
    await optimizer.shutdown();
    return result;
  },

  'processing->optimized': async () => {
    const { optimizer, jobId } = await preparedLanding('optimising');
    const result = await landingAssetEdge('optimized', () => optimizer.start([jobId]));
    await optimizer.shutdown();
    return result;
  },

  'processing->skipped': async () => {
    // A name collision, not a size comparison. The WebP the image would become is already
    // taken by a different file, and clobbering it would destroy something the page uses —
    // so the asset is left as it is, which is a real outcome rather than a failure.
    const optimizer = await landingOptimizer();
    const folder = await landingFolder('colliding', { 'photo.webp': 'an unrelated file' });
    await optimizer.prepareFromFolderPath(folder);
    const jobId = optimizer.state().jobs[0]?.id as string;
    const result = await landingAssetEdge('skipped', () => optimizer.start([jobId]));
    await optimizer.shutdown();
    return result;
  },

  'processing->failed': async () => {
    const { optimizer, jobId } = await preparedLanding('failing');
    // The image encoder refuses. One asset failing does not fail the landing — the rest of
    // the page is still optimised and the summary says which file could not be.
    await behave({
      hang: false,
      exitCode: 4,
      durationMs: 10,
      stdoutBase64: '',
      stderr: 'the encoder refused'
    });
    const result = await landingAssetEdge('failed', () => optimizer.start([jobId]));
    await optimizer.shutdown();
    return result;
  }
};

const mediaActionEdge = driverFor('media-action');

/** A conversion queue whose converter is held open until the driver decides. */
async function mediaActions(converter?: ConstructorParameters<typeof MediaActionQueue>[1]) {
  const directory = await mkdtemp(path.join(workspace, 'media-actions-'));
  const source = path.join(directory, 'photo.png');
  await writeFile(source, ONE_PIXEL_PNG);
  const calls: { reject: (error: Error) => void; resolve: (value: unknown) => void }[] = [];
  const queue = new MediaActionQueue(
    () => {},
    converter ??
      ((_input, outputPath, _format, signal) =>
        new Promise((resolve, reject) => {
          calls.push({ resolve: resolve as never, reject });
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
          void outputPath;
        }))
  );
  return { queue, source, calls, directory };
}

const MEDIA_ACTION_DRIVERS: DriverMap = {
  'queued->skipped': async () => {
    // Already in the target format. Nothing to do is a real outcome, and telling them apart
    // from a stop is exactly why `skipped` and `cancelled` are two states rather than one.
    const { queue, directory } = await mediaActions();
    const source = path.join(directory, 'already.png');
    await writeFile(source, ONE_PIXEL_PNG);
    const result = await mediaActionEdge('skipped', () =>
      queue.addImageConversions([source], 'png')
    );
    await queue.shutdown();
    return result;
  },

  'queued->processing': async () => {
    const { queue, source } = await mediaActions();
    const result = await mediaActionEdge('processing', () =>
      queue.addImageConversions([source], 'jpeg')
    );
    await queue.cancelAll();
    await queue.shutdown();
    return result;
  },

  'queued->cancelled': async () => {
    // Two conversions, one at a time. The second is still waiting when it is stopped.
    const { queue, source } = await mediaActions();
    const jobs = await queue.addImageConversions([source, source], 'jpeg');
    const result = await mediaActionEdge('cancelled', () => queue.cancel(jobs[1]?.id as string));
    await queue.cancelAll();
    await queue.shutdown();
    return result;
  },

  'processing->cancelled': async () => {
    const { queue, source, calls } = await mediaActions();
    const jobs = await queue.addImageConversions([source], 'jpeg');
    await waitFor(() => calls.length > 0, { describe: 'the converter to start' });
    const result = await mediaActionEdge('cancelled', () => queue.cancel(jobs[0]?.id as string));
    await queue.shutdown();
    return result;
  },

  'processing->completed': async () => {
    const { queue, source, calls } = await mediaActions();
    await queue.addImageConversions([source], 'jpeg');
    await waitFor(() => calls.length > 0, { describe: 'the converter to start' });
    const result = await mediaActionEdge('completed', async () => {
      calls[0]?.resolve({ outputPath: `${source}.jpg`, width: 1, height: 1, size: 1 });
    });
    await queue.shutdown();
    return result;
  },

  'processing->failed': async () => {
    const { queue, source, calls } = await mediaActions();
    await queue.addImageConversions([source], 'jpeg');
    await waitFor(() => calls.length > 0, { describe: 'the converter to start' });
    const result = await mediaActionEdge('failed', async () => {
      calls[0]?.reject(new Error('the converter refused'));
    });
    await queue.shutdown();
    return result;
  }
};

const previewItemEdge = driverFor('landing-preview-item');

/** A renderer that can be made to fail, and that reports when it has been asked to work. */
class DriverRenderer {
  failNext = false;
  renders = 0;

  async init(): Promise<void> {}

  availability() {
    return { available: true, error: null };
  }

  async render({ outputPath }: { outputPath: string }) {
    this.renders += 1;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('Synthetic renderer failure.');
    }
    // A minimal but real WebP container: the catalog checks what came back rather than
    // trusting the renderer's word for it.
    await writeFile(
      outputPath,
      Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(32)])
    );
    return {
      width: 1440,
      height: 900,
      segmentFiles: [outputPath],
      title: null,
      blockedExternalRequests: 0,
      warning: null
    };
  }

  async shutdown(): Promise<void> {}
}

/** A catalog pointed at one landing page, ready to render. */
async function previewCatalog() {
  const directory = await mkdtemp(path.join(workspace, 'preview-'));
  const catalogueRoot = path.join(directory, 'catalogue');
  const landingRoot = path.join(catalogueRoot, 'first');
  await mkdir(landingRoot, { recursive: true });
  const entry = path.join(landingRoot, 'index.html');
  await writeFile(entry, '<!doctype html><title>First</title>');

  const renderer = new DriverRenderer();
  const catalog = new LandingPreviewCatalog({
    root: path.join(directory, 'cache'),
    renderer: renderer as never
  });
  await catalog.init();
  return { catalog, renderer, catalogueRoot, entry };
}

async function previewIdle(catalog: InstanceType<typeof LandingPreviewCatalog>) {
  await waitFor(() => !catalog.state().running, {
    timeoutMs: 20_000,
    describe: 'the preview run to finish'
  });
}

const LANDING_PREVIEW_ITEM_DRIVERS: DriverMap = {
  'queued->rendering': async () => {
    const { catalog, catalogueRoot } = await previewCatalog();
    const result = await previewItemEdge('rendering', () => catalog.openRoot(catalogueRoot));
    await previewIdle(catalog);
    await catalog.shutdown();
    return result;
  },

  'rendering->ready': async () => {
    const { catalog, catalogueRoot } = await previewCatalog();
    const result = await previewItemEdge('ready', () => catalog.openRoot(catalogueRoot));
    await previewIdle(catalog);
    await catalog.shutdown();
    return result;
  },

  'rendering->failed': async () => {
    const { catalog, catalogueRoot, renderer } = await previewCatalog();
    renderer.failNext = true;
    const result = await previewItemEdge('failed', () => catalog.openRoot(catalogueRoot));
    await previewIdle(catalog);
    await catalog.shutdown();
    return result;
  },

  'failed->queued': async () => {
    // A render that failed is worth attempting again once its cache is gone.
    const { catalog, catalogueRoot, renderer } = await previewCatalog();
    renderer.failNext = true;
    await catalog.openRoot(catalogueRoot);
    await previewIdle(catalog);
    const result = await previewItemEdge('queued', () => catalog.clearActiveCache());
    await catalog.shutdown();
    return result;
  },

  'ready->queued': async () => {
    // A page that rendered fine and is then asked for again. Declaring `ready` terminal
    // would have made the enforcement refuse every second render of every page.
    const { catalog, catalogueRoot } = await previewCatalog();
    await catalog.openRoot(catalogueRoot);
    await previewIdle(catalog);
    const result = await previewItemEdge('queued', () => catalog.clearActiveCache());
    await catalog.shutdown();
    return result;
  }
};

/**
 * Every lifecycle's drivers, keyed by the lifecycle id.
 *
 * Keyed rather than flattened because two lifecycles legitimately share an edge name —
 * `queued->processing` exists in five of the seven — and a flat map would silently let one
 * tool's driver stand in for another's.
 */
const stitchEdge = driverFor('stitch');

/**
 * A stitch queue whose media half is a stub the driver controls.
 *
 * The pipeline is injected for exactly this reason: the queue's guarantees are about order,
 * cancellation and state, none of which need a media engine to demonstrate — and the stub
 * FFmpeg installed for the other drivers could never satisfy the verification step, so a
 * real pipeline here would only ever drive the failure edges.
 */
async function stitchQueue(pipeline?: StitchPipeline) {
  const directory = await mkdtemp(path.join(workspace, 'stitcher-'));
  const source = path.join(directory, 'creative.mp4');
  await writeFile(source, 'not really a video');
  const queue = new StitchQueue({
    imagePathFor: async () => path.join(directory, 'photo.png'),
    onChange: () => {},
    bodies: new PreparedBodyCache({ root: directory }),
    pipeline:
      pipeline ??
      (async context => {
        const staged = path.join(context.workDir, 'result.mp4');
        await writeFile(staged, 'stitched');
        return { ok: true, stagedPath: staged, verification: PASSING_VERIFICATION };
      })
  });
  return { queue, source, directory };
}

const PASSING_VERIFICATION = {
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

const NOTHING_FOUND = { startSeconds: 0, endSeconds: 0, adjustedByUser: false };

function stitchRequest(source: string): StitchRunRequest {
  const profile = {
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
    colorRange: 'tv' as const,
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
  const screens = {
    startImageId: null,
    endImageId: 'photo',
    fitMode: 'cover' as const,
    endDurationSeconds: 45,
    startDurationSeconds: null
  };
  return {
    profile,
    detected: NOTHING_FOUND,
    screens,
    operation: 'stitch',
    destination: { kind: 'beside' },
    outputSuffix: '_stitched'
  };
}

/**
 * One row in the list, added the way the routes add it.
 *
 * Adding and starting are two steps in this queue — a row exists before it runs, which is
 * what makes it selectable — so the drivers hold on to both the id and the request.
 */
function addStitchRow(
  queue: InstanceType<typeof StitchQueue>,
  source: string
): { id: string; request: StitchRunRequest } {
  const request = stitchRequest(source);
  const [job] = queue.add([{ profile: request.profile }]);
  if (!job) throw new Error('the stitch row was not added');
  return { id: job.id, request };
}

/** A pipeline held open until the driver lets it go, or until the run is stopped. */
function heldPipeline() {
  let release: (() => void) | null = null;
  const started = { value: false };
  const pipeline: StitchPipeline = context =>
    new Promise(resolve => {
      started.value = true;
      const stop = () => resolve({ ok: false, error: 'STITCH_CANCELLED' });
      release = () => resolve({ ok: false, error: 'STITCH_TOOL_FAILED' });
      // An abort can already have happened by the time the pipeline is entered; a listener
      // alone would then never fire, which is a hang rather than a cancellation.
      if (context.signal.aborted) stop();
      else context.signal.addEventListener('abort', stop, { once: true });
    });
  return { pipeline, started, release: () => release?.() };
}

const STITCH_DRIVERS: DriverMap = {
  'ready->queued': async () => {
    const held = heldPipeline();
    const { queue, source } = await stitchQueue(held.pipeline);
    const row = addStitchRow(queue, source);
    const result = await stitchEdge('queued', async () => queue.start(row.id, row.request));
    await queue.cancelAll();
    await queue.shutdown();
    return result;
  },

  'queued->running': async () => {
    const held = heldPipeline();
    const { queue, source } = await stitchQueue(held.pipeline);
    const row = addStitchRow(queue, source);
    const result = await stitchEdge('running', async () => queue.start(row.id, row.request));
    await queue.shutdown();
    return result;
  },

  'queued->cancelled': async () => {
    // Two rows, one at a time. The second is still waiting when it is stopped.
    const held = heldPipeline();
    const { queue, source } = await stitchQueue(held.pipeline);
    const first = addStitchRow(queue, source);
    queue.start(first.id, first.request);
    const second = addStitchRow(queue, source);
    queue.start(second.id, second.request);
    const result = await stitchEdge('cancelled', () => queue.cancel(second.id));
    await queue.shutdown();
    return result;
  },

  'running->done': async () => {
    const { queue, source } = await stitchQueue();
    const row = addStitchRow(queue, source);
    const result = await stitchEdge('done', async () => queue.start(row.id, row.request));
    await queue.shutdown();
    return result;
  },

  'running->failed': async () => {
    const { queue, source } = await stitchQueue(async () => ({
      ok: false,
      error: 'STITCH_VERIFICATION_FAILED'
    }));
    const row = addStitchRow(queue, source);
    const result = await stitchEdge('failed', async () => queue.start(row.id, row.request));
    await queue.shutdown();
    return result;
  },

  'running->cancelled': async () => {
    const held = heldPipeline();
    const { queue, source } = await stitchQueue(held.pipeline);
    const row = addStitchRow(queue, source);
    queue.start(row.id, row.request);
    await waitFor(() => held.started.value, { describe: 'the stitch pipeline to start' });
    const result = await stitchEdge('cancelled', () => queue.cancel(row.id));
    await queue.shutdown();
    return result;
  },

  /* The three roads back. Running a settled row again returns it to `ready` first — that is
     where the previous result is cleared, rather than lingering beside the new one. */
  'done->ready': async () => {
    const { queue, source } = await stitchQueue();
    const row = addStitchRow(queue, source);
    queue.start(row.id, row.request);
    await waitFor(() => queue.state().jobs[0]?.status === 'done', {
      describe: 'the first stitch run to finish'
    });
    const result = await stitchEdge('ready', async () => queue.start(row.id, row.request));
    await queue.cancelAll();
    await queue.shutdown();
    return result;
  },

  'failed->ready': async () => {
    const { queue, source } = await stitchQueue(async () => ({
      ok: false,
      error: 'STITCH_VERIFICATION_FAILED'
    }));
    const row = addStitchRow(queue, source);
    queue.start(row.id, row.request);
    await waitFor(() => queue.state().jobs[0]?.status === 'failed', {
      describe: 'the first stitch run to fail'
    });
    const result = await stitchEdge('ready', async () => queue.start(row.id, row.request));
    await queue.cancelAll();
    await queue.shutdown();
    return result;
  },

  'cancelled->ready': async () => {
    const held = heldPipeline();
    const { queue, source } = await stitchQueue(held.pipeline);
    const first = addStitchRow(queue, source);
    queue.start(first.id, first.request);
    const second = addStitchRow(queue, source);
    queue.start(second.id, second.request);
    await queue.cancel(second.id);
    await waitFor(() => queue.state().jobs[1]?.status === 'cancelled', {
      describe: 'the waiting row to be stopped'
    });
    const result = await stitchEdge('ready', async () => queue.start(second.id, second.request));
    await queue.cancelAll();
    await queue.shutdown();
    return result;
  }
};

export const DRIVERS: Readonly<Record<string, DriverMap>> = {
  compression: COMPRESSION_DRIVERS,
  transcription: TRANSCRIPTION_DRIVERS,
  translation: TRANSLATION_DRIVERS,
  'landing-job': LANDING_JOB_DRIVERS,
  'landing-asset': LANDING_ASSET_DRIVERS,
  'landing-preview-item': LANDING_PREVIEW_ITEM_DRIVERS,
  'media-action': MEDIA_ACTION_DRIVERS,
  stitch: STITCH_DRIVERS
};
