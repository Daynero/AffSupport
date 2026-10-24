import { readFile, readdir, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { validateManifest, validateExecution } from './schema.mjs';
import { verifyEvidence } from './records.mjs';
import { bindCampaignManifest } from './manifest.mjs';
import { acceptanceScope } from './policy.mjs';
import { requiredCaseVariants, getRequiredVariantPolicyBinding } from './required-variants.mjs';

/** No missing result is a PASS. Conflicting latest attempts fail closed. */
export async function buildReport(root, manifest) {
  if (!validateManifest(manifest).ok) throw new Error('ACCEPTANCE_MANIFEST_INVALID');
  const binding = await bindCampaignManifest(root, manifest);
  const scope = binding.manifest;
  // validateManifest above has checked every member against the closed catalog.
  /** @type {string[]} */
  const caseIds = scope.includedCases;
  const policy = acceptanceScope(caseIds);
  const requiredVariantPolicyBinding = getRequiredVariantPolicyBinding();
  const variantPolicyBound = scope.variantPolicySha256 === requiredVariantPolicyBinding.sha256;
  const excludedCases = new Set(policy.exclusions.flatMap(exclusion => exclusion.caseIds));
  const canonicalRoot = binding.root;
  const directory = path.join(canonicalRoot, 'runs');
  let names;
  try {
    if ((await realpath(directory)) !== directory) throw new Error('ACCEPTANCE_RECORD_PATH_UNSAFE');
    names = await readdir(directory);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      names = [];
    else throw error;
  }
  if (names.length > 10000) throw new Error('ACCEPTANCE_RECORD_LIMIT');
  const runs = [];
  for (const name of names.filter(name => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.json$/.test(name))) {
    const file = path.join(directory, name);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65536)
      throw new Error('ACCEPTANCE_RECORD_INVALID');
    const content = await readFile(file, 'utf8');
    if (content.length > 65536) throw new Error('ACCEPTANCE_RECORD_INVALID');
    const record = JSON.parse(content);
    if (!validateExecution(record, scope).ok || `${record.runId}.json` !== name)
      throw new Error('ACCEPTANCE_RECORD_INVALID');
    if (binding.state === 'frozen' && record.manifestSha256 !== binding.sha256)
      throw new Error('ACCEPTANCE_MANIFEST_MISMATCH');
    if (binding.state !== 'frozen' && record.manifestSha256 !== undefined)
      throw new Error('ACCEPTANCE_MANIFEST_UNFROZEN');
    await verifyEvidence(root, record.evidence);
    runs.push(record);
  }
  const superseded = new Set();
  for (const run of runs) {
    if (!run.supersedesRunId) continue;
    const previous = runs.find(other => other.runId === run.supersedesRunId);
    if (
      !previous ||
      previous.runId === run.runId ||
      previous.caseId !== run.caseId ||
      previous.variant !== run.variant ||
      Date.parse(previous.endedAt) > Date.parse(run.startedAt) ||
      superseded.has(previous.runId)
    )
      throw new Error('ACCEPTANCE_SUPERSESSION_INVALID');
    superseded.add(previous.runId);
  }
  const byId = new Map(runs.map(run => [run.runId, run]));
  for (const run of runs) {
    const seen = new Set();
    let cursor = run;
    while (cursor) {
      if (seen.has(cursor.runId)) throw new Error('ACCEPTANCE_SUPERSESSION_INVALID');
      seen.add(cursor.runId);
      cursor = byId.get(cursor.supersedesRunId);
    }
  }
  const current = runs.filter(run => !superseded.has(run.runId));
  const keys = current.map(run => `${run.caseId}/${run.variant}`);
  if (new Set(keys).size !== keys.length) throw new Error('ACCEPTANCE_RESULT_AMBIGUOUS');
  const totals = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_RUN: 0, NA: 0 };
  const cases = caseIds.map(caseId => {
    const variants = current.filter(run => run.caseId === caseId);
    const status = !variants.length
      ? 'NOT_RUN'
      : ['FAIL', 'BLOCKED', 'NOT_RUN', 'NA', 'PASS'].find(value =>
          variants.some(run => run.status === value)
        );
    totals[status] += 1;
    const required = requiredCaseVariants(caseId);
    const excluded = excludedCases.has(caseId);
    const ineligibleVariants = required
      .filter(expected => {
        const run = variants.find(value => value.variant === expected.id);
        return run && !expected.allowedTestKinds.includes(run.testKind);
      })
      .map(value => value.id)
      .sort();
    const missingVariants = excluded
      ? []
      : required
          .filter(
            expected =>
              !variants.some(
                run =>
                  run.variant === expected.id && expected.allowedTestKinds.includes(run.testKind)
              )
          )
          .map(value => value.id)
          .sort();
    const requiredRuns = variants.filter(run =>
      required.some(
        expected => run.variant === expected.id && expected.allowedTestKinds.includes(run.testKind)
      )
    );
    const reviewedExclusion =
      scope.exclusions.includes(caseId) &&
      variants.some(run => run.status === 'NA' && run.evidence.length > 0);
    const requiredStatus = excluded
      ? null
      : variants.some(run => run.status === 'FAIL')
        ? 'FAIL'
        : requiredRuns.some(run => run.status === 'BLOCKED')
          ? 'BLOCKED'
          : !variantPolicyBound
            ? 'NOT_RUN'
            : reviewedExclusion
              ? 'NA'
              : missingVariants.length ||
                  requiredRuns.some(run => ['NOT_RUN', 'NA'].includes(run.status))
                ? 'NOT_RUN'
                : 'PASS';
    return {
      caseId,
      status,
      scope: excludedCases.has(caseId) ? 'owner_excluded' : 'required',
      requiredStatus,
      requiredVariants: required.map(value => value.id),
      missingVariants,
      ineligibleVariants,
      variants: variants.map(run => ({
        runId: run.runId,
        variant: run.variant,
        status: run.status,
        testKind: run.testKind
      }))
    };
  });
  const requiredTotals = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_RUN: 0, NA: 0 };
  for (const entry of cases) {
    if (entry.requiredStatus !== null) requiredTotals[entry.requiredStatus] += 1;
  }
  return {
    schemaVersion: 1,
    campaignId: scope.campaignId,
    candidateSha: scope.candidateSha,
    dirty: scope.dirty,
    manifestBinding: { state: binding.state, sha256: binding.sha256 },
    totals,
    cases,
    requiredCaseCount: cases.length - excludedCases.size,
    requiredTotals,
    scopeExclusions: policy.exclusions,
    policyBinding: policy.binding,
    variantPolicyBinding: {
      ...requiredVariantPolicyBinding,
      state: variantPolicyBound ? 'bound' : 'unbound'
    },
    historyCount: runs.length,
    executed_pass: requiredTotals.PASS,
    recorded_pass: current.filter(run => run.status === 'PASS').length,
    adopted_pass: 0,
    verdict: 'NO_GO',
    reason:
      'Final required variants, exact-SHA package, load and external evidence require independent acceptance; development report cannot authorize production.'
  };
}
