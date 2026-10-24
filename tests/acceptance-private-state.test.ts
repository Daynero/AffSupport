import { removeTemporaryDirectory } from './support/temp-dir.js';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readPrivateState, writePrivateState } from '../scripts/acceptance/private-state.mjs';

const namespace = 'acceptance-private-test';
const roots: string[] = [];
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'acceptance-private-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => removeTemporaryDirectory(root)));
});
it('atomically replaces complete checkpoints and refuses duplicate initial ownership', async () => {
  const root = await setup();
  await writePrivateState(namespace, 'fixtures.json', { sequence: 1 }, { root, createOnly: true });
  await expect(
    writePrivateState(namespace, 'fixtures.json', { sequence: 2 }, { root, createOnly: true })
  ).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readPrivateState(namespace, 'fixtures.json', root)).toEqual({ sequence: 1 });
  await writePrivateState(namespace, 'fixtures.json', { sequence: 3 }, { root });
  expect(await readPrivateState(namespace, 'fixtures.json', root)).toEqual({ sequence: 3 });
  expect(await readdir(path.join(root, namespace))).toEqual(['fixtures.json']);
  if (process.platform !== 'win32')
    expect((await stat(path.join(root, namespace, 'fixtures.json'))).mode & 0o777).toBe(0o600);
});
it('rejects traversal, oversized checkpoints and corrupt credentials without echoing them', async () => {
  const root = await setup();
  await expect(writePrivateState('../escape', 'fixtures.json', {}, { root })).rejects.toThrow(
    'ACCEPTANCE_PRIVATE_STATE_INVALID'
  );
  await expect(writePrivateState(namespace, 'target.json', {}, { root })).rejects.toThrow(
    'ACCEPTANCE_PRIVATE_STATE_INVALID'
  );
  await expect(
    writePrivateState(namespace, 'fixtures.json', 'x'.repeat(65536), { root })
  ).rejects.toThrow('ACCEPTANCE_PRIVATE_STATE_INVALID');
  await writePrivateState(namespace, 'fixtures.json', {}, { root });
  await writeFile(path.join(root, namespace, 'fixtures.json'), 'sensitive-invalid-json');
  await expect(readPrivateState(namespace, 'fixtures.json', root)).rejects.toThrow(
    /^ACCEPTANCE_PRIVATE_STATE_INVALID$/
  );
});
it('never follows a checkpoint symlink into another campaign', async () => {
  const root = await setup();
  await writePrivateState(namespace, 'reader.json', {}, { root });
  const outside = path.join(root, 'sentinel.json');
  await writeFile(outside, 'unchanged');
  const file = path.join(root, namespace, 'reader.json');
  await rm(file);
  await symlink(outside, file);
  await expect(readPrivateState(namespace, 'reader.json', root)).rejects.toThrow(
    'ACCEPTANCE_PRIVATE_STATE_UNSAFE'
  );
  await expect(writePrivateState(namespace, 'reader.json', {}, { root })).rejects.toThrow(
    'ACCEPTANCE_PRIVATE_STATE_UNSAFE'
  );
  expect(await readFile(outside, 'utf8')).toBe('unchanged');
});
