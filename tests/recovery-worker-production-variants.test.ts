import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { RecoveryJournal } from '../apps/agent/src/team-bridge/recovery-journal';
import { TeamRecoveryWorker } from '../apps/agent/src/team-bridge/recovery-worker';
import { removeTemporaryDirectory } from './support/temp-dir';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await removeTemporaryDirectory(root);
});

async function options(environment: 'production' | 'beta', nativeInstanceId: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-variants-'));
  roots.push(root);
  return {
    environment,
    currentActorId: () => null,
    journal: new RecoveryJournal(path.join(root, 'journal')),
    process: {
      process: async () => {
        throw new Error('unused');
      },
      cancel: () => false,
      busy: () => false
    },
    secrets: {
      read: async () => null,
      write: async () => {},
      delete: async () => {}
    },
    fetch: (async () => {
      throw new Error('unused');
    }) as unknown as typeof fetch,
    catalogVariants: { nativeInstanceId, enabled: () => true }
  };
}

/**
 * 1.4.1 shipped catalog video variants to production, and the Windows smoke
 * found the agent refusing to start: this constructor still demanded a beta
 * environment whenever variants were attached. The native instance identity
 * is what the claims are bound to, and it is the only thing left to refuse.
 */
it('carries catalog variant recovery in production as well as beta', async () => {
  const id = 'b1860000-0000-4000-8000-000000000001';
  const production = await options('production', id);
  const beta = await options('beta', id);
  const unbound = await options('production', 'not-an-instance-id');
  expect(() => new TeamRecoveryWorker(production)).not.toThrow();
  expect(() => new TeamRecoveryWorker(beta)).not.toThrow();
  expect(() => new TeamRecoveryWorker(unbound)).toThrow('INVALID_INPUT');
});
