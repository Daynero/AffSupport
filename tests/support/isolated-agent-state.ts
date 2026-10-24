import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestProject } from 'vitest/node';

/** Config env is installed before test imports and survives vi.unstubAllEnvs(). */
export default function setup(project: TestProject) {
  const name = project.config.env.AGENT_SUPPORT_DIRECTORY_NAME;
  if (typeof name !== 'string' || !/^Soty Verification-[a-f0-9-]{36}-(unit|e2e)$/u.test(name)) {
    throw new Error('Refusing to run tests without an isolated agent profile');
  }
  // Mirror native support roots without importing agent modules into the runner.
  const base =
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : process.platform === 'win32'
        ? process.env.APPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Roaming')
        : path.join(os.homedir(), '.local', 'share');
  const directory = path.join(base, name);
  return async () => {
    // Only this invocation's exact UUID directory can be removed.
    await rm(directory, { recursive: true, force: true });
  };
}
