import { mkdtemp, mkdir, writeFile, copyFile, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import { buildReport } from '../scripts/acceptance/report.mjs';
import { CASE_IDS } from '../scripts/acceptance/catalog.mjs';
import {
  requiredCaseVariants,
  getRequiredVariantPolicyBinding
} from '../scripts/acceptance/required-variants.mjs';

const requiredVariantPolicyBinding = getRequiredVariantPolicyBinding();
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTemporaryDirectory));
});
const manifest = {
  schemaVersion: 1,
  campaignId: 'acceptance-variants',
  candidateSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  baseTag: 'v1.2.6',
  createdAt: '2026-10-23T10:00:00.000Z',
  dirty: true,
  mode: 'development',
  targetFingerprint: 'c'.repeat(64),
  fixtureVersion: 'v1',
  includedCases: ['ACL-004'],
  exclusions: [],
  variantPolicySha256: requiredVariantPolicyBinding.sha256
};
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'acceptance-variants-'));
  roots.push(root);
  await mkdir(path.join(root, 'runs'));
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(root, 'proof.txt'), 'synthetic test evidence');
  return root;
}
async function record(root: string, variant: string, testKind = 'native-browser', status = 'PASS') {
  await writeFile(
    path.join(root, 'runs', `${variant}.json`),
    JSON.stringify({
      runId: variant,
      campaignId: manifest.campaignId,
      candidateSha: manifest.candidateSha,
      caseId: 'ACL-004',
      variant,
      testKind,
      status,
      startedAt: '2026-10-23T10:00:00.000Z',
      endedAt: '2026-10-23T10:01:00.000Z',
      actual: 'Synthetic result for report regression only',
      ...(['NA', 'BLOCKED', 'NOT_RUN'].includes(status)
        ? { reason: 'Synthetic report regression scope reason' }
        : {}),
      evidence: [
        {
          path: 'proof.txt',
          sha256: createHash('sha256').update('synthetic test evidence').digest('hex')
        }
      ]
    })
  );
}

it('cannot close a viewer case from one passing browser variant', async () => {
  const root = await setup();
  await record(root, 'required');
  expect(await buildReport(root, manifest)).toMatchObject({
    totals: { PASS: 1 },
    requiredTotals: { PASS: 0, NOT_RUN: 1 },
    executed_pass: 0,
    cases: [
      { requiredStatus: 'NOT_RUN', missingVariants: ['role-browser-swap', 'server-authority'] }
    ]
  });
});

it('requires the actual server and swapped-browser variants before closing a case', async () => {
  const root = await setup();
  await record(root, 'required');
  await record(root, 'server-authority', 'actor');
  await record(root, 'role-browser-swap');
  expect(await buildReport(root, manifest)).toMatchObject({
    requiredTotals: { PASS: 1, NOT_RUN: 0 },
    executed_pass: 1,
    recorded_pass: 3,
    cases: [{ requiredStatus: 'PASS', missingVariants: [], ineligibleVariants: [] }]
  });
});

it('does not substitute unit evidence or an arbitrary variant for runtime acceptance', async () => {
  const root = await setup();
  await record(root, 'required', 'unit');
  await record(root, 'arbitrary-extra');
  await record(root, 'server-authority', 'actor');
  await record(root, 'role-browser-swap');
  expect(await buildReport(root, manifest)).toMatchObject({
    requiredTotals: { PASS: 0, NOT_RUN: 1 },
    executed_pass: 0,
    cases: [
      { requiredStatus: 'NOT_RUN', missingVariants: ['required'], ineligibleVariants: ['required'] }
    ]
  });
});

it('keeps a failed supplemental variant blocking instead of hiding it behind complete passes', async () => {
  const root = await setup();
  await record(root, 'required');
  await record(root, 'server-authority', 'actor');
  await record(root, 'role-browser-swap');
  await record(root, 'regression-extra', 'unit', 'FAIL');
  expect(await buildReport(root, manifest)).toMatchObject({
    requiredTotals: { FAIL: 1, PASS: 0 },
    executed_pass: 0,
    cases: [{ requiredStatus: 'FAIL' }]
  });
});

it('covers every catalog case with immutable, unique, traceable runtime variants', () => {
  expect(CASE_IDS).toHaveLength(174);
  for (const caseId of CASE_IDS) {
    const variants = requiredCaseVariants(caseId);
    expect(variants.some(value => value.id === 'required')).toBe(true);
    expect(new Set(variants.map(value => value.id)).size).toBe(variants.length);
    for (const value of variants) {
      expect(value.basis.length).toBeGreaterThan(0);
      expect(value.allowedTestKinds).not.toContain('unit');
      expect(Object.isFrozen(value.allowedTestKinds)).toBe(true);
    }
    expect(Object.isFrozen(variants)).toBe(true);
  }
  expect(requiredVariantPolicyBinding.sha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(() => requiredCaseVariants('ACL-999')).toThrow('ACCEPTANCE_VARIANT_POLICY_INVALID');
});

it('does not accept a weaker variant policy supplied in a campaign payload', async () => {
  const root = await setup();
  await expect(buildReport(root, { ...manifest, requiredVariants: ['required'] })).rejects.toThrow(
    'ACCEPTANCE_MANIFEST_INVALID'
  );
});

it('requires actual load and packaged kinds for the corresponding final evidence', () => {
  expect(requiredCaseVariants('OBS-008')[0].allowedTestKinds).toEqual(['load']);
  expect(requiredCaseVariants('OBS-010')[0].allowedTestKinds).toEqual(['packaged']);
});

it('does not treat an exclusion reason without hashed evidence as completed acceptance', async () => {
  const root = await setup();
  const scoped = { ...manifest, exclusions: ['ACL-004'] };
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify(scoped));
  await writeFile(
    path.join(root, 'runs', 'required.json'),
    JSON.stringify({
      runId: 'required',
      campaignId: manifest.campaignId,
      candidateSha: manifest.candidateSha,
      caseId: 'ACL-004',
      variant: 'required',
      testKind: 'manual',
      status: 'NA',
      startedAt: '2026-10-23T10:00:00.000Z',
      endedAt: '2026-10-23T10:01:00.000Z',
      actual: 'Synthetic exclusion regression',
      reason: 'Excluded from candidate',
      evidence: []
    })
  );
  expect(await buildReport(root, scoped)).toMatchObject({
    totals: { NA: 1 },
    requiredTotals: { NOT_RUN: 1, NA: 0 },
    executed_pass: 0,
    cases: [{ requiredStatus: 'NOT_RUN' }]
  });
});

it('keeps legacy executions unproven when their frozen manifest does not bind the variant policy', async () => {
  const root = await setup();
  const legacy = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== 'variantPolicySha256')
  );
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify(legacy));
  await record(root, 'required');
  await record(root, 'server-authority', 'actor');
  await record(root, 'role-browser-swap');
  expect(await buildReport(root, legacy)).toMatchObject({
    variantPolicyBinding: { state: 'unbound' },
    requiredTotals: { PASS: 0, NOT_RUN: 1 },
    executed_pass: 0,
    cases: [{ status: 'PASS', requiredStatus: 'NOT_RUN' }]
  });
});

it('rejects a forged or stale policy digest before trusting any execution', async () => {
  const root = await setup();
  const forged = { ...manifest, variantPolicySha256: 'd'.repeat(64) };
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify(forged));
  await expect(buildReport(root, forged)).rejects.toThrow('ACCEPTANCE_MANIFEST_INVALID');
});

it('defers policy validation so a catalog edit cannot prevent importing fixture teardown commands', async () => {
  const root = await setup();
  await mkdir(path.join(root, 'scripts/acceptance'), { recursive: true });
  await mkdir(path.join(root, 'specs/036-production-acceptance'), { recursive: true });
  for (const file of [
    'scripts/acceptance/catalog.mjs',
    'scripts/acceptance/schema.mjs',
    'scripts/acceptance/required-variants.mjs',
    'specs/036-production-acceptance/manual-test-cases.md',
    'specs/036-production-acceptance/required-variants.json'
  ]) {
    await copyFile(new URL(`../${file}`, import.meta.url), path.join(root, file));
  }
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  await appendFile(
    path.join(root, 'specs/036-production-acceptance/manual-test-cases.md'),
    '\n<!-- synthetic catalog edit -->\n'
  );
  const options = { cwd: root, encoding: 'utf8' as const, timeout: 10000 };
  expect(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "await import('./scripts/acceptance/schema.mjs'); console.log('IMPORTED')"
      ],
      options
    ).trim()
  ).toBe('IMPORTED');
  expect(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "const p=await import('./scripts/acceptance/required-variants.mjs'); try {p.getRequiredVariantPolicyBinding(); console.log('UNEXPECTED')} catch(error) {console.log(error.message)}"
      ],
      options
    ).trim()
  ).toBe('ACCEPTANCE_VARIANT_POLICY_INVALID');
}, 30000);
