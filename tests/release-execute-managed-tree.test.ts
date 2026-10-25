import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { waitFor } from './support/wait.js';
import { execute } from '../scripts/lib/release/execute.mjs';

const cwd = fileURLToPath(new URL('..', import.meta.url));

// The release host is POSIX. Windows uses the untouched legacy execution path;
// this opt-in refuses rather than pretending to supervise an unsupported group.
describe.skipIf(process.platform === 'win32')(
  '[needs: POSIX release host] managed release gate process groups',
  () => {
    it('awaits the spawn receipt and confirms cleanup for a successful owned process', async () => {
      const initialListeners = process.listenerCount('SIGTERM');
      let observed: number | null = null;
      let receiptCompleted = false;
      let releaseReceipt!: () => void;
      const receipt = new Promise<void>(resolve => {
        releaseReceipt = resolve;
      });
      let settled = false;
      const execution = execute([process.execPath, '-e', 'console.log("completed")'], {
        cwd,
        timeoutMs: 5000,
        managedTree: true,
        async onSpawn(identity) {
          observed = identity.processGroupId;
          await receipt;
          receiptCompleted = true;
        }
      }).then(result => {
        settled = true;
        return result;
      });
      try {
        await waitFor(
          () => {
            if (!observed) return false;
            try {
              process.kill(observed, 0);
              return false;
            } catch (error) {
              return error instanceof Error && 'code' in error && error.code === 'ESRCH';
            }
          },
          { describe: 'owned child exits while its spawn receipt is still pending' }
        );
        expect(settled).toBe(false);
      } finally {
        releaseReceipt();
      }
      const result = await execution;
      expect(result.ok).toBe(true);
      expect(result).toMatchObject({ cleanupConfirmed: true, timedOut: false, code: 0 });
      expect(observed).toBeGreaterThan(1);
      expect(receiptCompleted).toBe(true);
      expect(result.output.join('')).toContain('completed');
      expect(process.listenerCount('SIGTERM')).toBe(initialListeners);
    });

    it('escalates a timeout for a child that ignores TERM and closes its inherited pipes', async () => {
      const started = Date.now();
      const result = await execute(
        [
          process.execPath,
          '-e',
          'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 15000)'
        ],
        { cwd, timeoutMs: 300, managedTree: true }
      );
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ timedOut: true, cleanupConfirmed: true });
      expect(Date.now() - started).toBeLessThan(7000);
    }, 10000);

    it('does not wait indefinitely for descendants after a nonzero leader exit', async () => {
      const started = Date.now();
      const descendant =
        'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 15000)';
      const leader =
        `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'inherit'});` +
        'setTimeout(() => process.exit(7), 200);';
      const result = await execute([process.execPath, '-e', leader], {
        cwd,
        managedTree: true,
        timeoutMs: 5000
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe(7);
      expect(Date.now() - started).toBeLessThan(7500);
      // A container init may retain an orphaned zombie group. That is honestly
      // unconfirmed cleanup, never a successful gate or a reason to kill by name.
      expect('cleanupConfirmed' in result && typeof result.cleanupConfirmed).toBe('boolean');
    }, 10000);

    it('fails closed and stops its group when persisting the spawn receipt fails', async () => {
      const result = await execute(
        [
          process.execPath,
          '-e',
          'setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 15000)'
        ],
        {
          cwd,
          managedTree: true,
          timeoutMs: 5000,
          onSpawn() {
            throw new Error('receipt write failed');
          }
        }
      );
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ error: 'EXECUTION_SPAWN_OBSERVATION_FAILED' });
    }, 10000);

    it('cleans only its private group when the owning executor receives TERM', async () => {
      const module = new URL('../scripts/lib/release/execute.mjs', import.meta.url).href;
      const command = `
      import { execute } from ${JSON.stringify(module)};
      const result = await execute([process.execPath, '-e', 'setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 15000)'], {
        cwd: ${JSON.stringify(cwd)}, managedTree: true, timeoutMs: 5000,
        onSpawn: () => process.stdout.write('READY\\n')
      });
      process.stdout.write(JSON.stringify(result) + '\\n');
    `;
      const child = spawn(process.execPath, ['--input-type=module', '-e', command], {
        cwd: path.resolve(cwd),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false
      });
      let output = '';
      let stderr = '';
      let signalled = false;
      const finished = new Promise<number | null>((resolve, reject) => {
        child.stdout.on('data', chunk => {
          output += chunk.toString();
          if (!signalled && output.includes('READY\n')) {
            signalled = true;
            // This is our direct child, never the Vitest host or a discovered PID.
            child.kill('SIGTERM');
          }
        });
        child.stderr.on('data', chunk => {
          stderr += chunk.toString();
        });
        child.once('error', reject);
        child.once('close', resolve);
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 9000);
      try {
        expect(await finished, stderr).toBe(0);
        const result = JSON.parse(output.trim().split('\n').at(-1) ?? '{}');
        expect(result).toMatchObject({ ok: false, interrupted: 'SIGTERM', cleanupConfirmed: true });
      } finally {
        clearTimeout(timer);
      }
    }, 12000);
  }
);
