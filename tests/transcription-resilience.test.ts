import type { PathLike } from 'node:fs';
import { access, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { replaceFile } from '../apps/agent/src/files/replace-file.js';
import { TranscriptionQueue } from '../apps/agent/src/queue/transcription-queue.js';
import { saveWithTranslation } from '../apps/agent/src/transcription/export.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await removeTemporaryDirectory(directory);
});

async function scratch(prefix: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('replacing a file', () => {
  it('rides out the momentary holds Windows answers with, and gives up after the budget', async () => {
    const delays: number[] = [];
    const delay = (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    };
    const rename = vi
      .fn<(from: PathLike, to: PathLike) => Promise<void>>()
      .mockRejectedValueOnce(errno('EPERM'))
      .mockRejectedValueOnce(errno('EBUSY'))
      .mockResolvedValue(undefined);
    await replaceFile('a', 'b', { platform: 'win32', renameImpl: rename, delay });
    expect(rename).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([50, 100]);

    const stuck = vi.fn().mockRejectedValue(errno('EPERM'));
    await expect(
      replaceFile('a', 'b', { platform: 'win32', renameImpl: stuck, delay })
    ).rejects.toMatchObject({ code: 'EPERM' });
    expect(stuck).toHaveBeenCalledTimes(6);
  });

  it('does not retry where the codes mean what they say', async () => {
    const rename = vi.fn().mockRejectedValue(errno('EPERM'));
    await expect(
      replaceFile('a', 'b', {
        platform: 'darwin',
        renameImpl: rename,
        delay: () => Promise.resolve()
      })
    ).rejects.toMatchObject({ code: 'EPERM' });
    expect(rename).toHaveBeenCalledTimes(1);
    const missing = vi.fn().mockRejectedValue(errno('ENOENT'));
    await expect(
      replaceFile('a', 'b', {
        platform: 'win32',
        renameImpl: missing,
        delay: () => Promise.resolve()
      })
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(missing).toHaveBeenCalledTimes(1);
  });
});

describe('saving beside the source', () => {
  it('leaves nothing behind when the media cannot be moved', async () => {
    const directory = await scratch('soty-export-');
    const source = path.join(directory, 'gone.mp4');
    await expect(
      saveWithTranslation({
        sourcePath: source,
        languageLabel: 'English',
        transcriptText: 'Hello.',
        translationText: 'Привіт.',
        transcriptFileName: 'Transcript.txt'
      })
    ).rejects.toMatchObject({ code: 'ENOENT' });
    // The folder was claimed and the transcript written before the move failed; both go.
    expect(await readdir(directory)).toEqual([]);
  });

  it('moves the media only after the transcript is on disk', async () => {
    const directory = await scratch('soty-export-');
    const source = path.join(directory, 'clip.mp4');
    await writeFile(source, Buffer.alloc(16));
    const result = await saveWithTranslation({
      sourcePath: source,
      languageLabel: 'English',
      transcriptText: 'Hello.',
      translationText: 'Привіт.',
      transcriptFileName: 'Transcript.txt'
    });
    await access(result.movedMediaPath);
    await access(path.join(result.folderPath, 'Transcript.txt'));
    await expect(access(source)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('a queued job whose model is gone', () => {
  it('fails with a reason instead of holding the queue and the translations forever', async () => {
    const directory = await scratch('soty-queue-');
    process.env.AGENT_TRANSCRIBE_DOCUMENTS_PATH = path.join(directory, 'docs');
    process.env.AGENT_TRANSLATION_CACHE_PATH = path.join(directory, 'cache');
    process.env.AGENT_TRANSCRIBE_PREVIEWS_PATH = path.join(directory, 'previews');
    process.env.WHISPER_MODEL_PATH = path.join(directory, 'no-such-model.bin');
    try {
      const media = path.join(directory, 'clip.wav');
      await writeFile(media, Buffer.alloc(64));
      const events: string[] = [];
      // The engine is present; the model the run needs is not, and is not arriving.
      const queue = new TranscriptionQueue({ ffmpeg: true, whisper: true }, event => {
        if (event) events.push(event);
      });
      expect(await queue.add([media])).toEqual([]);
      const [job] = queue.state().jobs;
      expect(await queue.start([job.id], 'accurate')).toBe(true);
      await vi.waitFor(() => expect(queue.state().jobs[0].status).toBe('failed'), {
        timeout: 2000
      });
      const failed = queue.state().jobs[0];
      // Details stay on the agent; the sentence is what the row translates.
      expect(failed.error).toBe('The speech model for this run is not installed.');
      expect(failed.finishedAt).not.toBeNull();
      expect(queue.state().running).toBe(false);
      await queue.shutdown();
    } finally {
      delete process.env.AGENT_TRANSCRIBE_DOCUMENTS_PATH;
      delete process.env.AGENT_TRANSLATION_CACHE_PATH;
      delete process.env.AGENT_TRANSCRIBE_PREVIEWS_PATH;
      delete process.env.WHISPER_MODEL_PATH;
    }
  });
});

describe('retrying a run', () => {
  it('keeps the quality the run had, whatever the setting says now', async () => {
    const directory = await scratch('soty-retry-');
    process.env.AGENT_TRANSCRIBE_DOCUMENTS_PATH = path.join(directory, 'docs');
    process.env.AGENT_TRANSLATION_CACHE_PATH = path.join(directory, 'cache');
    process.env.AGENT_TRANSCRIBE_PREVIEWS_PATH = path.join(directory, 'previews');
    try {
      const media = path.join(directory, 'clip.wav');
      await writeFile(media, Buffer.alloc(64));
      // Without the engine the queue never runs, so the job can be queued, stopped, retried.
      const queue = new TranscriptionQueue({ ffmpeg: false, whisper: false }, () => {});
      expect(await queue.add([media])).toEqual([]);
      const [job] = queue.state().jobs;
      expect(await queue.start([job.id], 'accurate')).toBe(true);
      await queue.cancel(job.id);
      expect(queue.state().jobs[0].status).toBe('cancelled');
      queue.updateSettings({ quality: 'fast' });
      expect(await queue.retry(job.id)).toBe(true);
      expect(queue.state().jobs[0].quality).toBe('accurate');
      // Named explicitly, the retry takes the name.
      await queue.cancel(job.id);
      expect(await queue.retry(job.id, 'fast')).toBe(true);
      expect(queue.state().jobs[0].quality).toBe('fast');
      await queue.shutdown();
    } finally {
      delete process.env.AGENT_TRANSCRIBE_DOCUMENTS_PATH;
      delete process.env.AGENT_TRANSLATION_CACHE_PATH;
      delete process.env.AGENT_TRANSCRIBE_PREVIEWS_PATH;
    }
  });
});
