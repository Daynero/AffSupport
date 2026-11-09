import { readFile } from 'node:fs/promises';

/**
 * 048: the typed boundary for the two JSON records a Mac release carries about its
 * signature — the chain's summary (`signing.json`, written beside the artifact by the
 * packagers) and the release gate's trust record (one line on the stdout of
 * verify-macos-release-trust.mjs). Both cross a process boundary, so both are parsed
 * from `unknown` into closed shapes here and nowhere else (Constitution I).
 */

export const SIGNING_IDENTITIES = Object.freeze(['adhoc', 'developer-id']);
export const TRUST_POLICIES = Object.freeze(['developer-id', 'adhoc-pre-048']);
const TEAM_ID = /^[A-Z0-9]{10}$/u;
const SUBMISSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const PROFILES = Object.freeze(['node', 'chromium', 'hardened']);

const count = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const invalid = error => ({ ok: false, error });

/**
 * The chain's summary. `machO` counts the loose binaries plus the main executable, so
 * it equals the profile counts plus one; nested bundles' binaries are in
 * `nestedBundles` (contracts/signing-chain.md).
 * @param {unknown} input
 */
export function parseSigningSummary(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return invalid('SIGNING_SUMMARY_INVALID');
  const record = /** @type {Record<string, unknown>} */ (input);
  const { app, identity, teamId, machO, nestedBundles, profiles, notarized, stapled } = record;
  const submissionId = record.submissionId ?? null;
  if (typeof app !== 'string' || !app.endsWith('.app'))
    return invalid('SIGNING_SUMMARY_APP_INVALID');
  if (typeof identity !== 'string' || !SIGNING_IDENTITIES.includes(identity))
    return invalid('SIGNING_SUMMARY_IDENTITY_INVALID');
  if (identity === 'developer-id' ? !TEAM_ID.test(String(teamId)) : teamId !== null)
    return invalid('SIGNING_SUMMARY_TEAM_INVALID');
  if (!count(machO, 1024) || Number(machO) < 1 || !count(nestedBundles, 64))
    return invalid('SIGNING_SUMMARY_COUNT_INVALID');
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles))
    return invalid('SIGNING_SUMMARY_PROFILES_INVALID');
  const counts = /** @type {Record<string, unknown>} */ (profiles);
  if (!PROFILES.every(name => count(counts[name], 1024)))
    return invalid('SIGNING_SUMMARY_PROFILES_INVALID');
  if (PROFILES.reduce((sum, name) => sum + Number(counts[name]), 1) !== machO)
    return invalid('SIGNING_SUMMARY_COUNT_INVALID');
  if (typeof notarized !== 'boolean' || typeof stapled !== 'boolean')
    return invalid('SIGNING_SUMMARY_FLAGS_INVALID');
  if (identity === 'adhoc' && (notarized || stapled))
    return invalid('SIGNING_SUMMARY_ADHOC_NOTARIZED');
  if (stapled && !notarized) return invalid('SIGNING_SUMMARY_FLAGS_INVALID');
  if (
    submissionId !== null &&
    (typeof submissionId !== 'string' || !SUBMISSION_ID.test(submissionId))
  )
    return invalid('SIGNING_SUMMARY_SUBMISSION_INVALID');
  if (notarized !== (submissionId !== null)) return invalid('SIGNING_SUMMARY_SUBMISSION_INVALID');
  return {
    ok: true,
    value: {
      app,
      identity,
      teamId: identity === 'developer-id' ? String(teamId) : null,
      machO: Number(machO),
      nestedBundles: Number(nestedBundles),
      profiles: {
        node: Number(counts.node),
        chromium: Number(counts.chromium),
        hardened: Number(counts.hardened)
      },
      notarized,
      stapled,
      submissionId
    }
  };
}

/** `signing.json` beside a package; a missing file is a distinct, expected outcome. */
export async function readSigningSummary(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    return invalid(code === 'ENOENT' ? 'SIGNING_SUMMARY_MISSING' : 'SIGNING_SUMMARY_UNREADABLE');
  }
  if (raw.length > 65536) return invalid('SIGNING_SUMMARY_INVALID');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalid('SIGNING_SUMMARY_INVALID');
  }
  return parseSigningSummary(parsed);
}

/**
 * The release gate's record. `adhoc-pre-048` never claims Apple trust and
 * `developer-id` never claims less than all of it (048 Analytics acceptance).
 * @param {unknown} input
 */
export function parseTrustRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return invalid('TRUST_RECORD_INVALID');
  const record = /** @type {Record<string, unknown>} */ (input);
  const { target, trustPolicy, appleTrust, developerId, notarized, stapled } = record;
  if (typeof target !== 'string' || !['macos-arm64', 'macos-x64'].includes(target))
    return invalid('TRUST_RECORD_TARGET_INVALID');
  if (typeof trustPolicy !== 'string' || !TRUST_POLICIES.includes(trustPolicy))
    return invalid('TRUST_RECORD_POLICY_INVALID');
  if (![developerId, notarized, stapled].every(flag => typeof flag === 'boolean'))
    return invalid('TRUST_RECORD_INVALID');
  if (trustPolicy === 'developer-id') {
    const hardenedMachO = record.hardenedMachO;
    if (
      appleTrust !== 'verified' ||
      !developerId ||
      !notarized ||
      !stapled ||
      !count(hardenedMachO, 1024) ||
      Number(hardenedMachO) < 1
    )
      return invalid('TRUST_RECORD_DEVELOPER_ID_INCOMPLETE');
    return {
      ok: true,
      value: {
        target,
        trustPolicy,
        appleTrust: 'verified',
        developerId: true,
        hardenedMachO: Number(hardenedMachO),
        notarized: true,
        stapled: true
      }
    };
  }
  if (
    appleTrust !== 'unverified' ||
    developerId ||
    notarized ||
    stapled ||
    'hardenedMachO' in record
  )
    return invalid('TRUST_RECORD_ADHOC_OVERCLAIMS');
  return {
    ok: true,
    value: {
      target,
      trustPolicy,
      appleTrust: 'unverified',
      developerId: false,
      notarized: false,
      stapled: false
    }
  };
}

/** The last line of a command's output that is a JSON object, parsed; null when none. */
export function lastJsonObjectLine(output) {
  const text = Array.isArray(output) ? output.join('') : String(output ?? '');
  for (const line of text.split(/\r?\n/u).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 048 FR-005 / T013: the artifact must have been built the way the policy claims.
 * Under `developer-id` the chain's summary is required and must name the owner's team
 * and a stapled notarization; under `adhoc-pre-048` a summary is optional (packagers
 * before 048 wrote none) but may not claim an identity the policy denies.
 * @param {ReturnType<typeof parseSigningSummary>} signing
 * @param {{trustPolicy: string}} trust
 * @param {string | undefined} expectedTeam
 */
export function assertSigningMatchesPolicy(signing, trust, expectedTeam) {
  if (trust.trustPolicy === 'developer-id') {
    if (!signing.ok) throw new Error(`MACOS_SIGNING_SUMMARY_REQUIRED: ${signing.error}`);
    if (signing.value.identity !== 'developer-id') throw new Error('MACOS_SIGNING_IDENTITY_ADHOC');
    if (!TEAM_ID.test(expectedTeam ?? '') || signing.value.teamId !== expectedTeam)
      throw new Error('MACOS_SIGNING_TEAM_MISMATCH');
    if (!signing.value.notarized || !signing.value.stapled)
      throw new Error('MACOS_SIGNING_NOT_NOTARIZED');
    return;
  }
  if (signing.ok && signing.value.identity !== 'adhoc')
    throw new Error('MACOS_SIGNING_POLICY_CONFLICT');
}
