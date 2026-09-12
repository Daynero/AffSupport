export function assembleFinalManifest({ base, artifacts }) {
  const next = structuredClone(base);
  for (const [platform, artifact] of Object.entries(artifacts)) {
    if (!/^[a-f0-9]{64}$/u.test(artifact.sha256 ?? '') || !artifact.url?.startsWith('https://')) throw new Error('PUBLISHED_ARTIFACT_INVALID');
    next.artifacts[platform] = { ...next.artifacts[platform], url: artifact.url, sha256: artifact.sha256 };
  }
  return next;
}
