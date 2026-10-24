import { describe, expect, it } from 'vitest';
import { validateExecution } from '../scripts/acceptance/schema.mjs';

const context = {
  campaignId: 'acceptance-test-001',
  candidateSha: 'a'.repeat(40),
  includedCases: ['SET-001']
};
const record = {
  runId: 'run-001',
  campaignId: context.campaignId,
  candidateSha: context.candidateSha,
  caseId: 'SET-001',
  variant: 'owner-chrome',
  status: 'PASS',
  startedAt: '2026-10-20T20:00:00.000Z',
  endedAt: '2026-10-20T20:01:00.000Z',
  testKind: 'native-browser',
  actual: 'Independent authenticated session verified',
  evidence: [{ path: 'cases/set-001.png', sha256: 'b'.repeat(64) }]
};
describe('acceptance execution boundary', () => {
  it('accepts direct candidate evidence', () =>
    expect(validateExecution(record, context).ok).toBe(true));
  it.each([
    { evidence: [] },
    { candidateSha: 'c'.repeat(40) },
    { caseId: 'NOT-A-CASE' },
    { campaignId: 'other' },
    { status: 'NA' },
    { actual: 'Bearer abc-secret' },
    { actual: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.syntheticSignature' },
    { reason: 'sb_secret_syntheticCredential' },
    { endedAt: '2026-10-20T19:00:00.000Z' },
    { evidence: [{ path: '../secrets.txt', sha256: 'b'.repeat(64) }] },
    { evidence: [{ path: 'cases/result.json', sha256: 'invalid' }] },
    { secret: 'unexpected' }
  ])('rejects invalid or unsafe evidence %o', patch => {
    expect(validateExecution({ ...record, ...patch }, context).ok).toBe(false);
  });
  it('requires a reason for blocked and not run outcomes', () => {
    expect(
      validateExecution(
        { ...record, status: 'BLOCKED', evidence: [], reason: 'Native browser unavailable' },
        context
      ).ok
    ).toBe(true);
    expect(validateExecution({ ...record, status: 'NOT_RUN', evidence: [] }, context).ok).toBe(
      false
    );
  });
});

// Campaign metadata is a boundary too: runs must never validate against a caller-invented scope.
