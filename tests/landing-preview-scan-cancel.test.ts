import { describe, expect, it } from 'vitest';
import { guardedFs } from '../apps/agent/src/landing-preview/scanner.js';

describe('guardedFs — scans can always be cancelled without wedging', () => {
  it('returns the operation result when nothing goes wrong', async () => {
    await expect(guardedFs(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('rejects instantly when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(guardedFs(() => Promise.resolve('ok'), controller.signal)).rejects.toThrow(
      'cancelled'
    );
  });

  it('unblocks a never-resolving fs op the moment cancel is requested', async () => {
    const controller = new AbortController();
    // Simulates a readdir/stat stuck on a removed cloud folder: it never settles.
    const hung = guardedFs<never>(() => new Promise<never>(() => {}), controller.signal);
    const started = Date.now();
    setTimeout(() => controller.abort(new Error('Preview generation cancelled.')), 10);
    await expect(hung).rejects.toThrow('Preview generation cancelled.');
    // It must resolve to the abort promptly, not hang on the pending syscall.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('times out a stuck fs op even without a cancel signal', async () => {
    await expect(
      guardedFs<never>(() => new Promise<never>(() => {}), undefined, 25)
    ).rejects.toThrow(/Timed out reading from disk/);
  });

  it('does not fire the timeout for an operation that completes in time', async () => {
    await expect(
      guardedFs(() => new Promise(resolve => setTimeout(() => resolve('done'), 10)), undefined, 200)
    ).resolves.toBe('done');
  });
});
