import { mkdir, mkdtemp, readdir, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TranslationCacheStore } from '../apps/agent/src/transcription/document-store.js';
import { MediaPreviewManager } from '../apps/agent/src/transcription/media-preview.js';
import { sweepAbandonedTempDirectories } from '../apps/agent/src/whisper/transcriber.js';
import { TranscriptionQueue } from '../apps/agent/src/queue/transcription-queue.js';
import { gpuLayers, translationConcurrency } from '../apps/agent/src/translation/translator.js';
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

describe('housekeeping at boot', () => {
  it('drops cached translations of another model version, stale ones, and torn writes', async () => {
    const directory = await scratch('soty-translation-cache-');
    const store = new TranslationCacheStore(directory);
    const entry = (modelVersion: string, cacheKey: string) => ({
      cacheKey,
      targetLanguage: 'uk',
      modelVersion,
      status: 'completed' as const,
      segments: [],
      error: null
    });
    await store.save(entry('gemma-v2', 'current'));
    await store.save(entry('gemma-v1', 'old-model'));
    await store.save(entry('gemma-v2', 'old-entry'));
    await writeFile(path.join(directory, 'torn.json.abc.part'), '{');
    // Aged past the budget: same model, but nobody has asked for it in a long time.
    const [oldEntry] = (await readdir(directory)).filter(
      name => name.endsWith('.json') && name !== path.basename(store['file']('current'))
    );
    void oldEntry;
    const ancient = new Date(Date.now() - 100 * 24 * 60 * 60_000);
    await utimes(store['file']('old-entry'), ancient, ancient);

    const removed = await store.sweep({
      currentModelVersion: 'gemma-v2',
      maxAgeMs: 60 * 24 * 60 * 60_000
    });
    expect(removed).toBe(3);
    expect(await store.load('current')).not.toBeNull();
    expect(await store.load('old-model')).toBeNull();
    expect(await store.load('old-entry')).toBeNull();
    expect((await readdir(directory)).some(name => name.endsWith('.part'))).toBe(false);
  });

  it('removes preview proxies whose job no longer exists, and unfinished ones', async () => {
    const directory = await scratch('soty-previews-');
    const manager = new MediaPreviewManager(directory);
    await writeFile(path.join(directory, 'kept-job-0123456789abcdef.mp4'), 'x');
    await writeFile(path.join(directory, 'gone-job-0123456789abcdef.mp4'), 'x');
    await writeFile(path.join(directory, 'kept-job-fedcba9876543210.mp4.part'), 'x');
    const removed = await manager.sweepOrphans(new Set(['kept-job']));
    expect(removed).toBe(2);
    expect((await readdir(directory)).sort()).toEqual(['kept-job-0123456789abcdef.mp4']);
  });

  it('sweeps abandoned whisper scratch directories, leaving young ones alone', async () => {
    const root = await scratch('soty-tmp-root-');
    const old = path.join(root, 'wishly-transcribe-old');
    const young = path.join(root, 'wishly-transcribe-young');
    const other = path.join(root, 'something-else');
    for (const directory of [old, young, other]) {
      await mkdir(directory);
      await writeFile(path.join(directory, 'audio.wav'), 'x');
    }
    const ancient = new Date(Date.now() - 3 * 60 * 60_000);
    await utimes(old, ancient, ancient);
    const removed = await sweepAbandonedTempDirectories(root, 60 * 60_000);
    expect(removed).toBe(1);
    expect((await readdir(root)).sort()).toEqual(['something-else', 'wishly-transcribe-young']);
  });

  it('removes upload directories no job uses, keeping the ones still pointed at', async () => {
    const directory = await scratch('soty-imports-');
    const imports = path.join(directory, 'TranscribeImports');
    const used = path.join(imports, 'import-used');
    const orphan = path.join(imports, 'import-orphan');
    const foreign = path.join(imports, 'something');
    for (const folder of [used, orphan, foreign]) {
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, 'clip.wav'), Buffer.alloc(64));
    }
    process.env.AGENT_TRANSCRIBE_DOCUMENTS_PATH = path.join(directory, 'docs');
    process.env.AGENT_TRANSLATION_CACHE_PATH = path.join(directory, 'cache');
    process.env.AGENT_TRANSCRIBE_PREVIEWS_PATH = path.join(directory, 'previews');
    try {
      const queue = new TranscriptionQueue({ ffmpeg: false, whisper: false }, () => {});
      expect(await queue.addUploaded(path.join(used, 'clip.wav'), 'clip.wav', 'key')).toEqual([]);
      const removed = await queue.sweepImports(imports);
      expect(removed).toBe(1);
      expect((await readdir(imports)).sort()).toEqual(['import-used', 'something']);
      await queue.shutdown();
    } finally {
      delete process.env.AGENT_TRANSCRIBE_DOCUMENTS_PATH;
      delete process.env.AGENT_TRANSLATION_CACHE_PATH;
      delete process.env.AGENT_TRANSCRIBE_PREVIEWS_PATH;
    }
  });
});

describe('translator runtime sizing', () => {
  it('offloads to the GPU only on Apple Silicon and runs fewer slots on a CPU build', () => {
    expect(gpuLayers('darwin')).toBe(99);
    expect(gpuLayers('win32')).toBe(0);
    expect(translationConcurrency('darwin')).toBe(6);
    expect(translationConcurrency('win32')).toBe(3);
  });
});
