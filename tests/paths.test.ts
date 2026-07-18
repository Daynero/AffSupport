import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appearsCompressed, nextOutputPath } from '../apps/agent/src/files/paths.js';

let temp = '';
afterEach(async () => {
  if (temp) await rm(temp, { recursive: true, force: true });
});
describe('safe output paths', () => {
  it('supports spaces and Cyrillic and does not overwrite', async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), 'video paths '));
    const input = path.join(temp, 'Моє відео (тест).mov');
    await writeFile(input, 'source');
    expect(await nextOutputPath(input)).toBe(path.join(temp, 'Моє відео (тест)_compressed.mp4'));
    await writeFile(path.join(temp, 'Моє відео (тест)_compressed.mp4'), 'existing');
    expect(await nextOutputPath(input)).toBe(path.join(temp, 'Моє відео (тест)_compressed_2.mp4'));
  });
  it('detects application-created compressed suffixes', () => {
    expect(appearsCompressed('/tmp/video_compressed.mp4')).toBe(true);
    expect(appearsCompressed('/tmp/video_compressed_3.mp4')).toBe(true);
    expect(appearsCompressed('/tmp/video_embedded_compressed.mp4')).toBe(true);
    expect(appearsCompressed('/tmp/video_embedded_compressed_2.mp4')).toBe(true);
    expect(appearsCompressed('/tmp/video.mp4')).toBe(false);
  });

  it('uses a collision-safe embedded output suffix', async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), 'embedded video paths '));
    const input = path.join(temp, 'відео & test.mov');
    await writeFile(input, 'source');
    expect(await nextOutputPath(input, undefined, [], true)).toBe(
      path.join(temp, 'відео & test_embedded_compressed.mp4')
    );
    await writeFile(path.join(temp, 'відео & test_embedded_compressed.mp4'), 'existing');
    expect(await nextOutputPath(input, undefined, [], true)).toBe(
      path.join(temp, 'відео & test_embedded_compressed_2.mp4')
    );
  });
});
