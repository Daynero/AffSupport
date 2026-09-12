import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobQueue } from '../apps/agent/src/queue/queue.js';
import {
  UPLOADED_VIDEO_OUTPUT_FOLDER,
  uploadedOutputDir
} from '../apps/agent/src/files/output-destination.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import { makeJob, optimalSettings } from './helpers.js';

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => removeTemporaryDirectory(root)));
});

/**
 * A queue holding one job, with the source file actually on disk so `start`
 * does not drop it as a missing source before resolving an output path.
 */
async function queueWith(sourceKind: 'local' | 'uploaded', inputDir: string) {
  const inputPath = path.join(inputDir, 'clip.mp4');
  await writeFile(inputPath, '');
  const job = makeJob('one', 'ready', { inputPath, sourceKind });
  const queue = new JobQueue({ ffmpeg: true, ffprobe: true }, () => {}, [job], {
    ...optimalSettings,
    outputMode: 'next-to-originals',
    outputFolder: null
  });
  return { queue, job, inputPath };
}

describe('where the compressor writes a result', () => {
  it('puts a local source beside the file the person actually has', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'compressor-loc-local-'));
    roots.push(root);
    const { queue, job } = await queueWith('local', root);

    await queue.start([job.id]);

    expect(path.dirname(queue.state().jobs[0].outputPath)).toBe(root);
  });

  it('never writes beside the private copy it made of an upload', async () => {
    // What a browser drop leaves behind when the real file cannot be found:
    // Application Support/Soty/Imports/import-XXXX/clip.mp4. Writing the result
    // there buried it in an internal folder — and `cleanupImportedSource`
    // removes that whole directory with the card, taking the result with it.
    const support = await mkdtemp(path.join(os.tmpdir(), 'compressor-loc-import-'));
    roots.push(support);
    const importDir = path.join(support, 'Imports', 'import-abc123');
    await mkdir(importDir, { recursive: true });
    // Never the real Downloads folder: a test must not leave anything in it.
    vi.stubEnv('AGENT_UPLOADED_OUTPUT_PATH', path.join(support, 'downloads'));
    const { queue, job } = await queueWith('uploaded', importDir);

    await queue.start([job.id]);
    const output = queue.state().jobs[0].outputPath;

    expect(path.dirname(output)).not.toBe(importDir);
    expect(output).not.toContain('Imports');
    expect(path.dirname(output)).toBe(uploadedOutputDir(UPLOADED_VIDEO_OUTPUT_FOLDER));
  });

  it('still honours an explicitly chosen folder for an upload', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'compressor-loc-chosen-'));
    roots.push(root);
    const chosen = path.join(root, 'chosen');
    const importDir = path.join(root, 'Imports', 'import-abc123');
    await mkdir(importDir, { recursive: true });
    vi.stubEnv('AGENT_UPLOADED_OUTPUT_PATH', path.join(root, 'downloads'));
    const inputPath = path.join(importDir, 'clip.mp4');
    await writeFile(inputPath, '');
    const job = makeJob('one', 'ready', { inputPath, sourceKind: 'uploaded' });
    const queue = new JobQueue({ ffmpeg: true, ffprobe: true }, () => {}, [job], {
      ...optimalSettings,
      outputMode: 'chosen-folder',
      outputFolder: chosen
    });

    await queue.start([job.id]);

    // An explicit choice outranks every fallback: it is the one case where the
    // person said where the file goes.
    expect(path.dirname(queue.state().jobs[0].outputPath)).toBe(chosen);
  });
});
