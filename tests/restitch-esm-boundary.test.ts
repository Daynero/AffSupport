import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

// Edge imports a leaf module first; a bundler's barrel import can hide an ESM
// initialization cycle. Verify the compiled contract in independent runtimes.
it.each(['team/restitch.js', 'types.js', 'team/restitch-selection.js'])(
  'initializes the compiled shared contract from %s in a fresh ESM runtime',
  entry => {
    const url = pathToFileURL(path.resolve('packages/shared/dist', entry)).href;
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const contract = await import(${JSON.stringify(url)}); if (!Object.keys(contract).length) throw new Error('EMPTY_CONTRACT'); process.stdout.write('ready');`
      ],
      { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    expect(output).toBe('ready');
  }
);
