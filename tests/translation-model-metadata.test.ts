import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALIGNMENT_MODEL_DESCRIPTOR,
  TRANSLATION_MODEL_DESCRIPTOR,
  TRANSLATION_RUNTIME_DESCRIPTOR,
  alignmentModelPath,
  finalizeTranslationModelArtifact,
  translationModelPath,
  translationRuntimePath
} from '../apps/agent/src/translation/tools.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

describe('pinned local translation artifacts', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wishly-translation-model-'));
  });

  afterEach(async () => {
    delete process.env.TRANSLATION_RUNTIME_PATH;
    delete process.env.TRANSLATION_MODEL_PATH;
    delete process.env.ALIGNMENT_MODEL_PATH;
    await removeTemporaryDirectory(dir);
  });

  it('pins immutable revisions, exact sizes, and exact SHA-256 values', () => {
    expect(TRANSLATION_MODEL_DESCRIPTOR).toMatchObject({
      baseRevision: '10042cb0e6e7fdce748996a71dc3dc432a4e0c89',
      artifactRevision: '74307c4cbd921b1f524ec90113e3c4cf0466e98c',
      sizeBytes: 2_489_909_120,
      sha256: '8040937f77f3c0612461d833cdf7696282444c7aded00250b3924be9652f2055'
    });
    expect(TRANSLATION_MODEL_DESCRIPTOR.url).toContain(
      `/${TRANSLATION_MODEL_DESCRIPTOR.artifactRevision}/`
    );
    expect(TRANSLATION_RUNTIME_DESCRIPTOR).toMatchObject({
      tag: 'b10092',
      revision: '3ce7da2c852c538c4c5f9806da27029cf8c9cc4a',
      sizeBytes: 10_612_780,
      sha256: 'f3ec2351e06322478e3f38f23f5339cd834cca5e3740f334ce2bdc5de95f90e0'
    });
    expect(ALIGNMENT_MODEL_DESCRIPTOR).toMatchObject({
      artifactRevision: '3251974431b4ec1b9f6b0335edebedc505ec36d8',
      sizeBytes: 124_350_304,
      sha256: '6661b6e1ccb06e3044e2cd7aa25ca0b837ef7224a2cb5aff3a9e6807c60d01f1'
    });
  });

  it('rejects a non-GGUF translator and writes the required notice beside a valid one', async () => {
    const invalid = path.join(dir, 'invalid.gguf');
    await writeFile(invalid, 'nope');
    await expect(finalizeTranslationModelArtifact(invalid)).rejects.toThrow('not a GGUF');

    const valid = path.join(dir, TRANSLATION_MODEL_DESCRIPTOR.fileName);
    await writeFile(valid, Buffer.from('GGUFfixture'));
    await finalizeTranslationModelArtifact(valid);
    const notice = await readFile(path.join(dir, 'NOTICE-Gemma.txt'), 'utf8');
    expect(notice).toContain('Gemma Terms of Use');
    expect(notice).toContain(TRANSLATION_MODEL_DESCRIPTOR.baseRevision);
    expect(notice).toContain('not an official Google GGUF');
  });

  it('honors all three development path overrides without system dependencies', () => {
    process.env.TRANSLATION_RUNTIME_PATH = path.join(dir, 'llama-server');
    process.env.TRANSLATION_MODEL_PATH = path.join(dir, 'translate.gguf');
    process.env.ALIGNMENT_MODEL_PATH = path.join(dir, 'align.gguf');
    expect(translationRuntimePath()).toBe(process.env.TRANSLATION_RUNTIME_PATH);
    expect(translationModelPath()).toBe(process.env.TRANSLATION_MODEL_PATH);
    expect(alignmentModelPath()).toBe(process.env.ALIGNMENT_MODEL_PATH);
  });
});
