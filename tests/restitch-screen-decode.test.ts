import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { decodeRestitchScreen } from '../apps/agent/src/team-bridge/screen-decode';
import { probeImage } from '../apps/agent/src/ffmpeg/tools';
import { restitchFixturePath } from './fixtures/restitch-images';
import { describeRequiring } from './support/requires';
import { ffmpegBinaries } from './support/toolchain';
import { removeTemporaryDirectory } from './support/temp-dir';
import type { runTool, ToolResult } from '../apps/agent/src/stitcher/run';

describeRequiring(ffmpegBinaries, 'strict restitch screen decode', () => {
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'screen-decode-'));
  });
  afterAll(async () => {
    await removeTemporaryDirectory(directory);
  });
  it.each([
    ['plain.png', 'image/png'],
    ['plain.jpg', 'image/jpeg'],
    ['plain.webp', 'image/webp']
  ] as const)('fully decodes %s using the stitcher media engine', async (file, mime) => {
    expect(
      await decodeRestitchScreen(restitchFixturePath(file), mime, new AbortController().signal)
    ).toBe(true);
  });
  it('rejects a truncated image whose metadata remains readable', async () => {
    const bytes = await readFile(restitchFixturePath('plain.png'));
    const file = path.join(directory, 'truncated.png');
    await writeFile(file, bytes.subarray(0, bytes.length - 8));
    expect(await probeImage(file)).toMatchObject({ width: 64, height: 32 });
    expect(await decodeRestitchScreen(file, 'image/png', new AbortController().signal)).toBe(false);
  });
});
it('stops decoding on its bounded deadline and preserves a resource limit cause', async () => {
  const run: typeof runTool = vi.fn(
    async (_command, _args, options) =>
      new Promise<ToolResult>(resolve => {
        const stop = () =>
          resolve({ code: null, stdout: '', stderr: '', spawnErrorCode: null, cancelled: true });
        if (options?.signal?.aborted) stop();
        else options?.signal?.addEventListener('abort', stop, { once: true });
      })
  );
  await expect(
    decodeRestitchScreen('synthetic.png', 'image/png', new AbortController().signal, {
      run,
      timeoutMs: 5
    })
  ).rejects.toThrow('RESTITCH_SCREEN_SELECTION_LIMIT');
});
it('does not start a decoder for an already cancelled request', async () => {
  const controller = new AbortController();
  controller.abort();
  const run = vi.fn();
  await expect(
    decodeRestitchScreen('synthetic.png', 'image/png', controller.signal, { run })
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(run).not.toHaveBeenCalled();
});
