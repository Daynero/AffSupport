import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  ensureSilenceBank,
  silenceBankPath,
  silenceRoot
} from '../apps/agent/src/stitcher/silence.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

const runTool = vi.hoisted(() => vi.fn());
vi.mock('../apps/agent/src/stitcher/run.js', () => ({
  runTool,
  toolSucceeded: (result: { code: number; cancelled: boolean }) =>
    result.code === 0 && !result.cancelled
}));
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'soty-silence-test-'));
  runTool.mockReset();
  runTool.mockImplementation(async (_command: string, args: string[]) => {
    await writeFile(args.at(-1)!, 'aac');
    return { code: 0, cancelled: false, spawnErrorCode: null };
  });
});
afterEach(async () => {
  await removeTemporaryDirectory(root);
});

it.each([
  [1 / 30, 2],
  [6, 60],
  [320, 600],
  [3000, 3660],
  [3600, 3780],
  [0, 3660],
  [undefined, 3660]
])(
  'prepares enough silence for %s seconds without encoding an unnecessary hour',
  async (neededSeconds, seconds) => {
    const options = { root, sampleRate: 48000, channels: 2, neededSeconds };
    const first = await ensureSilenceBank(options);
    expect(first).toEqual({ ok: true, path: silenceBankPath(48000, 2, seconds!, root) });
    const args = runTool.mock.calls[0]![1] as string[];
    expect(args[args.indexOf('-t') + 1]).toBe(String(seconds));
    expect(await ensureSilenceBank(options)).toEqual(first);
    expect(runTool).toHaveBeenCalledTimes(1);
  }
);

it('reuses an existing long bank after an upgrade', async () => {
  await mkdir(silenceRoot(root), { recursive: true });
  const existing = silenceBankPath(48000, 2, 3660, root);
  await writeFile(existing, 'existing-aac');
  expect(
    await ensureSilenceBank({ root, sampleRate: 48000, channels: 2, neededSeconds: 1 / 30 })
  ).toEqual({ ok: true, path: existing });
  expect(runTool).not.toHaveBeenCalled();
});

it('never uses a short bank for a longer screen or another audio shape', async () => {
  await ensureSilenceBank({ root, sampleRate: 48000, channels: 2, neededSeconds: 1 / 30 });
  await ensureSilenceBank({ root, sampleRate: 48000, channels: 2, neededSeconds: 45 });
  await ensureSilenceBank({ root, sampleRate: 44100, channels: 1, neededSeconds: 1 / 30 });
  expect(runTool).toHaveBeenCalledTimes(3);
});

it('does not publish a bank after cancellation', async () => {
  runTool.mockResolvedValue({ code: 0, cancelled: true, spawnErrorCode: null });
  expect(
    await ensureSilenceBank({ root, sampleRate: 48000, channels: 2, neededSeconds: 1 / 30 })
  ).toEqual({ ok: false, error: 'SILENCE_BANK_FAILED' });
  expect(await readdir(silenceRoot(root))).toEqual([]);
});
