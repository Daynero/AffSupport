import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadState, saveState } from '../apps/agent/src/queue/store.js';
import { makeJob, optimalSettings } from './helpers.js';

let directory = '';
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
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
    expect(restored.batch?.finishedAt).toBeTypeOf('number');
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
