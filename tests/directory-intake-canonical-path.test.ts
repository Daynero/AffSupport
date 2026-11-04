import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { removeTemporaryDirectory } from './support/temp-dir.js';

const spelling = vi.hoisted(() => ({ escape: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    realpath: async (file: Parameters<typeof actual.realpath>[0]) => {
      const resolved = await actual.realpath(file);
      const returned = spelling.escape
        ? resolved.replace(
            `${path.sep}Project${path.sep}Child`,
            `${path.sep}ProjectSibling${path.sep}Child`
          )
        : resolved;
      return returned.toUpperCase();
    }
  };
});
vi.mock('../apps/agent/src/platform/platform.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../apps/agent/src/platform/platform.js')>()),
  currentPlatform: () => 'win32'
}));

import { DirectoryIntake } from '../apps/agent/src/files/directory-intake.js';
import { PathGrantLedger } from '../apps/agent/src/files/path-grants.js';

let root = '';
let intake: DirectoryIntake | undefined;
afterEach(async () => {
  intake?.shutdown();
  spelling.escape = false;
  if (root) await removeTemporaryDirectory(root);
});

async function fixture() {
  root = await mkdtemp(path.join(os.tmpdir(), 'soty-canonical-intake-'));
  const picked = path.join(root, 'Project');
  await mkdir(path.join(picked, 'Child'), { recursive: true });
  await writeFile(path.join(picked, 'Child', 'clip.txt'), 'bounded');
  intake = new DirectoryIntake(async () => picked, new PathGrantLedger());
  return intake;
}

it('accepts Windows canonical path casing without extending the chosen grant', async () => {
  const selection = await fixture();
  const result = await selection.select();
  if (result.kind !== 'selected') throw new Error('selection failed');
  expect(
    await selection.read({
      grantId: result.grantId,
      relativePath: 'Project/Child/clip.txt',
      offset: 1,
      length: 3
    })
  ).toEqual(Buffer.from('oun'));
});

it('still rejects a canonical sibling whose name shares the selected root prefix', async () => {
  const selection = await fixture();
  spelling.escape = true;
  await expect(selection.select()).rejects.toThrow('PATH_NOT_GRANTED');
});
