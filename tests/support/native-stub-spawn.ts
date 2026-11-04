import { existsSync } from 'node:fs';
import { vi } from 'vitest';

// Windows cannot spawn a fixture .cmd with shell:false. Redirect only existing
// fixture bodies to native Node at the OS boundary: the real governor still
// registers and terminates the child, and no shell is introduced. Light probes
// use the same body without changing their production spawn path.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...[command, args, options]: Parameters<typeof actual.spawn>) => {
      const body = command.replace(/\.cmd$/iu, '.cjs');
      return process.platform === 'win32' && body !== command && existsSync(body)
        ? actual.spawn(process.execPath, [body, ...(args ?? [])], options)
        : actual.spawn(command, args, options);
    }
  };
});
