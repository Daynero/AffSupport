import { exactReconcile } from './reconcile.mjs';
export const reconcileGitHub = (expected, observed) => exactReconcile(expected, observed);

export function releaseDispatch({ workflow, sourceSha, releaseId, mode }) {
  if (workflow !== 'release-windows.yml' || !/^[a-f0-9]{40}$/u.test(sourceSha) || !releaseId || !['build-only', 'publish'].includes(mode)) throw new Error('GITHUB_DISPATCH_INVALID');
  return Object.freeze({ workflow, sourceSha, releaseId, mode, inputs: { source_sha: sourceSha, release_id: releaseId, publish: mode === 'publish' } });
}

export function verifyWindowsAsset(asset, expectedName, expectedDigest) {
  return asset?.name === expectedName && asset?.sha256 === expectedDigest ? { ok: true } : { ok: false, code: 'WINDOWS_ASSET_MISMATCH' };
}
