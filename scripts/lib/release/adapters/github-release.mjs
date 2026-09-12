export function releaseDispatch({ workflow, sourceSha, releaseId, mode }) {
  if (workflow !== 'release-windows.yml' || !/^[a-f0-9]{40}$/u.test(sourceSha) || !releaseId || !['build-only', 'publish'].includes(mode)) throw new Error('GITHUB_DISPATCH_INVALID');
  return Object.freeze({ workflow, sourceSha, releaseId, mode, inputs: { source_sha: sourceSha, release_id: releaseId, publish: mode === 'publish' } });
}

export function verifyWindowsAsset(asset, expectedName, expectedDigest) {
  if (asset?.name !== expectedName || asset?.sha256 !== expectedDigest) return { ok: false, code: 'WINDOWS_ASSET_MISMATCH' };
  return { ok: true };
}
