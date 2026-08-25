import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadState, saveState } from '../apps/agent/src/queue/store.js';
import { makeJob, optimalSettings } from './helpers.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

let directory = '';
afterEach(async () => {
  if (directory) await removeTemporaryDirectory(directory);
  directory = '';
});

describe('persistent agent state', () => {
  it('restores settings and marks an interrupted encode without treating it as active', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'compressor-state-'));
    const source = path.join(directory, 'source.mov');
    const stateFile = path.join(directory, 'state.json');
    await writeFile(source, 'source');
    const job = makeJob('processing', 'processing', {
      inputPath: source,
      outputPath: path.join(directory, 'output.mp4'),
      startedAt: Date.now() - 1000,
      batchId: 'batch'
    });
    await saveState(
      {
        settings: { ...optimalSettings, mode: 'custom', frameRate: 25, resolutionLimit: 720 },
        jobs: [job],
        batch: { id: 'batch', jobIds: [job.id], startedAt: Date.now() - 1000, finishedAt: null }
      },
      stateFile
    );
    const restored = await loadState(stateFile);
    expect(restored.settings).toMatchObject({
      mode: 'custom',
      frameRate: 25,
      resolutionLimit: 720
    });
    expect(restored.jobs[0].status).toBe('interrupted');
    expect(restored.jobs[0].error).toContain('interrupted');
    // Was asserted as a number, which is what A8 turned out to be: the loader coerced a
    // persisted `null` into `Date.now()`, so an unfinished batch always came back finished
    // and the drain watchdog's guard could never be true. The batch here never finished.
    expect(restored.batch?.finishedAt).toBeNull();
  });

  it('does not restore an inaccessible old source as an active file', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'compressor-state-missing-'));
    const stateFile = path.join(directory, 'state.json');
    await saveState(
      {
        settings: { ...optimalSettings },
        jobs: [makeJob('missing', 'ready', { inputPath: path.join(directory, 'missing.mov') })],
        batch: null
      },
      stateFile
    );
    expect((await loadState(stateFile)).jobs).toEqual([]);
  });

  it('migrates the previous single-image settings into the new image grids', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'compressor-state-images-'));
    const stateFile = path.join(directory, 'state.json');
    const legacyImage = {
      id: '11111111-1111-4111-8111-111111111111',
      fileName: 'opening.png',
      width: 640,
      height: 360,
      size: 100,
      mimeType: 'image/png',
      extension: '.png'
    };
    await writeFile(
      stateFile,
      JSON.stringify({
        settings: {
          imageEmbedding: {
            enabled: true,
            startImage: legacyImage,
            endImage: null,
            finalDurationMode: 'random-40-50',
            fitMode: 'cover'
          }
        },
        jobs: [],
        batch: null
      })
    );

    expect((await loadState(stateFile)).settings.imageEmbedding).toMatchObject({
      enabled: true,
      startImages: [legacyImage],
      endImages: [],
      replaceExisting: false
    });
  });

  it('keeps the state file atomic when saves overlap', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'compressor-state-overlap-'));
    const stateFile = path.join(directory, 'state.json');
    const crfValues = Array.from({ length: 20 }, (_, index) => 18 + index);

    await expect(
      Promise.all(
        crfValues.map(crf =>
          saveState(
            {
              settings: { ...optimalSettings, crf },
              jobs: [],
              batch: null
            },
            stateFile
          )
        )
      )
    ).resolves.toHaveLength(crfValues.length);

    const saved = JSON.parse(await readFile(stateFile, 'utf8')) as {
      settings: { crf: number };
    };
    expect(crfValues).toContain(saved.settings.crf);
  });
});

describe('what a restart finds on disk', () => {
  it('removes the partial output an encode that died mid-run left behind', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'compressor-orphan-'));
    const source = path.join(directory, 'clip.mov');
    const partial = path.join(directory, 'clip_compressed.mp4');
    const stateFile = path.join(directory, 'state.json');
    await writeFile(source, 'source');
    await writeFile(partial, 'half an encode');

    await saveState(
      {
        settings: optimalSettings,
        jobs: [
          makeJob('killed', 'processing', { inputPath: source, outputPath: partial, progress: 40 })
        ],
        batch: null
      },
      stateFile
    );

    const restored = await loadState(stateFile);

    // A2(ii). Every cancel path unlinks; a quit did not, so a user who quit mid-batch
    // accumulated truncated .mp4 files next to their sources and nothing ever removed them.
    expect(restored.jobs[0].status).toBe('interrupted');
    expect(existsSync(partial)).toBe(false);
  });

  it('keeps the finished output of a run interrupted during validation', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'compressor-recovery-'));
    const source = path.join(directory, 'clip.mov');
    const output = path.join(directory, 'clip_compressed.mp4');
    const stateFile = path.join(directory, 'state.json');
    await writeFile(source, 'source');
    await writeFile(output, 'a complete encode');

    await saveState(
      {
        settings: optimalSettings,
        jobs: [
          makeJob('recoverable', 'interrupted', {
            inputPath: source,
            outputPath: output,
            errorDetails: JSON.stringify({
              code: 'MEDIA_TOOL_UNAVAILABLE',
              phase: 'output-validation',
              tool: 'ffprobe'
            })
          })
        ],
        batch: null
      },
      stateFile
    );

    const restored = await loadState(stateFile);

    // The encode had already finished; only the validation probe was interrupted. Recovery
    // re-probes this file and completes the job, so removing it would destroy finished work
    // and make the user encode the same video twice.
    expect(restored.jobs[0].status).toBe('interrupted');
    expect(existsSync(output)).toBe(true);
  });

  it('brings an unfinished batch back unfinished so the drain watchdog can fire', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'compressor-batch-'));
    const source = path.join(directory, 'clip.mov');
    const stateFile = path.join(directory, 'state.json');
    await writeFile(source, 'source');
    const job = makeJob('queued-job', 'queued', { inputPath: source, batchId: 'batch' });

    await saveState(
      {
        settings: optimalSettings,
        jobs: [job],
        batch: { id: 'batch', jobIds: [job.id], startedAt: Date.now() - 1000, finishedAt: null }
      },
      stateFile
    );

    const restored = await loadState(stateFile);

    // A8. `Number(null) || Date.now()` made this always truthy, so the watchdog's
    // `!batch.finishedAt` guard could never be true for a restored batch and the documented
    // "agent died mid-drain" recovery was unreachable dead code.
    expect(restored.batch?.finishedAt).toBeNull();
  });

  it('preserves the timestamp of a batch that really did finish', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'compressor-batch-done-'));
    const source = path.join(directory, 'clip.mov');
    const stateFile = path.join(directory, 'state.json');
    await writeFile(source, 'source');
    const job = makeJob('done-job', 'completed', {
      inputPath: source,
      outputPath: source,
      batchId: 'batch'
    });
    const finishedAt = Date.now() - 5_000;

    await saveState(
      {
        settings: optimalSettings,
        jobs: [job],
        batch: { id: 'batch', jobIds: [job.id], startedAt: Date.now() - 10_000, finishedAt }
      },
      stateFile
    );

    const restored = await loadState(stateFile);

    expect(restored.batch?.finishedAt).toBe(finishedAt);
  });
});
