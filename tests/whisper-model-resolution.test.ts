import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const filesystem = vi.hoisted(() => ({ exists: vi.fn((_file: unknown) => false) }));
vi.mock('node:fs', async importOriginal => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: filesystem.exists
}));
vi.mock('../apps/agent/src/files/support-dir', () => ({
  applicationSupportRoot: () => '/synthetic-soty-support'
}));
import {
  defaultQualityForInstalledModels,
  downloadedModelPath,
  modelPresent,
  whisperVadModelPathOrNull,
  WHISPER_MODELS
} from '../apps/agent/src/whisper/tools';

beforeEach(() => {
  filesystem.exists.mockReset().mockReturnValue(false);
  vi.stubEnv('WHISPER_MODEL_PATH', undefined);
  vi.stubEnv('WHISPER_VAD_MODEL_PATH', undefined);
});
afterEach(() => vi.unstubAllEnvs());

it('prefers the writable VAD model over the bundled copy', () => {
  const writable = path.join(path.dirname(downloadedModelPath()), 'ggml-silero-v5.1.2.bin');
  filesystem.exists.mockReturnValue(true);
  expect(whisperVadModelPathOrNull()).toBe(writable);
  expect(filesystem.exists).toHaveBeenCalledTimes(1);
});

it('falls back to bundled VAD and explicitly reports absence when neither file exists', () => {
  filesystem.exists.mockImplementation(file => String(file).includes('/runtime/models/'));
  expect(whisperVadModelPathOrNull()).toMatch(/runtime[/\\]models[/\\]ggml-silero-v5\.1\.2\.bin$/);
  filesystem.exists.mockReturnValue(false);
  expect(whisperVadModelPathOrNull()).toBeNull();
});

it('honors an explicit VAD override without silently substituting another file', () => {
  vi.stubEnv('WHISPER_VAD_MODEL_PATH', '/synthetic-explicit-vad.bin');
  filesystem.exists.mockReturnValue(true);
  expect(whisperVadModelPathOrNull()).toBe('/synthetic-explicit-vad.bin');
  filesystem.exists.mockReturnValue(false);
  expect(whisperVadModelPathOrNull()).toBeNull();
  expect(
    filesystem.exists.mock.calls.every(([file]) => file === '/synthetic-explicit-vad.bin')
  ).toBe(true);
});

it('keeps an existing full-model installation usable and defaults new installations to fast', () => {
  filesystem.exists.mockImplementation(file =>
    String(file).endsWith(WHISPER_MODELS.accurate.fileName)
  );
  expect(defaultQualityForInstalledModels()).toBe('accurate');
  filesystem.exists.mockReturnValue(true);
  expect(defaultQualityForInstalledModels()).toBe('fast');
  filesystem.exists.mockReturnValue(false);
  expect(defaultQualityForInstalledModels()).toBe('fast');
  expect(modelPresent()).toBe(false);
});
