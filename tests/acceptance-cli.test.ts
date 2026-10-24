import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { removeTemporaryDirectory } from './support/temp-dir';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await removeTemporaryDirectory(root);
});

describe('acceptance CLI strict dispatch', () => {
  it('preserves manifest rejection codes through the actual record and report CLI', async () => {
    await mkdir(path.resolve('release/acceptance'), { recursive: true });
    const base = await realpath(path.resolve('release/acceptance'));
    const root = await mkdtemp(path.join(base, 'manifest-cli-test-'));
    roots.push(root);
    const manifest = {
      schemaVersion: 1,
      campaignId: path.basename(root),
      candidateSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      baseTag: 'v1.2.6',
      createdAt: '2026-10-21T10:00:00.000Z',
      dirty: true,
      mode: 'development',
      targetFingerprint: 'c'.repeat(64),
      fixtureVersion: 'tooling-test',
      includedCases: ['SET-001'],
      exclusions: []
    };
    const text = 'Synthetic storage only; no product acceptance case executed.';
    const record = {
      runId: 'synthetic-only',
      campaignId: manifest.campaignId,
      candidateSha: manifest.candidateSha,
      caseId: 'SET-001',
      variant: 'tooling-only',
      status: 'PASS',
      testKind: 'unit',
      startedAt: '2026-10-21T10:01:00.000Z',
      endedAt: '2026-10-21T10:02:00.000Z',
      actual: text,
      evidence: [{ path: 'proof.txt', sha256: createHash('sha256').update(text).digest('hex') }]
    };
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(path.join(root, 'record-input.json'), JSON.stringify(record));
    await writeFile(
      path.join(root, 'forged.json'),
      JSON.stringify({ ...manifest, fixtureVersion: 'changed' })
    );
    await writeFile(path.join(root, 'proof.txt'), text);
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ['scripts/acceptance/cli.mjs', ...args], { encoding: 'utf8' });
    const write = run(
      'record',
      root,
      path.join(root, 'manifest.json'),
      path.join(root, 'record-input.json')
    );
    expect(write.status).toBe(0);
    const read = run('report', root, path.join(root, 'manifest.json'));
    expect(JSON.parse(read.stdout).data.manifestBinding.state).toBe('frozen');
    const rejected = run('report', root, path.join(root, 'forged.json'));
    expect(rejected.status).toBe(1);
    expect(JSON.parse(rejected.stdout)).toMatchObject({
      ok: false,
      error: { code: 'ACCEPTANCE_MANIFEST_MISMATCH' }
    });
  });
  it.each(
    [
      [],
      ['unknown'],
      ['load'],
      ['preflight', '--unsafe'],
      ['fixture', 'raw-sql'],
      ['mail-capture'],
      ['mail-capture', 'target.json', '--force'],
      ['mail-capture', '--remote'],
      ['resources'],
      ['resources', '--remote'],
      ['resources', 'target.json', '--force'],
      ['calibrate-realtime', '--unsafe'],
      ['calibrate-realtime', 'target.json', 'unknown'],
      ['calibrate-realtime', 'target.json', 'steady', '--ignore-errors']
    ].map(args => ({
      args
    }))
  )('rejects unimplemented/unknown input %o', ({ args }) => {
    const result = spawnSync(process.execPath, ['scripts/acceptance/cli.mjs', ...args], {
      encoding: 'utf8'
    });
    expect(result.status).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.ok).toBe(false);
    expect(output.schemaVersion).toBe(1);
    expect(output.error.code).toBe('ACCEPTANCE_USAGE');
  });
});

it('the resource CLI rejects a remote target without printing its payload', async () => {
  await mkdir(path.resolve('release/acceptance'), { recursive: true });
  const root = await mkdtemp(
    path.join(await realpath(path.resolve('release/acceptance')), 'resources-cli-')
  );
  roots.push(root);
  const file = path.join(root, 'target.json');
  await writeFile(file, JSON.stringify({ kind: 'hosted-acceptance', secret: 'DO_NOT_ECHO' }));
  const result = spawnSync(process.execPath, ['scripts/acceptance/cli.mjs', 'resources', file], {
    encoding: 'utf8',
    timeout: 10000
  });
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: { code: 'ACCEPTANCE_TARGET_UNSAFE' }
  });
  expect(result.stdout + result.stderr).not.toContain('DO_NOT_ECHO');
});

it('the actual mail capture CLI refuses an unverified target before database or provider IO', async () => {
  await mkdir(path.resolve('release/acceptance'), { recursive: true });
  const root = await mkdtemp(
    path.join(await realpath(path.resolve('release/acceptance')), 'mail-cli-')
  );
  roots.push(root);
  const file = path.join(root, 'target.json');
  await writeFile(file, JSON.stringify({ kind: 'hosted', secret: 'DO_NOT_ECHO' }));
  const result = spawnSync(process.execPath, ['scripts/acceptance/cli.mjs', 'mail-capture', file], {
    encoding: 'utf8',
    timeout: 10000
  });
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: { code: 'ACCEPTANCE_MAIL_CAPTURE_REFUSED' },
    data: { captured: 0, delivered: false, databaseCommitted: false }
  });
  expect(result.stdout + result.stderr).not.toContain('DO_NOT_ECHO');
});
