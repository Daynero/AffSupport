import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const policyUrl = new URL(
  '../../specs/036-production-acceptance/acceptance-policy.json',
  import.meta.url
);

/** This version permits only the explicitly approved native Windows exclusion.
 * @param {unknown} input
 */
export function validateAcceptancePolicy(input) {
  const reject = () => ({ ok: false, code: 'ACCEPTANCE_POLICY_INVALID' });
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return reject();
    const keys = [
      'schemaVersion',
      'policyId',
      'recordedAt',
      'authority',
      'ownerInstruction',
      'scopeExclusions'
    ];
    if (Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key)))
      return reject();
    const get = key => Reflect.get(input, key);
    const recordedAt = get('recordedAt');
    const instruction = get('ownerInstruction');
    if (
      get('schemaVersion') !== 1 ||
      get('policyId') !== '036-owner-exclusions-v1' ||
      get('authority') !== 'product-owner' ||
      typeof recordedAt !== 'string' ||
      !Number.isFinite(Date.parse(recordedAt)) ||
      new Date(recordedAt).toISOString() !== recordedAt ||
      typeof instruction !== 'string' ||
      !instruction.trim() ||
      instruction.length > 1000
    )
      return reject();
    const exclusions = get('scopeExclusions');
    if (!Array.isArray(exclusions) || exclusions.length !== 1) return reject();
    const exclusion = exclusions[0];
    if (
      !exclusion ||
      typeof exclusion !== 'object' ||
      Array.isArray(exclusion) ||
      Object.keys(exclusion).length !== 4 ||
      !['scope', 'caseIds', 'taskIds', 'reason'].every(key => Object.hasOwn(exclusion, key))
    )
      return reject();
    const reason = Reflect.get(exclusion, 'reason');
    if (
      Reflect.get(exclusion, 'scope') !== 'native-windows-runtime' ||
      JSON.stringify(Reflect.get(exclusion, 'caseIds')) !== '["REG-017"]' ||
      JSON.stringify(Reflect.get(exclusion, 'taskIds')) !== '["T059","T173"]' ||
      typeof reason !== 'string' ||
      !reason.trim() ||
      reason.length > 1000
    )
      return reject();
    return { ok: true };
  } catch {
    return reject();
  }
}

/** Read reviewed repository policy, never a caller-provided waiver or campaign payload.
 * @param {string[]} includedCases
 */
export function acceptanceScope(includedCases) {
  const bytes = readFileSync(policyUrl);
  if (bytes.length > 16384) throw Error('ACCEPTANCE_POLICY_INVALID');
  const policy = JSON.parse(bytes.toString('utf8'));
  if (!validateAcceptancePolicy(policy).ok) throw Error('ACCEPTANCE_POLICY_INVALID');
  return {
    binding: {
      policyId: '036-owner-exclusions-v1',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      source: 'specs/036-production-acceptance/acceptance-policy.json'
    },
    exclusions: includedCases.includes('REG-017') ? policy.scopeExclusions : []
  };
}
