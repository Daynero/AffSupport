/**
 * Choosing what to roll the site back to.
 *
 * Rolling back is the one operation nobody is calm during, so none of it is
 * decided in the moment: the deploy that went out archived exactly the bytes it
 * uploaded, and this picks from that record. A rollback that rebuilds from
 * source would ship something nobody has ever served — which is a second
 * unverified deploy wearing the word "rollback".
 *
 * Nothing here touches the network or the disk; the gate does that with what
 * these functions choose.
 */
import { createPublicKey, verify } from 'node:crypto';
import {
  RELEASE_MANIFEST_PUBLIC_KEY_SPKI_B64,
  releaseManifestSigningPayload
} from '../../packages/shared/dist/release.js';

function refuse(code, message) {
  const error = new Error(`${code}: ${message}`);
  return Object.assign(error, { code });
}

/** Flat markers are current; legacy nested bindings must agree if also present. */
export function assertRollbackBinding(deployment, bindingId) {
  const flat = deployment?.bindingId;
  const nested = deployment?.binding?.bindingId;
  if (
    typeof bindingId !== 'string' ||
    !bindingId ||
    (flat === undefined && nested === undefined) ||
    (flat !== undefined && flat !== bindingId) ||
    (nested !== undefined && nested !== bindingId)
  )
    throw refuse('ROLLBACK_BINDING_MISMATCH', 'deployment is not proven to belong to this target');
  return bindingId;
}

/** The local current signed channel must survive rollback byte-for-byte. */
export function assertRollbackManifest({
  local,
  archived,
  live,
  publicKeySpki = RELEASE_MANIFEST_PUBLIC_KEY_SPKI_B64
}) {
  const current = Buffer.from(local);
  if (!current.equals(Buffer.from(archived)) || !current.equals(Buffer.from(live)))
    throw refuse(
      'ROLLBACK_CHANNEL_CHANGED',
      'local, archived and live stable manifest bytes differ'
    );
  let manifest;
  try {
    manifest = JSON.parse(current.toString('utf8'));
    if (
      !manifest ||
      manifest.schemaVersion !== 1 ||
      manifest.channel !== 'stable' ||
      typeof manifest.signature !== 'string' ||
      !/^[A-Za-z0-9_-]+$/u.test(manifest.signature) ||
      !verify(
        'sha256',
        Buffer.from(releaseManifestSigningPayload(manifest), 'utf8'),
        {
          key: createPublicKey({
            key: Buffer.from(publicKeySpki, 'base64'),
            format: 'der',
            type: 'spki'
          }),
          dsaEncoding: 'ieee-p1363'
        },
        Buffer.from(manifest.signature, 'base64url')
      )
    )
      throw new Error('invalid signature');
  } catch {
    throw refuse('ROLLBACK_MANIFEST_INVALID', 'current stable manifest signature does not verify');
  }
  return manifest;
}

/** A rollback is a new deployment, so future selection sees the actual current bytes. */
export function rollbackReceipt({ target, current, deployedAt }) {
  if (typeof deployedAt !== 'string' || !Number.isFinite(Date.parse(deployedAt)))
    throw refuse('ROLLBACK_RECEIPT_INVALID', 'a fresh deployment timestamp is required');
  const bindingId = target.bindingId ?? target.binding?.bindingId;
  assertRollbackBinding(target, bindingId);
  assertRollbackBinding(current, bindingId);
  const deployment = { ...target };
  delete deployment.rolledBackFrom;
  return {
    ...deployment,
    bindingId,
    deployedAt,
    rolledBackFrom: {
      sourceSha: current.sourceSha,
      outputDigest: current.outputDigest,
      deployedAt: current.deployedAt ?? null
    }
  };
}

/**
 * @param {string} text
 * @returns {Deployment[]}
 */
export function parseHistory(text) {
  return text
    .split(/\r?\n/)
    .filter(line => line.trim())
    .map(line => JSON.parse(line))
    .filter(
      entry => typeof entry?.outputDigest === 'string' && typeof entry?.sourceSha === 'string'
    );
}

/**
 * @typedef {{
 *   sourceSha: string,
 *   outputDigest: string,
 *   deployedAt?: string,
 *   bindingId?: string,
 *   binding?: {bindingId?: string}
 * }} Deployment
 *
 * @param {readonly Deployment[]} history newest last
 * @param {{to?: string, archived: readonly string[]}} options
 * @returns {{target: Deployment|null, current: Deployment|null, problems: string[]}}
 */
export function selectRollbackTarget(history, { to, archived }) {
  const available = new Set(archived);
  const current = history.at(-1) ?? null;
  if (!current)
    return {
      target: null,
      current: null,
      problems: ['nothing has been deployed from this machine, so there is nothing to roll back to']
    };

  if (to) {
    const named = [...history]
      .reverse()
      .find(entry => entry.sourceSha.startsWith(to) || entry.outputDigest.startsWith(to));
    if (!named) return { target: null, current, problems: [`no deployment matches ${to}`] };
    if (!available.has(named.outputDigest))
      return {
        target: null,
        current,
        problems: [
          `the bundle for ${to} is no longer archived, so its exact bytes cannot be redeployed`
        ]
      };
    if (named.outputDigest === current.outputDigest)
      return { target: null, current, problems: [`${to} is what is deployed now`] };
    return { target: named, current, problems: [] };
  }

  // The previous *different* bundle, not simply the previous entry: redeploying
  // the same bytes under a new deployment id changes nothing and would read in
  // the log as a rollback that happened.
  const previous = [...history]
    .reverse()
    .find(
      entry => entry.outputDigest !== current.outputDigest && available.has(entry.outputDigest)
    );
  if (!previous)
    return {
      target: null,
      current,
      problems: ['no earlier bundle is still archived, so there is nothing to roll back to']
    };
  return { target: previous, current, problems: [] };
}

/**
 * Which archived bundles to keep. Content-addressed, so a redeploy of unchanged
 * bytes does not consume a slot, and the one currently deployed is never pruned
 * however old it is.
 *
 * @param {readonly Deployment[]} history newest last
 * @param {number} keep
 * @returns {string[]}
 */
export function bundlesToKeep(history, keep) {
  const seen = [];
  for (const entry of [...history].reverse())
    if (!seen.includes(entry.outputDigest)) seen.push(entry.outputDigest);
  return seen.slice(0, keep);
}
