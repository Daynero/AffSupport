import { removeTemporaryDirectory } from './support/temp-dir.js';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { appendExecution } from '../scripts/acceptance/records.mjs';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => removeTemporaryDirectory(root)));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'acceptance-writer-'));
  roots.push(root);
  await mkdir(path.join(root, 'cases'));
  const content = 'synthetic proof';
  await writeFile(path.join(root, 'cases/proof.txt'), content);
  const context = {
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
    includedCases: ['SET-001'],
    exclusions: []
  };
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify(context));
  const record = {
    runId: 'run-001',
    campaignId: context.campaignId,
    candidateSha: context.candidateSha,
    caseId: 'SET-001',
    variant: 'owner',
    status: 'PASS',
    testKind: 'actor',
    actual: 'Verified',
    startedAt: '2026-10-20T20:00:00.000Z',
    endedAt: '2026-10-20T20:01:00.000Z',
    evidence: [
      { path: 'cases/proof.txt', sha256: createHash('sha256').update(content).digest('hex') }
    ]
  };
  return { root, context, record };
}
describe('append only execution writer', () => {
  it('writes immutable records and rejects duplicate run IDs', async () => {
    const { root, context, record } = await fixture();
    await appendExecution(root, record, context);
    await expect(appendExecution(root, record, context)).rejects.toThrow('ACCEPTANCE_RUN_EXISTS');
    expect(JSON.parse(await readFile(path.join(root, 'runs/run-001.json'), 'utf8'))).toEqual({
      ...record,
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
  });
  it('checks artifact bytes before storing PASS', async () => {
    const { root, context, record } = await fixture();
    await writeFile(path.join(root, 'cases/proof.txt'), 'changed');
    await expect(appendExecution(root, record, context)).rejects.toThrow(
      'ACCEPTANCE_EVIDENCE_MISMATCH'
    );
  });
});
