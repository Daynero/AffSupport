import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UPLOAD_BYTES,
  FOLDER_UPLOAD_LIMITS,
  MAX_LANDING_ARCHIVE_BYTES,
  MAX_LANDING_ASSET_BYTES,
  MAX_MEDIA_UPLOAD_BYTES,
  withinPathBounds
} from '../apps/agent/src/server/upload-limits.js';
import { runAttempt } from './support/adversarial.js';
import { NARROW_LIMITS, uploadBudgetSuite } from './support/adversarial/upload-budgets.js';

/**
 * C8 (FR-027). Every upload is bounded — per route, per folder session, and by the plugin
 * default for a route that forgets to say.
 *
 * Before: the multipart plugin ran with a 100 GiB global file size, so every upload route was
 * effectively unbounded, and the landing folder route — called once per file — had no
 * aggregate cap at all: a session could write five hundred thousand files, at any depth, for
 * as long as it liked. The attempts below run against the real server; their table is shared
 * with `tests/adversarial-suite-size.test.ts`, which counts them.
 */

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

describe('the adversarial uploads are all refused', () => {
  it.each(uploadBudgetSuite.attempts.map(attempt => [attempt.name, attempt] as const))(
    '%s',
    async (_name, attempt) => {
      const result = await runAttempt(uploadBudgetSuite, attempt);
      expect(result.refused, result.evidence).toBe(true);
    },
    30_000
  );
});

describe('the legitimate upload still works', () => {
  it('accepts a folder within every budget and finishes it', async () => {
    const target = await uploadBudgetSuite.start();
    try {
      const inputDir = await target.begin();
      for (let index = 0; index < NARROW_LIMITS.maxFiles; index += 1) {
        const response = await target.sendFile(`assets/page-${index}.html`, '<p>ok</p>');
        expect(response.statusCode).toBe(200);
      }
      expect(inputDir).toBeTruthy();
      const finished = await target.post('/api/landing/upload/folder/finish');
      expect(finished.error).not.toBe('UPLOAD_BUDGET_EXCEEDED');
    } finally {
      await target.stop();
    }
  });

  it('accepts a path exactly at the depth bound', async () => {
    const target = await uploadBudgetSuite.start();
    try {
      await target.begin();
      const segments = Array.from({ length: FOLDER_UPLOAD_LIMITS.maxDepth - 1 }, (_, i) => `d${i}`);
      const response = await target.sendFile([...segments, 'f.txt'].join('/'), 'x');
      expect(response.statusCode).toBe(200);
    } finally {
      await target.stop();
    }
  });

  it('starts a fresh budget with every session', async () => {
    const target = await uploadBudgetSuite.start();
    try {
      await target.begin();
      for (let index = 0; index < NARROW_LIMITS.maxFiles; index += 1) {
        await target.sendFile(`a-${index}.txt`, 'x');
      }
      await target.post('/api/landing/upload/folder/finish');
      await target.optimizer.reset();
      await target.begin();
      expect((await target.sendFile('next-session.txt', 'x')).statusCode).toBe(200);
    } finally {
      await target.stop();
    }
  });
});

describe('the stated limits', () => {
  it('match the contract table', () => {
    // contracts/agent-http.md §7.
    expect(DEFAULT_UPLOAD_BYTES).toBe(32 * MiB);
    expect(MAX_MEDIA_UPLOAD_BYTES).toBe(20 * GiB);
    expect(MAX_LANDING_ARCHIVE_BYTES).toBe(512 * MiB);
    expect(MAX_LANDING_ASSET_BYTES).toBe(32 * MiB);
    expect(FOLDER_UPLOAD_LIMITS).toEqual({
      maxFiles: 5_000,
      maxBytes: 2 * GiB,
      maxDurationMs: 10 * 60 * 1000,
      maxDepth: 16,
      maxSegmentLength: 255
    });
  });

  it('bound depth and segment length exactly at the edge', () => {
    const at = Array.from({ length: 16 }, (_, i) => `s${i}`).join('/');
    expect(withinPathBounds(at)).toBe(true);
    expect(withinPathBounds(`${at}/one-more`)).toBe(false);
    expect(withinPathBounds('a'.repeat(255))).toBe(true);
    expect(withinPathBounds('a'.repeat(256))).toBe(false);
  });

  it('give every upload route its own ceiling rather than inheriting one', async () => {
    // Each upload route names its limit where it reads the file. The default is safe now, but
    // a media route that silently fell back to 32 MiB would refuse real footage — the limit is
    // part of the route's contract either way.
    const expected: Record<string, { file: string; constant: RegExp }> = {
      '/api/files/upload': {
        file: 'apps/agent/src/compressor/routes.ts',
        constant: /MAX_MEDIA_UPLOAD_BYTES/
      },
      '/api/transcription/files/upload': {
        file: 'apps/agent/src/transcription/routes.ts',
        constant: /MAX_MEDIA_UPLOAD_BYTES/
      },
      '/api/landing/upload/zip': {
        file: 'apps/agent/src/landing/routes.ts',
        constant: /MAX_LANDING_ARCHIVE_BYTES/
      },
      '/api/landing/upload/folder/file': {
        file: 'apps/agent/src/landing/routes.ts',
        constant: /MAX_LANDING_ASSET_BYTES/
      }
    };
    for (const [route, { file, constant }] of Object.entries(expected)) {
      const source = await readFile(path.resolve(file), 'utf8');
      const start = source.indexOf(`'${route}'`);
      expect(start, `${route} is not registered in ${file}`).toBeGreaterThanOrEqual(0);
      const next = source.indexOf('app.post', start + route.length);
      const handler = source.slice(start, next === -1 ? undefined : next);
      expect(handler, `${route} reads a file without stating its ceiling`).toMatch(
        /request\.file\(/
      );
      expect(handler, `${route} does not use its own ceiling`).toMatch(constant);
    }
  });

  it('keeps the plugin default restrictive', async () => {
    const source = await readFile(path.resolve('apps/agent/src/server/app.ts'), 'utf8');
    const registration = source.slice(source.indexOf('register(fastifyMultipart'));
    expect(registration.slice(0, 600)).toMatch(/fileSize:\s*DEFAULT_UPLOAD_BYTES/);
    expect(registration.slice(0, 600)).toMatch(/files:\s*1\b/);
  });
});
