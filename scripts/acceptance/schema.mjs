import { CASE_IDS } from './catalog.mjs';
import { getRequiredVariantPolicyBinding } from './required-variants.mjs';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const KEYS = new Set([
  'runId',
  'campaignId',
  'candidateSha',
  'caseId',
  'variant',
  'status',
  'startedAt',
  'endedAt',
  'testKind',
  'actual',
  'reason',
  'evidence',
  'manifestSha256',
  'supersedesRunId'
]);
const STATUSES = new Set(['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN', 'NA']);
const KINDS = new Set([
  'native-browser',
  'actor',
  'unit',
  'database',
  'load',
  'packaged',
  'manual'
]);
const forbidden =
  /Bearer\s+\S+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|sb_secret_[A-Za-z0-9_-]+|-----BEGIN .*PRIVATE KEY|postgres(?:ql)?:\/\/|(?:refresh_token|access_token|service_role|password)\s*[=:]/i;

export function safeArtifactPath(value) {
  return (
    typeof value === 'string' &&
    value.length <= 240 &&
    /^[a-zA-Z0-9][a-zA-Z0-9/._-]*$/.test(value) &&
    value.split('/').every(part => part && part !== '.' && part !== '..')
  );
}

/** Validate untrusted records without including rejected values in errors. */
export function validateExecution(input, context) {
  const reject = () => ({ ok: false, code: 'ACCEPTANCE_RECORD_INVALID' });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return reject();
  if (Object.keys(input).some(key => !KEYS.has(key))) return reject();
  if (
    ['runId', 'campaignId', 'variant'].some(
      key => typeof input[key] !== 'string' || !SAFE_ID.test(input[key])
    )
  )
    return reject();
  if (
    input.campaignId !== context.campaignId ||
    input.candidateSha !== context.candidateSha ||
    !SHA.test(input.candidateSha)
  )
    return reject();
  if (
    !context.includedCases.includes(input.caseId) ||
    !STATUSES.has(input.status) ||
    !KINDS.has(input.testKind)
  )
    return reject();
  const times = [input.startedAt, input.endedAt];
  if (
    times.some(
      value =>
        typeof value !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString() !== value
    )
  )
    return reject();
  if (Date.parse(input.endedAt) < Date.parse(input.startedAt)) return reject();
  if (typeof input.actual !== 'string' || !input.actual.trim() || input.actual.length > 2000)
    return reject();
  if (
    input.reason !== undefined &&
    (typeof input.reason !== 'string' || input.reason.length > 1000)
  )
    return reject();
  if (['BLOCKED', 'NOT_RUN', 'NA'].includes(input.status) && !input.reason?.trim()) return reject();
  // NA needs a reviewed scope exclusion, rather than an arbitrary reason.
  if (input.status === 'NA' && !context.exclusions?.includes(input.caseId)) return reject();
  if (
    input.manifestSha256 !== undefined &&
    (typeof input.manifestSha256 !== 'string' || !DIGEST.test(input.manifestSha256))
  )
    return reject();
  if (
    input.supersedesRunId !== undefined &&
    (typeof input.supersedesRunId !== 'string' || !SAFE_ID.test(input.supersedesRunId))
  )
    return reject();
  if (!Array.isArray(input.evidence) || input.evidence.length > 32) return reject();
  if (['PASS', 'FAIL'].includes(input.status) && !input.evidence.length) return reject();
  for (const evidence of input.evidence) {
    if (
      !evidence ||
      typeof evidence !== 'object' ||
      Array.isArray(evidence) ||
      Object.keys(evidence).some(key => !['path', 'sha256'].includes(key)) ||
      !safeArtifactPath(evidence.path) ||
      typeof evidence.sha256 !== 'string' ||
      !DIGEST.test(evidence.sha256)
    )
      return reject();
  }
  if (forbidden.test(JSON.stringify(input))) return reject();
  return { ok: true };
}

const MANIFEST_KEYS = new Set([
  'schemaVersion',
  'campaignId',
  'candidateSha',
  'baseSha',
  'baseTag',
  'createdAt',
  'dirty',
  'mode',
  'targetFingerprint',
  'fixtureVersion',
  'includedCases',
  'exclusions',
  'variantPolicySha256'
]);
/** A final manifest may never describe a dirty development tree. */
export function validateManifest(input) {
  const reject = () => ({ ok: false, code: 'ACCEPTANCE_MANIFEST_INVALID' });
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some(key => !MANIFEST_KEYS.has(key))
  )
    return reject();
  if (
    input.schemaVersion !== 1 ||
    typeof input.campaignId !== 'string' ||
    !SAFE_ID.test(input.campaignId)
  )
    return reject();
  if (
    typeof input.candidateSha !== 'string' ||
    !SHA.test(input.candidateSha) ||
    typeof input.baseSha !== 'string' ||
    !SHA.test(input.baseSha) ||
    input.baseTag !== 'v1.2.6'
  )
    return reject();
  if (
    typeof input.dirty !== 'boolean' ||
    !['development', 'final'].includes(input.mode) ||
    (input.mode === 'final' && input.dirty)
  )
    return reject();
  if (
    typeof input.targetFingerprint !== 'string' ||
    !DIGEST.test(input.targetFingerprint) ||
    typeof input.fixtureVersion !== 'string' ||
    !SAFE_ID.test(input.fixtureVersion)
  )
    return reject();
  if (
    typeof input.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(input.createdAt)) ||
    new Date(input.createdAt).toISOString() !== input.createdAt
  )
    return reject();
  if (
    !Array.isArray(input.includedCases) ||
    !input.includedCases.length ||
    input.includedCases.some(id => !CASE_IDS.includes(id)) ||
    new Set(input.includedCases).size !== input.includedCases.length
  )
    return reject();
  if (
    !Array.isArray(input.exclusions) ||
    input.exclusions.some(id => !input.includedCases.includes(id)) ||
    new Set(input.exclusions).size !== input.exclusions.length
  )
    return reject();
  if (input.mode === 'final' && input.includedCases.length !== CASE_IDS.length) return reject();
  // Absent on historical manifests. Those remain readable but cannot close the
  // current required variants; supplied bindings must match reviewed policy.
  if (
    input.variantPolicySha256 !== undefined &&
    (typeof input.variantPolicySha256 !== 'string' ||
      !DIGEST.test(input.variantPolicySha256) ||
      input.variantPolicySha256 !== getRequiredVariantPolicyBinding().sha256)
  )
    return reject();
  return { ok: true };
}
