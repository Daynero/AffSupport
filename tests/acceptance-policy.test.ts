import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { acceptanceScope, validateAcceptancePolicy } from '../scripts/acceptance/policy.mjs';

const bytes = readFileSync(
  new URL('../specs/036-production-acceptance/acceptance-policy.json', import.meta.url)
);
const policy = JSON.parse(bytes.toString('utf8'));

it('binds the owner exclusion to actual reviewed policy bytes', () => {
  expect(validateAcceptancePolicy(policy)).toEqual({ ok: true });
  expect(acceptanceScope(['REG-017']).binding.sha256).toBe(
    createHash('sha256').update(bytes).digest('hex')
  );
  expect(acceptanceScope(['ACL-001']).exclusions).toEqual([]);
});

it.each(['ACL-001', 'TARIFF-001', 'LIFE-001', 'OBS-010'])(
  'cannot widen the Windows-only exception to %s',
  caseId => {
    const forged = structuredClone(policy);
    forged.scopeExclusions[0].caseIds = [caseId];
    expect(validateAcceptancePolicy(forged)).toMatchObject({ ok: false });
  }
);

it('rejects build or other platform exclusions and unknown policy fields', () => {
  const forged = structuredClone(policy);
  forged.scopeExclusions[0].scope = 'windows-build';
  expect(validateAcceptancePolicy(forged)).toMatchObject({ ok: false });
  expect(validateAcceptancePolicy({ ...policy, arbitraryExclusions: ['ACL-001'] })).toMatchObject({
    ok: false
  });
});

it('rejects malformed authority, time and unbounded rationale', () => {
  expect(validateAcceptancePolicy({ ...policy, authority: 'caller' })).toMatchObject({ ok: false });
  expect(validateAcceptancePolicy({ ...policy, recordedAt: 'not-a-time' })).toMatchObject({
    ok: false
  });
  const forged = structuredClone(policy);
  forged.scopeExclusions[0].reason = 'x'.repeat(1001);
  expect(validateAcceptancePolicy(forged)).toMatchObject({ ok: false });
});
