import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PathGrantLedger } from '../apps/agent/src/files/path-grants.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

const capability = vi.hoisted(() => ({ enabled: true }));
vi.mock('../apps/agent/src/server/capabilities.js', () => ({
  hasCapability: () => capability.enabled
}));
const { DirectoryIntake, registerDirectoryIntakeRoutes } =
  await import('../apps/agent/src/files/directory-intake.js');

let root: string;
let picked: string;
let ledger: PathGrantLedger;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'soty-directory-intake-'));
  picked = path.join(root, 'Project');
  await mkdir(path.join(picked, 'Empty'), { recursive: true });
  await writeFile(path.join(picked, 'a.txt'), 'hello');
  ledger = new PathGrantLedger();
  capability.enabled = true;
});

afterEach(async () => {
  ledger.clear();
  await removeTemporaryDirectory(root);
});

describe('native directory intake', () => {
  it('enumerates empty folders and reads only bounded chunks from the chosen tree', async () => {
    const intake = new DirectoryIntake(async () => picked, ledger);
    const result = await intake.select();
    expect(result.kind).toBe('selected');
    if (result.kind !== 'selected') throw new Error('selection failed');
    expect(result.entries).toEqual(
      expect.arrayContaining([
        { kind: 'directory', relativePath: 'Project' },
        { kind: 'directory', relativePath: 'Project/Empty' },
        {
          kind: 'file',
          relativePath: 'Project/a.txt',
          sizeBytes: 5,
          mimeType: 'application/octet-stream'
        }
      ])
    );
    expect(
      await intake.read({
        grantId: result.grantId,
        relativePath: 'Project/a.txt',
        offset: 1,
        length: 2
      })
    ).toEqual(Buffer.from('el'));
    await expect(
      intake.read({ grantId: result.grantId, relativePath: '../a.txt', offset: 0, length: 2 })
    ).rejects.toThrow('INVALID_INPUT');
    await expect(
      intake.read({ grantId: result.grantId, relativePath: 'Project/Empty', offset: 0, length: 2 })
    ).rejects.toThrow('FILE_UNAVAILABLE');
    await expect(
      intake.read({
        grantId: result.grantId,
        relativePath: 'Project/a.txt',
        offset: 0,
        length: 2 * 1024 * 1024 + 1
      })
    ).rejects.toThrow('INVALID_INPUT');
    intake.shutdown();
    await expect(
      intake.read({ grantId: result.grantId, relativePath: 'Project/a.txt', offset: 0, length: 1 })
    ).rejects.toThrow('DIRECTORY_INTAKE_UNAVAILABLE');
    expect(ledger.get(result.grantId)).toBeNull();
  });

  it('returns cancellation without minting a grant', async () => {
    const intake = new DirectoryIntake(async () => null, ledger);
    expect(await intake.select()).toEqual({ kind: 'canceled' });
    expect(ledger.all()).toHaveLength(0);
  });

  it('does not allow a grant for a different folder or an expired selection', async () => {
    let now = 1_000;
    const intake = new DirectoryIntake(
      async () => picked,
      ledger,
      () => now
    );
    const result = await intake.select();
    if (result.kind !== 'selected') throw new Error('selection failed');
    const other = path.join(root, 'Other');
    await mkdir(other);
    const foreign = ledger.mint(other, { access: 'read', origin: 'picker' });
    await expect(
      intake.read({ grantId: foreign?.id, relativePath: 'Project/a.txt', offset: 0, length: 1 })
    ).rejects.toThrow('PATH_NOT_GRANTED');
    now += 31 * 60_000;
    await expect(
      intake.read({ grantId: result.grantId, relativePath: 'Project/a.txt', offset: 0, length: 1 })
    ).rejects.toThrow('PATH_NOT_GRANTED');
    expect(ledger.get(result.grantId)).toBeNull();
  });

  it('cannot mint a grant after shutdown while the picker is still open', async () => {
    let finishPick: ((value: string) => void) | undefined;
    const intake = new DirectoryIntake(
      () =>
        new Promise(resolve => {
          finishPick = resolve;
        }),
      ledger
    );
    const pending = intake.select();
    expect(intake.busy()).toBe(true);
    intake.shutdown();
    finishPick?.(picked);
    await expect(pending).rejects.toThrow('DIRECTORY_INTAKE_UNAVAILABLE');
    expect(intake.busy()).toBe(false);
    expect(ledger.all()).toHaveLength(0);
  });

  it('rejects symlinks instead of following an escape', async () => {
    await symlink(root, path.join(picked, 'Escape'));
    const intake = new DirectoryIntake(async () => picked, ledger);
    await expect(intake.select()).rejects.toThrow('FILE_UNAVAILABLE');
    expect(ledger.all()).toHaveLength(0);
  });

  it('rejects a file replaced after enumeration', async () => {
    const intake = new DirectoryIntake(async () => picked, ledger);
    const result = await intake.select();
    if (result.kind !== 'selected') throw new Error('selection failed');
    await rm(path.join(picked, 'a.txt'));
    await writeFile(path.join(picked, 'a.txt'), 'hello');
    await expect(
      intake.read({ grantId: result.grantId, relativePath: 'Project/a.txt', offset: 0, length: 1 })
    ).rejects.toThrow('FILE_UNAVAILABLE');
  });

  it('capability-gates both routes with a stable machine code', async () => {
    const intake = new DirectoryIntake(async () => picked, ledger);
    const app = Fastify();
    registerDirectoryIntakeRoutes(app, intake);
    try {
      capability.enabled = false;
      const selected = await app.inject({
        method: 'POST',
        url: '/api/team/directory-intake/select',
        payload: {}
      });
      const read = await app.inject({
        method: 'POST',
        url: '/api/team/directory-intake/read',
        payload: {}
      });
      expect(selected.statusCode).toBe(501);
      expect(read.statusCode).toBe(501);
      expect(selected.json()).toEqual({ error: 'DIRECTORY_INTAKE_UNAVAILABLE' });
      expect(ledger.all()).toHaveLength(0);
    } finally {
      intake.shutdown();
      await app.close();
    }
  });
});
