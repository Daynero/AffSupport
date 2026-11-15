import { chmod, mkdtemp, mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writableUploadedOutputDir } from '../apps/agent/src/files/output-destination.js';
import { describeRequiring, requirePlatform } from './support/requires.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'soty-output-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.stubEnv('AGENT_UPLOADED_OUTPUT_PATH', '');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await chmod(path.join(home, 'Downloads'), 0o755).catch(() => undefined);
  await removeTemporaryDirectory(home);
});

describe('where an uploaded video result goes', () => {
  it('keeps Downloads when it can be written', async () => {
    await expect(writableUploadedOutputDir('Soty')).resolves.toBe(
      path.join(home, 'Downloads', 'Soty')
    );
  });
});

describeRequiring(requirePlatform('darwin'), 'a Downloads folder the app may not write', () => {
  it('falls back to a visible Movies folder instead of failing at the end', async () => {
    await mkdir(path.join(home, 'Downloads'));
    await chmod(path.join(home, 'Downloads'), 0o500);
    const folder = await writableUploadedOutputDir('Soty');
    expect(folder).toBe(path.join(home, 'Movies', 'Soty'));
    expect((await stat(folder)).isDirectory()).toBe(true);
  });
});
