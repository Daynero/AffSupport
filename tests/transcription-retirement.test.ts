import { describe, expect, it } from 'vitest';
import { AGENT_API_VERSION, defaultTranscriptionSettings } from '@video-compressor/shared';
import { validDocument } from '../apps/agent/src/transcription/document-store.js';
import { versionState } from '../apps/web/src/connection';
import { originalDocumentFixture, retiredPayloads } from './support/translation-retirement';
import Fastify from 'fastify';
import { registerTranscriptionRoutes } from '../apps/agent/src/transcription/routes';
import { EventChannel } from '../apps/agent/src/server/sse';
import type { TranscriptionQueue } from '../apps/agent/src/queue/transcription-queue';

describe('original-only transcription upgrade', () => {
  it.each(retiredPayloads)('retains valid original despite legacy payload %j', payload => {
    const original = originalDocumentFixture();
    expect(
      validDocument({ ...original, translations: payload, translationSource: payload })
    ).toEqual(original);
  });
  it('still rejects damaged original timing and text', () => {
    const original = originalDocumentFixture();
    expect(
      validDocument({ ...original, segments: [{ ...original.segments[0], endMs: -1 }] })
    ).toBeNull();
  });
  it('uses only original speech settings', () => {
    expect(defaultTranscriptionSettings()).toEqual({ language: 'auto', quality: 'fast' });
  });
  it('rejects API5 before tool use and exposes API6', () => {
    expect(AGENT_API_VERSION).toBe(6);
    expect(versionState(5)).toBe('agent_update_required');
    expect(versionState(6)).toBe('connected');
  });
});

it('keeps legacy routes behind authentication and refuses mixed settings without queue work', async () => {
  const app = Fastify();
  let calls = 0;
  const queue = new Proxy(
    {},
    {
      get: () => () => {
        calls++;
        throw new Error('UNEXPECTED_QUEUE_WORK');
      }
    }
  );
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.authorization !== 'Bearer synthetic')
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
  });
  registerTranscriptionRoutes(app, {
    queue: queue as TranscriptionQueue,
    events: new EventChannel(new Set(), () => {
      throw new Error('NO_EVENTS');
    }),
    acceptingNewTasks: () => true
  });
  try {
    const paths = [
      ['POST', '/api/transcription/translator/download'],
      ['POST', '/api/transcription/translator/cancel'],
      ['POST', '/api/transcription/jobs/opaque/save-with-translation'],
      ['POST', '/api/transcription/jobs/opaque/translations'],
      ['GET', '/api/transcription/jobs/opaque/translations/uk'],
      ['DELETE', '/api/transcription/jobs/opaque/translations']
    ] as const;
    for (const [method, url] of paths) {
      expect((await app.inject({ method, url })).statusCode).toBe(401);
      const refused = await app.inject({
        method,
        url,
        headers: { authorization: 'Bearer synthetic' }
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toEqual({ error: 'FEATURE_RETIRED' });
    }
    const patch = await app.inject({
      method: 'POST',
      url: '/api/transcription/settings',
      headers: { authorization: 'Bearer synthetic' },
      payload: { language: 'uk', quality: 'accurate', translationLanguage: 'en' }
    });
    expect(patch.statusCode).toBe(409);
    expect(calls).toBe(0);
  } finally {
    await app.close();
  }
});

it('leaves old downloaded and partial artifacts inert and untouched', async () => {
  const { mkdtemp, mkdir, writeFile, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { vi } = await import('vitest');
  const { removeTemporaryDirectory } = await import('./support/temp-dir');
  const { TranscriptionQueue } = await import('../apps/agent/src/queue/transcription-queue');
  const root = await mkdtemp(path.join(tmpdir(), 'soty-retired-artifacts-'));
  vi.stubEnv('AGENT_TRANSCRIBE_DOCUMENTS_PATH', path.join(root, 'documents'));
  vi.stubEnv('AGENT_TRANSCRIBE_PREVIEWS_PATH', path.join(root, 'previews'));
  vi.stubEnv('AGENT_TRANSLATION_CACHE_PATH', path.join(root, 'old-cache'));
  let queue: InstanceType<typeof TranscriptionQueue> | undefined;
  try {
    await mkdir(path.join(root, 'old-cache'));
    const artifacts = ['old-cache/result.json', 'old-model.gguf', 'old-model.gguf.part'];
    for (const name of artifacts)
      await writeFile(path.join(root, name), 'synthetic retained artifact');
    queue = new TranscriptionQueue({ ffmpeg: false, whisper: false }, () => {});
    await queue.sweepCaches();
    expect(queue.workActive()).toBe(false);
    expect(queue.state()).not.toHaveProperty('translatorModel');
    expect(queue.state().settings).not.toHaveProperty('translationLanguage');
    for (const name of artifacts)
      expect(await readFile(path.join(root, name), 'utf8')).toBe('synthetic retained artifact');
  } finally {
    await queue?.shutdown();
    vi.unstubAllEnvs();
    await removeTemporaryDirectory(root);
  }
});

it('discards a damaged historical pivot warning without discarding valid source reliability', () => {
  const original = originalDocumentFixture();
  const reliability = {
    windows: 1,
    retries: 0,
    recoveredWindows: 0,
    timedWords: 0,
    totalWords: 1,
    warnings: [{ code: 'PIVOT_UNAVAILABLE', startMs: -5, endMs: 'damaged' }]
  };
  expect(validDocument({ ...original, reliability })).toEqual({
    ...original,
    reliability: { ...reliability, warnings: [] }
  });
});
