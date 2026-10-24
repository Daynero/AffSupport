import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CASE_IDS } from './catalog.mjs';

/** @typedef {{readonly id:string, readonly allowedTestKinds:readonly string[], readonly basis:string}} RequiredCaseVariant */
/** @typedef {{required:Map<string,readonly RequiredCaseVariant[]>, binding:{readonly policyId:string,readonly source:string,readonly sha256:string,readonly catalogSha256:string}}} LoadedRequiredPolicy */
/** @type {LoadedRequiredPolicy|undefined} */
let loaded;

function loadPolicy() {
  if (loaded) return loaded;
  const root = new URL('../../specs/036-production-acceptance/', import.meta.url);
  const bytes = readFileSync(new URL('required-variants.json', root));
  const catalog = readFileSync(new URL('manual-test-cases.md', root));
  const hash = value => createHash('sha256').update(value).digest('hex');
  /** @returns {never} */
  const invalid = () => {
    throw Error('ACCEPTANCE_VARIANT_POLICY_INVALID');
  };
  if (bytes.length > 131072) invalid();
  const policy = JSON.parse(bytes.toString('utf8'));
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const exact = (value, keys) =>
    object(value) &&
    Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key));
  if (
    !exact(policy, [
      'schemaVersion',
      'policyId',
      'catalogSha256',
      'groupRequiredVariants',
      'caseOverrides',
      'caseAdditions'
    ]) ||
    policy.schemaVersion !== 1 ||
    policy.policyId !== '036-required-variants-v1' ||
    policy.catalogSha256 !== hash(catalog)
  )
    invalid();
  const kinds = new Set(['native-browser', 'manual', 'actor', 'database', 'load', 'packaged']);
  function variants(input) {
    if (!Array.isArray(input) || !input.length || input.length > 16) invalid();
    const result = input.map(value => {
      if (
        !exact(value, ['id', 'allowedTestKinds', 'basis']) ||
        typeof value.id !== 'string' ||
        !/^[a-z][a-z0-9-]{0,63}$/u.test(value.id) ||
        typeof value.basis !== 'string' ||
        !value.basis.trim() ||
        value.basis.length > 1000 ||
        !Array.isArray(value.allowedTestKinds) ||
        !value.allowedTestKinds.length ||
        value.allowedTestKinds.some(kind => !kinds.has(kind)) ||
        new Set(value.allowedTestKinds).size !== value.allowedTestKinds.length
      )
        invalid();
      return Object.freeze({
        id: value.id,
        allowedTestKinds: Object.freeze([...value.allowedTestKinds]),
        basis: value.basis
      });
    });
    if (new Set(result.map(value => value.id)).size !== result.length) invalid();
    return result;
  }
  const groups = [...new Set(CASE_IDS.map(id => id.split('-')[0]))].sort();
  if (
    !object(policy.groupRequiredVariants) ||
    JSON.stringify(Object.keys(policy.groupRequiredVariants).sort()) !== JSON.stringify(groups)
  )
    invalid();
  for (const section of [policy.caseOverrides, policy.caseAdditions]) {
    if (!object(section) || Object.keys(section).some(id => !CASE_IDS.includes(id))) invalid();
    for (const values of Object.values(section)) variants(values);
  }
  /** @type {Map<string, readonly RequiredCaseVariant[]>} */
  const required = new Map();
  for (const caseId of CASE_IDS) {
    const base = variants(
      policy.caseOverrides[caseId] ?? policy.groupRequiredVariants[caseId.split('-')[0]]
    );
    const additions = policy.caseAdditions[caseId] ? variants(policy.caseAdditions[caseId]) : [];
    const all = [...base, ...additions];
    if (
      all.length > 16 ||
      new Set(all.map(value => value.id)).size !== all.length ||
      !all.some(value => value.id === 'required')
    )
      invalid();
    required.set(caseId, Object.freeze(all));
  }
  const binding = Object.freeze({
    policyId: '036-required-variants-v1',
    source: 'specs/036-production-acceptance/required-variants.json',
    sha256: hash(bytes),
    catalogSha256: hash(catalog)
  });
  loaded = { required, binding };
  return loaded;
}

/** Normative repository policy; loading is deferred so fixture teardown is independent.
 * @param {string} caseId
 */
export function requiredCaseVariants(caseId) {
  const result = loadPolicy().required.get(caseId);
  if (!result) throw Error('ACCEPTANCE_VARIANT_POLICY_INVALID');
  return result;
}

export function getRequiredVariantPolicyBinding() {
  return loadPolicy().binding;
}
