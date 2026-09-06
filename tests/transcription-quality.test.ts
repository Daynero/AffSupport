import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import os from 'node:os';
import path from 'node:path';
import { buildWhisperArgs, defaultWhisperThreads } from '../apps/agent/src/whisper/transcriber.js';
import { memoizePresence, WHISPER_MODELS } from '../apps/agent/src/whisper/tools.js';
import { transcriptPreview } from '../apps/agent/src/queue/transcription-queue.js';
import { loadTranscriptionState } from '../apps/agent/src/queue/transcription-store.js';

describe('quality modes', () => {
  it('runs beam search on both models and loads a different file for each', () => {
    const build = (quality: 'fast' | 'accurate', platform: 'darwin' | 'win32' | 'linux') =>
      buildWhisperArgs(
        { wavPath: 'a.wav', outputBase: 'out', language: 'auto', quality },
        { threads: 4, vadModelPath: null, platform }
      );
    const beams = (args: string[]) => args.slice(args.indexOf('-bs'), args.indexOf('-bs') + 4);
    // On Apple Silicon the turbo decoder makes the search close to free, so both modes
    // search. On a CPU-only machine five beams are five decoder passes, and the fast mode
    // exists for exactly that machine: it decodes greedily and keeps the best-of fallback.
    expect(beams(build('fast', 'darwin'))).toEqual(['-bs', '5', '-bo', '5']);
    expect(beams(build('accurate', 'darwin'))).toEqual(['-bs', '5', '-bo', '5']);
    expect(beams(build('fast', 'win32'))).toEqual(['-bs', '1', '-bo', '5']);
    expect(beams(build('accurate', 'win32'))).toEqual(['-bs', '5', '-bo', '5']);
    expect(beams(build('fast', 'linux'))).toEqual(['-bs', '1', '-bo', '5']);
    // Each mode loads its own model file.
    const fast = build('fast', 'darwin');
    const accurate = build('accurate', 'darwin');
    expect(fast[fast.indexOf('-m') + 1]).toContain(WHISPER_MODELS.fast.fileName);
    expect(accurate[accurate.indexOf('-m') + 1]).toContain(WHISPER_MODELS.accurate.fileName);
  });

  it('describes two verifiable models, the fast one a fraction of the size', () => {
    expect(WHISPER_MODELS.fast.sizeBytes).toBeLessThan(WHISPER_MODELS.accurate.sizeBytes / 4);
    for (const model of Object.values(WHISPER_MODELS)) {
      expect(model.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(model.url).toMatch(/^https:\/\/huggingface\.co\/.+\.bin$/u);
    }
  });

  it('caps whisper threads so hyper-threaded Windows machines are not oversubscribed', () => {
    // Two cores stay free on every machine, so a four-core laptop keeps its interface.
    expect(defaultWhisperThreads(2)).toBe(2);
    expect(defaultWhisperThreads(4)).toBe(2);
    expect(defaultWhisperThreads(6)).toBe(4);
    expect(defaultWhisperThreads(8)).toBe(6);
    expect(defaultWhisperThreads(16)).toBe(8);
    expect(defaultWhisperThreads(32)).toBe(8);
  });
});

describe('memoized presence', () => {
  it('asks the filesystem once per window and again after an invalidation', () => {
    let calls = 0;
    let present = false;
    const check = memoizePresence(() => {
      calls += 1;
      return present;
    }, 60_000);
    expect(check()).toBe(false);
    expect(check()).toBe(false);
    expect(calls).toBe(1);
    present = true;
    expect(check()).toBe(false);
    check.invalidate();
    expect(check()).toBe(true);
    expect(calls).toBe(2);
  });
});

describe('transcript preview', () => {
  it('collapses whitespace and cuts long text at a word', () => {
    expect(transcriptPreview('  One line.\n\nTwo   lines. ')).toBe('One line. Two lines.');
    const long = Array.from({ length: 80 }, (_, index) => `word${index}`).join(' ');
    const preview = transcriptPreview(long);
    expect(preview.endsWith('…')).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(222);
    expect(preview.slice(0, -1).trim().endsWith('word')).toBe(false);
  });
});

describe('restart-safe translation requests', () => {
  it('keeps a translation that was running as queued, so it resumes on boot', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'soty-transcription-store-'));
    const documents = path.join(dir, 'docs');
    process.env.AGENT_TRANSCRIBE_DOCUMENTS_PATH = documents;
    try {
      await writeFile(
        path.join(documents, 'job.json').replace('docs/job.json', 'job-placeholder'),
        ''
      ).catch(() => {});
      const { mkdir } = await import('node:fs/promises');
      await mkdir(documents, { recursive: true });
      await writeFile(path.join(documents, 'job.json'), '{}');
      const file = path.join(dir, 'state.json');
      await writeFile(
        file,
        JSON.stringify({
          settings: { language: 'auto', translationLanguage: 'uk', quality: 'accurate' },
          jobs: [
            {
              id: 'job',
              inputPath: path.join(dir, 'missing.mp4'),
              fileName: 'missing.mp4',
              status: 'completed',
              characters: 40,
              preview: 'The opening words.',
              quality: 'fast',
              translation: {
                targetLanguage: 'de',
                status: 'processing',
                progress: 40,
                completedSegments: 4,
                totalSegments: 10,
                error: null
              },
              createdAt: 1
            }
          ]
        })
      );
      const restored = await loadTranscriptionState(file);
      expect(restored.settings.quality).toBe('accurate');
      expect(restored.jobs).toHaveLength(1);
      expect(restored.jobs[0].quality).toBe('fast');
      expect(restored.jobs[0].preview).toBe('The opening words.');
      expect(restored.jobs[0].translation).toEqual({
        targetLanguage: 'de',
        status: 'queued',
        progress: null,
        completedSegments: 0,
        totalSegments: 10,
        error: null
      });
    } finally {
      delete process.env.AGENT_TRANSCRIBE_DOCUMENTS_PATH;
      await removeTemporaryDirectory(dir);
    }
  });
});
