const SHA256 = /^[a-f0-9]{64}$/u;

export function validateCandidate({ candidate, previousStable, betaEvidence }) {
  if (!candidate?.sourceSha || !candidate?.version || !candidate?.targetDigest) {
    return { ok: false, code: 'GATE_FAILED', subject: 'Candidate identity is incomplete.' };
  }
  if (!previousStable?.version || !previousStable?.signature || !previousStable?.artifacts) {
    return { ok: false, code: 'GATE_FAILED', subject: 'Trusted previous stable manifest is incomplete.' };
  }
  if (Object.values(previousStable.artifacts).some(value => !SHA256.test(value?.sha256 ?? ''))) {
    return { ok: false, code: 'GATE_FAILED', subject: 'Previous stable manifest has invalid artifact digests.' };
  }
  if (!betaEvidence || betaEvidence.sourceSha !== candidate.sourceSha || betaEvidence.packageDigest !== candidate.packageDigest) {
    return { ok: false, code: 'BETA_EVIDENCE_INVALID', subject: 'Beta package provenance does not match candidate.' };
  }
  return { ok: true };
}

export function validateFinal({ manifest, publishedArtifacts, expectedVersion }) {
  if (!manifest?.signature || manifest.version !== expectedVersion) return { ok: false, code: 'GATE_FAILED', subject: 'Final manifest identity is invalid.' };
  for (const [platform, artifact] of Object.entries(manifest.artifacts ?? {})) {
    if (!SHA256.test(artifact?.sha256 ?? '') || publishedArtifacts?.[platform]?.sha256 !== artifact.sha256) {
      return { ok: false, code: 'GATE_FAILED', subject: `Published ${platform} bytes do not match signed manifest.` };
    }
  }
  return { ok: true };
}
