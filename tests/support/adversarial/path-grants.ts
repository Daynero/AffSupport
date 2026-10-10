import { mkdir, mkdtemp, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PathGrantLedger } from '../../../apps/agent/src/files/path-grants.js';
import { outcome, type AdversarialSuite } from '../adversarial.js';
import { removeTemporaryDirectory } from '../temp-dir.js';

/**
 * C3. The path ledger's adversarial set, against a real filesystem, enforcing.
 *
 * `tests/path-grants.test.ts` explains each case at length; this is the same set as a table,
 * so SC-008's count includes it. Every attempt is made with the ledger *enforcing* — observe
 * mode would allow them by design, and an attempt that is only counted is not refused.
 */

export interface GrantWorkspace {
  root: string;
  ledger: PathGrantLedger;
}

async function startWorkspace(): Promise<GrantWorkspace & { stop(): Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soty-adversarial-grants-'));
  const ledger = new PathGrantLedger();
  ledger.setEnforcing(true);
  return { root, ledger, stop: () => removeTemporaryDirectory(root) };
}

function refusedRead(ledger: PathGrantLedger, target: string, access: 'read' | 'write' = 'read') {
  const allowed = ledger.check(target, access);
  return outcome(!allowed, allowed ? `${access} allowed` : `${access} refused`);
}

const OUTER_BOUND: readonly [string, string][] = [
  ['an ssh directory', path.join(os.homedir(), '.ssh')],
  ['a keychain directory', path.join(os.homedir(), 'Library', 'Keychains')],
  ['a system directory', process.platform === 'win32' ? 'C:\\Windows' : '/etc']
];

export const pathGrantSuite: AdversarialSuite<GrantWorkspace> = {
  testFile: 'tests/path-grants.test.ts',
  start: startWorkspace,
  attempts: [
    {
      name: 'a file never granted',
      async attempt({ root, ledger }) {
        const file = path.join(root, 'never-chosen.mov');
        await writeFile(file, 'video');
        return refusedRead(ledger, file);
      }
    },
    {
      name: "a granted file's neighbour",
      async attempt({ root, ledger }) {
        const granted = path.join(root, 'clip.mov');
        const neighbour = path.join(root, 'private.mov');
        await writeFile(granted, 'video');
        await writeFile(neighbour, 'secret');
        ledger.mint(granted);
        return refusedRead(ledger, neighbour);
      }
    },
    {
      name: 'traversal out of a granted directory',
      async attempt({ root, ledger }) {
        const inside = path.join(root, 'inside');
        await mkdir(inside);
        await writeFile(path.join(root, 'outside.txt'), 'not yours');
        ledger.mint(inside);
        return refusedRead(ledger, path.join(inside, '..', 'outside.txt'));
      }
    },
    {
      name: 'a write through a read grant',
      async attempt({ root, ledger }) {
        const file = path.join(root, 'clip.mov');
        await writeFile(file, 'video');
        ledger.mint(file, { access: 'read' });
        return refusedRead(ledger, file, 'write');
      }
    },
    {
      name: 'a file swapped for a symlink after it was approved',
      async attempt({ root, ledger }) {
        const approved = path.join(root, 'approved.mov');
        const secret = path.join(root, 'secret.txt');
        await writeFile(approved, 'video');
        await writeFile(secret, 'credentials');
        ledger.mint(approved);
        await unlink(approved);
        await symlink(secret, approved);
        return refusedRead(ledger, approved);
      }
    },
    {
      name: 'a granted path that no longer exists',
      async attempt({ root, ledger }) {
        const file = path.join(root, 'clip.mov');
        await writeFile(file, 'video');
        ledger.mint(file);
        await unlink(file);
        return refusedRead(ledger, file);
      }
    },
    ...OUTER_BOUND.map(([why, target]) => ({
      name: `a grant minted for ${why}`,
      async attempt({ ledger }: GrantWorkspace) {
        const minted = ledger.mint(target);
        const allowed = ledger.check(target, 'read');
        return outcome(minted === null && !allowed, `minted ${minted !== null}, read ${allowed}`);
      }
    }))
  ]
};
