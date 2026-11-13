/**052 Read-only evidence check. It cannot deploy, activate policy or delete bytes.*/
import { createHash } from 'node:crypto';
const HEX = /^[a-f0-9]{64}$/u;
/** @param {any} evidence @param {{sourceSha:string,environment:string,routingRevision:string,manifestDigest:string,now?:number}} expected */
export function evaluateCatalogGlobalCutoverEvidence(evidence, expected) {
  const failures = [];
  if (!evidence || evidence.schema !== 1)
    return { ok: false, failures: ['GLOBAL_IMAGE_ACCEPTANCE_MISSING'], digest: null };
  for (const [key, value] of Object.entries({
    source_sha: expected.sourceSha,
    environment: expected.environment,
    routing_revision: expected.routingRevision,
    manifest_digest: expected.manifestDigest
  }))
    if (evidence[key] !== value) failures.push(`GLOBAL_IMAGE_BINDING_${key.toUpperCase()}`);
  if (
    !HEX.test(evidence.worker_source_sha256 ?? '') ||
    !HEX.test(evidence.route_config_sha256 ?? '') ||
    !HEX.test(evidence.key_versions_sha256 ?? '')
  )
    failures.push('GLOBAL_IMAGE_SERVING_PROVENANCE_MISSING');
  const age = (expected.now ?? Date.now()) - Date.parse(evidence.observed_at ?? '');
  if (!Number.isFinite(age) || age < 0 || age > 120_000)
    failures.push('GLOBAL_IMAGE_SERVING_PROOF_STALE');
  for (const check of [
    'http',
    'browser',
    'installed_macos',
    'installed_windows',
    'meta_import',
    'origin_request_fanout',
    'retirement',
    'diagnostics',
    'performance',
    'drained_legacy_writes',
    'drained_legacy_deletions'
  ])
    if (evidence[check] !== 'verified')
      failures.push(`GLOBAL_IMAGE_${check.toUpperCase()}_UNVERIFIED`);
  for (const build of ['current', 'rollback'])
    if (
      evidence.builds?.[build]?.policy_aware !== true ||
      !HEX.test(evidence.builds?.[build]?.archive_sha256 ?? '')
    )
      failures.push(`GLOBAL_IMAGE_${build.toUpperCase()}_BUILD_INCOMPATIBLE`);
  return {
    ok: failures.length === 0,
    failures,
    digest: createHash('sha256').update(JSON.stringify(evidence)).digest('hex')
  };
}
/** Optional future T0 preparation is separate from an ordinary inactive compatibility release. */
export function inspectCatalogGlobalRelease(binding, sourceSha) {
  if (!binding?.catalogGlobalCutover)
    return { ok: true, state: 'inactive_no_activation_requested', failures: [] };
  const request = binding.catalogGlobalCutover;
  const verdict = evaluateCatalogGlobalCutoverEvidence(request.evidence, {
    sourceSha,
    environment: binding.kind === 'production' ? 'production' : request.environment,
    routingRevision: request.routingRevision,
    manifestDigest: request.manifestDigest
  });
  return {
    ...verdict,
    state: verdict.ok ? 'prepared_for_owner_activation' : 'blocked',
    automaticActivation: false
  };
}
/** Trusted full-release adapter only. Browser/operator handlers expose no matching route.
 * @param {{rpc:(name:string,params:Record<string,unknown>)=>Promise<any>}} service
 * @param {any} evidence
 * @param {{sourceSha:string,environment:string,routingRevision:string,manifestDigest:string}} expected
 */
export async function recordCatalogGlobalAcceptance(service, evidence, expected) {
  const verdict = evaluateCatalogGlobalCutoverEvidence(evidence, expected);
  if (!verdict.ok) throw new Error('GLOBAL_IMAGE_ACCEPTANCE_INCOMPLETE');
  const result = await service.rpc('service_catalog_global_acceptance', {
    p_evidence: evidence,
    p_digest: verdict.digest
  });
  if (result?.error) throw new Error('GLOBAL_IMAGE_ACCEPTANCE_RECORD_UNKNOWN');
  return { recorded: true, digest: verdict.digest, automaticActivation: false };
}
/** The source collector binds the optional reviewed Worker artifact to the same release SHA.
 * It reads local bytes only; neither this function nor preflight publishes them.
 * @param {string} sourceSha @param {Uint8Array} workerArtifact
 * @param {{environment:string,routingRevision:string,manifestDigest:string,keyVersions:number[],routeConfig:object}} configuration
 */
export function collectCatalogGlobalSource(sourceSha, workerArtifact, configuration) {
  if (
    !/^[a-f0-9]{40}$/u.test(sourceSha) ||
    workerArtifact.length < 1 ||
    workerArtifact.length > 1_000_000 ||
    !['dev', 'beta', 'production'].includes(configuration.environment) ||
    configuration.keyVersions.length < 1 ||
    configuration.keyVersions.length > 8 ||
    !configuration.keyVersions.every(n => Number.isInteger(n) && n > 0 && n <= 65535)
  )
    throw new Error('GLOBAL_IMAGE_SOURCE_BINDING_INVALID');
  return {
    source_sha: sourceSha,
    environment: configuration.environment,
    routing_revision: configuration.routingRevision,
    manifest_digest: configuration.manifestDigest,
    worker_source_sha256: createHash('sha256').update(workerArtifact).digest('hex'),
    route_config_sha256: createHash('sha256')
      .update(JSON.stringify(configuration.routeConfig))
      .digest('hex'),
    key_versions_sha256: createHash('sha256')
      .update(JSON.stringify([...new Set(configuration.keyVersions)].sort((a, b) => a - b)))
      .digest('hex')
  };
}
