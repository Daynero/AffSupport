import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TranscriptionDocument, TranscriptionJob } from '@video-compressor/shared';
import { TranscriptionDocumentStore } from '../apps/agent/src/transcription/document-store.js';
import { TranscriptionQueue } from '../apps/agent/src/queue/transcription-queue.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

describe('original media and legacy transcript compatibility', () => {
  let dir: string;
  let queue: TranscriptionQueue;
  let jobId: string;
  let mediaPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wishly-tr-'));
    process.env.AGENT_TRANSCRIBE_DOCUMENTS_PATH = path.join(dir, 'docs');
    process.env.AGENT_TRANSCRIBE_PREVIEWS_PATH = path.join(dir, 'previews');
    mediaPath = path.join(dir, 'sample.mp3');
    await writeFile(mediaPath, 'x');
    queue = new TranscriptionQueue({ ffmpeg: true, whisper: true }, () => {});
    await queue.add([mediaPath]);
    jobId = queue.state().jobs[0].id;
    const document: TranscriptionDocument = {
      jobId,
      sourceLanguage: 'en',
      modelVersion: 'large-v3',
      segments: [{ id: `${jobId}-s0`, startMs: 0, endMs: 0, sourceText: 'Hello world.', words: [] }]
    };
    await new TranscriptionDocumentStore(path.join(dir, 'docs')).save(document);
  });
  afterEach(async () => {
    await queue.shutdown();
    delete process.env.AGENT_TRANSCRIBE_DOCUMENTS_PATH;
    delete process.env.AGENT_TRANSCRIBE_PREVIEWS_PATH;
    await removeTemporaryDirectory(dir);
  });

  it('never resolves media or preview controls for an unknown opaque job id', async () => {
    expect(queue.sourcePath(jobId)).toBe(mediaPath);
    expect(queue.sourcePath('nope')).toBeNull();
    expect(await queue.mediaSource('nope')).toBeNull();
    expect(await queue.playbackMediaSource('nope')).toBeNull();
    expect(await queue.mediaPreviewStatus('nope')).toBeNull();
    expect(await queue.prepareMediaPreview('nope')).toBeNull();
    expect(queue.cancelMediaPreview('nope')).toBe(false);
  });

  it('migrates an old plain-text transcript on demand without putting text in SSE state', async () => {
    const internal = queue as unknown as { jobs: TranscriptionJob[] };
    await new TranscriptionDocumentStore(path.join(dir, 'docs')).remove(jobId);
    Object.assign(internal.jobs[0], {
      status: 'completed',
      text: 'Legacy transcript.',
      detectedLanguage: 'en',
      characters: 18
    });

    expect(queue.state().jobs[0].text).toBeNull();
    const migrated = await queue.document(jobId);
    expect(migrated?.segments.map(segment => segment.sourceText)).toEqual(['Legacy transcript.']);
  });
});
