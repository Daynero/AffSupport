import { existsSync } from 'node:fs';
import { vi } from 'vitest';

// Windows cannot spawn the fixture's .cmd shim with shell:false. Invoke its
// Node body directly while retaining the real governor registration and cleanup.
vi.mock('../../apps/agent/src/power/spawn.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../apps/agent/src/power/spawn.js')>();
  return {
    ...actual,
    spawnTracked: (...[command, args, options]: Parameters<typeof actual.spawnTracked>) => {
      const body = command.replace(/\.cmd$/iu, '.cjs');
      return process.platform === 'win32' && body !== command && existsSync(body)
        ? actual.spawnTracked(process.execPath, [body, ...args], options)
        : actual.spawnTracked(command, args, options);
    }
  };
});
