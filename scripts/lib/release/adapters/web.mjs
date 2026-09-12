import { exactReconcile } from './reconcile.mjs';
export const reconcileWeb = (expected, observed) => exactReconcile(expected, observed);

export function validateWebDeployment({ binding, sourceSha, manifestSha, outputDigest }) {
  if (!binding?.bindingId || !/^[a-f0-9]{40}$/u.test(sourceSha) || !/^[a-f0-9]{40}$/u.test(manifestSha) || !/^[a-f0-9]{64}$/u.test(outputDigest)) {
    throw new Error('WEB_DEPLOYMENT_IDENTITY_INVALID');
  }
  return Object.freeze({ schemaVersion: 1, bindingId: binding.bindingId, sourceSha, manifestSha, outputDigest });
}
