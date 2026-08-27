import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PowerGovernor } from '../apps/agent/src/power/governor.js';
import { spawnManaged } from '../apps/agent/src/power/spawn.js';
import { waitFor } from './support/wait.js';
import type {
  TranslateRequest,
  Translator,
  TranslationOutputSegment
} from '../apps/agent/src/translation/translator.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import { describeRequiring, requirePlatform } from './support/requires.js';

/**
 * "Stopped" has to mean the machine goes quiet, not that a status field changed.
 *
 * Every failure guarded here looked identical to the user: the tool reported
 * the job as stopped while an FFmpeg, a whisper pass, or a local translation
 * carried on holding the CPU — visible only as a power readout that would not
 * come down, and blamed on whatever they opened next.
 */

const posixTermination = requirePlatform('darwin', 'linux');

describeRequiring(posixTermination, 'terminating a managed child', () => {
  it('kills one that swallows SIGTERM instead of leaving it running', async () => {
    const governor = new PowerGovernor({ cpuCount: 4, pauseSupported: false });
    // A child that handles SIGTERM and carries on is not hypothetical: a
    // process wedged inside a native inference loop never reaches its handler
    // either, and both look the same from here.
    const stubborn = [
      "process.on('SIGTERM', () => {});",
      'setInterval(() => {}, 1000);',
      // Announce readiness: a signal sent before the handler is installed would
      // test the default disposition, not the escalation.
      "process.stdout.write('ready\\n');"
    ].join('');
    const child = spawnManaged(governor, process.execPath, ['-e', stubborn], { toolId: 'test' });
    const exit = new Promise<NodeJS.Signals | null>(resolve => {
      child.once('close', (_code, signal) => resolve(signal));
    });
    await new Promise<void>(resolve => child.stdout.once('data', () => resolve()));

    child.kill('SIGTERM');

    expect(await exit).toBe('SIGKILL');
  }, 15_000);

  it('leaves a child that exits on SIGTERM alone', async () => {
    const governor = new PowerGovernor({ cpuCount: 4, pauseSupported: false });
    const child = spawnManaged(
      governor,
      process.execPath,
      ['-e', "setInterval(() => {}, 1000); process.stdout.write('ready\\n');"],
      { toolId: 'test' }
    );
    const exit = new Promise<NodeJS.Signals | null>(resolve => {
      child.once('close', (_code, signal) => resolve(signal));
    });
    await new Promise<void>(resolve => child.stdout.once('data', () => resolve()));

    child.kill('SIGTERM');

    expect(await exit).toBe('SIGTERM');
  }, 15_000);
});

describe('cancelling a transcription', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'soty-stop-'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    await removeTemporaryDirectory(dir);
  });

  it('never starts the audio extract when the stop lands before the first spawn', async () => {
    // A cancel between two stages has no child to signal — it only sets a flag,
    // and that flag is not read again until the stage about to start has
    // finished. Spawning anyway meant the user's stop was followed by a full
    // extract, or a whole whisper pass, at full speed.
    const marker = path.join(dir, 'spawned');
    const stub = path.join(dir, 'stub-ffmpeg');
    await writeFile(
      stub,
      [
        '#!/usr/bin/env node',
        "const { writeFileSync } = require('node:fs');",
        `writeFileSync(${JSON.stringify(marker)}, 'yes');`,
        // Hangs like a real extract would, so a leak shows up as a test that
        // waits rather than one that silently passes.
        'setInterval(() => {}, 1000);'
      ].join('\n'),
      { mode: 0o755 }
    );
    vi.stubEnv('FFMPEG_PATH', stub);
    vi.stubEnv('WHISPER_PATH', stub);
    vi.resetModules();
    const { transcribe } = await import('../apps/agent/src/whisper/transcriber.js');

    const handle = transcribe({
      inputPath: path.join(dir, 'media.mp4'),
      language: 'auto',
      onProgress: () => {}
    });
    // Synchronously, before the temp directory even exists: this is the window
    // in which the handle holds no child at all.
    handle.cancel();
    const result = await handle.done;

    expect(result.cancelled).toBe(true);
    expect(result.failedStage).toBeNull();
    expect(existsSync(marker)).toBe(false);
  }, 15_000);
});

class BlockingTranslator implements Translator {
  aborted = 0;
  started = 0;

  available(): boolean {
    return true;
  }

  modelVersion(): string {
    return 'stop-test-1';
  }

  translate(request: TranslateRequest, signal: AbortSignal): Promise<TranslationOutputSegment[]> {
    this.started += 1;
    return new Promise((_resolve, reject) => {
      const abort = () => {
        this.aborted += 1;
        reject(new Error('aborted'));
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  }
}

describe('stopping everything in the transcription tool', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'soty-stop-all-'));
    const modelPath = path.join(dir, 'whisper.bin');
    await writeFile(modelPath, 'model');
    process.env.WHISPER_MODEL_PATH = modelPath;
    process.env.AGENT_TRANSCRIBE_DOCUMENTS_PATH = path.join(dir, 'docs');
    process.env.AGENT_TRANSLATION_CACHE_PATH = path.join(dir, 'cache');
    process.env.AGENT_TRANSCRIBE_PREVIEWS_PATH = path.join(dir, 'previews');
  });

  afterEach(async () => {
    vi.resetModules();
    delete process.env.WHISPER_MODEL_PATH;
    delete process.env.AGENT_TRANSCRIBE_DOCUMENTS_PATH;
    delete process.env.AGENT_TRANSLATION_CACHE_PATH;
    delete process.env.AGENT_TRANSCRIBE_PREVIEWS_PATH;
    await removeTemporaryDirectory(dir);
  });

  it('stops the local translation, not just the transcription queue', async () => {
    // Translation is the other half of what this tool runs, and it belongs to a
    // job that has already finished transcribing — so it is never in the list
    // of jobs "stop all" walks. Leaving it running is what kept a stopped queue
    // pinning the machine.
    vi.doMock('../apps/agent/src/whisper/transcriber.js', () => ({
      transcribe: ({ onProgress }: { onProgress: (value: number | null) => void }) => {
        onProgress(100);
        return {
          cancel: () => {},
          done: Promise.resolve({
            code: 0,
            cancelled: false,
            text: 'Hello there.',
            detectedLanguage: 'en',
            stderr: '',
            failedStage: null,
            spawnErrorCode: null,
            words: [],
            englishText: '',
            englishWords: []
          })
        };
      }
    }));
    const { TranscriptionQueue } = await import('../apps/agent/src/queue/transcription-queue.js');
    const queue = new TranscriptionQueue({ ffmpeg: true, whisper: true }, () => {});
    const translator = new BlockingTranslator();
    queue.setTranslator(translator);
    queue.updateSettings({ translationLanguage: 'uk' });

    const mediaPath = path.join(dir, 'clip.mp3');
    await writeFile(mediaPath, 'media');
    await queue.add([mediaPath]);
    const id = queue.state().jobs[0].id;
    expect(await queue.start([id])).toBe(true);
    await waitFor(() => translator.started === 1);

    expect(queue.cancelAll()).toBeGreaterThan(0);

    await waitFor(() => translator.aborted === 1);
    await waitFor(() => queue.state().jobs[0].translation?.status !== 'processing');
    await queue.shutdown();
  }, 15_000);
});

describe('the agent exiting', () => {
  it('kills a managed child that is still registered when the governor shuts down', async () => {
    // Every tool has already had its own graceful shutdown by the time the
    // governor's runs — the module list is drained first. So a child still
    // registered here ignored its SIGTERM or was never signalled at all, and
    // once this process exits nothing can reap it, find it, or report it. It
    // would simply keep the machine hot behind an app that is no longer there.
    const governor = new PowerGovernor({ cpuCount: 4, pauseSupported: false });
    const child = spawnManaged(
      governor,
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      { toolId: 'test' }
    );
    const exit = new Promise<NodeJS.Signals | null>(resolve => {
      child.once('close', (_code, signal) => resolve(signal));
    });

    await governor.shutdown();

    expect(await exit).toBe('SIGKILL');
  }, 15_000);
});

describe('quitting while Finder image conversions are queued', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('finishes the conversions already in hand', async () => {
    // Draining is the point: a Finder action is started from the context menu,
    // often with no Soty window on screen, so a quit that discarded the queue
    // would silently drop work the user asked for.
    const { MediaActionQueue } = await import('../apps/agent/src/media-actions/queue.js');
    const converted: string[] = [];
    const queue = new MediaActionQueue(
      () => {},
      async (inputPath, outputPath) => {
        converted.push(inputPath);
        return { outputPath, width: 1, height: 1, size: 1 };
      }
    );
    await queue.addImageConversions(['/tmp/one.png', '/tmp/two.png'], 'jpeg');

    await queue.shutdown();

    expect(converted).toHaveLength(2);
  }, 15_000);

  it('stops an encoder that outlasts the drain, instead of waiting on it forever', async () => {
    // The other half of draining. Nothing used to signal the running encoder,
    // so one FFmpeg wedged on a malformed image held the agent open until the
    // launcher lost patience and killed it — orphaning that encoder, still
    // converting, attached to nothing that could stop or report it.
    vi.useFakeTimers();
    const { MediaActionQueue } = await import('../apps/agent/src/media-actions/queue.js');
    let sawAbort = false;
    const queue = new MediaActionQueue(
      () => {},
      (_inputPath, outputPath, _format, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              sawAbort = true;
              reject(new Error('stopped'));
            },
            { once: true }
          );
          void outputPath;
        })
    );
    await queue.addImageConversions(['/tmp/wedged.png', '/tmp/next.png'], 'jpeg');

    const shutdown = queue.shutdown();
    await vi.advanceTimersByTimeAsync(60_000);
    await shutdown;

    expect(sawAbort).toBe(true);
    // The job behind the wedged one is never picked up: the queue stops where it
    // stands rather than starting fresh work on the way out. Both end `cancelled`
    // — nothing about them broke, the application ran out of time — so the last
    // state the window sees describes work that is no longer happening.
    expect(queue.state().jobs.map(job => job.status)).toEqual(['cancelled', 'cancelled']);
  }, 15_000);
});

describeRequiring(posixTermination, 'the termination guarantee without a resource budget', () => {
  it('still kills a child that swallows SIGTERM when no governor is attached', async () => {
    // The guarantee used to be skipped entirely on this branch: `spawnManaged` returned
    // early when it had no governor, so the child never got the escalation wrapper. A
    // process spawned before a governor is installed — or in any assembly that omits one —
    // could handle SIGTERM, carry on, and nothing would ever kill it. Escalation is about
    // stopping, not about throttling, so it must not depend on a budget being present.
    const stubborn = [
      "process.on('SIGTERM', () => {});",
      'setInterval(() => {}, 1000);',
      "process.stdout.write('ready\\n');"
    ].join('');
    const child = spawnManaged(null, process.execPath, ['-e', stubborn], { toolId: 'test' });
    const exit = new Promise<NodeJS.Signals | null>(resolve => {
      child.once('close', (_code, signal) => resolve(signal));
    });
    await new Promise<void>(resolve => child.stdout.once('data', () => resolve()));

    child.kill('SIGTERM');

    expect(await exit).toBe('SIGKILL');
  }, 15_000);
});
