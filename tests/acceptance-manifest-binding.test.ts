import { mkdtemp, mkdir, readFile, writeFile, unlink, symlink, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const faults = vi.hoisted(() => ({ failSnapshotLink: false, failRecordWrite: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args);
      if (
        !faults.failRecordWrite ||
        !String(args[0]).includes(`${path.sep}runs${path.sep}.pending-`)
      )
        return handle;
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'writeFile')
            return async () => {
              throw new Error('synthetic record write failure');
            };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    },
    link: async (...args: Parameters<typeof original.link>) => {
      if (faults.failSnapshotLink && String(args[1]).endsWith('manifest.frozen.json'))
        throw Object.assign(new Error('synthetic publication failure'), { code: 'EIO' });
      return original.link(...args);
    }
  };
});
import { appendExecution } from '../scripts/acceptance/records.mjs';
import { buildReport } from '../scripts/acceptance/report.mjs';
import { CASE_IDS } from '../scripts/acceptance/catalog.mjs';
import { removeTemporaryDirectory } from './support/temp-dir';

const roots: string[] = [];
afterEach(async () => {
  faults.failSnapshotLink = false;
  faults.failRecordWrite = false;
  for (const root of roots.splice(0)) await removeTemporaryDirectory(root);
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'acceptance-binding-'));
  roots.push(root);
  const manifest = {
    schemaVersion: 1,
    campaignId: 'binding-test',
    candidateSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    baseTag: 'v1.2.6',
    createdAt: '2026-10-21T10:00:00.000Z',
    dirty: true,
    mode: 'development',
    targetFingerprint: 'c'.repeat(64),
    fixtureVersion: 'v1',
    includedCases: ['SET-001'],
    exclusions: []
  };
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(root, 'proof.txt'), 'synthetic proof');
  const record = {
    runId: 'run-one',
    campaignId: manifest.campaignId,
    candidateSha: manifest.candidateSha,
    caseId: 'SET-001',
    variant: 'owner',
    status: 'PASS',
    testKind: 'actor',
    startedAt: '2026-10-21T10:01:00.000Z',
    endedAt: '2026-10-21T10:02:00.000Z',
    actual: 'Synthetic proof',
    evidence: [
      { path: 'proof.txt', sha256: createHash('sha256').update('synthetic proof').digest('hex') }
    ]
  };
  return { root, manifest, record };
}

it('rejects a writer scope supplied in place of the campaign stored on disk', async () => {
  const { root, manifest, record } = await fixture();
  await expect(
    appendExecution(
      root,
      { ...record, caseId: 'SET-002' },
      { ...manifest, includedCases: ['SET-002'] }
    )
  ).rejects.toThrow('ACCEPTANCE_MANIFEST_MISMATCH');
});

it('rejects a reporting scope supplied in place of the stored campaign', async () => {
  const { root, manifest } = await fixture();
  await expect(buildReport(root, { ...manifest, includedCases: ['SET-002'] })).rejects.toThrow(
    'ACCEPTANCE_MANIFEST_MISMATCH'
  );
});

it('freezes the manifest before publishing a run and binds every new record to its digest', async () => {
  const { root, manifest, record } = await fixture();
  await appendExecution(root, record, manifest);
  expect(JSON.parse(await readFile(path.join(root, 'manifest.frozen.json'), 'utf8'))).toEqual(
    manifest
  );
  const saved = JSON.parse(await readFile(path.join(root, 'runs/run-one.json'), 'utf8'));
  expect(saved.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(saved.manifestSha256).toBe(
    createHash('sha256')
      .update(await readFile(path.join(root, 'manifest.frozen.json')))
      .digest('hex')
  );
  expect(await buildReport(root, manifest)).toMatchObject({
    manifestBinding: { state: 'frozen', sha256: saved.manifestSha256 },
    totals: { PASS: 1 },
    verdict: 'NO_GO'
  });
  const changed = { ...manifest, fixtureVersion: 'changed' };
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify(changed));
  await expect(appendExecution(root, { ...record, runId: 'run-two' }, changed)).rejects.toThrow(
    'ACCEPTANCE_MANIFEST_MISMATCH'
  );
  await expect(buildReport(root, changed)).rejects.toThrow('ACCEPTANCE_MANIFEST_MISMATCH');
});

it('supports concurrent first publications against one identical frozen manifest', async () => {
  const { root, manifest, record } = await fixture();
  await Promise.all([
    appendExecution(root, record, manifest),
    appendExecution(root, { ...record, runId: 'run-two', variant: 'member' }, manifest)
  ]);
  const a = JSON.parse(await readFile(path.join(root, 'runs/run-one.json'), 'utf8'));
  const b = JSON.parse(await readFile(path.join(root, 'runs/run-two.json'), 'utf8'));
  expect(a.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(b.manifestSha256).toBe(a.manifestSha256);
  expect(await buildReport(root, manifest)).toMatchObject({ historyCount: 2, totals: { PASS: 1 } });
});

it('reads legacy development evidence explicitly without retroactively freezing it', async () => {
  const { root, manifest, record } = await fixture();
  await mkdir(path.join(root, 'runs'));
  await writeFile(path.join(root, 'runs/run-one.json'), JSON.stringify(record));
  expect(await buildReport(root, manifest)).toMatchObject({
    manifestBinding: { state: 'legacy_unfrozen' },
    totals: { PASS: 1 },
    verdict: 'NO_GO'
  });
  await expect(appendExecution(root, { ...record, runId: 'run-two' }, manifest)).rejects.toThrow(
    'ACCEPTANCE_MANIFEST_UNFROZEN'
  );
  await expect(readFile(path.join(root, 'manifest.frozen.json'))).rejects.toMatchObject({
    code: 'ENOENT'
  });
});

it('rejects missing and symlinked manifest files before accepting runs', async () => {
  const { root, manifest, record } = await fixture();
  await unlink(path.join(root, 'manifest.json'));
  await expect(appendExecution(root, record, manifest)).rejects.toThrow(
    'ACCEPTANCE_MANIFEST_INVALID'
  );
  await writeFile(path.join(root, 'other.json'), JSON.stringify(manifest));
  await symlink(path.join(root, 'other.json'), path.join(root, 'manifest.json'));
  await expect(buildReport(root, manifest)).rejects.toThrow('ACCEPTANCE_MANIFEST_PATH_UNSAFE');
});

it('rejects removal of the frozen manifest instead of downgrading bound records to legacy', async () => {
  const { root, manifest, record } = await fixture();
  await appendExecution(root, record, manifest);
  await unlink(path.join(root, 'manifest.frozen.json'));
  await expect(buildReport(root, manifest)).rejects.toThrow('ACCEPTANCE_MANIFEST_UNFROZEN');
});

it('rejects changed snapshot bytes and records without the frozen digest', async () => {
  const { root, manifest, record } = await fixture();
  await appendExecution(root, record, manifest);
  const frozen = path.join(root, 'manifest.frozen.json');
  const bytes = await readFile(frozen, 'utf8');
  await writeFile(frozen, bytes + '\n');
  await expect(buildReport(root, manifest)).rejects.toThrow('ACCEPTANCE_MANIFEST_MISMATCH');
  await writeFile(frozen, bytes);
  await writeFile(path.join(root, 'runs/run-one.json'), JSON.stringify(record));
  await expect(buildReport(root, manifest)).rejects.toThrow('ACCEPTANCE_MANIFEST_MISMATCH');
});

it('rejects oversized input and does not attach rejected parser contents to errors', async () => {
  const { root, manifest } = await fixture();
  await writeFile(path.join(root, 'manifest.json'), ' '.repeat(65537) + JSON.stringify(manifest));
  await expect(buildReport(root, manifest)).rejects.toThrow('ACCEPTANCE_MANIFEST_INVALID');
  await writeFile(path.join(root, 'manifest.json'), '{synthetic-rejected-private-input');
  try {
    await buildReport(root, manifest);
    expect.unreachable();
  } catch (error) {
    expect(error).toMatchObject({ message: 'ACCEPTANCE_MANIFEST_INVALID' });
    expect(error).not.toHaveProperty('cause');
    expect(String(error)).not.toContain('synthetic-rejected-private-input');
  }
});

it('removes an unpublished snapshot after an I/O failure and permits a safe retry', async () => {
  const { root, manifest, record } = await fixture();
  faults.failSnapshotLink = true;
  await expect(appendExecution(root, record, manifest)).rejects.toThrow(
    'ACCEPTANCE_MANIFEST_PUBLISH_FAILED'
  );
  expect((await readdir(root)).filter(name => name.startsWith('.manifest-pending-'))).toEqual([]);
  await expect(readFile(path.join(root, 'manifest.frozen.json'))).rejects.toMatchObject({
    code: 'ENOENT'
  });
  faults.failSnapshotLink = false;
  await appendExecution(root, record, manifest);
  expect(await buildReport(root, manifest)).toMatchObject({ manifestBinding: { state: 'frozen' } });
});

it('does not allow a legacy campaign to present itself as final evidence', async () => {
  const { root, manifest, record } = await fixture();
  const final = { ...manifest, mode: 'final', dirty: false, includedCases: [...CASE_IDS] };
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify(final));
  await mkdir(path.join(root, 'runs'));
  await writeFile(path.join(root, 'runs/run-one.json'), JSON.stringify(record));
  await expect(buildReport(root, final)).rejects.toThrow('ACCEPTANCE_MANIFEST_UNFROZEN');
});

it('cleans an unpublished run after its write fails and permits retry without a torn record', async () => {
  const { root, manifest, record } = await fixture();
  faults.failRecordWrite = true;
  await expect(appendExecution(root, record, manifest)).rejects.toThrow(
    'synthetic record write failure'
  );
  expect(await readdir(path.join(root, 'runs'))).toEqual([]);
  faults.failRecordWrite = false;
  await appendExecution(root, record, manifest);
  expect(await buildReport(root, manifest)).toMatchObject({ historyCount: 1, totals: { PASS: 1 } });
});
