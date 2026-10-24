import { removeTemporaryDirectory } from './support/temp-dir.js';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildReport } from '../scripts/acceptance/report.mjs';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => removeTemporaryDirectory(root)));
});
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'acceptance-report-'));
  roots.push(root);
  await mkdir(path.join(root, 'runs'));
  await writeFile(path.join(root, 'proof.txt'), 'proof');
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  return root;
}
const manifest = {
  schemaVersion: 1,
  campaignId: 'acceptance-test',
  candidateSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  baseTag: 'v1.2.6',
  createdAt: '2026-10-20T20:00:00.000Z',
  dirty: true,
  mode: 'development',
  targetFingerprint: 'c'.repeat(64),
  fixtureVersion: 'v1',
  includedCases: ['SET-001', 'ACL-001'],
  exclusions: []
};
const record = {
  runId: 'run-001',
  campaignId: manifest.campaignId,
  candidateSha: manifest.candidateSha,
  caseId: 'SET-001',
  variant: 'owner',
  status: 'PASS',
  testKind: 'actor',
  startedAt: '2026-10-20T20:00:00.000Z',
  endedAt: '2026-10-20T20:01:00.000Z',
  actual: 'Verified',
  evidence: [{ path: 'proof.txt', sha256: createHash('sha256').update('proof').digest('hex') }]
};
describe('truthful campaign reporting', () => {
  it('rejects a self-superseding attempt even at the same instant', async () => {
    const root = await setup();
    await writeFile(
      path.join(root, 'runs/run-001.json'),
      JSON.stringify({ ...record, endedAt: record.startedAt, supersedesRunId: record.runId })
    );
    await expect(buildReport(root, manifest)).rejects.toThrow('ACCEPTANCE_SUPERSESSION_INVALID');
  });
  it('rejects symlinked run files before reading their contents', async () => {
    const root = await setup();
    await writeFile(path.join(root, 'foreign.json'), JSON.stringify(record));
    await symlink(path.join(root, 'foreign.json'), path.join(root, 'runs/run-001.json'));
    await expect(buildReport(root, manifest)).rejects.toThrow('ACCEPTANCE_RECORD_INVALID');
  });

  it('counts missing cases as NOT_RUN and never grants final GO', async () => {
    const root = await setup();
    await writeFile(path.join(root, 'runs/run-001.json'), JSON.stringify(record));
    expect(await buildReport(root, manifest)).toMatchObject({
      totals: { PASS: 1, NOT_RUN: 1 },
      verdict: 'NO_GO'
    });
  });
  it('rejects evidence changed after execution', async () => {
    const root = await setup();
    await writeFile(path.join(root, 'runs/run-001.json'), JSON.stringify(record));
    await writeFile(path.join(root, 'proof.txt'), 'changed');
    await expect(buildReport(root, manifest)).rejects.toThrow('ACCEPTANCE_EVIDENCE_MISMATCH');
  });
  it('rejects two current attempts without an explicit supersession', async () => {
    const root = await setup();
    await writeFile(path.join(root, 'runs/run-001.json'), JSON.stringify(record));
    await writeFile(
      path.join(root, 'runs/run-002.json'),
      JSON.stringify({ ...record, runId: 'run-002' })
    );
    await expect(buildReport(root, manifest)).rejects.toThrow('ACCEPTANCE_RESULT_AMBIGUOUS');
  });
  it('keeps unexecuted Windows evidence visible and excludes only the owner-waived native case from required totals', async () => {
    const root = await setup();
    const scoped = { ...manifest, includedCases: ['REG-017', 'ACL-001'] };
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify(scoped));
    const report = await buildReport(root, scoped);
    expect(report).toMatchObject({
      totals: { PASS: 0, NOT_RUN: 2 },
      requiredCaseCount: 1,
      requiredTotals: { PASS: 0, NOT_RUN: 1 },
      scopeExclusions: [{ scope: 'native-windows-runtime', caseIds: ['REG-017'] }],
      verdict: 'NO_GO'
    });
    expect(report.cases.find(row => row.caseId === 'REG-017')).toMatchObject({
      status: 'NOT_RUN',
      scope: 'owner_excluded'
    });
    expect(report.cases.find(row => row.caseId === 'ACL-001')).toMatchObject({
      status: 'NOT_RUN',
      scope: 'required'
    });
    expect(report.policyBinding.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      await import('node:fs/promises').then(fs =>
        fs.readFile(path.join(root, 'manifest.json'), 'utf8')
      )
    ).toBe(JSON.stringify(scoped));
  });
  it('does not exclude other cases or hide recorded passes that lack required variants', async () => {
    const root = await setup();
    await writeFile(path.join(root, 'runs/run-001.json'), JSON.stringify(record));
    const report = await buildReport(root, manifest);
    expect(report).toMatchObject({
      requiredCaseCount: 2,
      totals: { PASS: 1, NOT_RUN: 1 },
      requiredTotals: { PASS: 0, NOT_RUN: 2 },
      scopeExclusions: [],
      executed_pass: 0,
      recorded_pass: 1
    });
  });
});
